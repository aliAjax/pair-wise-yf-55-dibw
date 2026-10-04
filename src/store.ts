import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  autoMappings,
  convertible,
  diffFields,
  evaluateMappings,
  recomputeRules,
  type CalcRule,
  type FieldConflict,
  type FieldMapping,
  type FieldType,
  type FormField,
  type FormVersion,
  type LinkRule,
  type MigrationTask,
} from './engine';

export type { FieldType, FormField, FormVersion, LinkRule, CalcRule, MigrationTask };

export interface Snapshot {
  id: string;
  versionId: string;
  label: string;
  operator: string;
  submittedAt: string;
  /** 原始键值冻结保存；解释永远按 versionId 指向的版本 */
  data: Record<string, string>;
}

export interface Draft {
  id: string;
  operator: string;
  label: string;
  /** 草稿所基于的已发布版本 id */
  baseVersionId: string;
  /** 基线发布序号，提交时做乐观锁 */
  baseRevision: number;
  fields: FormField[];
  rules: LinkRule[];
  calcRules: CalcRule[];
  status: 'editing' | 'conflict';
  conflict?: {
    liveVersionId: string;
    liveRevision: number;
    fields: FieldConflict[];
    /** 对方提交时的时间，便于展示「谁先生效」 */
    publishedAt: string;
  };
  updatedAt: string;
}

export interface SubmissionRecord {
  id: string;
  versionId: string;
  operator: string;
  data: Record<string, string | number>;
  submittedAt: string;
}

interface SchemaState {
  versions: FormVersion[];
  activeVersionId: string;
  snapshots: Snapshot[];
  submissions: SubmissionRecord[];
  drafts: Draft[];
  migrations: MigrationTask[];
  /** 模拟回填接口失败的开关：打开后下一次回填必失败 */
  failNextBackfill: boolean;
}

let seq = 100;
export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
// Immer draft 是代理对象，structuredClone 会抛 DataCloneError；业务数据均为 JSON 可序列化结构
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const v1: FormVersion = {
  id: 'v1', label: '展会报名 2026-08', createdAt: '2026-08-01', revision: 1,
  fields: [
    { id: 'company', label: '参展公司', type: 'text', required: true },
    { id: 'contact', label: '联系人', type: 'text', required: true },
    { id: 'level', label: '参展资质', type: 'select', required: true, options: ['A级', 'B级'] },
    { id: 'amount', label: '申请金额(元)', type: 'number', required: true },
    { id: 'area', label: '展位面积(㎡)', type: 'number', required: true },
  ],
  rules: [
    { id: 'v1-r1', fieldId: 'level', operator: 'equals', value: 'B级', effect: 'require', targetId: 'amount', status: { kind: 'active' } },
  ],
  calcRules: [
    { id: 'v1-c1', targetId: 'amount', inputs: ['area'], op: 'multiply', status: { kind: 'active' } },
  ],
  publishedBroken: [],
};

const v2: FormVersion = {
  id: 'v2', label: '展会报名 2026-09', createdAt: '2026-09-28', revision: 2,
  fields: [
    { id: 'company', label: '参展公司', type: 'text', required: true },
    { id: 'contact', label: '联系人', type: 'text', required: true },
    { id: 'phone', label: '联系电话', type: 'text', required: true },
    { id: 'level', label: '参展资质', type: 'select', required: true, options: ['A级', 'B级', 'C级'] },
    { id: 'certNo', label: '资质证书编号', type: 'text', required: false },
    { id: 'area', label: '展位面积(㎡)', type: 'number', required: true },
    { id: 'unitPrice', label: '展位单价(元/㎡)', type: 'number', required: true },
    { id: 'amount', label: '申请金额(元)', type: 'number', required: true },
    { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false },
  ],
  rules: [
    // 资质校验：C 级必须填证书编号（C 级是本月新增选项）
    { id: 'v2-r1', fieldId: 'level', operator: 'equals', value: 'C级', effect: 'require', targetId: 'certNo', status: { kind: 'active' } },
    // 金额联动：金额非空才显示开票日期
    { id: 'v2-r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate', status: { kind: 'active' } },
  ],
  calcRules: [
    // 金额计算：面积 × 单价
    { id: 'v2-c1', targetId: 'amount', inputs: ['area', 'unitPrice'], op: 'multiply', status: { kind: 'active' } },
  ],
  publishedBroken: [],
};

const initial: SchemaState = {
  versions: [v1, v2],
  activeVersionId: 'v2',
  snapshots: [
    { id: 's1', versionId: 'v1', label: '八月展会 · 星辰科技', operator: '运营甲', submittedAt: '2026-08-12 10:20', data: { company: '星辰科技', contact: '王敏', level: 'B级', area: '12', amount: '14400' } },
    { id: 's2', versionId: 'v1', label: '八月展会 · 蓝湾贸易', operator: '运营乙', submittedAt: '2026-08-20 15:02', data: { company: '蓝湾贸易', contact: '李晨', level: 'A级', area: '9', amount: '10800' } },
  ],
  submissions: [],
  drafts: [],
  migrations: [],
  failNextBackfill: false,
};

interface NewFieldPayload { draftId: string; label?: string; type?: FieldType }
interface UpdateFieldPayload { draftId: string; fieldId: string; patch: Partial<FormField> }
interface RemoveFieldPayload { draftId: string; fieldId: string }
interface ReorderPayload { draftId: string; activeId: string; overId: string }
interface AddRulePayload { draftId: string; rule: Omit<LinkRule, 'id' | 'status'> }
interface RemoveRulePayload { draftId: string; ruleId: string }
interface RebindRulePayload { draftId: string; ruleId: string; patch: Partial<Pick<LinkRule, 'fieldId' | 'targetId' | 'operator' | 'value' | 'effect'>> }

const slice = createSlice({
  name: 'schema',
  initialState: initial,
  reducers: {
    resetAll() {
      return clone(initial);
    },

    startDraft(state, action: PayloadAction<{ operator: string; baseVersionId?: string }>) {
      const baseId = action.payload.baseVersionId ?? state.activeVersionId;
      const base = state.versions.find((v) => v.id === baseId);
      if (!base) return;
      // 同一运营基于同一版本只保留一份编辑中草稿（冲突草稿除外，用于复盘）
      const existing = state.drafts.find((d) => d.operator === action.payload.operator && d.baseVersionId === base.id && d.status === 'editing');
      if (existing) return;
      state.drafts.push({
        id: uid('draft'),
        operator: action.payload.operator,
        label: `${base.label} · 改版草稿`,
        baseVersionId: base.id,
        baseRevision: base.revision,
        fields: clone(base.fields),
        rules: clone(base.rules),
        calcRules: clone(base.calcRules),
        status: 'editing',
        updatedAt: new Date().toISOString(),
      });
    },

    removeDraft(state, action: PayloadAction<string>) {
      state.drafts = state.drafts.filter((d) => d.id !== action.payload);
    },

    addField(state, action: PayloadAction<NewFieldPayload>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      draft.fields.push({
        id: uid('field'),
        label: action.payload.label ?? '新字段',
        type: action.payload.type ?? 'text',
        required: false,
      });
      draft.updatedAt = new Date().toISOString();
    },

    updateField(state, action: PayloadAction<UpdateFieldPayload>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      const field = draft.fields.find((f) => f.id === action.payload.fieldId);
      if (!field) return;
      Object.assign(field, action.payload.patch);
      // 字段改名不影响引用；改类型 / 选项 / 删除都要让引用它的规则失效重算
      recomputeRules(draft);
      draft.updatedAt = new Date().toISOString();
    },

    removeField(state, action: PayloadAction<RemoveFieldPayload>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      draft.fields = draft.fields.filter((f) => f.id !== action.payload.fieldId);
      recomputeRules(draft);
      draft.updatedAt = new Date().toISOString();
    },

    reorderFields(state, action: PayloadAction<ReorderPayload>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      const from = draft.fields.findIndex((f) => f.id === action.payload.activeId);
      const to = draft.fields.findIndex((f) => f.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = draft.fields.splice(from, 1);
      draft.fields.splice(to, 0, moved);
    },

    addRule(state, action: PayloadAction<AddRulePayload>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      draft.rules.push({ ...clone(action.payload.rule), id: uid('rule'), status: { kind: 'active' } });
      recomputeRules(draft);
      draft.updatedAt = new Date().toISOString();
    },

    removeRule(state, action: PayloadAction<RemoveRulePayload>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      draft.rules = draft.rules.filter((r) => r.id !== action.payload.ruleId);
      draft.calcRules = draft.calcRules.filter((r) => r.id !== action.payload.ruleId);
      draft.updatedAt = new Date().toISOString();
    },

    /** 修复失效规则：重新绑定字段或修改条件后重算 */
    rebindRule(state, action: PayloadAction<RebindRulePayload>) {
      const draft = state.drafts.find((d) => d.id === action.payload.draftId);
      if (!draft) return;
      const rule = draft.rules.find((r) => r.id === action.payload.ruleId);
      if (rule) Object.assign(rule, action.payload.patch);
      recomputeRules(draft);
      draft.updatedAt = new Date().toISOString();
    },

    /**
     * 提交草稿。乐观锁：基线版本仍是当前最新版本 → 先生效入库；
     * 期间已有别人提交 → 后提交者保留为草稿并看到冲突。
     */
    commitDraft(state, action: PayloadAction<string>) {
      const draft = state.drafts.find((d) => d.id === action.payload);
      if (!draft || draft.status === 'conflict') return;
      const latest = state.versions.reduce((a, b) => (b.revision > a.revision ? b : a));

      if (draft.baseRevision === latest.revision && draft.baseVersionId === latest.id) {
        recomputeRules(draft);
        const revision = latest.revision + 1;
        const id = `v${revision}`;
        const publishedBroken = [
          ...draft.rules.filter((r) => r.status.kind === 'broken').map((r) => ({ ruleId: r.id, reason: (r.status as { kind: 'broken'; reason: string }).reason })),
          ...draft.calcRules.filter((r) => r.status.kind === 'broken').map((r) => ({ ruleId: r.id, reason: (r.status as { kind: 'broken'; reason: string }).reason })),
        ];
        const version: FormVersion = {
          id,
          label: `展会报名 版本${revision}`,
          createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
          revision,
          fields: clone(draft.fields),
          rules: clone(draft.rules),
          calcRules: clone(draft.calcRules),
          publishedBroken,
        };
        state.versions.push(version);
        state.activeVersionId = id;
        state.drafts = state.drafts.filter((d) => d.id !== draft.id);
        return;
      }

      // 后入库：保草稿，标记冲突
      draft.status = 'conflict';
      draft.conflict = {
        liveVersionId: latest.id,
        liveRevision: latest.revision,
        fields: diffFields(draft.fields, latest.fields),
        publishedAt: latest.createdAt,
      };
      draft.updatedAt = new Date().toISOString();
    },

    /** 冲突后基于最新版本重建草稿：保留自己新增的字段，失效规则重算后继续修 */
    rebaseDraft(state, action: PayloadAction<string>) {
      const draft = state.drafts.find((d) => d.id === action.payload);
      if (!draft || draft.status !== 'conflict' || !draft.conflict) return;
      const latest = state.versions.find((v) => v.id === draft.conflict!.liveVersionId);
      if (!latest) return;

      const mergedFields = clone(latest.fields);
      // 草稿里独有的新增字段保留；同 id 以已生效版本为准（冲突以对方为准，避免覆盖先入库数据）
      for (const field of draft.fields) {
        if (!latest.fields.some((f) => f.id === field.id)) mergedFields.push(clone(field));
      }
      // 规则以最新版本为底，再叠加草稿独有规则
      const mergedRules = clone(latest.rules);
      for (const rule of draft.rules) {
        if (!latest.rules.some((r) => r.id === rule.id)) mergedRules.push(clone(rule));
      }
      const mergedCalc = clone(latest.calcRules);
      for (const rule of draft.calcRules) {
        if (!latest.calcRules.some((r) => r.id === rule.id)) mergedCalc.push(clone(rule));
      }

      draft.baseVersionId = latest.id;
      draft.baseRevision = latest.revision;
      draft.fields = mergedFields;
      draft.rules = mergedRules;
      draft.calcRules = mergedCalc;
      draft.status = 'editing';
      draft.conflict = undefined;
      recomputeRules(draft);
      draft.updatedAt = new Date().toISOString();
    },

    // ---------- 快照迁移 ----------

    startMigration(state, action: PayloadAction<{ snapshotId: string; targetVersionId?: string }>) {
      const snapshot = state.snapshots.find((s) => s.id === action.payload.snapshotId);
      if (!snapshot) return;
      const targetId = action.payload.targetVersionId ?? state.activeVersionId;
      const source = state.versions.find((v) => v.id === snapshot.versionId);
      const target = state.versions.find((v) => v.id === targetId);
      if (!source || !target) return;
      const mappings = autoMappings(source, target);
      // 发起升级即算出回填计划：能映射的标记可回填，映射不了的立刻列出待补
      const plan = evaluateMappings({ mappings }, snapshot.data, source, target);
      const task: MigrationTask = {
        id: uid('mig'),
        snapshotId: snapshot.id,
        sourceVersionId: source.id,
        targetVersionId: target.id,
        mappings,
        backfilled: {},
        pending: plan.pending,
        // 初始一律待回填：即使没有待补项，也要点一次「执行回填」才入库
        status: 'pending_backfill',
        attempts: 0,
        createdAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      };
      state.migrations.unshift(task);
    },

    /** 运营手动改映射：改完立刻按当前映射重算可回填计划与待补清单（保留已回填数据和补录值） */
    remapField(state, action: PayloadAction<{ taskId: string; targetId: string; sourceId: string | null }>) {
      const task = state.migrations.find((t) => t.id === action.payload.taskId);
      if (!task || task.status === 'done') return;
      const { targetId, sourceId } = action.payload;
      task.mappings = task.mappings.filter((m) => m.targetId !== targetId);
      if (sourceId) {
        const source = state.versions.find((v) => v.id === task.sourceVersionId);
        const target = state.versions.find((v) => v.id === task.targetVersionId);
        const sf = source?.fields.find((f) => f.id === sourceId);
        const tf = target?.fields.find((f) => f.id === targetId);
        task.mappings.push({
          sourceId,
          targetId,
          compatible: sf && tf ? convertible(sf.type, tf.type) : false,
        });
      }
      // 换了映射来源后，旧的回填值/补录值作废，避免张冠李戴
      delete task.backfilled[targetId];
      recomputePlan(state, task);
      task.lastError = undefined;
      if (task.status === 'failed') task.status = 'pending_backfill';
    },

    /** 补录待补字段的值（仅记录，下一次回填时按类型校验后入库） */
    supplyPending(state, action: PayloadAction<{ taskId: string; targetId: string; value: string }>) {
      const task = state.migrations.find((t) => t.id === action.payload.taskId);
      if (!task || task.status === 'done') return;
      const item = task.pending.find((p) => p.targetId === action.payload.targetId);
      if (item) item.supplied = action.payload.value;
    },

    /**
     * 回填（含重试）。失败时保留未完成快照、已回填数据和补录值，状态 failed，可继续重试。
     */
    runBackfill(state, action: PayloadAction<{ taskId: string }>) {
      const task = state.migrations.find((t) => t.id === action.payload.taskId);
      if (!task || task.status === 'done') return;
      const snapshot = state.snapshots.find((s) => s.id === task.snapshotId);
      const source = state.versions.find((v) => v.id === task.sourceVersionId);
      const target = state.versions.find((v) => v.id === task.targetVersionId);
      if (!snapshot || !source || !target) return;

      task.attempts += 1;

      // 模拟回填接口失败：开关打开时本次失败，随后自动复位（重试即可成功）。
      // 失败前不动任何数据，未完成快照原样留住。
      if (state.failNextBackfill) {
        state.failNextBackfill = false;
        task.status = 'failed';
        task.lastError = '回填服务超时（模拟），已保留已回填数据与补录值，可重试';
        return;
      }

      // 1) 先按最新映射重算自动回填计划（字段可能在期间又被改动）
      recomputePlan(state, task);

      // 2) 自动映射可回填的值入库
      const plan = evaluateMappings(task, snapshot.data, source, target);
      task.backfilled = { ...task.backfilled, ...plan.backfilled };

      // 3) 运营补录的值按目标字段类型校验后入库；类型非法的继续留在待补
      for (const item of task.pending) {
        if (!item.targetId || item.supplied === undefined || item.supplied === '') continue;
        const field = target.fields.find((f) => f.id === item.targetId);
        if (!field) continue;
        if (field.type === 'number') {
          const n = Number(item.supplied);
          if (!Number.isFinite(n)) continue;
          task.backfilled[field.id] = n;
        } else if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}/.test(item.supplied)) {
          continue;
        } else {
          task.backfilled[field.id] = item.supplied;
        }
      }

      // 4) 已入库的字段移出待补（补录值保留以便复现）
      task.pending = task.pending.filter((p) => p.targetId === null || !(p.targetId in task.backfilled));

      if (task.pending.length > 0) {
        task.status = 'pending_backfill';
        task.lastError = undefined;
      } else {
        task.status = 'done';
        task.lastError = undefined;
      }
    },

    setFailNextBackfill(state, action: PayloadAction<boolean>) {
      state.failNextBackfill = action.payload;
    },

    dismissMigration(state, action: PayloadAction<string>) {
      state.migrations = state.migrations.filter((m) => m.id !== action.payload);
    },

    // ---------- 运行态提交 ----------

    recordSubmission(state, action: PayloadAction<{ versionId: string; operator: string; data: Record<string, string | number> }>) {
      state.submissions.unshift({
        id: uid('sub'),
        versionId: action.payload.versionId,
        operator: action.payload.operator,
        data: action.payload.data,
        submittedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      });
      // 运行态提交同样冻结为按该版本解释的快照
      const version = state.versions.find((v) => v.id === action.payload.versionId);
      if (version) {
        state.snapshots.unshift({
          id: uid('s'),
          versionId: version.id,
          label: `${version.label} · ${String(action.payload.data.company ?? action.payload.operator)}`,
          operator: action.payload.operator,
          submittedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
          data: Object.fromEntries(Object.entries(action.payload.data).map(([k, v]) => [k, String(v)])),
        });
      }
    },

    replaceState(_state, action: PayloadAction<SchemaState>) {
      const next = action.payload;
      // 重开后对待修复规则重新计算一次，保证状态一致
      for (const draft of next.drafts) recomputeRules(draft);
      return next;
    },
  },
});

/**
 * 按当前映射重算待补清单：保留运营已补录的值；改了映射后能自动回填的字段从待补移除。
 */
function recomputePlan(state: SchemaState, task: MigrationTask) {
  const snapshot = state.snapshots.find((s) => s.id === task.snapshotId);
  const source = state.versions.find((v) => v.id === task.sourceVersionId);
  const target = state.versions.find((v) => v.id === task.targetVersionId);
  if (!snapshot || !source || !target) return;
  const plan = evaluateMappings(task, snapshot.data, source, target);
  task.pending = plan.pending
    .filter((p) => p.targetId === null || !(p.targetId in plan.backfilled))
    .map((p) => {
      const previous = task.pending.find((q) => q.targetId === p.targetId);
      return previous?.supplied !== undefined ? { ...p, supplied: previous.supplied } : p;
    });
}

export const {
  resetAll,
  startDraft,
  removeDraft,
  addField,
  updateField,
  removeField,
  reorderFields,
  addRule,
  removeRule,
  rebindRule,
  commitDraft,
  rebaseDraft,
  startMigration,
  remapField,
  supplyPending,
  runBackfill,
  setFailNextBackfill,
  dismissMigration,
  recordSubmission,
  replaceState,
} = slice.actions;

export const store = configureStore({ reducer: { schema: slice.reducer } });

const STORAGE_KEY = 'yf55-expo-schema-state-v2';
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
    } catch {
      /* 旧缓存不兼容时忽略 */
    }
  }
  store.subscribe(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify((store.getState() as RootState).schema));
  });
}

export type RootState = { schema: SchemaState };
