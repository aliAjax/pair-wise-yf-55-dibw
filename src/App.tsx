import {
  Alert, AppBar, Box, Button, Card, CardContent, Chip, Container, FormControl, Grid, InputLabel, MenuItem, Select, Stack, Tab, Tabs, Toolbar, Typography,
} from '@mui/material';
import { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Designer from './Designer';
import MigrationPanel from './MigrationPanel';
import Runtime from './Runtime';
import { brokenRules } from './engine';
import { removeDraft, resetAll, startDraft, type RootState } from './store';

const OPERATORS = ['运营甲', '运营乙'];

function Overview({ operator, onNavigate }: { operator: string; onNavigate: (tab: number, draftId?: string) => void }) {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const draftsWithBroken = state.drafts
    .map((d) => ({ draft: d, broken: [...brokenRules(d.rules), ...brokenRules(d.calcRules)] }))
    .filter((x) => x.broken.length > 0);
  const conflictDrafts = state.drafts.filter((d) => d.status === 'conflict');
  const pendingMigrations = state.migrations.filter((m) => m.status !== 'done');
  const failedMigrations = state.migrations.filter((m) => m.status === 'failed');

  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Card><CardContent><Typography variant="h4">{state.versions.length}</Typography><Typography variant="body2" color="text.secondary">已发布版本（序号）</Typography></CardContent></Card>
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Card><CardContent><Typography variant="h4">{state.snapshots.length}</Typography><Typography variant="body2" color="text.secondary">已提交快照（按原版解释）</Typography></CardContent></Card>
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Card><CardContent><Typography variant="h4" color={draftsWithBroken.length ? 'error.main' : undefined}>{draftsWithBroken.length}</Typography><Typography variant="body2" color="text.secondary">草稿有待修复规则</Typography></CardContent></Card>
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Card><CardContent><Typography variant="h4" color={pendingMigrations.length ? 'warning.main' : undefined}>{pendingMigrations.length}</Typography><Typography variant="body2" color="text.secondary">未完成回填任务（失败 {failedMigrations.length}）</Typography></CardContent></Card>
        </Grid>
      </Grid>

      {conflictDrafts.length > 0 && (
        <Alert severity="warning">
          <Typography fontWeight={700}>有 {conflictDrafts.length} 份草稿在提交时落后于已生效版本，已保留为草稿：</Typography>
          {conflictDrafts.map((d) => (
            <Stack key={d.id} direction="row" spacing={1} alignItems="center" mt={0.5}>
              <Chip size="small" label={`${d.operator} vs ${d.conflict?.liveVersionId}`} />
              <Typography variant="body2">{d.conflict?.fields.length ?? 0} 个字段冲突 · 对方已于 {d.conflict?.publishedAt} 生效</Typography>
              <Button size="small" onClick={() => onNavigate(1, d.id)}>查看并合并</Button>
            </Stack>
          ))}
        </Alert>
      )}

      {draftsWithBroken.length > 0 && (
        <Alert severity="error">
          <Typography fontWeight={700}>待修复规则（字段移走或改类型后失效，已自动重算）：</Typography>
          {draftsWithBroken.map(({ draft, broken }) => (
            <Box key={draft.id} mt={0.5}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" color="error" label={`${draft.operator} · ${draft.label}`} />
                <Button size="small" onClick={() => onNavigate(1, draft.id)}>去修复（{broken.length} 条）</Button>
              </Stack>
            </Box>
          ))}
        </Alert>
      )}

      {pendingMigrations.length > 0 && (
        <Alert severity="info">
          <Typography fontWeight={700}>待补 / 失败的迁移记录：</Typography>
          {pendingMigrations.map((m) => {
            const snap = state.snapshots.find((s) => s.id === m.snapshotId);
            return (
              <Stack key={m.id} direction="row" spacing={1} alignItems="center" mt={0.5}>
                <Chip size="small" color={m.status === 'failed' ? 'error' : 'warning'}
                  label={`${snap?.label ?? m.snapshotId} → ${m.targetVersionId}：${m.status === 'failed' ? '回填失败' : `${m.pending.filter((p) => !p.supplied).length} 项待补`}`} />
                <Button size="small" onClick={() => onNavigate(2)}>{m.status === 'failed' ? '去重试' : '去补录'}</Button>
              </Stack>
            );
          })}
        </Alert>
      )}

      <Card variant="outlined"><CardContent>
        <Typography variant="subtitle1" fontWeight={700} mb={1}>已发布版本</Typography>
        {state.versions.map((v) => (
          <Stack key={v.id} direction="row" spacing={1} alignItems="center" mb={0.5}>
            <Chip size="small" label={v.id} color={v.id === state.activeVersionId ? 'success' : 'default'} />
            <Typography variant="body2">{v.label}</Typography>
            <Typography variant="caption" color="text.secondary">序号 {v.revision} · {v.createdAt} · {v.fields.length} 字段 / {v.rules.filter((r) => r.status.kind === 'active').length} 条生效规则{v.publishedBroken.length > 0 ? ` / ${v.publishedBroken.length} 条失效` : ''}</Typography>
          </Stack>
        ))}
      </CardContent></Card>

      <Card variant="outlined"><CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <div>
            <Typography variant="subtitle1" fontWeight={700}>演示并发提交</Typography>
            <Typography variant="body2" color="text.secondary">
              两位运营分别从当前版本各开一份草稿并修改；先提交者发布为新版本，后提交者提交时自动保草稿并看到字段冲突，再「合并到最新版」续改。
            </Typography>
          </div>
          <Button variant="contained" onClick={() => { dispatch(startDraft({ operator })); onNavigate(1); }}>为 {operator} 开一份改版草稿</Button>
        </Stack>
      </CardContent></Card>
    </Stack>
  );
}

export default function App() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const [operator, setOperator] = useState(OPERATORS[0]);
  const [tab, setTab] = useState(0);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);

  const myDrafts = useMemo(
    () => state.drafts.filter((d) => d.operator === operator),
    [state.drafts, operator],
  );
  const selectedDraft = state.drafts.find((d) => d.id === selectedDraftId)
    ?? myDrafts[0]
    ?? state.drafts[0]
    ?? null;

  function navigate(nextTab: number, draftId?: string) {
    if (draftId) setSelectedDraftId(draftId);
    setTab(nextTab);
  }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>展会报名 · 字段版本协同与快照迁移</Typography>
          <FormControl size="small" sx={{ mr: 2, minWidth: 120, bgcolor: 'rgba(255,255,255,0.15)', borderRadius: 1 }}>
            <InputLabel sx={{ color: 'white' }}>当前运营</InputLabel>
            <Select label="当前运营" value={operator} onChange={(e) => setOperator(e.target.value)} sx={{ color: 'white' }}>
              {OPERATORS.map((o) => <MenuItem key={o} value={o}>{o}</MenuItem>)}
            </Select>
          </FormControl>
          <Button color="inherit" onClick={() => { if (window.confirm('清空 localStorage 中的演示数据并恢复种子？')) { dispatch(resetAll()); setTab(0); } }}>重置演示数据</Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="xl" sx={{ py: 3 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="总览 / 待办" />
          <Tab label="字段与规则设计器" />
          <Tab label="旧快照迁移" />
          <Tab label="报名运行态" />
        </Tabs>

        {tab === 0 && <Overview operator={operator} onNavigate={navigate} />}

        {tab === 1 && (
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 3 }}>
              <Card variant="outlined"><CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                  <Typography variant="subtitle1" fontWeight={700}>草稿</Typography>
                  <Button size="small" variant="outlined" onClick={() => dispatch(startDraft({ operator }))}>新建</Button>
                </Stack>
                {state.drafts.length === 0 && <Typography variant="body2" color="text.secondary">暂无草稿，从总览或此处新建。</Typography>}
                {state.drafts.map((d) => (
                  <Card key={d.id} variant={selectedDraft?.id === d.id ? 'elevation' : 'outlined'} sx={{ p: 1.2, mb: 1, cursor: 'pointer', borderColor: d.status === 'conflict' ? 'warning.main' : undefined }}
                    onClick={() => setSelectedDraftId(d.id)}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Box>
                        <Typography variant="body2" fontWeight={700}>{d.label}</Typography>
                        <Typography variant="caption" color="text.secondary">{d.operator} · 基线 {d.baseVersionId}#{d.baseRevision}</Typography>
                      </Box>
                      <Box>
                        {d.status === 'conflict' && <Chip size="small" color="warning" label="冲突" />}
                        <Button size="small" color="error" onClick={(e) => { e.stopPropagation(); dispatch(removeDraft(d.id)); }}>删</Button>
                      </Box>
                    </Stack>
                  </Card>
                ))}
              </CardContent></Card>
            </Grid>
            <Grid size={{ xs: 12, md: 9 }}>
              {selectedDraft
                ? <Card><CardContent><Designer draft={selectedDraft} /></CardContent></Card>
                : <Alert severity="info">没有选中的草稿。新建一份草稿后即可拖拽字段、调整类型并观察规则失效重算。</Alert>}
            </Grid>
          </Grid>
        )}

        {tab === 2 && <Card><CardContent><MigrationPanel /></CardContent></Card>}
        {tab === 3 && <Card><CardContent><Runtime operator={operator} /></CardContent></Card>}
      </Container>
    </Box>
  );
}
