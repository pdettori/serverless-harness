import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { ControlPlaneApi, CreateSessionRequest } from '../../api/types.js';
import type { Preset } from '../../config.js';
import { describeError } from '../../core/messages.js';
import {
  SESSION_OPTION_FIELDS,
  checkPreset,
  resolveSessionOptions,
  type Resolution,
  type SessionOptionField,
} from '../../core/session-options.js';
import { useTheme } from '../../theme/context.js';
import { SelectList } from '../SelectList.js';
import { Spinner } from '../Spinner.js';

interface Props {
  cp: ControlPlaneApi;
  fields?: readonly SessionOptionField[];
  lastUsed: Record<string, string>;
  presets: Preset[];
  onCreate: (req: CreateSessionRequest, values: Record<string, string>) => Promise<void>;
  onBlocked: (hint: string) => void;
  onCancel: () => void;
}

type Phase =
  | { kind: 'presets' }
  | { kind: 'resolving' }
  | {
      kind: 'pick';
      res: Extract<Resolution, { status: 'needs-input' }>;
      given: Record<string, string>;
    }
  | { kind: 'creating' }
  | { kind: 'error'; message: string };

const CUSTOM = '__custom__';

export function NewSessionOverlay({
  cp,
  fields = SESSION_OPTION_FIELDS,
  lastUsed,
  presets,
  onCreate,
  onBlocked,
  onCancel,
}: Props) {
  const { tokens: t } = useTheme();
  const [phase, setPhase] = useState<Phase>(
    presets.length > 0 ? { kind: 'presets' } : { kind: 'resolving' },
  );
  const [note, setNote] = useState<string>();

  const resolve = async (given: Record<string, string>) => {
    setPhase({ kind: 'resolving' });
    try {
      const r = await resolveSessionOptions(cp, fields, given, lastUsed);
      if (r.status === 'blocked') return onBlocked(r.field.emptyHint);
      if (r.status === 'needs-input') return setPhase({ kind: 'pick', res: r, given });
      setPhase({ kind: 'creating' });
      await onCreate(r.request, r.values);
    } catch (err) {
      setPhase({ kind: 'error', message: describeError(err) });
    }
  };

  useEffect(() => {
    if (presets.length === 0) void resolve({});
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold color={t.primary}>
        New session
      </Text>
      {note ? <Text color={t.warning}>{note}</Text> : null}
      {phase.kind === 'presets' ? (
        <SelectList
          filter="off"
          items={[
            ...presets.map((p) => ({
              key: p.name,
              label: p.name,
              detail: Object.values(p.values).join(' · '),
              value: p.name,
            })),
            { key: CUSTOM, label: 'choose options…', value: CUSTOM },
          ]}
          onCancel={onCancel}
          onSelect={(name) => {
            const preset = presets.find((p) => p.name === name);
            if (!preset) return void resolve({});
            const { values, stale } = checkPreset(preset, fields);
            if (stale.length > 0)
              setNote(`ignoring preset fields this version does not know: ${stale.join(', ')}`);
            void resolve(values);
          }}
        />
      ) : null}
      {phase.kind === 'pick' ? (
        <SelectList
          title={phase.res.field.label}
          filter="slash"
          initialKey={phase.res.defaultValue}
          items={phase.res.choices.map((c) => ({ key: c.value, label: c.label, value: c.value }))}
          onCancel={onCancel}
          onSelect={(v) =>
            void resolve({ ...phase.given, ...phase.res.values, [phase.res.field.key]: v })
          }
        />
      ) : null}
      {phase.kind === 'resolving' ? <Spinner label="checking options" /> : null}
      {phase.kind === 'creating' ? <Spinner label="creating session" /> : null}
      {phase.kind === 'error' ? <Text color={t.error}>{phase.message}</Text> : null}
    </Box>
  );
}
