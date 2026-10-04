// ============================================================
// 展会报名页 · 版本协同内核（纯函数）
// 职责：字段定义/联动规则校验与失效重算、快照按原版解释、
//      跨版本映射与迁移回填、并发提交冲突分析。
// ============================================================

export type FieldType = 'text' | 'number' | 'select' | 'date';

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export type RuleOperator = 'equals' | 'notEmpty' | 'gt';
export type RuleEffect = 'show' | 'require';

/** 联动 / 必填规则：申请金额与资质校验的条件都挂在这里 */
export interface LinkRule {
  id: string;
  /** 条件来源字段；字段被移走时规则失效 */
  fieldId: string;
  operator: RuleOperator;
  value: string;
  effect: RuleEffect;
  /** 生效目标字段；字段被移走或类型不匹配时规则失效 */
  targetId: string;
  /** 最近一次重算结果（由 recomputeRules 写入） */
  status: RuleStatus;
}

/** 计算规则：如「展位金额 = 面积 × 单价」 */
export interface CalcRule {
  id: string;
  targetId: string;
  inputs: string[];
  op: 'multiply';
  status: RuleStatus;
}

export type Rule = LinkRule | CalcRule;

export type RuleStatus =
  | { kind: 'active' }
  | { kind: 'broken'; reason: string };

export interface FormVersion {
  id: string;
  label: string;
  createdAt: string;
  /** 发布序号，乐观锁：同一 base 上并发提交靠它判定先后 */
  revision: number;
  fields: FormField[];
  rules: LinkRule[];
  calcRules: CalcRule[];
  /** 发布时仍未修复的规则，只作存档展示 */
  publishedBroken: { ruleId: string; reason: string }[];
}

// ---------- 规则失效重算 ----------

export function linkRuleStatus(rule: Omit<LinkRule, 'status'>, fields: FormField[]): RuleStatus {
  const source = fields.find((f) => f.id === rule.fieldId);
  if (!source) return { kind: 'broken', reason: `条件字段已移走（${rule.fieldId}）` };
  const target = fields.find((f) => f.id === rule.targetId);
  if (!target) return { kind: 'broken', reason: `目标字段已移走（${rule.targetId}）` };
  if (rule.operator === 'equals' && source.type === 'number')
    return { kind: 'broken', reason: `「等于」不能用于金额/数字字段 ${source.label}，请改用数值比较` };
  if (rule.operator === 'equals' && source.type === 'select' && source.options && !source.options.includes(rule.value))
    return { kind: 'broken', reason: `选项「${rule.value}」已不在 ${source.label} 的候选项中` };
  if (rule.operator === 'gt' && source.type !== 'number')
    return { kind: 'broken', reason: `「大于」只能用于金额/数字字段，${source.label} 是 ${source.type}` };
  if (rule.operator === 'gt' && target.type !== 'number')
    return { kind: 'broken', reason: `金额比较的目标 ${target.label} 不是金额/数字类型` };
  return { kind: 'active' };
}

export function calcRuleStatus(rule: Omit<CalcRule, 'status'>, fields: FormField[]): RuleStatus {
  const target = fields.find((f) => f.id === rule.targetId);
  if (!target) return { kind: 'broken', reason: `计算结果字段已移走（${rule.targetId}）` };
  if (target.type !== 'number') return { kind: 'broken', reason: `计算结果 ${target.label} 不再是金额/数字类型` };
  for (const inputId of rule.inputs) {
    const input = fields.find((f) => f.id === inputId);
    if (!input) return { kind: 'broken', reason: `被引用字段已移走（${inputId}）` };
    if (input.type !== 'number') return { kind: 'broken', reason: `被引用字段 ${input.label} 不是金额/数字类型` };
  }
  if (rule.inputs.length === 0) return { kind: 'broken', reason: '计算规则缺少被引用字段' };
  return { kind: 'active' };
}

/**
 * 字段移走 / 改类型后，引用它的规则全部失效重算。
 * 只改写 status，保留规则本身——运营在设计器里可以看到失效原因并修复。
 */
export function recomputeRules(version: { rules: LinkRule[]; calcRules: CalcRule[]; fields: FormField[] }) {
  // 只改写 status，保留规则本身——运营在设计器里可以看到失效原因并修复
  for (const rule of version.rules) rule.status = linkRuleStatus(rule, version.fields);
  for (const rule of version.calcRules) rule.status = calcRuleStatus(rule, version.fields);
}

export function isActive(rule: Rule): boolean {
  return rule.status.kind === 'active';
}

export const activeRules = (rules: Rule[]) => rules.filter(isActive);
export const brokenRules = (rules: Rule[]) => rules.filter((r) => r.status.kind === 'broken');

// ---------- 快照按原版解释 ----------

export type InterpretedValue = string | number | null;

/** 已提交快照永远按它提交时的版本解释，不随字段改名/改类型而变化 */
export function interpretValue(field: FormField, raw: unknown): InterpretedValue {
  if (raw === undefined || raw === null || raw === '') return null;
  if (field.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return String(raw);
}

export interface InterpretedField {
  fieldId: string;
  label: string;
  type: FieldType;
  value: InterpretedValue;
  /** 快照里存在、但原版本字段定义中已经找不到的键（不会出现在正常字段里） */
  orphan?: boolean;
}

export interface InterpretedSnapshot {
  fields: InterpretedField[];
  orphanKeys: string[];
}

export function interpretSnapshot(version: FormVersion | undefined, data: Record<string, unknown>): InterpretedSnapshot {
  const fields: InterpretedField[] = [];
  const known = new Set<string>();
  if (version) {
    for (const field of version.fields) {
      known.add(field.id);
      fields.push({ fieldId: field.id, label: field.label, type: field.type, value: interpretValue(field, data[field.id]) });
    }
  }
  const orphanKeys = Object.keys(data).filter((key) => !known.has(key));
  for (const key of orphanKeys) {
    fields.push({ fieldId: key, label: key, type: 'text', value: interpretValue({ id: key, label: key, type: 'text', required: false }, data[key]), orphan: true });
  }
  return { fields, orphanKeys };
}

// ---------- 跨版本映射与类型转换 ----------

/** text 源可尝试转出任意类型（值不合法则转换失败）；任意类型→text 合法；number/select/date 互转不兼容 */
export function convertible(from: FieldType, to: FieldType): boolean {
  if (from === to) return true;
  if (to === 'text') return true;
  if (from === 'text') return true;
  return false;
}

export function convertValue(raw: unknown, from: FieldType, to: FieldType): { ok: true; value: string | number } | { ok: false; reason: string } {
  if (!convertible(from, to)) return { ok: false, reason: `${from} 类型无法转换为 ${to}` };
  if (to === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    if (!Number.isFinite(n)) return { ok: false, reason: `「${String(raw)}」不是合法金额/数字` };
    return { ok: true, value: n };
  }
  if (to === 'select') {
    const v = String(raw ?? '').trim();
    if (!v) return { ok: false, reason: '空值无法转为单选项' };
    return { ok: true, value: v };
  }
  if (to === 'date') {
    const v = String(raw ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return { ok: false, reason: `「${v || '(空)'}」不是合法日期` };
    return { ok: true, value: v.slice(0, 10) };
  }
  return { ok: true, value: String(raw ?? '') };
}

/** 同名字段自动映射；目标版本新增的必填字段留给待补 */
export function autoMappings(source: FormVersion, target: FormVersion): FieldMapping[] {
  return target.fields
    .map((targetField) => {
      const sourceField = source.fields.find((f) => f.id === targetField.id);
      if (!sourceField) return null;
      return {
        sourceId: sourceField.id,
        targetId: targetField.id,
        compatible: convertible(sourceField.type, targetField.type),
      };
    })
    .filter((m): m is FieldMapping => m !== null);
}

export interface FieldMapping {
  sourceId: string;
  targetId: string;
  compatible: boolean;
}

export interface PendingItem {
  /** target field id；null 表示映射目标字段后来又被移走（悬挂映射） */
  targetId: string | null;
  label: string;
  reason: string;
  /** 运营补录的值 */
  supplied?: string;
}

export interface MigrationTask {
  id: string;
  snapshotId: string;
  sourceVersionId: string;
  targetVersionId: string;
  mappings: FieldMapping[];
  /** 已回填到新版本的数据（部分成功也保留，支持重试续跑） */
  backfilled: Record<string, string | number>;
  pending: PendingItem[];
  status: 'pending_backfill' | 'failed' | 'done';
  /** 最近一次回填失败原因（模拟回填接口失败） */
  lastError?: string;
  attempts: number;
  createdAt: string;
}

/** 评估映射：同类型自动回填；可转换的按值转换；不兼容/缺值/转换失败进入待补 */
export function evaluateMappings(task: Pick<MigrationTask, 'mappings'>, snapshotData: Record<string, unknown>, source: FormVersion, target: FormVersion) {
  const backfilled: Record<string, string | number> = {};
  const pending: PendingItem[] = [];

  for (const mapping of task.mappings) {
    const targetField = target.fields.find((f) => f.id === mapping.targetId);
    const sourceField = source.fields.find((f) => f.id === mapping.sourceId);
    if (!targetField) {
      pending.push({ targetId: null, label: mapping.targetId, reason: '目标字段在新版本中已被移走，映射悬挂' });
      continue;
    }
    if (!sourceField) {
      if (targetField.required) pending.push({ targetId: targetField.id, label: targetField.label, reason: '源版本没有对应字段' });
      continue;
    }
    const raw = snapshotData[mapping.sourceId];
    if (raw === undefined || raw === null || raw === '') {
      if (targetField.required) pending.push({ targetId: targetField.id, label: targetField.label, reason: `原快照中 ${sourceField.label} 为空` });
      continue;
    }
    if (!mapping.compatible) {
      pending.push({ targetId: targetField.id, label: targetField.label, reason: `${sourceField.type} 无法转换为 ${targetField.type}` });
      continue;
    }
    const result = convertValue(raw, sourceField.type, targetField.type);
    if (result.ok) {
      backfilled[targetField.id] = result.value;
    } else {
      pending.push({ targetId: targetField.id, label: targetField.label, reason: result.reason });
    }
  }

  // 目标版本新增、且没有任何映射覆盖的必填字段 → 待补
  const covered = new Set(task.mappings.map((m) => m.targetId));
  for (const field of target.fields) {
    if (field.required && !covered.has(field.id)) {
      pending.push({ targetId: field.id, label: field.label, reason: '新版本新增的必填字段，需要补录' });
    }
  }

  return { backfilled, pending };
}

// ---------- 运行态：条件求值 / 显隐 / 提交校验 ----------

export function evalCondition(rule: LinkRule, values: Record<string, unknown>): boolean {
  const raw = values[rule.fieldId];
  switch (rule.operator) {
    case 'equals':
      return String(raw ?? '') === rule.value;
    case 'notEmpty':
      return raw !== undefined && raw !== null && String(raw) !== '';
    case 'gt': {
      const n = Number(raw);
      const threshold = Number(rule.value);
      return Number.isFinite(n) && Number.isFinite(threshold) && n > threshold;
    }
  }
}

/** 存在命中的 show 规则才显示；没有 show 规则引用的字段默认显示 */
export function visibleFields(version: Pick<FormVersion, 'fields' | 'rules'>, values: Record<string, unknown>): FormField[] {
  return version.fields.filter((field) => {
    const showRules = version.rules.filter((r) => isActive(r) && r.effect === 'show' && r.targetId === field.id);
    if (showRules.length === 0) return true;
    return showRules.some((rule) => evalCondition(rule, values));
  });
}

/** 运行态校验：必填 + 命中的联动必填 + 金额/资质类型，返回错误表 */
export function validateSubmission(version: FormVersion, values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  const visible = new Set(visibleFields(version, values).map((f) => f.id));

  for (const field of version.fields) {
    if (!visible.has(field.id)) continue;
    const raw = values[field.id];
    const empty = raw === undefined || raw === null || raw === '';
    let required = field.required;
    if (!required) {
      required = version.rules.some(
        (r) => isActive(r) && r.effect === 'require' && r.targetId === field.id && evalCondition(r, values),
      );
    }
    if (required && empty) {
      errors[field.id] = `请填写${field.label}`;
      continue;
    }
    if (!empty && field.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) errors[field.id] = `${field.label} 必须是合法金额/数字`;
      else if (n <= 0) errors[field.id] = `${field.label} 必须大于 0`;
    }
    if (!empty && field.type === 'select' && field.options && !field.options.includes(String(raw))) {
      errors[field.id] = `${field.label} 的选项已失效，请重新选择`;
    }
  }
  return errors;
}

/** 计算规则按引用拓扑序求值；引用环标记出来 */
export function evalCalcs(version: Pick<FormVersion, 'calcRules' | 'fields'>, values: Record<string, number | string>): {
  values: Record<string, number>;
  cycles: string[];
} {
  const result: Record<string, number> = {};
  const rules = version.calcRules.filter(isActive);
  const byTarget = new Map(rules.map((r) => [r.targetId, r]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cycles: string[] = [];

  const resolve = (id: string): number | null => {
    if (done.has(id)) return result[id];
    if (id in values) {
      const n = Number(values[id]);
      if (Number.isFinite(n)) return n;
      return null;
    }
    const rule = byTarget.get(id);
    if (!rule) return null;
    if (visiting.has(id)) {
      cycles.push(id);
      return null;
    }
    visiting.add(id);
    let product = 1;
    let hasValue = false;
    for (const input of rule.inputs) {
      const v = resolve(input);
      if (v === null) { visiting.delete(id); return null; }
      product *= v;
      hasValue = true;
    }
    visiting.delete(id);
    if (!hasValue) return null;
    result[id] = product;
    done.add(id);
    return product;
  };

  for (const rule of rules) resolve(rule.targetId);
  return { values: result, cycles };
}

// ---------- 并发提交：冲突分析 ----------

export interface FieldConflict {
  fieldId: string;
  label: string;
  kind: 'removed_vs_kept' | 'type_changed' | 'required_changed' | 'options_changed';
  detail: string;
}

/** 后提交者的草稿 vs 已生效版本逐字段对比 */
export function diffFields(draftFields: FormField[], liveFields: FormField[]): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const draftField of draftFields) {
    const liveField = liveFields.find((f) => f.id === draftField.id);
    if (!liveField) {
      // 草稿删字段，但对方发布版本仍保留
      conflicts.push({ fieldId: draftField.id, label: draftField.label, kind: 'removed_vs_kept', detail: '你删除了该字段，但已生效版本仍在使用' });
      continue;
    }
    if (draftField.type !== liveField.type)
      conflicts.push({ fieldId: draftField.id, label: draftField.label, kind: 'type_changed', detail: `类型冲突：你改为 ${draftField.type}，已生效版本为 ${liveField.type}` });
    if (draftField.required !== liveField.required)
      conflicts.push({ fieldId: draftField.id, label: draftField.label, kind: 'required_changed', detail: `必填冲突：你设为${draftField.required ? '必填' : '选填'}，已生效版本为${liveField.required ? '必填' : '选填'}` });
    if (draftField.type === 'select' || liveField.type === 'select') {
      const a = draftField.options?.join('|') ?? '';
      const b = liveField.options?.join('|') ?? '';
      if (a !== b) conflicts.push({ fieldId: draftField.id, label: draftField.label, kind: 'options_changed', detail: '下拉选项与已生效版本不一致' });
    }
  }
  for (const liveField of liveFields) {
    if (!draftFields.some((f) => f.id === liveField.id)) {
      conflicts.push({ fieldId: liveField.id, label: liveField.label, kind: 'removed_vs_kept', detail: '已生效版本保留该字段，你的草稿已将其移走' });
    }
  }
  return conflicts;
}
