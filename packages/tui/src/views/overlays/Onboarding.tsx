import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { ControlPlaneApi, HarnessApi } from '../../api/types.js';
import type { CachedAuth, Endpoints } from '../../config.js';
import type { LoginDeps } from '../../core/auth.js';
import { describeError } from '../../core/messages.js';
import { useTheme } from '../../theme/context.js';
import { Form } from '../Form.js';
import { Spinner } from '../Spinner.js';
import { CredentialsOverlay } from './Credentials.js';
import { LoginOverlay } from './Login.js';

interface Props {
  initial: Endpoints;
  connect: (e: Required<Endpoints>) => { cp: ControlPlaneApi; harness: HarnessApi };
  hasValidLogin: () => boolean;
  loginDeps: () => LoginDeps;
  onLoggedIn: (auth: CachedAuth) => void;
  copy?: (text: string) => void | Promise<void>;
  openUrl?: (url: string) => void;
  onDone: () => void;
  onCancel: () => void;
}

type Step =
  | { kind: 'endpoints'; error?: string }
  | { kind: 'probing' }
  | { kind: 'login'; controlPlaneUrl: string }
  | { kind: 'checking' }
  | { kind: 'credential' };

const isHttpUrl = (s: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
};

// Spec §6.8: every step is skipped when it is already satisfied, so `--setup` on a configured
// machine is a confirmation, not a chore.
export function OnboardingOverlay({
  initial,
  connect,
  hasValidLogin,
  loginDeps,
  onLoggedIn,
  copy,
  openUrl,
  onDone,
  onCancel,
}: Props) {
  const { tokens: t } = useTheme();
  const [step, setStep] = useState<Step>({ kind: 'endpoints' });
  const [endpoints, setEndpoints] = useState(initial);
  const [cp, setCp] = useState<ControlPlaneApi>();

  // Guards every state update that follows an `await` below: `probe`/`checkCredential` keep
  // running after this overlay is unmounted (the parent swapping it out, or the process closing
  // it mid-check) — set false only on unmount so a still-mounted re-render never trips it.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const checkCredential = async (api: ControlPlaneApi) => {
    setStep({ kind: 'checking' });
    try {
      const creds = await api.listCredentials();
      if (!mountedRef.current) return;
      if (creds.some((c) => c.consumer === 'inference')) onDone();
      else setStep({ kind: 'credential' });
    } catch (err) {
      if (!mountedRef.current) return;
      setStep({ kind: 'endpoints', error: describeError(err) });
    }
  };

  const probe = async (e: Required<Endpoints>) => {
    setEndpoints(e);
    setStep({ kind: 'probing' });
    const clients = connect(e);
    setCp(clients.cp);
    const [c, h] = await Promise.allSettled([clients.cp.healthz(), clients.harness.health()]);
    if (!mountedRef.current) return;
    const failures = [
      c.status === 'rejected' ? `control plane: ${describeError(c.reason)}` : undefined,
      h.status === 'rejected' ? `harness: ${describeError(h.reason)}` : undefined,
    ].filter(Boolean);
    if (failures.length > 0) return setStep({ kind: 'endpoints', error: failures.join('\n') });
    if (!hasValidLogin()) return setStep({ kind: 'login', controlPlaneUrl: e.controlPlaneUrl });
    await checkCredential(clients.cp);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={2}
      paddingY={1}
    >
      <Text bold>Welcome to sh-tui</Text>
      <Text color={t.muted}>1 endpoints · 2 login · 3 credential · 4 first session</Text>
      {step.kind === 'endpoints' ? (
        <Form
          title="Where are your services?"
          fields={[
            {
              key: 'controlPlaneUrl',
              label: 'Control plane URL',
              initial: endpoints.controlPlaneUrl,
              hint: 'auth, sessions and credentials',
            },
            {
              key: 'harnessUrl',
              label: 'Harness URL',
              initial: endpoints.harnessUrl,
              hint: 'where turns run',
            },
          ]}
          validate={(v) =>
            !isHttpUrl(v.controlPlaneUrl)
              ? 'the control plane URL must be an http(s) URL'
              : !isHttpUrl(v.harnessUrl)
                ? 'the harness URL must be an http(s) URL'
                : undefined
          }
          error={step.error}
          onCancel={onCancel}
          onSubmit={(v) =>
            void probe({
              controlPlaneUrl: v.controlPlaneUrl.trim(),
              harnessUrl: v.harnessUrl.trim(),
            })
          }
        />
      ) : null}
      {step.kind === 'probing' ? <Spinner label="checking both endpoints" /> : null}
      {step.kind === 'checking' ? <Spinner label="looking for an inference credential" /> : null}
      {step.kind === 'login' ? (
        <LoginOverlay
          deps={loginDeps()}
          controlPlaneUrl={step.controlPlaneUrl}
          copy={copy}
          openUrl={openUrl}
          onCancel={onCancel}
          onLoggedIn={(auth) => {
            onLoggedIn(auth);
            if (cp) void checkCredential(cp);
          }}
        />
      ) : null}
      {step.kind === 'credential' && cp ? (
        <CredentialsOverlay
          cp={cp}
          startInAdd
          hint="an inference credential is the key and gateway your sessions use to reach a model"
          onChanged={() => void checkCredential(cp)}
          onCancel={onDone}
        />
      ) : null}
    </Box>
  );
}
