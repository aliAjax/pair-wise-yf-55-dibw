import {
  autoMappings, diffFields, evalCalcs, evalCondition, evaluateMappings, interpretSnapshot,
  linkRuleStatus, recomputeRules, validateSubmission, visibleFields,
  type FormVersion, type LinkRule, type MigrationTask,
} from '../src/engine';

let pass = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else { pass++; console.log('PASS:', msg); } };

// ---------- v1 / v2 种子（与 store 一致的最小副本） ----------
const v1: FormVersion = {
  id: 'v1', label: 'v1', createdAt: '', revision: 1,
  fields: [
    { id: 'company', label: '公司', type: 'text', required: true },
    { id: 'contact', label: '联系人', type: 'text', required: true },
    { id: 'level', label: '资质', type: 'select', required: true, options: ['A级', 'B级'] },
    { id: 'amount', label: '金额', type: 'number', required: true },
    { id: 'area', label: '面积', type: 'number', required: true },
  ],
  rules: [{ id: 'r1', fieldId: 'level', operator: 'equals', value: 'B级', effect: 'require', targetId: 'amount', status: { kind: 'active' } }],
  calcRules: [{ id: 'c1', targetId: 'amount', inputs: ['area'], op: 'multiply', status: { kind: 'active' } }],
  publishedBroken: [],
};

const v2: FormVersion = {
  id: 'v2', label: 'v2', createdAt: '', revision: 2,
  fields: [
    { id: 'company', label: '公司', type: 'text', required: true },
    { id: 'contact', label: '联系人', type: 'text', required: true },
    { id: 'phone', label: '电话', type: 'text', required: true },
    { id: 'level', label: '资质', type: 'select', required: true, options: ['A级', 'B级', 'C级'] },
    { id: 'certNo', label: '证书编号', type: 'text', required: false },
    { id: 'area', label: '面积', type: 'number', required: true },
    { id: 'unitPrice', label: '单价', type: 'number', required: true },
    { id: 'amount', label: '金额', type: 'number', required: true },
    { id: 'invoiceDate', label: '开票日期', type: 'date', required: false },
  ],
  rules: [
    { id: 'r1', fieldId: 'level', operator: 'equals', value: 'C级', effect: 'require', targetId: 'certNo', status: { kind: 'active' } },
    { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate', status: { kind: 'active' } },
  ],
  calcRules: [{ id: 'c1', targetId: 'amount', inputs: ['area', 'unitPrice'], op: 'multiply', status: { kind: 'active' } }],
  publishedBroken: [],
};

// ========== 诉求1：字段移走/改类型 → 引用规则失效重算 ==========
const draft: FormVersion = structuredClone(v2);
// 模拟：金额字段 amount 被改成文本类型（资质/金额校验对不上的根因）
draft.fields.find((f) => f.id === 'amount')!.type = 'text';
recomputeRules(draft);
ok(draft.rules.find((r) => r.id === 'r2')!.status.kind === 'active', '不引用 amount 的证书规则不受影响');
// r2 引用 amount 做 notEmpty —— notEmpty 对 text 仍有效；再把 amount 移走
draft.fields = draft.fields.filter((f) => f.id !== 'amount');
recomputeRules(draft);
ok(draft.rules.find((r) => r.id === 'r2')!.status.kind === 'broken', '金额字段移走后「金额非空才显示」规则失效');
ok((draft.rules.find((r) => r.id === 'r2')!.status as { reason: string }).reason.includes('条件字段已移走'), '失效原因指向被移走的条件字段');
ok(draft.calcRules[0].status.kind === 'broken', '金额计算规则引用被移走字段后失效');
// 目标字段移走
const r: LinkRule = { id: 'x', fieldId: 'level', operator: 'equals', value: 'C级', effect: 'require', targetId: 'ghost', status: { kind: 'active' } };
ok(linkRuleStatus(r, v2.fields).kind === 'broken', '目标字段不存在时规则失效');
// equals 用于 number 非法；gt 用于非 number 非法
ok(linkRuleStatus({ ...r, fieldId: 'amount', targetId: 'amount' } as LinkRule, v2.fields).kind === 'broken', '「等于」用于金额字段判失效');
ok(linkRuleStatus({ ...r, fieldId: 'company', operator: 'gt', value: '10', targetId: 'amount' } as LinkRule, v2.fields).kind === 'broken', '「大于」用于文本字段判失效');
// 选项移除导致 equals 失配
ok(linkRuleStatus({ ...r, fieldId: 'level', value: 'D级', targetId: 'certNo' }, v1.fields).kind === 'broken', '引用已删除选项的资质规则失效');

// ========== 诉求2：已提交快照按原版解释 ==========
const oldData = { company: '星辰科技', contact: '王敏', level: 'B级', area: '12', amount: '14400', futureKey: 'x' };
const interp = interpretSnapshot(v1, oldData);
ok(interp.fields.find((f) => f.fieldId === 'amount')!.value === 14400, '旧快照金额按 v1 解释为数字');
ok(interp.orphanKeys.includes('futureKey'), '原版本无定义的键标为游离键但不丢数据');
// v2 把 level 加了 C 级选项，旧数据解释不受影响
const interpV1Again = interpretSnapshot(v1, { level: 'B级' });
ok(interpV1Again.fields.find((f) => f.fieldId === 'level')!.value === 'B级', '旧 B 级资质在 v1 下永远合法，不被 v2 重解释');

// ========== 诉求：迁移自动映射 + 待补 ==========
const mappings = autoMappings(v1, v2);
ok(mappings.length === 5, `同名 5 个字段自动映射（实际 ${mappings.length}）`);
const task: MigrationTask = {
  id: 't1', snapshotId: 's1', sourceVersionId: 'v1', targetVersionId: 'v2',
  mappings, backfilled: {}, pending: [], status: 'pending_backfill', attempts: 0, createdAt: '',
};
const ev = evaluateMappings(task, oldData, v1, v2);
ok(ev.backfilled.amount === 14400, '同名字段金额回填');
ok(ev.backfilled.area === 12, '面积字符串转为数字回填');
const pendingIds = ev.pending.map((p) => p.targetId).sort();
ok(JSON.stringify(pendingIds) === JSON.stringify(['phone', 'unitPrice']), `新增必填字段电话/单价进入待补（实际 ${pendingIds.join(',')}）`);
// 不兼容映射：number(area) -> date(invoiceDate)
const incompatible = evaluateMappings(
  { mappings: [{ sourceId: 'area', targetId: 'invoiceDate', compatible: false }] },
  { area: '12' }, v1, v2,
);
ok(incompatible.pending.some((p) => p.targetId === 'invoiceDate'), 'number→date 不兼容列入待补');
// 可转换但值非法：text -> date
const badDate = evaluateMappings(
  { mappings: [{ sourceId: 'company', targetId: 'invoiceDate', compatible: true }] },
  { company: '星辰科技' }, v1, v2,
);
ok(badDate.pending.some((p) => p.reason.includes('不是合法日期')), 'text→date 值非法时给出原因并待补');

// ========== 诉求3：并发提交冲突 ==========
// v2 之后甲先发 v3，乙的草稿仍基于 revision 2
const v3: FormVersion = { ...structuredClone(v2), id: 'v3', revision: 3, fields: v2.fields.map((f) => f.id === 'amount' ? { ...f, type: 'text' } : f) };
const yiDraftFields = structuredClone(v2.fields); // 乙没动
const conflicts = diffFields(yiDraftFields, v3.fields);
ok(conflicts.some((c) => c.fieldId === 'amount' && c.kind === 'type_changed'), '乙提交时看到金额类型与已生效版本冲突');
// 乙删了 phone 但甲的 v3 保留
const yiRemovedPhone = yiDraftFields.filter((f) => f.id !== 'phone');
ok(diffFields(yiRemovedPhone, v3.fields).some((c) => c.kind === 'removed_vs_kept'), '草稿删除而对方保留 → 冲突');

// ========== 运行态：金额/资质校验一致 + 联动显隐 + 计算 ==========
// C级必须填证书编号
ok(!!validateSubmission(v2, { company: 'x', contact: 'y', phone: '1', level: 'C级', area: 12, unitPrice: 1000, amount: 12000 }).certNo, 'C级资质缺证书编号 → 报错');
ok(!validateSubmission(v2, { company: 'x', contact: 'y', phone: '1', level: 'C级', certNo: 'C-1', area: 12, unitPrice: 1000, amount: 12000 }).certNo, 'C级填了证书编号 → 通过');
// A级不需要证书编号
ok(!validateSubmission(v2, { company: 'x', contact: 'y', phone: '1', level: 'A级', area: 12, unitPrice: 1000, amount: 12000 }).certNo, 'A级不要求证书编号');
// 金额必须 > 0
ok(!!validateSubmission(v2, { company: 'x', contact: 'y', phone: '1', level: 'A级', area: 12, unitPrice: 1000, amount: 0 }).amount, '金额为 0 → 报错');
// 开票日期只有金额非空才显示
ok(!visibleFields(v2, { amount: '' }).some((f) => f.id === 'invoiceDate'), '金额为空时开票日期隐藏');
ok(visibleFields(v2, { amount: 100 }).some((f) => f.id === 'invoiceDate'), '金额非空时开票日期显示');
// 面积 × 单价 = 金额
const calcResult = evalCalcs(v2, { area: 12, unitPrice: 1200 });
ok(calcResult.values.amount === 14400, `金额自动计算 12×1200=14400（实际 ${calcResult.values.amount}）`);
// 循环依赖
const cyclic: FormVersion = {
  ...v2,
  calcRules: [
    { id: 'a', targetId: 'amount', inputs: ['area', 'unitPrice'], op: 'multiply', status: { kind: 'active' } },
    { id: 'b', targetId: 'unitPrice', inputs: ['amount'], op: 'multiply', status: { kind: 'active' } },
  ],
};
ok(evalCalcs(cyclic, { area: 2 }).cycles.length > 0, '计算规则循环依赖被检出');
// notEmpty 条件
ok(evalCondition(v2.rules[1], { amount: 1 }) === true, 'notEmpty 对数字非空成立');

// ========== 诉求4：真实 store —— 回填失败保留未完成快照 + 重试 + 并发提交 ==========
const { store } = await import('../src/store');
const storeActions = await import('../src/store');

store.dispatch(storeActions.resetAll());
store.dispatch(storeActions.startMigration({ snapshotId: 's1', targetVersionId: 'v2' }));
let s = store.getState().schema;
let taskState = s.migrations[0];
ok(taskState.status === 'pending_backfill', '迁移任务创建后为待回填状态');
ok(taskState.pending.map((p) => p.targetId).join() === 'phone,unitPrice', '电话和单价列为待补');

// 打开失败开关后执行回填 → failed，任务保留，尝试次数 +1
store.dispatch(storeActions.setFailNextBackfill(true));
store.dispatch(storeActions.runBackfill({ taskId: taskState.id }));
s = store.getState().schema;
taskState = s.migrations[0];
ok(taskState.status === 'failed', '回填失败后任务状态为 failed（未完成快照被留住）');
ok(!!taskState.lastError && taskState.attempts === 1, '记录失败原因与尝试次数');

// 补录一个待补项，直接重试（此时失败开关已自动复位）
store.dispatch(storeActions.supplyPending({ taskId: taskState.id, targetId: 'phone', value: '13800000000' }));
store.dispatch(storeActions.runBackfill({ taskId: taskState.id }));
s = store.getState().schema;
taskState = s.migrations[0];
ok(taskState.status === 'pending_backfill', '部分补齐后仍是待回填（未完成任务继续留住）');
ok(String(taskState.backfilled.phone) === '13800000000', '补录的电话已回填');
ok(taskState.backfilled.amount === 14400 && taskState.backfilled.area === 12, '自动映射的金额/面积一并回填');
ok(taskState.pending.map((p) => p.targetId).join() === 'unitPrice', '只剩单价待补');

// 再补单价 → 完成
store.dispatch(storeActions.supplyPending({ taskId: taskState.id, targetId: 'unitPrice', value: '1200' }));
store.dispatch(storeActions.runBackfill({ taskId: taskState.id }));
taskState = store.getState().schema.migrations[0];
ok(taskState.status === 'done' && taskState.backfilled.unitPrice === 1200, '待补补齐后重试回填完成');
ok(taskState.attempts === 3, `共 3 次尝试（失败→部分→完成，实际 ${taskState.attempts}）`);

// ---------- 并发提交：先入库生效，后提交保草稿看冲突 ----------
store.dispatch(storeActions.resetAll());
store.dispatch(storeActions.startDraft({ operator: '运营甲' }));
store.dispatch(storeActions.startDraft({ operator: '运营乙' }));
s = store.getState().schema;
const [draftA, draftB] = s.drafts;
// 甲把 amount 改成 text 后提交 → 先生效 v3
store.dispatch(storeActions.updateField({ draftId: draftA.id, fieldId: 'amount', patch: { type: 'text' } }));
store.dispatch(storeActions.commitDraft(draftA.id));
s = store.getState().schema;
ok(s.activeVersionId === 'v3' && s.versions.length === 3, '先提交的甲入库为 v3');
ok(s.drafts.find((d) => d.id === draftA.id) === undefined, '甲的草稿提交后移除');
// 乙再提交 → 保草稿 + 冲突
store.dispatch(storeActions.commitDraft(draftB.id));
s = store.getState().schema;
const bAfter = s.drafts.find((d) => d.id === draftB.id)!;
ok(bAfter.status === 'conflict', '后提交的乙保留为草稿并标记冲突');
ok(bAfter.conflict?.fields.some((c) => c.fieldId === 'amount' && c.kind === 'type_changed'), '乙看到金额类型冲突');
// 乙合并到最新版：amount 以甲的 text 为准；乙如果自己加过字段则保留
store.dispatch(storeActions.addField({ draftId: draftB.id, label: '乙的备注', type: 'text' }));
store.dispatch(storeActions.rebaseDraft(draftB.id));
s = store.getState().schema;
const bRebased = s.drafts.find((d) => d.id === draftB.id)!;
ok(bRebased.status === 'editing' && bRebased.baseRevision === 3, '合并后回到编辑态，基线升到序号 3');
ok(bRebased.fields.find((f) => f.id === 'amount')?.type === 'text', '金额类型以先生效的 v3 为准');
ok(bRebased.fields.some((f) => f.label === '乙的备注'), '乙独有的新增字段在合并后保留');

// ---------- 改类型导致规则失效，发布后存档，运行态跳过 ----------
store.dispatch(storeActions.resetAll());
store.dispatch(storeActions.startDraft({ operator: '运营甲' }));
const draftId = store.getState().schema.drafts[0].id;
store.dispatch(storeActions.removeField({ draftId, fieldId: 'certNo' }));
s = store.getState().schema;
const broken = s.drafts[0].rules.filter((r) => r.status.kind === 'broken');
ok(broken.some((r) => r.id === 'v2-r1'), '移走证书编号后 C 级资质规则失效（金额与资质校验不再错位执行）');
store.dispatch(storeActions.commitDraft(draftId));
s = store.getState().schema;
const v3broken = s.versions.find((v) => v.id === 'v3')!.publishedBroken;
ok(v3broken.length === 1, '发布时未修复的失效规则存档在版本上');

// ---------- 运行态提交冻结版本快照 ----------
store.dispatch(storeActions.recordSubmission({ versionId: 'v1', operator: '运营甲', data: { company: '测试', amount: 100 } }));
s = store.getState().schema;
const newSnap = s.snapshots[0];
ok(newSnap.versionId === 'v1', '运行态提交的快照冻结到提交时版本');

console.log(`\n${pass} 项断言全部通过`);
