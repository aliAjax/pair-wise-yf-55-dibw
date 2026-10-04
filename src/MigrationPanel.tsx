import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, FormControl, InputLabel, MenuItem, Select, Stack, Switch, TextField, Typography,
} from '@mui/material';
import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { convertible, interpretSnapshot, type MigrationTask } from './engine';
import { dismissMigration, runBackfill, setFailNextBackfill, startMigration, supplyPending, remapField, type RootState } from './store';

function SnapshotInterpretation({ snapshotId }: { snapshotId: string }) {
  const state = useSelector((root: RootState) => root.schema);
  const snapshot = state.snapshots.find((s) => s.id === snapshotId);
  if (!snapshot) return null;
  const version = state.versions.find((v) => v.id === snapshot.versionId);
  const interpreted = interpretSnapshot(version, snapshot.data);
  return (
    <Card variant="outlined" sx={{ p: 2, mb: 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography fontWeight={700}>{snapshot.label}</Typography>
        <Chip size="small" label={`按 ${version?.label ?? snapshot.versionId} 解释`} color="info" variant="outlined" />
      </Stack>
      <Typography variant="caption" color="text.secondary">{snapshot.operator} 提交于 {snapshot.submittedAt}</Typography>
      <Stack direction="row" spacing={1} mt={1} flexWrap="wrap" useFlexGap>
        {interpreted.fields.map((f) => (
          <Chip key={f.fieldId} size="small" variant={f.orphan ? 'filled' : 'outlined'} color={f.orphan ? 'default' : undefined}
            label={`${f.label}：${f.value ?? '（空）'} [${f.type}]`}
            title={f.orphan ? '该键在原版本定义中已找不到' : undefined} />
        ))}
      </Stack>
      {interpreted.orphanKeys.length > 0 && (
        <Typography variant="caption" color="text.secondary" mt={0.5} display="block">
          游离键（原版本无定义，仅存档）：{interpreted.orphanKeys.join('、')}
        </Typography>
      )}
    </Card>
  );
}

function TaskCard({ task }: { task: MigrationTask }) {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const source = state.versions.find((v) => v.id === task.sourceVersionId)!;
  const target = state.versions.find((v) => v.id === task.targetVersionId)!;
  const snapshot = state.snapshots.find((s) => s.id === task.snapshotId)!;

  return (
    <Card variant={task.status === 'failed' ? 'elevation' : 'outlined'}
      sx={{ p: 2, mb: 2, borderColor: task.status === 'failed' ? 'error.main' : undefined }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
        <Typography fontWeight={700}>{snapshot.label} 升级 → {target.label}</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {task.status === 'pending_backfill' && <Chip size="small" color="warning" label={`待补 ${task.pending.filter((p) => !p.supplied).length} 项`} />}
          {task.status === 'failed' && <Chip size="small" color="error" label={`回填失败 · 已重试 ${task.attempts} 次`} />}
          {task.status === 'done' && <Chip size="small" color="success" label={`回填完成（共 ${task.attempts} 次尝试）`} />}
          <Button size="small" color="inherit" onClick={() => dispatch(dismissMigration(task.id))}>关闭</Button>
        </Stack>
      </Stack>

      {task.lastError && <Alert severity="error" sx={{ mb: 1 }}>{task.lastError}。已回填 {Object.keys(task.backfilled).length} 个字段已保留，可继续重试。</Alert>}

      <Typography variant="subtitle2" mt={1}>字段映射（可手动改挂到旧版本任意字段）</Typography>
      <Stack spacing={1} mt={1}>
        {target.fields.map((tf) => {
          const mapping = task.mappings.find((m) => m.targetId === tf.id);
          const sf = mapping ? source.fields.find((f) => f.id === mapping.sourceId) : undefined;
          const backfilled = tf.id in task.backfilled;
          const pendingItem = task.pending.find((p) => p.targetId === tf.id);
          return (
            <Stack key={tf.id} direction="row" spacing={1.5} alignItems="center">
              <Box sx={{ width: 170 }}>
                <Typography variant="body2">{tf.label} <Chip component="span" size="small" label={tf.type} variant="outlined" sx={{ ml: 0.5 }} /></Typography>
              </Box>
              <Typography variant="caption">←</Typography>
              <FormControl size="small" sx={{ minWidth: 170 }}>
                <InputLabel>旧字段</InputLabel>
                <Select label="旧字段" value={mapping?.sourceId ?? ''}
                  onChange={(e) => dispatch(remapField({ taskId: task.id, targetId: tf.id, sourceId: e.target.value === '' ? null : e.target.value }))}>
                  <MenuItem value=""><em>不映射（新增字段）</em></MenuItem>
                  {source.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label} ({f.type})</MenuItem>)}
                </Select>
              </FormControl>
              {sf && (
                convertible(sf.type, tf.type)
                  ? (backfilled
                      ? <Chip size="small" color="success" label={`已回填：${String(task.backfilled[tf.id])}`} />
                      : <Chip size="small" color="success" variant="outlined" label={`可自动回填（${sf.type}→${tf.type}，待执行）`} />)
                  : <Chip size="small" color="error" variant="outlined" label={`类型不兼容 ${sf.type}→${tf.type}`} />
              )}
              {pendingItem && !pendingItem.supplied && <Chip size="small" color="warning" label={`待补：${pendingItem.reason}`} />}
            </Stack>
          );
        })}
      </Stack>

      <Divider sx={{ my: 2 }} />
      <Typography variant="subtitle2">待补记录（补录后随回填一起入库）</Typography>
      {task.pending.length === 0 && <Typography variant="body2" color="text.secondary" mt={1}>没有待补项。</Typography>}
      <Stack spacing={1} mt={1}>
        {task.pending.map((p) => (
          <Stack key={p.targetId ?? p.label} direction="row" spacing={1.5} alignItems="center">
            <Box sx={{ width: 200 }}>
              <Typography variant="body2">{p.label}{p.targetId === null && '（悬挂）'}</Typography>
              <Typography variant="caption" color="text.secondary">{p.reason}</Typography>
            </Box>
            {p.targetId
              ? <TextField size="small" sx={{ width: 220 }} label="补录值" value={p.supplied ?? ''}
                  onChange={(e) => dispatch(supplyPending({ taskId: task.id, targetId: p.targetId as string, value: e.target.value }))} />
              : <Typography variant="caption" color="warning.main">请重新指定该字段的映射目标</Typography>}
            {p.supplied && <Chip size="small" color="info" label="已补录，待回填" />}
          </Stack>
        ))}
      </Stack>

      <Divider sx={{ my: 2 }} />
      <Stack direction="row" spacing={2} alignItems="center">
        <Button variant="contained" disabled={task.status === 'done'}
          onClick={() => dispatch(runBackfill({ taskId: task.id }))}>
          {task.status === 'failed' ? '重试回填' : task.attempts === 0 ? '执行回填' : '继续回填'}
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Switch size="small" checked={state.failNextBackfill} onChange={(e) => dispatch(setFailNextBackfill(e.target.checked))} />
          <Typography variant="caption">模拟下一次回填接口失败（验证未完成快照保留与重试）</Typography>
        </Box>
      </Stack>
    </Card>
  );
}

export default function MigrationPanel() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const [targetBySnapshot, setTargetBySnapshot] = useState<Record<string, string>>({});

  return (
    <Box>
      <Typography variant="h6" mb={1}>旧数据快照（已提交数据按原版解释）</Typography>
      {state.snapshots.map((s) => {
        const targetId = targetBySnapshot[s.id] ?? state.activeVersionId;
        return (
          <Box key={s.id}>
            <SnapshotInterpretation snapshotId={s.id} />
            <Stack direction="row" spacing={1} alignItems="center" mb={2} pl={1}>
              <FormControl size="small" sx={{ minWidth: 200 }}>
                <InputLabel>升级到版本</InputLabel>
                <Select label="升级到版本" value={targetId} onChange={(e) => setTargetBySnapshot({ ...targetBySnapshot, [s.id]: e.target.value })}>
                  {state.versions.filter((v) => v.id !== s.versionId).map((v) => <MenuItem key={v.id} value={v.id}>{v.label}</MenuItem>)}
                </Select>
              </FormControl>
              <Button size="small" variant="outlined"
                onClick={() => dispatch(startMigration({ snapshotId: s.id, targetVersionId: targetId }))}>
                模拟升级（自动映射 + 列出待补）
              </Button>
            </Stack>
          </Box>
        );
      })}

      <Divider sx={{ my: 3 }} />
      <Typography variant="h6" mb={1}>升级 / 回填任务（失败保留、可重试，刷新页面仍在）</Typography>
      {state.migrations.length === 0 && <Alert severity="info">暂无迁移任务。点击上方「模拟升级」开始。</Alert>}
      {state.migrations.map((task) => <TaskCard key={task.id} task={task} />)}
    </Box>
  );
}
