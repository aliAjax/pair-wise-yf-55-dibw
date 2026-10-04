import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  Grid,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Tooltip,
  Typography
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  addField,
  addRule,
  publishVersion,
  reorderFields,
  removeField,
  removeRule,
  selectPreview,
  submitSnapshot,
  updateField,
  upgradeSnapshotAction
} from './store';
import {
  diffVersions,
  evalRule,
  recomputeRules,
  validateRuntime
} from './migration';
import type { RootState } from './store';
import type {
  FieldType,
  FormField,
  FormVersion,
  LinkRule,
  Snapshot
} from './types';
import { FIELD_TYPES, FIELD_TYPE_LABEL } from './types';

/* ---------------- 字段编排 ---------------- */

function SortableFieldCard({ field }: { field: FormField }) {
  const dispatch = useDispatch();
  const sortable = useSortable({ id: field.id });
  return (
    <Card
      ref={sortable.setNodeRef}
      variant="outlined"
      sx={{ mb: 1, transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
    >
      <CardContent sx={{ py: '12px !important' }}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Button size="small" {...sortable.attributes} {...sortable.listeners}>
            拖拽
          </Button>
          <TextField
            size="small"
            label="字段名"
            value={field.label}
            onChange={(event) => dispatch(updateField({ fieldId: field.id, patch: { label: event.target.value } }))}
            sx={{ width: 140 }}
          />
          <TextField
            size="small"
            label="字段ID"
            value={field.id}
            disabled
            sx={{ width: 130 }}
            helperText="ID 不可变，规则按 ID 引用"
          />
          <FormControl size="small" sx={{ width: 120 }}>
            <InputLabel>类型</InputLabel>
            <Select
              label="类型"
              value={field.type}
              onChange={(event) =>
                dispatch(updateField({ fieldId: field.id, patch: { type: event.target.value as FieldType } }))
              }
            >
              {FIELD_TYPES.map((type) => (
                <MenuItem key={type} value={type}>
                  {FIELD_TYPE_LABEL[type]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControlLabel
            control={
              <Checkbox
                checked={field.required}
                onChange={(event) => dispatch(updateField({ fieldId: field.id, patch: { required: event.target.checked } }))}
              />
            }
            label="必填"
          />
          {field.type === 'select' && (
            <TextField
              size="small"
              label="可选项（逗号分隔）"
              value={(field.options ?? []).join('，')}
              onChange={(event) =>
                dispatch(
                  updateField({
                    fieldId: field.id,
                    patch: { options: event.target.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean) }
                  })
                )
              }
              sx={{ flex: 1, minWidth: 180 }}
            />
          )}
          <Tooltip title="移除字段：引用它的规则将失效">
            <IconButton color="error" onClick={() => dispatch(removeField(field.id))}>
              ✕
            </IconButton>
          </Tooltip>
        </Stack>
      </CardContent>
    </Card>
  );
}

function FieldOrchestration({ version }: { version: FormVersion }) {
  const dispatch = useDispatch();
  const sensors = useSensors(useSensor(PointerSensor));
  function dragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }
  return (
    <Card>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
          <div>
            <Typography variant="h6">字段编排</Typography>
            <Typography variant="body2" color="text.secondary">
              拖动排序、改类型或移除字段；引用它的联动规则会立即失效重算。
            </Typography>
          </div>
          <Button variant="contained" onClick={() => dispatch(addField())}>
            添加字段
          </Button>
        </Stack>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
          <SortableContext items={version.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}>
            <Stack>
              {version.fields.map((field) => (
                <SortableFieldCard key={field.id} field={field} />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      </CardContent>
    </Card>
  );
}

/* ---------------- 联动规则 ---------------- */

function RuleRow({ rule, version }: { rule: LinkRule; version: FormVersion }) {
  const dispatch = useDispatch();
  const source = version.fields.find((field) => field.id === rule.fieldId);
  const target = version.fields.find((field) => field.id === rule.targetId);
  const invalid = rule.status === 'invalid';
  return (
    <Alert
      severity={invalid ? 'error' : 'info'}
      sx={{ mb: 1 }}
      action={
        <IconButton color="error" size="small" onClick={() => dispatch(removeRule(rule.id))}>
          ✕
        </IconButton>
      }
    >
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip size="small" label={invalid ? '已失效' : '生效中'} color={invalid ? 'error' : 'success'} />
        <Typography variant="body2">
          当 <b>{source?.label ?? rule.fieldId}</b>
          {rule.operator === 'equals' ? ` 等于「${rule.value}」` : ' 非空'} 时，
          {rule.effect === 'require' ? '要求必填' : '显示'} <b>{target?.label ?? rule.targetId}</b>
        </Typography>
      </Stack>
      {invalid && (
        <Typography variant="caption" color="error" display="block" mt={0.5}>
          失效原因：{rule.invalidReason}
        </Typography>
      )}
    </Alert>
  );
}

function RuleEditor({ version }: { version: FormVersion }) {
  const dispatch = useDispatch();
  const [fieldId, setFieldId] = useState(version.fields[0]?.id ?? '');
  const [operator, setOperator] = useState<'equals' | 'notEmpty'>('equals');
  const [value, setValue] = useState('');
  const [effect, setEffect] = useState<'show' | 'require'>('require');
  const [targetId, setTargetId] = useState(version.fields.at(-1)?.id ?? '');

  useEffect(() => {
    setFieldId((current) => (version.fields.some((field) => field.id === current) ? current : version.fields[0]?.id ?? ''));
    setTargetId((current) => (version.fields.some((field) => field.id === current) ? current : version.fields[0]?.id ?? ''));
  }, [version]);

  function submit() {
    if (!fieldId || !targetId) return;
    const source = version.fields.find((field) => field.id === fieldId);
    const target = version.fields.find((field) => field.id === targetId);
    dispatch(
      addRule({
        fieldId,
        operator,
        value,
        effect,
        targetId,
        sourceType: source?.type,
        targetType: target?.type
      })
    );
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" mb={1}>
          联动规则
        </Typography>
        <Stack spacing={1}>
          {version.rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} version={version} />
          ))}
          {version.rules.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              暂无规则。新增规则后，字段移除或类型变更会导致引用它的规则失效。
            </Typography>
          )}
        </Stack>
        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2" mb={1}>
          新增规则
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>触发字段</InputLabel>
            <Select label="触发字段" value={fieldId} onChange={(event) => setFieldId(event.target.value)}>
              {version.fields.map((field) => (
                <MenuItem key={field.id} value={field.id}>
                  {field.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>条件</InputLabel>
            <Select label="条件" value={operator} onChange={(event) => setOperator(event.target.value as 'equals' | 'notEmpty')}>
              <MenuItem value="equals">等于</MenuItem>
              <MenuItem value="notEmpty">非空</MenuItem>
            </Select>
          </FormControl>
          {operator === 'equals' && (
            <TextField size="small" label="值" value={value} onChange={(event) => setValue(event.target.value)} sx={{ width: 110 }} />
          )}
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>效果</InputLabel>
            <Select label="效果" value={effect} onChange={(event) => setEffect(event.target.value as 'show' | 'require')}>
              <MenuItem value="require">必填</MenuItem>
              <MenuItem value="show">显示</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>目标字段</InputLabel>
            <Select label="目标字段" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {version.fields.map((field) => (
                <MenuItem key={field.id} value={field.id}>
                  {field.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button variant="outlined" onClick={submit}>
            添加规则
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

/* ---------------- 版本差异 ---------------- */

function VersionDiffTab({ versions, previewId }: { versions: FormVersion[]; previewId: string }) {
  const [baseId, setBaseId] = useState(versions[0]?.id ?? '');
  useEffect(() => {
    if (!versions.some((version) => version.id === baseId)) setBaseId(versions[0]?.id ?? '');
  }, [versions, baseId]);
  const base = versions.find((version) => version.id === baseId) ?? versions[0];
  const target = versions.find((version) => version.id === previewId) ?? versions[versions.length - 1];
  const diff = useMemo(() => (base && target ? diffVersions(base, target) : null), [base, target]);
  if (!base || !target || !diff) return null;
  return (
    <Box mt={2}>
      <Stack direction="row" spacing={1} alignItems="center" mb={2}>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>基准版本</InputLabel>
          <Select label="基准版本" value={base.id} onChange={(event) => setBaseId(event.target.value)}>
            {versions.map((version) => (
              <MenuItem key={version.id} value={version.id}>
                {version.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Typography fontWeight={700}>→ {target.label}</Typography>
      </Stack>

      <Stack direction="row" gap={1} flexWrap="wrap" mb={2}>
        {diff.added.map((field) => (
          <Chip key={field.id} label={`新增 ${field.label}`} color="success" variant="outlined" />
        ))}
        {diff.removed.map((field) => (
          <Chip key={field.id} label={`移除 ${field.label}`} color="error" variant="outlined" />
        ))}
        {diff.typeChanged.map(({ field, from }) => (
          <Chip key={field.id} label={`${field.label} 类型 ${from}→${field.type}`} color="warning" variant="outlined" />
        ))}
        {!diff.added.length && !diff.removed.length && !diff.typeChanged.length && (
          <Chip label="字段定义无差异" variant="outlined" />
        )}
      </Stack>

      <Typography fontWeight={700} mb={1}>
        失效规则（{diff.invalidRules.length}）
      </Typography>
      {diff.invalidRules.length === 0 ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          规则全部有效，金额与资质校验可正常重算。
        </Alert>
      ) : (
        <Stack spacing={1} mb={2}>
          {diff.invalidRules.map((rule) => (
            <Alert key={rule.id} severity="error">
              {rule.invalidReason}
            </Alert>
          ))}
        </Stack>
      )}

      <Alert severity="info">
        旧版本解释保持冻结：过去提交的快照按其提交时的版本解释，不随字段新增、移除或改类型而改变。
      </Alert>
    </Box>
  );
}

/* ---------------- 快照升级 ---------------- */

function SnapshotUpgradeCard({ snapshot, target }: { snapshot: Snapshot; target: FormVersion }) {
  const dispatch = useDispatch();
  const versions = useSelector((root: RootState) => root.schema.versions);
  const source = versions.find((version) => version.id === snapshot.versionId);
  const targetRules = recomputeRules(target.rules, target.fields);
  const invalidRules = targetRules.filter((rule) => rule.status === 'invalid');

  function upgrade() {
    dispatch(upgradeSnapshotAction({ snapshotId: snapshot.id, targetVersionId: target.id }));
  }

  return (
    <Card variant="outlined" sx={{ p: 2, mb: 1.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <div>
          <Typography fontWeight={700}>
            {snapshot.label}
            {snapshot.operator ? ` · ${snapshot.operator}` : ''}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            提交于 {source?.label ?? snapshot.versionId} → 升级目标 {target.label}
          </Typography>
        </div>
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={snapshot.status === 'official' ? '已入库' : '草稿'} color={snapshot.status === 'official' ? 'success' : 'default'} />
          <Chip
            size="small"
            label={
              snapshot.upgradeStatus === 'none'
                ? '未升级'
                : snapshot.upgradeStatus === 'done'
                  ? '已完成'
                  : snapshot.upgradeStatus === 'pending'
                    ? '待补字段'
                    : '回填失败'
            }
            color={
              snapshot.upgradeStatus === 'done'
                ? 'success'
                : snapshot.upgradeStatus === 'pending'
                  ? 'warning'
                  : snapshot.upgradeStatus === 'failed'
                    ? 'error'
                    : 'default'
            }
          />
        </Stack>
      </Stack>

      {snapshot.conflict && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          并发冲突：{snapshot.conflictReason}
        </Alert>
      )}

      {snapshot.upgradeStatus === 'none' && (
        <Button size="small" variant="contained" sx={{ mt: 1 }} onClick={upgrade}>
          升级到 {target.label}
        </Button>
      )}

      {snapshot.upgradeStatus === 'failed' && (
        <Alert severity="error" sx={{ mt: 1 }}>
          <Typography fontWeight={700}>回填失败，未完成快照已留住，可修复后重试。</Typography>
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {snapshot.failureReason}
          </Typography>
          <Typography variant="subtitle2" sx={{ mt: 1 }}>
            待修复规则（{invalidRules.length}）：
          </Typography>
          <Stack spacing={0.5} mt={0.5}>
            {invalidRules.map((rule) => (
              <Typography key={rule.id} variant="body2">
                · {rule.invalidReason}
              </Typography>
            ))}
          </Stack>
          <Button size="small" variant="contained" sx={{ mt: 1 }} onClick={upgrade}>
            重试回填
          </Button>
        </Alert>
      )}

      {snapshot.upgradeStatus === 'pending' && (
        <Box mt={1}>
          <Alert severity="warning">
            部分字段已回填，以下 {snapshot.pendingFields?.length ?? 0} 项映射不了，待人工补充：
            <Stack component="ul" sx={{ m: 0, pl: 2 }}>
              {snapshot.pendingFields?.map((item) => (
                <Typography component="li" key={item.fieldId} variant="body2">
                  {item.label}：{item.reason}
                </Typography>
              ))}
            </Stack>
          </Alert>
          {snapshot.backfilled && Object.keys(snapshot.backfilled).length > 0 && (
            <Typography variant="body2" color="text.secondary" mt={1}>
              已回填：{JSON.stringify(snapshot.backfilled)}
            </Typography>
          )}
          <Button size="small" variant="outlined" sx={{ mt: 1 }} onClick={upgrade}>
            重新升级
          </Button>
        </Box>
      )}

      {snapshot.upgradeStatus === 'done' && (
        <Alert severity="success" sx={{ mt: 1 }}>
          回填完成，全部字段已映射。
          <Typography variant="body2" color="text.secondary" mt={0.5}>
            回填结果：{JSON.stringify(snapshot.backfilled)}
          </Typography>
          <Button size="small" variant="outlined" sx={{ mt: 1 }} onClick={upgrade}>
            重新升级
          </Button>
        </Alert>
      )}
    </Card>
  );
}

function SnapshotUpgradeTab({ target }: { target: FormVersion }) {
  const snapshots = useSelector((root: RootState) => root.schema.snapshots);
  const failed = snapshots.filter((snapshot) => snapshot.upgradeStatus === 'failed');
  const pending = snapshots.filter((snapshot) => snapshot.upgradeStatus === 'pending');
  return (
    <Box mt={2}>
      {(failed.length > 0 || pending.length > 0) && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          重开提示：{failed.length} 条快照回填失败待修复规则，{pending.length} 条快照有待补记录。状态已按版本持久化。
        </Alert>
      )}
      {snapshots.map((snapshot) => (
        <SnapshotUpgradeCard key={snapshot.id} snapshot={snapshot} target={target} />
      ))}
    </Box>
  );
}

/* ---------------- 运行态表单 + 并发提交 ---------------- */

function FieldControl({
  field,
  value,
  onChange,
  required,
  error
}: {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
  required: boolean;
  error?: string;
}) {
  const label = `${field.label}${required ? ' *' : ''}`;
  if (field.type === 'select') {
    return (
      <FormControl size="small" fullWidth error={Boolean(error)}>
        <InputLabel>{label}</InputLabel>
        <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </Select>
        {error && <FormHelperText>{error}</FormHelperText>}
      </FormControl>
    );
  }
  return (
    <TextField
      size="small"
      fullWidth
      label={label}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      error={Boolean(error)}
      helperText={error}
      InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
    />
  );
}

function OperatorForm({ version, operator, color }: { version: FormVersion; operator: string; color: 'primary' | 'secondary' }) {
  const dispatch = useDispatch();
  const [data, setData] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expectedRevision, setExpectedRevision] = useState(version.revision);
  useEffect(() => {
    setData({});
    setErrors({});
    setExpectedRevision(version.revision);
    // 仅在切换版本时重置；revision 变化时保留本方提交时的版本号以识别并发冲突。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version.id]);

  const setValue = (fieldId: string, value: string) => setData((current) => ({ ...current, [fieldId]: value }));

  const activeRules = recomputeRules(version.rules, version.fields).filter((rule) => rule.status === 'active');
  const visibleFields = version.fields.filter((field) => {
    const showRules = activeRules.filter((rule) => rule.targetId === field.id && rule.effect === 'show');
    if (showRules.length && !showRules.some((rule) => evalRule(rule, data))) return false;
    return true;
  });
  const isRequired = (field: FormField) => {
    if (field.required) return true;
    return activeRules.some((rule) => rule.targetId === field.id && rule.effect === 'require' && evalRule(rule, data));
  };

  function submit() {
    const validationErrors = validateRuntime(version, data);
    if (Object.keys(validationErrors).length) {
      setErrors(validationErrors);
      return;
    }
    dispatch(submitSnapshot({ versionId: version.id, operator, label: `${operator} 提交`, data, expectedRevision }));
    setData({});
    setErrors({});
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography fontWeight={700}>{operator}</Typography>
          <Chip label={`提交时版本号 ${expectedRevision}`} size="small" color={color} variant="outlined" />
        </Stack>
        <Stack spacing={2} mt={2}>
          {visibleFields.map((field) => (
            <FieldControl
              key={field.id}
              field={field}
              value={data[field.id] ?? ''}
              onChange={(value) => setValue(field.id, value)}
              required={isRequired(field)}
              error={errors[field.id]}
            />
          ))}
          <Button variant="contained" color={color} onClick={submit}>
            提交（先入库生效）
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function RuntimeTab({ version }: { version: FormVersion }) {
  const snapshots = useSelector((root: RootState) => root.schema.snapshots);
  const drafts = snapshots.filter((snapshot) => snapshot.status === 'draft' && snapshot.conflict);
  return (
    <Box mt={2}>
      <Alert severity="info" sx={{ mb: 2 }}>
        两位运营同时提交同一版本：先入库的正式生效，后一个因版本号落后存为草稿并看到冲突。
      </Alert>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <OperatorForm version={version} operator="运营A" color="primary" />
        <OperatorForm version={version} operator="运营B" color="secondary" />
      </Stack>
      {drafts.length > 0 && (
        <Box mt={2}>
          <Typography fontWeight={700} mb={1}>
            冲突草稿
          </Typography>
          {drafts.map((draft) => (
            <Alert key={draft.id} severity="warning" sx={{ mb: 1 }}>
              {draft.label}：{draft.conflictReason}
            </Alert>
          ))}
        </Box>
      )}
    </Box>
  );
}

/* ---------------- 主页面 ---------------- */

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const preview = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const active = state.versions.find((item) => item.id === state.activeVersionId) ?? state.versions[state.versions.length - 1];
  const [tab, setTab] = useState(0);

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>
            {t('title')}
          </Typography>
          <Button color="inherit" onClick={() => dispatch(publishVersion())}>
            {t('publish')}
          </Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Stack spacing={3}>
              <FieldOrchestration version={preview} />
              <RuleEditor version={preview} />
            </Stack>
          </Grid>
          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, value) => setTab(value)}>
                  <Tab label="版本差异" />
                  <Tab label="快照升级" />
                  <Tab label="运行态/并发" />
                </Tabs>
                {tab === 0 && <VersionDiffTab versions={state.versions} previewId={preview.id} />}
                {tab === 1 && <SnapshotUpgradeTab target={active} />}
                {tab === 2 && <RuntimeTab version={active} />}
              </CardContent>
            </Card>
            <Card sx={{ mt: 3 }}>
              <CardContent>
                <Typography variant="subtitle2" gutterBottom>
                  历史版本（点击预览）
                </Typography>
                {state.versions.map((version) => (
                  <Button
                    key={version.id}
                    fullWidth
                    sx={{ justifyContent: 'space-between', mb: 0.5 }}
                    variant={version.id === preview.id ? 'contained' : 'text'}
                    onClick={() => dispatch(selectPreview(version.id))}
                  >
                    <span>{version.label}</span>
                    <span>{version.createdAt} · 修订 {version.revision}</span>
                  </Button>
                ))}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
