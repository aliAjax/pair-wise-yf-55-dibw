import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, FormControl, IconButton, InputLabel, MenuItem,
  Select, Stack, Switch, TextField, Tooltip, Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { brokenRules, type FormField, type LinkRule, type RuleEffect, type RuleOperator } from './engine';
import { addField, addRule, commitDraft, rebaseDraft, rebindRule, removeField, removeRule, reorderFields, updateField, type Draft } from './store';

function SortableField({ draft, field }: { draft: Draft; field: FormField }) {
  const dispatch = useDispatch();
  const sortable = useSortable({ id: field.id });
  return (
    <Card
      ref={sortable.setNodeRef}
      variant="outlined"
      sx={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, mb: 1 }}
    >
      <CardContent sx={{ py: '12px !important', px: 2, '&:last-child': { pb: '12px !important' } }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
        <Tooltip title="拖动排序"><Box sx={{ cursor: 'grab', color: 'text.secondary', px: 0.5 }} {...sortable.attributes} {...sortable.listeners}>⠿</Box></Tooltip>
          <TextField size="small" label="字段名" value={field.label} sx={{ width: 150 }}
            onChange={(e) => dispatch(updateField({ draftId: draft.id, fieldId: field.id, patch: { label: e.target.value } }))} />
          <FormControl size="small" sx={{ width: 110 }}>
            <InputLabel>类型</InputLabel>
            <Select label="类型" value={field.type}
              onChange={(e) => dispatch(updateField({ draftId: draft.id, fieldId: field.id, patch: { type: e.target.value as FormField['type'] } }))}>
              <MenuItem value="text">文本</MenuItem><MenuItem value="number">金额/数字</MenuItem>
              <MenuItem value="select">下拉</MenuItem><MenuItem value="date">日期</MenuItem>
            </Select>
          </FormControl>
          {field.type === 'select' && (
            <TextField size="small" label="选项(逗号分隔)" sx={{ width: 200 }} value={field.options?.join(',') ?? ''}
              onChange={(e) => dispatch(updateField({ draftId: draft.id, fieldId: field.id, patch: { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } }))} />
          )}
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Typography variant="caption" mr={0.5}>必填</Typography>
            <Switch size="small" checked={field.required}
              onChange={(e) => dispatch(updateField({ draftId: draft.id, fieldId: field.id, patch: { required: e.target.checked } }))} />
          </Box>
          <Chip size="small" label={field.id} variant="outlined" sx={{ fontFamily: 'monospace' }} />
          <Box flexGrow={1} />
          <IconButton size="small" color="error" onClick={() => dispatch(removeField({ draftId: draft.id, fieldId: field.id }))}><DeleteIcon /></IconButton>
        </Stack>
      </CardContent>
    </Card>
  );
}

function RuleRow({ draft, rule }: { draft: Draft; rule: LinkRule }) {
  const dispatch = useDispatch();
  const broken = rule.status.kind === 'broken';
  return (
    <Alert
      severity={broken ? 'error' : 'success'}
      icon={false}
      sx={{ mb: 1, alignItems: 'center' }}
      action={<Button size="small" color="error" onClick={() => dispatch(removeRule({ draftId: draft.id, ruleId: rule.id }))}>删除</Button>}
    >
      <Stack spacing={1}>
        {broken && <Typography variant="body2" fontWeight={700}>规则已失效：{(rule.status as { kind: 'broken'; reason: string }).reason}</Typography>}
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="caption">当</Typography>
          <FormControl size="small" sx={{ minWidth: 130 }} error={broken}>
            <InputLabel>条件字段</InputLabel>
            <Select label="条件字段" value={rule.fieldId}
              onChange={(e) => dispatch(rebindRule({ draftId: draft.id, ruleId: rule.id, patch: { fieldId: e.target.value } }))}>
              {draft.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 90 }}>
            <InputLabel>条件</InputLabel>
            <Select label="条件" value={rule.operator}
              onChange={(e) => dispatch(rebindRule({ draftId: draft.id, ruleId: rule.id, patch: { operator: e.target.value as RuleOperator } }))}>
              <MenuItem value="equals">等于</MenuItem><MenuItem value="notEmpty">非空</MenuItem><MenuItem value="gt">大于</MenuItem>
            </Select>
          </FormControl>
          {rule.operator !== 'notEmpty' && (
            <TextField size="small" sx={{ width: 100 }} label={rule.operator === 'gt' ? '阈值' : '值'} value={rule.value}
              onChange={(e) => dispatch(rebindRule({ draftId: draft.id, ruleId: rule.id, patch: { value: e.target.value } }))} />
          )}
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>效果</InputLabel>
            <Select label="效果" value={rule.effect}
              onChange={(e) => dispatch(rebindRule({ draftId: draft.id, ruleId: rule.id, patch: { effect: e.target.value as RuleEffect } }))}>
              <MenuItem value="show">显示</MenuItem><MenuItem value="require">要求必填</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 130 }} error={broken}>
            <InputLabel>目标字段</InputLabel>
            <Select label="目标字段" value={rule.targetId}
              onChange={(e) => dispatch(rebindRule({ draftId: draft.id, ruleId: rule.id, patch: { targetId: e.target.value } }))}>
              {draft.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
            </Select>
          </FormControl>
        </Stack>
      </Stack>
    </Alert>
  );
}

export default function Designer({ draft }: { draft: Draft }) {
  const dispatch = useDispatch();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [ruleDraft, setRuleDraft] = useState({ fieldId: 'level', operator: 'equals' as RuleOperator, value: '', effect: 'require' as RuleEffect, targetId: 'amount' });

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderFields({ draftId: draft.id, activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  const brokenLink = brokenRules(draft.rules) as LinkRule[];
  const brokenCalc = brokenRules(draft.calcRules);
  const conflict = draft.status === 'conflict' ? draft.conflict : undefined;

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
        <div>
          <Typography variant="h6">{draft.label}</Typography>
          <Typography variant="body2" color="text.secondary">
            {draft.operator} 的草稿 · 基于 {draft.baseVersionId}（序号 {draft.baseRevision}）
          </Typography>
        </div>
        <Button variant="contained" color="primary" onClick={() => dispatch(commitDraft(draft.id))}>提交发布</Button>
      </Stack>

      {conflict && (
        <Alert severity="warning" sx={{ mb: 2 }}
          action={<Button color="inherit" variant="outlined" onClick={() => dispatch(rebaseDraft(draft.id))}>以最新版为基线合并</Button>}>
          <Typography fontWeight={700}>提交冲突：{conflict.liveVersionId} 已在 {conflict.publishedAt} 由对方先入库生效，你的修改已保留为草稿。</Typography>
          <Box mt={1}>
            {conflict.fields.length === 0 && <Typography variant="body2">字段定义无直接冲突（可直接合并基线后再提交）。</Typography>}
            {conflict.fields.map((c) => <Chip key={`${c.fieldId}-${c.kind}`} size="small" sx={{ mr: 1, mb: 0.5 }} color="warning" label={`${c.label}：${c.detail}`} />)}
          </Box>
        </Alert>
      )}

      {(brokenLink.length > 0 || brokenCalc.length > 0) && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography fontWeight={700}>有 {brokenLink.length + brokenCalc.length} 条规则因字段移走/改类型而失效，已自动重算——修复前运行态不会执行它们：</Typography>
          <Box mt={0.5}>
            {[...brokenLink, ...brokenCalc].map((r) => {
              const target = draft.fields.find((f) => f.id === (r as LinkRule).targetId)?.label ?? (r as LinkRule).targetId;
              return <Chip key={r.id} size="small" sx={{ mr: 1, mb: 0.5 }} color="error" variant="outlined"
                label={`${target} — ${(r.status as { kind: 'broken'; reason: string }).reason}`} />;
            })}
          </Box>
        </Alert>
      )}

      <Typography variant="subtitle1" fontWeight={700} mb={1}>字段定义（改名不影响引用；改类型/删除会让规则失效重算）</Typography>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={draft.fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
          {draft.fields.map((field) => <SortableField key={field.id} draft={draft} field={field} />)}
        </SortableContext>
      </DndContext>
      <Stack direction="row" spacing={1} mt={1}>
        <Button size="small" onClick={() => dispatch(addField({ draftId: draft.id }))}>+ 文本字段</Button>
        <Button size="small" onClick={() => dispatch(addField({ draftId: draft.id, type: 'number', label: '新金额字段' }))}>+ 金额字段</Button>
        <Button size="small" onClick={() => dispatch(addField({ draftId: draft.id, type: 'select', label: '新下拉字段' }))}>+ 下拉字段</Button>
      </Stack>

      <Divider sx={{ my: 3 }} />
      <Typography variant="subtitle1" fontWeight={700} mb={1}>联动 / 必填 / 金额资质校验规则</Typography>
      {draft.rules.map((rule) => <RuleRow key={rule.id} draft={draft} rule={rule} />)}
      {draft.rules.length === 0 && <Typography variant="body2" color="text.secondary">暂无规则</Typography>}

      <Card variant="outlined" sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="subtitle2" mb={1}>新增联动规则</Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>条件字段</InputLabel>
              <Select label="条件字段" value={ruleDraft.fieldId} onChange={(e) => setRuleDraft({ ...ruleDraft, fieldId: e.target.value })}>
                {draft.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 90 }}>
              <InputLabel>条件</InputLabel>
              <Select label="条件" value={ruleDraft.operator} onChange={(e) => setRuleDraft({ ...ruleDraft, operator: e.target.value as RuleOperator })}>
                <MenuItem value="equals">等于</MenuItem><MenuItem value="notEmpty">非空</MenuItem><MenuItem value="gt">大于</MenuItem>
              </Select>
            </FormControl>
            {ruleDraft.operator !== 'notEmpty' && <TextField size="small" sx={{ width: 100 }} label="值/阈值" value={ruleDraft.value} onChange={(e) => setRuleDraft({ ...ruleDraft, value: e.target.value })} />}
            <FormControl size="small" sx={{ minWidth: 110 }}>
              <InputLabel>效果</InputLabel>
              <Select label="效果" value={ruleDraft.effect} onChange={(e) => setRuleDraft({ ...ruleDraft, effect: e.target.value as RuleEffect })}>
                <MenuItem value="show">显示</MenuItem><MenuItem value="require">要求必填</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>目标字段</InputLabel>
              <Select label="目标字段" value={ruleDraft.targetId} onChange={(e) => setRuleDraft({ ...ruleDraft, targetId: e.target.value })}>
                {draft.fields.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
              </Select>
            </FormControl>
            <Button variant="outlined" onClick={() => { dispatch(addRule({ draftId: draft.id, rule: ruleDraft })); setRuleDraft({ ...ruleDraft, value: '' }); }}>添加规则</Button>
          </Stack>
        </CardContent>
      </Card>

      <Divider sx={{ my: 3 }} />
      <Typography variant="subtitle1" fontWeight={700} mb={1}>金额计算规则（随基线继承）</Typography>
      {draft.calcRules.map((rule) => {
        const target = draft.fields.find((f) => f.id === rule.targetId)?.label ?? rule.targetId;
        const inputs = rule.inputs.map((id) => draft.fields.find((f) => f.id === id)?.label ?? id).join(' × ');
        return <Alert key={rule.id} severity={rule.status.kind === 'active' ? 'info' : 'error'} sx={{ mb: 1 }}>
          {target} = {inputs || '(无引用字段)'}
          {rule.status.kind === 'broken' && <> —— 失效：{rule.status.reason}</>}
        </Alert>;
      })}
    </Box>
  );
}
