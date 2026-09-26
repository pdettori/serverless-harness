import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useTheme } from '../theme/context.js';

export interface FormField {
  key: string;
  label: string;
  masked?: boolean;
  hint?: string;
  initial?: string;
  optional?: boolean;
  suggestions?: string[];
  visible?: (values: Record<string, string>) => boolean;
}

interface Props {
  title: string;
  fields: FormField[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  validate?: (values: Record<string, string>) => string | undefined;
  error?: string;
}

export function Form({ title, fields, onSubmit, onCancel, validate, error }: Props) {
  const { tokens: t } = useTheme();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])),
  );
  const [focus, setFocus] = useState(0);
  const [problem, setProblem] = useState<string>();

  const shown = fields.filter((f) => !f.visible || f.visible(values));
  const at = Math.min(focus, shown.length - 1);
  const field = shown[at];

  const submit = () => {
    const out = Object.fromEntries(shown.map((f) => [f.key, values[f.key] ?? '']));
    const missing = shown.find((f) => !f.optional && !out[f.key].trim());
    if (missing) return setProblem(`${missing.label} is required`);
    const msg = validate?.(out);
    if (msg) return setProblem(msg);
    setProblem(undefined);
    onSubmit(out);
  };

  useInput((input, key) => {
    if (!field) return;
    if (key.escape) return onCancel();
    // Functional updates, same reasoning as SelectList: don't derive the next focus from `at`
    // (this render's snapshot), since a rapid burst of presses would otherwise collapse to one.
    if (key.upArrow) return setFocus((f) => Math.max(0, Math.min(f, shown.length - 1) - 1));
    if (key.downArrow) return setFocus((f) => Math.min(shown.length - 1, f + 1));
    if (key.return) {
      if (at === shown.length - 1) submit();
      else setFocus(at + 1);
      return;
    }
    if (key.tab) {
      const s = field.suggestions;
      if (s && s.length > 0) {
        const next = s[(s.indexOf(values[field.key]) + 1) % s.length];
        setValues((v) => ({ ...v, [field.key]: next }));
      } else setFocus(Math.min(shown.length - 1, at + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setValues((v) => ({ ...v, [field.key]: (v[field.key] ?? '').slice(0, -1) }));
      return;
    }
    if (input && !key.ctrl && !key.meta)
      setValues((v) => ({ ...v, [field.key]: (v[field.key] ?? '') + input }));
  });

  return (
    <Box flexDirection="column">
      <Text bold color={t.primary}>
        {title}
      </Text>
      {shown.map((f, i) => {
        const v = values[f.key] ?? '';
        const display = f.masked ? '•'.repeat(Array.from(v).length) : v;
        return (
          <Box key={f.key} flexDirection="column">
            <Text color={i === at ? t.primary : t.text}>
              {i === at ? '› ' : '  '}
              {f.label}: {display}
              {i === at ? '▌' : ''}
            </Text>
            {i === at && f.hint ? <Text color={t.muted}> {f.hint}</Text> : null}
            {i === at && f.suggestions ? (
              <Text color={t.muted}> tab: {f.suggestions.join(' / ')}</Text>
            ) : null}
          </Box>
        );
      })}
      {problem ? <Text color={t.warning}>{problem}</Text> : null}
      {error ? <Text color={t.error}>{error}</Text> : null}
    </Box>
  );
}
