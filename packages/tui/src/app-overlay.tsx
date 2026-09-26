import type { CreateSessionRequest } from './api/types.js';
import type { CommandHost, OverlayName } from './commands/builtin.js';
import type { CommandRegistry } from './commands/registry.js';
import type { CachedAuth } from './config.js';
import { apiTokenValid } from './core/auth.js';
import { runDiagnostics } from './core/diagnostics.js';
import { SessionManager } from './core/session-manager.js';
import type { OsDeps } from './os.js';
import { setAuth, setEndpoints, type Runtime } from './runtime.js';
import { CredentialsOverlay } from './views/overlays/Credentials.js';
import { DoctorOverlay } from './views/overlays/Doctor.js';
import { HelpOverlay } from './views/overlays/Help.js';
import { LoginOverlay } from './views/overlays/Login.js';
import { NewSessionOverlay } from './views/overlays/NewSession.js';
import { OnboardingOverlay } from './views/overlays/Onboarding.js';
import { PaletteOverlay } from './views/overlays/Palette.js';
import { SessionsOverlay } from './views/overlays/Sessions.js';

/** `then` reopens an overlay once this one reports a change (credentials → new session). */
export type Overlay = { name: OverlayName; hint?: string; then?: OverlayName };

export function sessionManager(rt: Runtime): SessionManager {
  return new SessionManager({
    cp: rt.cp!,
    harness: rt.harness!,
    transcripts: rt.transcripts,
    now: rt.now,
    sleep: rt.sleep,
  });
}

interface Props {
  overlay: Overlay;
  rt: Runtime;
  os: OsDeps;
  registry: CommandRegistry<CommandHost>;
  host: CommandHost;
  currentSessionId?: string;
  open: (o: Overlay) => void;
  close: () => void;
  onOnboarded: () => void;
  onOnboardingCancel: () => void;
  onLoggedIn: (auth: CachedAuth) => void;
  onCreate: (req: CreateSessionRequest, values: Record<string, string>) => Promise<void>;
  onResume: (id: string) => void;
  onDeleted: (id: string) => void;
  onInputless: (inputless: boolean) => void;
}

// Every overlay owns Esc on its interactive screens. Sessions, New Session and Credentials also
// have screens with no input at all (a spinner, an error); they report those via onInputless and
// the App closes the overlay on Esc from there, so no error screen can strand the user.
export function AppOverlay({
  overlay,
  rt,
  os,
  registry,
  host,
  currentSessionId,
  open,
  close,
  onOnboarded,
  onOnboardingCancel,
  onLoggedIn,
  onCreate,
  onResume,
  onDeleted,
  onInputless,
}: Props) {
  const loginDeps = () => ({ cp: rt.cp!, sleep: rt.sleep, now: rt.now });
  switch (overlay.name) {
    case 'onboarding':
      return (
        <OnboardingOverlay
          initial={rt.endpoints}
          connect={(e) => {
            // Persists the URLs and reloads the login cached for this control plane.
            setEndpoints(rt, e);
            return { cp: rt.cp!, harness: rt.harness! };
          }}
          hasValidLogin={() => apiTokenValid(rt.auth, rt.now())}
          loginDeps={loginDeps}
          onLoggedIn={(a) => setAuth(rt, a)}
          copy={os.copy}
          openUrl={os.openUrl}
          onDone={onOnboarded}
          onCancel={onOnboardingCancel}
        />
      );
    case 'login':
      return (
        <LoginOverlay
          deps={loginDeps()}
          controlPlaneUrl={rt.endpoints.controlPlaneUrl!}
          copy={os.copy}
          openUrl={os.openUrl}
          onLoggedIn={onLoggedIn}
          onCancel={close}
        />
      );
    case 'sessions':
      return (
        <SessionsOverlay
          cp={rt.cp!}
          transcripts={rt.transcripts}
          now={rt.now}
          currentSessionId={currentSessionId}
          remove={(id) => sessionManager(rt).remove(id)}
          onResume={onResume}
          onNew={() => open({ name: 'new-session' })}
          onDeleted={onDeleted}
          onCancel={close}
          onInputless={onInputless}
        />
      );
    case 'new-session':
      return (
        <NewSessionOverlay
          cp={rt.cp!}
          lastUsed={rt.config.lastUsed}
          presets={rt.config.presets}
          onCreate={onCreate}
          onBlocked={(hint) => open({ name: 'credentials', hint, then: 'new-session' })}
          onCancel={close}
          onInputless={onInputless}
        />
      );
    case 'credentials': {
      const then = overlay.then;
      return (
        <CredentialsOverlay
          cp={rt.cp!}
          hint={overlay.hint}
          startInAdd={!!overlay.hint}
          onChanged={then ? () => open({ name: then }) : undefined}
          onCancel={close}
          onInputless={onInputless}
        />
      );
    }
    case 'doctor':
      return (
        <DoctorOverlay
          run={() =>
            runDiagnostics({
              cp: rt.cp!,
              harness: rt.harness!,
              controlPlaneUrl: rt.endpoints.controlPlaneUrl!,
              harnessUrl: rt.endpoints.harnessUrl!,
              loggedIn: apiTokenValid(rt.auth, rt.now()),
            })
          }
          onClose={close}
        />
      );
    case 'palette':
      return <PaletteOverlay registry={registry} host={host} onClose={close} />;
    case 'help':
      return <HelpOverlay registry={registry} host={host} onClose={close} />;
  }
}
