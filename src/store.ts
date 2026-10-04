import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { recomputeRules, upgradeSnapshot } from './migration';
import type {
  FieldType,
  FormField,
  FormVersion,
  LinkRule,
  SchemaState,
  Snapshot
} from './types';

const initial: SchemaState = {
  activeVersionId: 'v2',
  previewVersionId: 'v2',
  versions: [
    {
      id: 'v1',
      label: '费用申请 v1',
      createdAt: '2026-08-12',
      revision: 0,
      fields: [
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'amount', label: '申请金额', type: 'number', required: true }
      ],
      rules: []
    },
    {
      id: 'v2',
      label: '费用申请 v2',
      createdAt: '2026-09-28',
      revision: 0,
      fields: [
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
        { id: 'amount', label: '申请金额', type: 'number', required: true },
        { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
      ],
      rules: [
        { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode', sourceType: 'select', targetType: 'text', status: 'active' },
        { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate', sourceType: 'number', targetType: 'date', status: 'active' }
      ]
    }
  ],
  rules: [],
  snapshots: [
    {
      id: 's1',
      versionId: 'v1',
      label: '八月培训预算',
      operator: '运营A',
      data: { name: '培训预算', department: '财务', amount: '12000' },
      status: 'official',
      upgradeStatus: 'none'
    },
    {
      id: 's2',
      versionId: 'v1',
      label: '市场活动费用',
      operator: '运营B',
      data: { name: '新品活动', department: '市场', amount: '58000' },
      status: 'official',
      upgradeStatus: 'none'
    }
  ]
};

// 预览草稿上的规则同样按当前字段重算状态。
function recomputePreview(state: SchemaState) {
  const version = state.versions.find((item) => item.id === state.previewVersionId);
  if (!version) return;
  version.rules = recomputeRules(version.rules, version.fields);
}

const slice = createSlice({
  name: 'schema',
  initialState: initial,
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const from = version.fields.findIndex((item) => item.id === action.payload.activeId);
      const to = version.fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = version.fields.splice(from, 1);
      version.fields.splice(to, 0, moved);
    },
    addField(state) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const id = `field-${Date.now()}`;
      version.fields.push({ id, label: '新字段', type: 'text', required: false });
    },
    updateField(state, action: PayloadAction<{ fieldId: string; patch: Partial<FormField> }>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const field = version.fields.find((item) => item.id === action.payload.fieldId);
      if (!field) return;
      Object.assign(field, action.payload.patch);
      recomputePreview(state);
    },
    removeField(state, action: PayloadAction<string>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      version.fields = version.fields.filter((item) => item.id !== action.payload);
      recomputePreview(state);
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id' | 'status' | 'invalidReason'>>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const rule: LinkRule = { ...action.payload, id: `rule-${Date.now()}` };
      version.rules.push(rule);
      recomputePreview(state);
    },
    removeRule(state, action: PayloadAction<string>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      version.rules = version.rules.filter((item) => item.id !== action.payload);
    },
    publishVersion(state) {
      const source = state.versions.find((item) => item.id === state.previewVersionId);
      if (!source) return;
      const id = `v${state.versions.length + 1}`;
      const clone: FormVersion = {
        ...structuredClone(source),
        id,
        label: `费用申请 ${id}`,
        createdAt: new Date().toISOString().slice(0, 10),
        revision: 0,
        baseVersionId: source.id
      };
      clone.rules = recomputeRules(clone.rules, clone.fields);
      state.versions.push(clone);
      state.activeVersionId = id;
      state.previewVersionId = id;
    },
    selectPreview(state, action: PayloadAction<string>) {
      state.previewVersionId = action.payload;
    },
    // 两个运营同时提交同一版本：先入库生效（official，revision+1），
    // 后一个因版本号不匹配存为草稿（draft）并标记冲突。
    submitSnapshot(
      state,
      action: PayloadAction<{ versionId: string; operator: string; label: string; data: Record<string, string>; expectedRevision: number }>
    ) {
      const version = state.versions.find((item) => item.id === action.payload.versionId);
      if (!version) return;
      const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const common = {
        id,
        versionId: version.id,
        label: action.payload.label,
        operator: action.payload.operator,
        data: action.payload.data,
        upgradeStatus: 'none' as const
      };
      if (version.revision === action.payload.expectedRevision) {
        version.revision += 1;
        state.snapshots.push({ ...common, status: 'official' });
      } else {
        const winner = [...state.snapshots]
          .reverse()
          .find((item) => item.versionId === version.id && item.status === 'official');
        state.snapshots.push({
          ...common,
          status: 'draft',
          conflict: true,
          expectedRevision: action.payload.expectedRevision,
          conflictReason: `运营 ${winner?.operator ?? '其他运营'} 已先提交同版本数据（当前版本号 ${version.revision}，本方提交时版本号 ${action.payload.expectedRevision}），本方保存为草稿。`
        });
      }
    },
    // 把快照升级到目标版本：能映射的回填，映射不了的列入待补；
    // 目标版本有失效规则时失败，留住未完成快照，修复后可重试。
    upgradeSnapshot(state, action: PayloadAction<{ snapshotId: string; targetVersionId: string }>) {
      const snapshot = state.snapshots.find((item) => item.id === action.payload.snapshotId);
      if (!snapshot) return;
      const source = state.versions.find((item) => item.id === snapshot.versionId);
      const target = state.versions.find((item) => item.id === action.payload.targetVersionId);
      if (!source || !target) return;
      const result = upgradeSnapshot(snapshot, source, target);
      snapshot.upgradeStatus = result.status;
      snapshot.upgradedTo = target.id;
      snapshot.backfilled = result.backfilled;
      snapshot.pendingFields = result.pending;
      snapshot.failureReason = result.failureReason;
    },
    replaceState(_state, action: PayloadAction<SchemaState>) {
      return action.payload;
    }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (versionId) => {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('yf55-schema-state');
        const saved = raw ? (JSON.parse(raw) as SchemaState) : initial;
        return { data: saved.versions.filter((item) => item.id !== versionId).slice(-3) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const {
  addField,
  addRule,
  publishVersion,
  reorderFields,
  removeField,
  removeRule,
  replaceState,
  selectPreview,
  submitSnapshot,
  updateField,
  upgradeSnapshot: upgradeSnapshotAction
} = slice.actions;

export const store = configureStore({
  reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer },
  middleware: (getDefault) => getDefault().concat(schemaApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf55-schema-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
  store.subscribe(() => localStorage.setItem('yf55-schema-state', JSON.stringify((store.getState() as { schema: SchemaState }).schema)));
}

export type RootState = { schema: SchemaState };
