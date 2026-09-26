import { ApiError, TOKEN_CODES, TurnCancelledError } from '../api/errors.js';
import { isTerminal, type TurnFrame } from '../api/frames.js';
import type {
  ControlPlaneApi,
  CreateSessionRequest,
  HarnessApi,
  SessionToken,
} from '../api/types.js';
import type { TranscriptStore } from './transcripts.js';

export class HarnessUntrustedError extends Error {
  constructor() {
    super(
      'the harness rejected a freshly minted session token — it is likely missing MU1 auth configuration. Run /doctor for details.',
    );
    this.name = 'HarnessUntrustedError';
  }
}

export type SessionEvent =
  | { kind: 'turn-start'; prompt: string }
  | { kind: 'frame'; frame: TurnFrame }
  | { kind: 'retrying'; seconds: number }
  | { kind: 'turn-end'; outcome: 'done' | 'error' | 'cancelled'; error?: Error }
  | { kind: 'queue'; size: number };

export interface SessionDeps {
  cp: ControlPlaneApi;
  harness: HarnessApi;
  transcripts?: TranscriptStore;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  remintMarginS?: number;
}

export class ActiveSession {
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private queue: string[] = [];
  private controller?: AbortController;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly deps: SessionDeps,
    readonly sessionId: string,
    private token: SessionToken,
  ) {}

  on(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get busy(): boolean {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }

  // The server does not serialize concurrent turns of one session (spec §2.6); this queue does.
  submit(prompt: string): void {
    this.queue.push(prompt);
    this.emit({ kind: 'queue', size: this.queue.length });
    void this.drain();
  }

  cancel(): void {
    this.controller?.abort();
  }

  clearQueue(): void {
    this.queue = [];
    this.emit({ kind: 'queue', size: 0 });
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) l(e);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const prompt = this.queue.shift()!;
        this.emit({ kind: 'queue', size: this.queue.length });
        await this.runTurn(prompt);
      }
    } finally {
      this.running = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private async ensureToken(): Promise<void> {
    const marginMs = (this.deps.remintMarginS ?? 30) * 1000;
    if (this.token.expiresAt * 1000 - this.deps.now() < marginMs) {
      this.token = await this.deps.cp.mintSessionToken(this.sessionId);
    }
  }

  private async runTurn(prompt: string): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.deps.transcripts?.appendPrompt(this.sessionId, prompt);
    this.emit({ kind: 'turn-start', prompt });
    let reminted = false;
    let streamed = false;
    try {
      for (;;) {
        await this.ensureToken();
        try {
          const frames = this.deps.harness.streamTurn({
            sessionId: this.sessionId,
            prompt,
            token: this.token.token,
            signal: controller.signal,
          });
          for await (const frame of frames) {
            streamed = true;
            this.deps.transcripts?.appendFrame(this.sessionId, frame);
            this.emit({ kind: 'frame', frame });
            if (isTerminal(frame)) {
              this.emit(
                frame.type === 'done'
                  ? { kind: 'turn-end', outcome: 'done' }
                  : {
                      kind: 'turn-end',
                      outcome: 'error',
                      error: new Error(frame.errorMessage ?? frame.stopReason),
                    },
              );
              return;
            }
          }
          return;
        } catch (err) {
          if (controller.signal.aborted || err instanceof TurnCancelledError)
            throw new TurnCancelledError();
          // Once frames have flowed the status code is spent; never re-send a half-run turn.
          if (!(err instanceof ApiError) || err.source !== 'harness' || streamed) throw err;
          if (TOKEN_CODES.has(err.code) || err.code === 'session_mismatch') {
            // One remint covers an expired token and client/server clock skew. A token rejected
            // seconds after minting means the harness does not trust this control plane (§8.2).
            if (!reminted) {
              reminted = true;
              this.token = await this.deps.cp.mintSessionToken(this.sessionId);
              continue;
            }
            throw err.code === 'session_mismatch' ? err : new HarnessUntrustedError();
          }
          if (err.status === 503 && err.retryAfterS !== undefined) {
            this.emit({ kind: 'retrying', seconds: err.retryAfterS });
            await this.deps.sleep(err.retryAfterS * 1000, controller.signal);
            if (controller.signal.aborted) throw new TurnCancelledError();
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      this.deps.transcripts?.flush(this.sessionId);
      if (err instanceof TurnCancelledError) this.emit({ kind: 'turn-end', outcome: 'cancelled' });
      else this.emit({ kind: 'turn-end', outcome: 'error', error: err as Error });
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

export class SessionManager {
  constructor(private readonly deps: SessionDeps) {}

  async create(req: CreateSessionRequest): Promise<ActiveSession> {
    const created = await this.deps.cp.createSession(req);
    this.deps.transcripts?.ensure(created.sessionId);
    return new ActiveSession(this.deps, created.sessionId, {
      token: created.token,
      expiresAt: created.expiresAt,
    });
  }

  async resume(sessionId: string): Promise<ActiveSession> {
    return new ActiveSession(this.deps, sessionId, await this.deps.cp.mintSessionToken(sessionId));
  }

  async remove(sessionId: string): Promise<'deleted' | 'accepted'> {
    const result = await this.deps.cp.deleteSession(sessionId);
    this.deps.transcripts?.delete(sessionId);
    return result;
  }
}
