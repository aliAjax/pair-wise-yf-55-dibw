// 版本迁移领域逻辑：规则失效重算、版本差异、快照回填。
import type {
  FieldType,
  FormField,
  FormVersion,
  LinkRule,
  PendingField,
  Snapshot
} from './types';

export function fieldById(fields: FormField[], id: string): FormField | undefined {
  return fields.find((field) => field.id === id);
}

// 依据版本内字段定义重算每条规则的状态：
// 触发/目标字段被移除，或字段类型较规则定义时发生变化，则规则失效。
export function recomputeRules(rules: LinkRule[], fields: FormField[]): LinkRule[] {
  return rules.map((rule) => {
    const source = fieldById(fields, rule.fieldId);
    const target = fieldById(fields, rule.targetId);
    const reasons: string[] = [];
    if (!source) reasons.push(`触发字段「${rule.fieldId}」已被移除`);
    else if (rule.sourceType && source.type !== rule.sourceType) {
      reasons.push(`触发字段「${source.label}」类型由 ${rule.sourceType} 变为 ${source.type}`);
    }
    if (!target) reasons.push(`目标字段「${rule.targetId}」已被移除`);
    else if (rule.targetType && target.type !== rule.targetType) {
      reasons.push(`目标字段「${target.label}」类型由 ${rule.targetType} 变为 ${target.type}`);
    }
    if (reasons.length) return { ...rule, status: 'invalid', invalidReason: reasons.join('；') };
    return { ...rule, status: 'active', invalidReason: undefined };
  });
}

export interface VersionDiff {
  added: FormField[];
  removed: FormField[];
  typeChanged: { field: FormField; from: FieldType }[];
  invalidRules: LinkRule[];
}

export function diffVersions(base: FormVersion, target: FormVersion): VersionDiff {
  const added = target.fields.filter((field) => !fieldById(base.fields, field.id));
  const removed = base.fields.filter((field) => !fieldById(target.fields, field.id));
  const typeChanged = target.fields
    .map((field) => ({ field, from: fieldById(base.fields, field.id)?.type }))
    .filter((item): item is { field: FormField; from: FieldType } => Boolean(item.from) && item.from !== item.field.type);
  const invalidRules = recomputeRules(target.rules, target.fields).filter((rule) => rule.status === 'invalid');
  return { added, removed, typeChanged, invalidRules };
}

// 按字段类型校验并归一化值。
export function coerceValue(field: FormField, raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (raw === '' || raw === null || raw === undefined) return { ok: true, value: '' };
  switch (field.type) {
    case 'number': {
      const num = Number(raw);
      if (Number.isNaN(num)) return { ok: false, reason: `「${raw}」不是有效数字` };
      return { ok: true, value: String(num) };
    }
    case 'select': {
      if (field.options && !field.options.includes(raw)) {
        return { ok: false, reason: `「${raw}」不在可选项 [${field.options.join(' / ')}] 中` };
      }
      return { ok: true, value: raw };
    }
    default:
      return { ok: true, value: raw };
  }
}

export interface BackfillResult {
  status: 'done' | 'pending' | 'failed';
  backfilled: Record<string, string>;
  pending: PendingField[];
  failureReason?: string;
}

// 把快照从源版本升级到目标版本：能映射的回填，映射不了的列入待补。
// 目标版本存在失效规则时回填失败（校验无法保证），留住未完成快照待修复后重试。
export function upgradeSnapshot(
  snapshot: Snapshot,
  sourceVersion: FormVersion,
  targetVersion: FormVersion
): BackfillResult {
  const targetRules = recomputeRules(targetVersion.rules, targetVersion.fields);
  const invalid = targetRules.filter((rule) => rule.status === 'invalid');
  if (invalid.length) {
    return {
      status: 'failed',
      backfilled: { ...(snapshot.backfilled ?? {}) },
      pending: [],
      failureReason: `目标版本存在 ${invalid.length} 条失效规则，金额/资质校验无法保证：${invalid
        .map((rule) => rule.invalidReason)
        .join('；')}。请先修复规则后重试。`
    };
  }

  const backfilled: Record<string, string> = {};
  const pending: PendingField[] = [];
  for (const targetField of targetVersion.fields) {
    const sourceField = fieldById(sourceVersion.fields, targetField.id);
    if (!sourceField) {
      pending.push({ fieldId: targetField.id, label: targetField.label, reason: '新增字段，旧快照无来源' });
      continue;
    }
    if (sourceField.type !== targetField.type) {
      pending.push({
        fieldId: targetField.id,
        label: targetField.label,
        reason: `字段类型由 ${sourceField.type} 变为 ${targetField.type}，需人工确认`
      });
      continue;
    }
    const raw = snapshot.data[targetField.id] ?? '';
    const coerced = coerceValue(targetField, raw);
    if (!coerced.ok) {
      pending.push({ fieldId: targetField.id, label: targetField.label, reason: coerced.reason ?? '值不合法' });
      continue;
    }
    if (coerced.value !== '') backfilled[targetField.id] = coerced.value;
  }

  return { status: pending.length ? 'pending' : 'done', backfilled, pending };
}

// 联动条件求值。
export function evalRule(rule: LinkRule, data: Record<string, string>): boolean {
  const value = data[rule.fieldId] ?? '';
  if (rule.operator === 'equals') return value === rule.value;
  return value !== '';
}

// 运行态校验：必填 + 类型 + 联动规则（show/require）。
export function validateRuntime(
  version: FormVersion,
  data: Record<string, string>
): Record<string, string> {
  const errors: Record<string, string> = {};
  const activeRules = recomputeRules(version.rules, version.fields).filter((rule) => rule.status === 'active');

  for (const field of version.fields) {
    const raw = data[field.id] ?? '';
    const coerced = coerceValue(field, raw);
    if (!coerced.ok) {
      errors[field.id] = coerced.reason ?? '值不合法';
      continue;
    }
    if (field.required && raw === '') errors[field.id] = `${field.label} 不能为空`;
  }

  for (const rule of activeRules) {
    if (!evalRule(rule, data)) continue;
    const target = fieldById(version.fields, rule.targetId);
    if (!target) continue;
    if (rule.effect === 'require' && (data[rule.targetId] ?? '') === '') {
      errors[rule.targetId] = `${target.label} 因「${rule.fieldId} ${
        rule.operator === 'equals' ? `等于 ${rule.value}` : '非空'
      }」变为必填`;
    }
  }
  return errors;
}
