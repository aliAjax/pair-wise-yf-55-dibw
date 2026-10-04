// 共享业务类型：字段、联动规则、版本、快照按版本协同。

export type FieldType = 'text' | 'number' | 'select' | 'date';
export const FIELD_TYPES: FieldType[] = ['text', 'number', 'select', 'date'];
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: '文本',
  number: '数字',
  select: '下拉选择',
  date: '日期'
};

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export type RuleOperator = 'equals' | 'notEmpty';
export type RuleEffect = 'show' | 'require';
export type RuleStatus = 'active' | 'invalid';

export interface LinkRule {
  id: string;
  fieldId: string; // 触发字段
  operator: RuleOperator;
  value: string;
  effect: RuleEffect;
  targetId: string; // 目标字段
  // 规则定义时记录的字段类型，用于发布/字段变更时判定类型变化导致的失效。
  sourceType?: FieldType;
  targetType?: FieldType;
  status?: RuleStatus;
  invalidReason?: string;
}

export interface FormVersion {
  id: string;
  label: string;
  createdAt: string;
  // 乐观并发版本号：每有一条正式快照入库就 +1，后提交者据此识别冲突。
  revision: number;
  fields: FormField[];
  rules: LinkRule[];
  baseVersionId?: string;
}

export type SnapshotStatus = 'official' | 'draft';
// none 未升级 / done 已完成 / pending 部分回填待补 / failed 回填失败待重试
export type UpgradeStatus = 'none' | 'done' | 'pending' | 'failed';

export interface PendingField {
  fieldId: string;
  label: string;
  reason: string;
}

export interface Snapshot {
  id: string;
  versionId: string; // 快照按提交时的版本解释
  label: string;
  operator?: string;
  data: Record<string, string>;
  status: SnapshotStatus;
  conflict?: boolean;
  conflictReason?: string;
  expectedRevision?: number;
  // 升级回填状态
  upgradeStatus: UpgradeStatus;
  upgradedTo?: string;
  backfilled?: Record<string, string>;
  pendingFields?: PendingField[];
  failureReason?: string;
}

export interface SchemaState {
  versions: FormVersion[];
  rules: LinkRule[];
  activeVersionId: string;
  previewVersionId: string;
  snapshots: Snapshot[];
}
