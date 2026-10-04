import {
  Alert, Box, Button, Card, CardContent, Chip, FormControl, InputLabel, MenuItem, Select, Stack, TextField, Typography,
} from '@mui/material';
import { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { evalCalcs, validateSubmission, visibleFields } from './engine';
import { recordSubmission, type RootState } from './store';

export default function Runtime({ operator }: { operator: string }) {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const [versionId, setVersionId] = useState(state.activeVersionId);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  const version = state.versions.find((v) => v.id === versionId) ?? state.versions[0];

  const visible = useMemo(() => visibleFields(version, values), [version, values]);
  const calc = useMemo(() => evalCalcs(version, values), [version, values]);

  function chooseVersion(id: string) {
    setVersionId(id);
    setValues({});
    setErrors({});
    setDone(null);
  }

  function setValue(id: string, raw: string | number) {
    setValues((prev) => ({ ...prev, [id]: raw }));
    setDone(null);
  }

  function submit() {
    // 计算字段落进表单值后再校验，保证金额联动校验一致
    const merged = { ...values, ...calc.values };
    const nextErrors = validateSubmission(version, merged);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setDone(null);
      return;
    }
    const payload: Record<string, string | number> = {};
    for (const field of visibleFields(version, merged)) {
      if (field.id in merged) payload[field.id] = merged[field.id];
    }
    dispatch(recordSubmission({ versionId: version.id, operator, data: payload }));
    setDone(`已按 ${version.label} 提交（快照冻结到该版本）`);
    setValues({});
    setErrors({});
  }

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">报名填写（{operator}）</Typography>
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel>按版本填写</InputLabel>
          <Select label="按版本填写" value={versionId} onChange={(e) => chooseVersion(e.target.value)}>
            {state.versions.map((v) => <MenuItem key={v.id} value={v.id}>{v.label}（序号 {v.revision}）</MenuItem>)}
          </Select>
        </FormControl>
      </Stack>

      {(version.publishedBroken.length > 0) && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          该版本发布时有 {version.publishedBroken.length} 条规则已失效被跳过：
          {version.publishedBroken.map((b) => <Chip key={b.ruleId} size="small" sx={{ ml: 0.5 }} label={b.reason} />)}
        </Alert>
      )}

      <Card variant="outlined"><CardContent>
        <Stack spacing={2}>
          {visible.map((field) => {
            const isCalc = version.calcRules.some((r) => r.targetId === field.id && r.status.kind === 'active');
            const calcValue = calc.values[field.id];
            const displayValue = field.id in values ? values[field.id] : (calcValue !== undefined ? calcValue : '');
            const common = {
              label: field.label, required: field.required, fullWidth: true, size: 'small' as const,
              value: displayValue,
              error: Boolean(errors[field.id]), helperText: errors[field.id],
            };
            if (isCalc) {
              return (
                <TextField key={field.id} {...common} disabled
                  helperText={errors[field.id] ?? `自动计算：${version.calcRules.find((r) => r.targetId === field.id)!.inputs.map((id) => version.fields.find((f) => f.id === id)?.label ?? id).join(' × ')}`}
                  onChange={() => undefined} />
              );
            }
            if (field.type === 'select') {
              return (
                <FormControl key={field.id} size="small" error={Boolean(errors[field.id])} required={field.required}>
                  <InputLabel>{field.label}</InputLabel>
                  <Select label={field.label} value={String(displayValue)} onChange={(e) => setValue(field.id, e.target.value)}>
                    {field.options?.map((opt) => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                  </Select>
                  {errors[field.id] && <Typography variant="caption" color="error">{errors[field.id]}</Typography>}
                </FormControl>
              );
            }
            return (
              <TextField key={field.id} {...common} type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
                onChange={(e) => setValue(field.id, field.type === 'number' ? e.target.value : e.target.value)} />
            );
          })}
          {calc.cycles.length > 0 && <Alert severity="error">计算规则存在循环依赖：{calc.cycles.join('、')}，相关金额未计算</Alert>}
          <Button variant="contained" onClick={submit}>提交报名</Button>
        </Stack>
      </CardContent></Card>

      {done && <Alert severity="success" sx={{ mt: 2 }}>{done}</Alert>}

      <Typography variant="subtitle2" mt={3} mb={1}>本次会话的提交记录</Typography>
      {state.submissions.length === 0 && <Typography variant="body2" color="text.secondary">暂无</Typography>}
      {state.submissions.map((s) => (
        <Card key={s.id} variant="outlined" sx={{ p: 1.5, mb: 1 }}>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2">{s.operator} · {s.submittedAt}</Typography>
            <Chip size="small" label={`冻结于 ${s.versionId}`} variant="outlined" />
          </Stack>
          <Typography variant="caption" color="text.secondary">{JSON.stringify(s.data)}</Typography>
        </Card>
      ))}
    </Box>
  );
}
