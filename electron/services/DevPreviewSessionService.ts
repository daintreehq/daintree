import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  getInvalidCommandMessage,
  normalizeNextjsDevCommand,
  normalizeViteDevCommand,
} from "./DevPreviewCommandNormalizer.js";
import {
  allocatePort,
  releasePort,
  waitForPortFree,
  PORT_FREE_TIMEOUT_MS,
} from "./DevPreviewPortAllocator.js";
import { waitForServerReady, READINESS_TIMEOUT_MS } from "./DevPreviewReadinessProbe.js";
import {
  createSessionKey,
  sanitizeToken,
  cloneEnv,
  envEquals,
  validateEnsureRequest,
  validateSessionRequest,
  validateStopByPanelRequest,
} from "./DevPreviewRequestValidators.js";

export { normalizeNextjsDevCommand } from "./DevPreviewCommandNormalizer.js";
import { buildDevPreviewSubdomain } from "../../shared/utils/devPreviewProxy.js";
import type { DevPreviewManifestEntry } from "./DevPreviewManifestService.js";
import type { PtyClient } from "./PtyClient.js";
import { UrlDetector } from "./UrlDetector.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewSessionState,
  DevPreviewSessionStatus,
  DevPreviewDiagnosticEvent,
  DevPreviewDiagnosticsSnapshot,
  DevPreviewProxyFailureCause,
  DevPreviewUpstreamResolution,
  DevPreviewDirMeta,
  DevPreviewDestructivePreviewMeta,
  DevPreviewDestructivePreviewSizes,
  DevPreviewDestructivePreviewSizesRequest,
  DevPreviewPackageManager,
} from "../../shared/types/ipc/devPreview.js";
import type { DevServerError } from "../../shared/utils/devServerErrors.js";
import { detectDevServerError } from "../../shared/utils/devServerErrors.js";
import { CRASH_SIGNALS, EXPECTED_TERMINATION_SIGNALS } from "./pty/terminalForensics.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance } from "../utils/performance.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

interface DevPreviewSession extends DevPreviewSessionState {
  cwd: string;
  devCommand: string;
  turbopackEnabled: boolean;
  env?: Record<string, string>;
  buffer: string;
  lastErrorKey: string | null;
  pendingUrl: string | null;
  readinessAbort: AbortController | null;
  markerSeen: boolean;
  needsInstall: boolean;
  isRunningInstall: boolean;
  installAttemptedGeneration: number | null;
  startupReplayTimer: ReturnType<typeof setTimeout> | null;
  updatedAtPerformanceMs: number;
  phaseLabel?: "Compiling";
  compiling: boolean;
  compilingTimer: ReturnType<typeof setTimeout> | null;
  compilingClearTimer: ReturnType<typeof setTimeout> | null;
  forceKilled?: boolean;
  // Crash-loop guard state. crashCount is the number of consecutive fast
  // install→crash cycles in the current window; devSpawnedAt marks when the
  // dev server (not an install) last spawned, used to graduate the counter
  // once a spawn survives CRASH_LOOP_MIN_UPTIME_MS. backoffAbort cancels a
  // pending delayed re-install when the user restarts or the service disposes.
  crashCount: number;
  devSpawnedAt: number | null;
  backoffAbort: AbortController | null;
  crashLoopStopped: boolean;
  restoredFromManifest: boolean;
}

const RUNNING_STATES: ReadonlySet<DevPreviewSessionStatus> = new Set([
  "starting",
  "installing",
  "running",
]);

// Framework build/dep caches wiped by restartAndClearCache, relative to the
// session cwd. Covers Next, Vite, Turbo, SvelteKit, Astro, and Nuxt root caches
// plus Vite's node_modules/.vite dep-optimization cache (distinct from a
// root-level .vite directory). Missing dirs are tolerated by removal callers.
const CACHE_DIRS: readonly string[] = [
  ".next",
  ".vite",
  ".turbo",
  ".svelte-kit",
  ".astro",
  ".nuxt",
  path.join("node_modules", ".vite"),
];

const DEFAULT_TIMEOUT_MS = 8000;
const DEV_PREVIEW_STOP_ESCALATION_MS = 5000;
const STALE_START_RECOVERY_MS = 10000;
const STARTUP_REPLAY_DELAY_MS = 1500;
const REPLAY_HISTORY_MAX_LINES = 300;
const PTY_SUBMIT_AFTER_SPAWN_MS = 100;
const COMPILE_ARM_MS = 1000;
const COMPILE_CLEAR_MS = 1500;

// Bounds for the `lastOutput` activity hint surfaced in the cross-worktree
// dashboard. Only the buffer tail is scanned (the last line is all we need) and
// the result is capped so a single pathological line can't bloat the snapshot.
const LAST_OUTPUT_SCAN_BYTES = 2000;
const LAST_OUTPUT_MAX_CHARS = 120;

// Per-session crash-loop guard. A broken config (missing deps that an install
// can't fix) otherwise drives an unbounded install→crash→reinstall cycle that
// burns CPU and battery. The guard counts consecutive fast cycles, backs off
// geometrically between re-install attempts, and after CRASH_LOOP_MAX_ATTEMPTS
// halts auto-respawn into a recoverable "stopped" state. A dev server that
// survives CRASH_LOOP_MIN_UPTIME_MS graduates and resets the counter. Values
// are tuned for a dev workflow (sub-3s cap) — not Kubernetes-style multi-minute
// waits — so a developer who just fixed the bug isn't punished. The first
// re-install in a fresh window runs immediately; backoff applies only to
// repeats.
const CRASH_LOOP_MIN_UPTIME_MS = 5000;
const CRASH_LOOP_INITIAL_DELAY_MS = 500;
const CRASH_LOOP_BACKOFF_MULTIPLIER = 1.5;
const CRASH_LOOP_MAX_DELAY_MS = 3000;
const CRASH_LOOP_MAX_ATTEMPTS = 5;

// Bounds for the per-session diagnostics timeline. The ring keeps the last
// DIAGNOSTIC_RING_MAX events per session key; the map keeps rings for the last
// DIAGNOSTIC_SESSIONS_MAX keys touched so a timeline survives hibernation /
// panel-close (the session object is deleted but its ring stays inspectable)
// without growing unbounded across a long app session. Free-text fields are
// capped so one pathological error line can't bloat a snapshot.
export const DIAGNOSTIC_RING_MAX = 100;
const DIAGNOSTIC_SESSIONS_MAX = 50;
const DIAGNOSTIC_TEXT_MAX = 200;
// Consecutive identical proxy failures coalesce into one event with a count —
// a webview retry storm must not evict the lifecycle history it explains.
const PROXY_EVENT_COALESCE_MS = 10_000;

// A diagnostic event as recorded at a call site: the ring assigns at/seq/
// generation/count. Distributes over the union so each variant keeps its
// typed details.
type DiagnosticInput<T = DevPreviewDiagnosticEvent> = T extends DevPreviewDiagnosticEvent
  ? Omit<T, "at" | "seq" | "generation" | "count">
  : never;

function capDiagnosticText(text: string): string {
  return text.length > DIAGNOSTIC_TEXT_MAX ? text.slice(0, DIAGNOSTIC_TEXT_MAX) : text;
}

/**
 * Parse both the port AND the transport scheme out of a detected dev-server URL (#9974).
 * Returns null if absent/unparseable. `isHttps` is true only when the URL scheme is
 * `https:` — a dev server running over TLS (Vite `server.https`, Next.js
 * `--experimental-https`, mkcert) must be dialed over HTTPS, not plain HTTP.
 */
function parseUrlEndpoint(url: string | null): { port: number; isHttps: boolean } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    if (!isHttps && parsed.protocol !== "http:") return null;
    // WHATWG URL strips the port when it equals the scheme default, so `https://localhost/` and
    // `https://localhost:443/` both surface an empty `parsed.port`. Fall back to the scheme's
    // default port rather than discarding the endpoint (which would otherwise dial the wrong port
    // over plain HTTP via the registry fallback).
    const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0) return null;
    return { port, isHttps };
  } catch {
    return null;
  }
}

export class DevPreviewSessionService {
  private readonly detector = new UrlDetector();
  private readonly textDecoder = new TextDecoder();
  private readonly sessions = new Map<string, DevPreviewSession>();
  private readonly terminalToSession = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly portRegistry = new Map<string, number>(); // sessionKey -> allocated port
  private readonly worktreeToSession = new Map<string, string>(); // worktreeId -> sessionKey
  // Spawn metadata for sessions that were running when Daintree last closed,
  // loaded once at first init. A panel with a matching entry and no live
  // session reports status "restored-stopped" so the UI can offer a restart.
  // Entries are dropped the moment a real session is created for that key.
  private readonly restoredEntries = new Map<string, DevPreviewManifestEntry>();
  // Per-session diagnostics timeline (sessionKey -> bounded ring). Kept in a
  // separate map (not on the session object) so the timeline outlives session
  // deletion — a "why did my server stop?" after hibernation or panel-close is
  // exactly what this exists to answer. LRU-bounded via re-insertion on write.
  private readonly diagnostics = new Map<
    string,
    { events: DevPreviewDiagnosticEvent[]; seq: number }
  >();
  // In-flight waitForPortFree aborts, so dispose() doesn't leave locked tasks
  // polling a busy port for up to PORT_FREE_TIMEOUT_MS after app quit began.
  private readonly portWaitAborts = new Set<AbortController>();
  private readonly onDataListener: (id: string, data: string | Uint8Array) => void;
  private readonly onExitListener: (id: string, exitCode: number, signal?: number) => void;

  constructor(
    private readonly ptyClient: PtyClient,
    private readonly onStateChanged: (state: DevPreviewSessionState) => void,
    restoredEntries: readonly DevPreviewManifestEntry[] = [],
    // Persists the running-session manifest. Invoked on two kinds of event:
    // when a session ENTERS a running state (so a later crash can restore it),
    // and after an EXPLICIT user stop (so the manifest stops offering a restart
    // for a server the user deliberately stopped). Deliberately NOT invoked from
    // handleExit — a process exit at shutdown must leave the manifest intact so
    // the next launch can offer the restart (#9094).
    private readonly onPersistManifest: (entries: DevPreviewManifestEntry[]) => void = () => {},
    // Fired alongside onStateChanged with a snapshot of EVERY session (live and
    // restored), powering the cross-worktree dev-server dashboard. Optional with
    // a no-op default so the 2-arg test fixtures and other call sites that don't
    // need the global view are unaffected.
    private readonly onAllSessionsChanged: (sessions: DevPreviewSessionState[]) => void = () => {}
  ) {
    this.onDataListener = this.handleData.bind(this);
    this.onExitListener = this.handleExit.bind(this);
    // Mirrored dev-server output arrives as "data-mirror" (Main-process-only
    // copy of chunks the renderer already received on its visual path); plain
    // "data" still carries the IPC-fallback case where no window's port took
    // the chunk. URL detection needs both.
    this.ptyClient.on("data", this.onDataListener);
    this.ptyClient.on("data-mirror", this.onDataListener);
    this.ptyClient.on("exit", this.onExitListener);
    for (const entry of restoredEntries) {
      this.restoredEntries.set(createSessionKey(entry.projectId, entry.panelId), entry);
    }
  }

  private persistManifest(): void {
    if (this.disposed) return;
    try {
      this.onPersistManifest(this.captureManifest());
    } catch (err) {
      console.warn("[DevPreviewSessionService] persistManifest failed:", err);
    }
  }

  /**
   * Snapshot the spawn metadata of every currently-running session for the
   * restore manifest. Captures only RUNNING_STATES — stopped/error sessions
   * have nothing meaningful to restart. `lastKnownPort` comes from the port
   * registry (populated even while a session is still starting, when `url` is
   * not yet known) and is informational only.
   *
   * Must be called BEFORE the PTYs are killed at shutdown: a killed dev-server
   * PTY fires `exit`, which transitions its session out of RUNNING_STATES, so a
   * post-kill capture would return nothing.
   */
  captureManifest(): DevPreviewManifestEntry[] {
    const entries: DevPreviewManifestEntry[] = [];
    for (const [key, session] of this.sessions) {
      if (!RUNNING_STATES.has(session.status)) continue;
      if (!session.devCommand.trim() || !session.cwd) continue;
      entries.push({
        panelId: session.panelId,
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        cwd: session.cwd,
        devCommand: session.devCommand,
        env: session.env ? { ...session.env } : undefined,
        turbopackEnabled: session.turbopackEnabled,
        lastKnownPort: this.portRegistry.get(key) ?? null,
        capturedAt: Date.now(),
      });
    }
    return entries;
  }

  /**
   * After a session is deleted, remove its stale worktreeToSession entry and
   * hand the mapping back to any surviving session that still claims the same worktreeId.
   */
  private restoreWorktreeMapping(worktreeId: string | undefined, deletedKey: string): void {
    if (!worktreeId) return;
    if (this.worktreeToSession.get(worktreeId) !== deletedKey) return;
    this.worktreeToSession.delete(worktreeId);
    for (const [survivingKey, survivingSession] of this.sessions) {
      if (survivingSession.worktreeId === worktreeId) {
        this.worktreeToSession.set(worktreeId, survivingKey);
        break;
      }
    }
  }

  getByWorktree(worktreeId: string): DevPreviewSessionState | null {
    const key = this.worktreeToSession.get(worktreeId);
    if (key) {
      const session = this.sessions.get(key);
      if (session) return this.toPublicState(session);
    }
    // Fall back to a restore placeholder so callers (e.g. the worktree-delete
    // dialog) still surface a dangling dev-preview panel that was running when
    // Daintree last closed but hasn't been restarted yet. #9094.
    for (const entry of this.restoredEntries.values()) {
      if (entry.worktreeId === worktreeId) {
        return this.getSessionState(entry.projectId, entry.panelId);
      }
    }
    return null;
  }

  /**
   * Snapshot of every dev-preview session across all worktrees — live sessions
   * plus any restore placeholders not yet superseded by a live session. Powers
   * the cross-worktree dashboard and the all-sessions push channel. Mirrors the
   * restore-placeholder fallback in getByWorktree so the dashboard never misses
   * a dangling session the worktree-delete dialog already surfaces.
   */
  getAllSessions(): DevPreviewSessionState[] {
    const result: DevPreviewSessionState[] = [];
    for (const session of this.sessions.values()) {
      result.push(this.toPublicState(session));
    }
    for (const [key, entry] of this.restoredEntries) {
      // A live session always supersedes its restore placeholder (the entry is
      // dropped in getOrCreateSession), but guard anyway so a key can't appear
      // twice if that invariant ever changes.
      if (this.sessions.has(key)) continue;
      result.push({
        panelId: entry.panelId,
        projectId: entry.projectId,
        worktreeId: entry.worktreeId,
        status: "restored-stopped",
        url: null,
        predictedUrl: null,
        error: null,
        terminalId: null,
        isRestarting: false,
        generation: 0,
        updatedAt: entry.capturedAt,
        forceKilled: undefined,
        phaseLabel: undefined,
      });
    }
    return result;
  }

  /**
   * Resolve a dev-preview proxy subdomain (`dp-<projectToken>-<panelToken>`) to the upstream
   * dev-server port for that panel, or null when none is live (#9100). Used by
   * DevPreviewProxyService to forward each request without coupling to session internals.
   * We rebuild the expected subdomain per session and match on equality — avoiding any
   * ambiguous split of a label whose sanitized tokens may themselves contain hyphens.
   */
  getUpstreamPortForSubdomain(subdomain: string): { port: number; isHttps: boolean } | null {
    const resolved = this.resolveUpstream(subdomain);
    return resolved.kind === "ok" ? { port: resolved.port, isHttps: resolved.isHttps } : null;
  }

  /**
   * Classified variant of getUpstreamPortForSubdomain: says WHY there is no
   * upstream instead of collapsing every miss to null, so the proxy can 502
   * with an accurate message and the diagnostics timeline can name the cause.
   */
  resolveUpstream(subdomain: string): DevPreviewUpstreamResolution {
    for (const session of this.sessions.values()) {
      if (buildDevPreviewSubdomain(session.projectId, session.panelId) !== subdomain) continue;
      // Only forward to a live server. After an explicit stop the registry entry lingers
      // (the success path doesn't release it), so a stale port could otherwise be handed to
      // whatever process later binds it.
      if (!RUNNING_STATES.has(session.status)) {
        return { kind: "not-running", status: session.status };
      }
      // Prefer the port AND scheme the dev server actually bound — UrlDetector overwrites
      // session.url when the server lands on a different port than the one allocated (a command
      // that ignores the injected PORT), and the URL carries the scheme (http vs https) so an
      // HTTPS dev server is dialed over TLS instead of getting a 502 (#9974). Fall back to the
      // allocated port (always plain HTTP) while still starting, before any URL has been detected.
      const detected = parseUrlEndpoint(session.url);
      if (detected !== null) return { kind: "ok", port: detected.port, isHttps: detected.isHttps };
      const fallbackPort = this.portRegistry.get(
        createSessionKey(session.projectId, session.panelId)
      );
      return fallbackPort !== undefined
        ? { kind: "ok", port: fallbackPort, isHttps: false }
        : { kind: "not-running", status: session.status };
    }
    for (const entry of this.restoredEntries.values()) {
      if (buildDevPreviewSubdomain(entry.projectId, entry.panelId) === subdomain) {
        return { kind: "not-running", status: "restored-stopped" };
      }
    }
    return { kind: "unknown-subdomain" };
  }

  dispose(): void {
    this.disposed = true;
    this.ptyClient.off("data", this.onDataListener);
    this.ptyClient.off("data-mirror", this.onDataListener);
    this.ptyClient.off("exit", this.onExitListener);
    for (const abort of this.portWaitAborts) {
      abort.abort();
    }
    this.portWaitAborts.clear();
    for (const session of this.sessions.values()) {
      this.clearStartupReplay(session);
      session.readinessAbort?.abort();
      session.backoffAbort?.abort();
      this.clearCompiling(session);
    }
    for (const terminalId of this.terminalToSession.keys()) {
      this.ptyClient.setIpcDataMirror(terminalId, false);
      try {
        this.ptyClient.kill(terminalId, "dev-preview:dispose");
      } catch (err) {
        const message = formatErrorMessage(err, "Failed to kill dev preview terminal");
        if (!this.isBenignMissingTerminalError(message)) {
          console.warn("[DevPreviewSessionService] Failed to kill terminal during dispose:", err);
        }
      }
    }
    this.terminalToSession.clear();
    this.sessions.clear();
    this.locks.clear();
    this.portRegistry.clear();
    this.worktreeToSession.clear();
    this.diagnostics.clear();
  }

  async ensure(request: DevPreviewEnsureRequest): Promise<DevPreviewSessionState> {
    validateEnsureRequest(request);
    if (this.disposed) return this.getSessionState(request.projectId, request.panelId);
    markPerformance(PERF_MARKS.DEVPREVIEW_ENSURE_START, {
      panelId: request.panelId,
      projectId: request.projectId,
      worktreeId: request.worktreeId ?? null,
    });
    const key = createSessionKey(request.projectId, request.panelId);
    let state: DevPreviewSessionState | undefined;
    await this.runLocked(key, async () => {
      if (this.disposed) return;
      const session = this.getOrCreateSession(request.projectId, request.panelId);
      const envChanged = !envEquals(session.env, request.env);
      const nextTurbopackEnabled = request.turbopackEnabled ?? true;
      const changedFields: string[] = [];
      if (session.cwd !== request.cwd) changedFields.push("cwd");
      if (session.worktreeId !== request.worktreeId) changedFields.push("worktreeId");
      if (session.devCommand !== request.devCommand) changedFields.push("devCommand");
      if (session.turbopackEnabled !== nextTurbopackEnabled) changedFields.push("turbopackEnabled");
      if (envChanged) changedFields.push("env");
      const configChanged = changedFields.length > 0;

      this.recordSessionDiagnostic(session, { type: "ensure-requested", configChanged });
      if (configChanged) {
        this.recordSessionDiagnostic(session, { type: "config-changed", changed: changedFields });
      }

      session.cwd = request.cwd;
      const prevWorktreeId = session.worktreeId;
      session.worktreeId = request.worktreeId;
      session.devCommand = request.devCommand;
      session.turbopackEnabled = nextTurbopackEnabled;
      if (envChanged) {
        session.env = cloneEnv(request.env);
      }

      // A config change is an explicit "try again with new settings" — clear a
      // tripped crash-loop guard so the fresh config gets its full attempt
      // budget instead of inheriting a stopped state from the old config.
      if (configChanged) {
        this.resetCrashLoopGuard(session);
      }

      if (prevWorktreeId && prevWorktreeId !== session.worktreeId) {
        this.worktreeToSession.delete(prevWorktreeId);
      }
      if (session.worktreeId) {
        const sessionKey = createSessionKey(session.projectId, session.panelId);
        this.worktreeToSession.set(session.worktreeId, sessionKey);
      }

      const commandError = getInvalidCommandMessage(session.devCommand);
      if (commandError) {
        this.recordSessionDiagnostic(session, {
          type: "command-invalid",
          message: capDiagnosticText(commandError),
        });
        if (configChanged && session.terminalId) {
          await this.stopSessionTerminal(session, "invalid-command");
        }
        this.updateSession(session, {
          status: "error",
          error: { type: "unknown", message: commandError },
          url: null,
          predictedUrl: null,
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      if (configChanged && session.terminalId) {
        await this.stopSessionTerminal(session, "config-change");
      }

      await this.ensureSessionTerminal(session);
      state = this.getSessionState(request.projectId, request.panelId);
    });
    return state ?? this.getSessionState(request.projectId, request.panelId);
  }

  async restart(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    validateSessionRequest(request);
    const restartStartedAt = Date.now();
    markPerformance(PERF_MARKS.DEVPREVIEW_RESTART_START, {
      panelId: request.panelId,
      projectId: request.projectId,
    });
    const key = createSessionKey(request.projectId, request.panelId);
    let state: DevPreviewSessionState | undefined;
    try {
      await this.runLocked(key, async () => {
        const session = this.sessions.get(key);
        if (!session) return;

        // User-initiated restart cancels any pending crash-loop backoff and
        // clears the guard so this attempt starts from a clean slate.
        this.resetCrashLoopGuard(session);

        const commandError = getInvalidCommandMessage(session.devCommand);
        if (commandError) {
          if (session.terminalId) {
            await this.stopSessionTerminal(session, "invalid-command");
          }
          this.updateSession(session, {
            status: "error",
            error: { type: "unknown", message: commandError },
            url: null,
            predictedUrl: null,
            terminalId: null,
            isRestarting: false,
          });
          state = this.getSessionState(request.projectId, request.panelId);
          return;
        }

        this.recordSessionDiagnostic(session, { type: "restart-requested", mode: "restart" });
        this.updateSession(session, {
          status: "starting",
          url: null,
          error: null,
          isRestarting: true,
          forceKilled: undefined,
        });

        await this.stopSessionTerminal(session, "restart");
        if (!(await this.waitForRegisteredPortFree(session, key))) {
          state = this.getSessionState(request.projectId, request.panelId);
          return;
        }
        await this.spawnSessionTerminal(session);
        state = this.getSessionState(request.projectId, request.panelId);
      });
    } finally {
      markPerformance(PERF_MARKS.DEVPREVIEW_RESTART_END, {
        panelId: request.panelId,
        projectId: request.projectId,
        durationMs: Date.now() - restartStartedAt,
      });
    }
    return state ?? this.getSessionState(request.projectId, request.panelId);
  }

  async restartAndClearCache(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    validateSessionRequest(request);
    const key = createSessionKey(request.projectId, request.panelId);
    await this.runLocked(key, async () => {
      const session = this.sessions.get(key);
      if (!session) return;

      this.resetCrashLoopGuard(session);

      const commandError = getInvalidCommandMessage(session.devCommand);
      if (commandError) {
        if (session.terminalId) {
          await this.stopSessionTerminal(session, "invalid-command");
        }
        this.updateSession(session, {
          status: "error",
          error: { type: "unknown", message: commandError },
          url: null,
          predictedUrl: null,
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      this.recordSessionDiagnostic(session, { type: "restart-requested", mode: "clear-cache" });
      this.updateSession(session, {
        status: "starting",
        url: null,
        error: null,
        isRestarting: true,
      });

      // Caches must be deleted only after the PTY is confirmed dead — Vite and
      // Next.js hold file handles on these directories, and a live process
      // causes EPERM on Windows.
      await this.stopSessionTerminal(session, "restart-clear-cache");

      if (!(await this.waitForRegisteredPortFree(session, key))) {
        return;
      }

      const deletionError = await this.clearCacheDirs(session.cwd);
      if (deletionError) {
        this.updateSession(session, {
          status: "error",
          url: null,
          predictedUrl: null,
          error: {
            type: "unknown",
            message: `Failed to clear cache: ${deletionError}`,
          },
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      await this.spawnSessionTerminal(session);
    });
    return this.getSessionState(request.projectId, request.panelId);
  }

  async reinstallAndRestart(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    validateSessionRequest(request);
    const key = createSessionKey(request.projectId, request.panelId);
    await this.runLocked(key, async () => {
      const session = this.sessions.get(key);
      if (!session) return;

      this.resetCrashLoopGuard(session);

      const commandError = getInvalidCommandMessage(session.devCommand);
      if (commandError) {
        if (session.terminalId) {
          await this.stopSessionTerminal(session, "invalid-command");
        }
        this.updateSession(session, {
          status: "error",
          error: { type: "unknown", message: commandError },
          url: null,
          predictedUrl: null,
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      this.recordSessionDiagnostic(session, { type: "restart-requested", mode: "reinstall" });
      this.updateSession(session, {
        status: "starting",
        url: null,
        error: null,
        isRestarting: true,
      });

      await this.stopSessionTerminal(session, "reinstall-restart");

      // node_modules deletion uses retries because Windows Defender frequently
      // holds locks on files mid-scan, surfacing as transient EPERM/EBUSY.
      try {
        await fsPromises.rm(path.join(session.cwd, "node_modules"), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch (err) {
        const message = formatErrorMessage(err, "Failed to remove node_modules");
        this.updateSession(session, {
          status: "error",
          url: null,
          predictedUrl: null,
          error: {
            type: "unknown",
            message: `Failed to remove node_modules: ${message}`,
          },
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      // runInstall spawns its own install PTY; the handleExit chain respawns
      // the dev server when the install exits 0. Do NOT call
      // spawnSessionTerminal here — that would double-spawn.
      await this.runInstall(session);
    });
    return this.getSessionState(request.projectId, request.panelId);
  }

  /**
   * Deletes the framework cache directories under cwd. Returns an error
   * message string if any deletion failed, or null on success. `force: true`
   * makes missing directories a no-op.
   */
  private async clearCacheDirs(cwd: string): Promise<string | null> {
    const failures: string[] = [];
    for (const dir of CACHE_DIRS) {
      try {
        await fsPromises.rm(path.join(cwd, dir), { recursive: true, force: true });
      } catch (err) {
        failures.push(`${dir} (${formatErrorMessage(err, "deletion failed")})`);
      }
    }
    return failures.length > 0 ? failures.join(", ") : null;
  }

  async stop(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    validateSessionRequest(request);
    const key = createSessionKey(request.projectId, request.panelId);
    await this.runLocked(key, async () => {
      const session = this.sessions.get(key);
      if (!session) return;

      // An explicit stop ends the session — clear the guard (and any pending
      // backoff) so it can't auto-respawn behind the user's back. The terminal
      // branch routes through stopSessionTerminal, but a stop arriving mid
      // backoff has no live terminal and would otherwise skip the abort.
      this.resetCrashLoopGuard(session);

      this.recordSessionDiagnostic(session, { type: "stop-requested", context: "stop" });

      if (session.terminalId) {
        this.updateSession(session, { status: "stopping", isRestarting: false });
        const stopStartedAt = performance.now();
        await this.stopSessionTerminal(session, "stop", DEV_PREVIEW_STOP_ESCALATION_MS);
        const forceKilled = performance.now() - stopStartedAt >= DEV_PREVIEW_STOP_ESCALATION_MS;

        const port = this.portRegistry.get(key);
        if (port !== undefined) {
          const portAbort = new AbortController();
          this.portWaitAborts.add(portAbort);
          const portFree = await waitForPortFree(port, portAbort.signal).finally(() => {
            this.portWaitAborts.delete(portAbort);
          });
          if (!portFree) {
            // Release the registry entry so a subsequent ensure() picks a fresh
            // port via allocatePort instead of immediately re-hitting the busy one.
            releasePort(this.portRegistry, key);
            this.recordSessionDiagnostic(session, { type: "port-conflict", port });
            this.updateSession(session, {
              status: "error",
              url: null,
              predictedUrl: null,
              error: {
                type: "port-conflict",
                message: `Port ${port} did not release within ${PORT_FREE_TIMEOUT_MS / 1000}s after stopping. Retry to start again.`,
                port: String(port),
              },
              terminalId: null,
              isRestarting: false,
              forceKilled,
              phaseLabel: undefined,
            });
            return;
          }
        }

        this.updateSession(session, {
          status: "stopped",
          url: null,
          predictedUrl: null,
          error: null,
          terminalId: null,
          isRestarting: false,
          forceKilled,
          phaseLabel: undefined,
        });
      } else {
        this.updateSession(session, {
          status: "stopped",
          url: null,
          predictedUrl: null,
          error: null,
          terminalId: null,
          isRestarting: false,
          phaseLabel: undefined,
        });
      }
    });
    // Explicit user stop — drop this session from the restore manifest so the
    // next launch doesn't offer to restart a server the user chose to stop.
    this.persistManifest();
    return this.getSessionState(request.projectId, request.panelId);
  }

  async stopByPanel(request: DevPreviewStopByPanelRequest): Promise<void> {
    validateStopByPanelRequest(request);
    const targets = [...this.sessions.values()].filter(
      (session) => session.panelId === request.panelId
    );

    await Promise.all(
      targets.map(async (session) => {
        const key = createSessionKey(session.projectId, session.panelId);
        await this.runLocked(key, async () => {
          try {
            this.recordSessionDiagnostic(session, {
              type: "stop-requested",
              context: "panel-closed",
            });
            await this.stopSessionTerminal(session, "panel-closed");
            this.updateSession(session, {
              status: "stopped",
              url: null,
              predictedUrl: null,
              error: null,
              terminalId: null,
              isRestarting: false,
            });
            this.sessions.delete(key);
            releasePort(this.portRegistry, key);
            this.restoreWorktreeMapping(session.worktreeId, key);
          } catch (err) {
            const message = formatErrorMessage(err, "Failed to stop dev preview");
            this.updateSession(session, {
              status: "error",
              url: null,
              predictedUrl: null,
              error: { type: "unknown", message: `Failed to stop dev preview: ${message}` },
              terminalId: null,
              isRestarting: false,
            });
            console.warn("[DevPreviewSessionService] stopByPanel failed for session", {
              panelId: session.panelId,
              projectId: session.projectId,
              error: message,
            });
          }
        });
      })
    );
    this.persistManifest();
  }

  async stopByProject(projectId: string): Promise<void> {
    const targets = [...this.sessions.entries()].filter(
      ([, session]) => session.projectId === projectId
    );

    await Promise.all(
      targets.map(async ([key, session]) => {
        await this.runLocked(key, async () => {
          try {
            this.recordSessionDiagnostic(session, {
              type: "stop-requested",
              context: "project-hibernated",
            });
            await this.stopSessionTerminal(session, "project-hibernated");
            this.updateSession(session, {
              status: "stopped",
              url: null,
              predictedUrl: null,
              error: null,
              terminalId: null,
              isRestarting: false,
            });
            this.sessions.delete(key);
            releasePort(this.portRegistry, key);
            this.restoreWorktreeMapping(session.worktreeId, key);
          } catch (err) {
            const message = formatErrorMessage(err, "Failed to stop dev preview");
            console.warn("[DevPreviewSessionService] stopByProject failed for session", {
              panelId: session.panelId,
              projectId: session.projectId,
              error: message,
            });
          }
        });
      })
    );
    this.persistManifest();
  }

  async stopDevServerByWorktree(worktreeId: string): Promise<DevPreviewSessionState> {
    const key = this.worktreeToSession.get(worktreeId);
    if (!key) {
      return {
        panelId: "",
        projectId: "",
        worktreeId: undefined,
        status: "stopped",
        url: null,
        predictedUrl: null,
        error: null,
        terminalId: null,
        isRestarting: false,
        generation: 0,
        updatedAt: Date.now(),
        forceKilled: undefined,
        phaseLabel: undefined,
      };
    }
    const session = this.sessions.get(key);
    if (!session) {
      return {
        panelId: "",
        projectId: "",
        worktreeId: undefined,
        status: "stopped",
        url: null,
        predictedUrl: null,
        error: null,
        terminalId: null,
        isRestarting: false,
        generation: 0,
        updatedAt: Date.now(),
        forceKilled: undefined,
        phaseLabel: undefined,
      };
    }
    return this.stop({ panelId: session.panelId, projectId: session.projectId });
  }

  async restartByWorktree(worktreeId: string): Promise<DevPreviewSessionState> {
    const key = this.worktreeToSession.get(worktreeId);
    const session = key ? this.sessions.get(key) : undefined;
    if (session) {
      return this.restart({ panelId: session.panelId, projectId: session.projectId });
    }

    // No live session — fall back to a restore placeholder so the dashboard's
    // restart offer for a server that was running when Daintree last closed
    // actually spawns it. This is an explicit user action, so (unlike a launch)
    // spawning IS the intended behavior here (#9094); ensure() drops the
    // manifest entry and starts the PTY. Mirrors getByWorktree's restore
    // fallback so the dashboard restart isn't a silent no-op.
    for (const entry of this.restoredEntries.values()) {
      if (entry.worktreeId === worktreeId) {
        return this.ensure({
          panelId: entry.panelId,
          projectId: entry.projectId,
          cwd: entry.cwd,
          devCommand: entry.devCommand,
          worktreeId: entry.worktreeId,
          env: entry.env,
          turbopackEnabled: entry.turbopackEnabled,
        });
      }
    }

    return {
      panelId: "",
      projectId: "",
      worktreeId: undefined,
      status: "stopped",
      url: null,
      predictedUrl: null,
      error: null,
      terminalId: null,
      isRestarting: false,
      generation: 0,
      updatedAt: Date.now(),
      forceKilled: undefined,
      phaseLabel: undefined,
    };
  }

  // Called from the renderer's worktree delete path BEFORE `git worktree
  // remove` runs. On Windows the dev server holds a directory lock — if the
  // session isn't stopped first, the removal fails outright (#9084). The
  // first stop failure rejects so the caller can abort the delete before
  // git removal makes a partial mess.
  async stopByWorktree(worktreeId: string): Promise<void> {
    const targets = [...this.sessions.entries()].filter(
      ([, session]) => session.worktreeId === worktreeId
    );

    const errors: unknown[] = [];
    await Promise.all(
      targets.map(async ([key, session]) => {
        await this.runLocked(key, async () => {
          try {
            this.recordSessionDiagnostic(session, {
              type: "stop-requested",
              context: "worktree-delete",
            });
            await this.stopSessionTerminal(session, "worktree-delete");
            this.updateSession(session, {
              status: "stopped",
              url: null,
              predictedUrl: null,
              error: null,
              terminalId: null,
              isRestarting: false,
            });
            this.sessions.delete(key);
            releasePort(this.portRegistry, key);
            this.restoreWorktreeMapping(session.worktreeId, key);
          } catch (err) {
            const message = formatErrorMessage(err, "Failed to stop dev preview");
            console.warn("[DevPreviewSessionService] stopByWorktree failed for session", {
              panelId: session.panelId,
              projectId: session.projectId,
              worktreeId: session.worktreeId,
              error: message,
            });
            errors.push(err);
          }
        });
      })
    );

    // Drop any restore placeholder for this worktree too — the worktree is
    // being removed, so its dev server must not be offered for restart.
    for (const [key, entry] of this.restoredEntries) {
      if (entry.worktreeId === worktreeId) {
        this.restoredEntries.delete(key);
      }
    }
    this.persistManifest();
    // Live sessions broadcast via updateSession above, but a restore-only
    // placeholder removal has no such trigger — push a fresh snapshot so the
    // dashboard drops the now-gone row instead of showing it until a remount.
    if (!this.disposed) {
      this.onAllSessionsChanged(this.getAllSessions());
    }

    if (errors.length > 0) {
      throw errors[0];
    }
  }

  getState(request: DevPreviewSessionRequest): DevPreviewSessionState {
    validateSessionRequest(request);
    return this.getSessionState(request.projectId, request.panelId);
  }

  /**
   * Append a diagnostic event to a session key's bounded ring. Consecutive
   * identical proxy failures coalesce into one event with a count so a webview
   * retry storm can't evict the lifecycle history. Writing touches the key's
   * LRU position; the oldest untouched key is dropped past DIAGNOSTIC_SESSIONS_MAX.
   */
  private recordDiagnostic(key: string, generation: number, input: DiagnosticInput): void {
    if (this.disposed) return;
    let ring = this.diagnostics.get(key);
    if (ring) {
      this.diagnostics.delete(key);
    } else {
      ring = { events: [], seq: 0 };
    }
    this.diagnostics.set(key, ring);
    while (this.diagnostics.size > DIAGNOSTIC_SESSIONS_MAX) {
      const oldest = this.diagnostics.keys().next().value;
      if (oldest === undefined) break;
      this.diagnostics.delete(oldest);
    }

    // Coalesce only true repeats: same failure, same errno, same generation —
    // a post-restart failure or a different errno must stay its own event.
    const last = ring.events[ring.events.length - 1];
    if (
      (input.type === "proxy-502" || input.type === "proxy-ws-failed") &&
      last !== undefined &&
      last.type === input.type &&
      last.cause === input.cause &&
      last.code === input.code &&
      last.generation === generation &&
      Date.now() - last.at <= PROXY_EVENT_COALESCE_MS
    ) {
      last.count = (last.count ?? 1) + 1;
      last.at = Date.now();
      return;
    }

    ring.events.push({
      ...input,
      at: Date.now(),
      seq: ring.seq++,
      generation,
    } as DevPreviewDiagnosticEvent);
    if (ring.events.length > DIAGNOSTIC_RING_MAX) {
      ring.events.splice(0, ring.events.length - DIAGNOSTIC_RING_MAX);
    }
  }

  private recordSessionDiagnostic(session: DevPreviewSession, input: DiagnosticInput): void {
    this.recordDiagnostic(
      createSessionKey(session.projectId, session.panelId),
      session.generation,
      input
    );
  }

  /**
   * Entry point for DevPreviewProxyService failure reports. Resolves the
   * subdomain back to a session key; a report that matches no session (cause
   * "no-session") has no timeline to land on and is dropped — the proxy's own
   * 502 body is the receipt for that case.
   */
  recordProxyDiagnostic(diagnostic: {
    subdomain: string;
    kind: "http" | "ws";
    cause: DevPreviewProxyFailureCause;
    code?: string;
  }): void {
    if (this.disposed) return;
    for (const [key, session] of this.sessions) {
      if (buildDevPreviewSubdomain(session.projectId, session.panelId) !== diagnostic.subdomain) {
        continue;
      }
      this.recordDiagnostic(key, session.generation, {
        type: diagnostic.kind === "ws" ? "proxy-ws-failed" : "proxy-502",
        cause: diagnostic.cause,
        ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
      });
      return;
    }
  }

  /**
   * Read snapshot for the diagnostics UI and IPC query. Pure read: never
   * creates a session, never mutates state. Works for live sessions, restore
   * placeholders, and already-deleted sessions whose ring is still retained.
   */
  getDiagnostics(request: DevPreviewSessionRequest): DevPreviewDiagnosticsSnapshot {
    validateSessionRequest(request);
    const key = createSessionKey(request.projectId, request.panelId);
    // Copy the event objects, not just the array: coalescing mutates the last
    // ring entry in place (count/at), and a snapshot must not change after it
    // was taken. `changed` is the only nested field.
    const events: DevPreviewDiagnosticEvent[] = (this.diagnostics.get(key)?.events ?? []).map(
      (event) =>
        event.type === "config-changed" ? { ...event, changed: [...event.changed] } : { ...event }
    );
    const upstream = this.resolveUpstream(
      buildDevPreviewSubdomain(request.projectId, request.panelId)
    );
    const session = this.sessions.get(key);
    if (!session) {
      const restored = this.restoredEntries.get(key);
      return {
        panelId: request.panelId,
        projectId: request.projectId,
        worktreeId: restored?.worktreeId,
        status: restored ? "restored-stopped" : "stopped",
        generation: 0,
        updatedAt: restored?.capturedAt ?? Date.now(),
        allocatedPort: this.portRegistry.get(key) ?? null,
        detectedUrl: null,
        upstream,
        crashLoop: { count: 0, stopped: false, backoffPending: false },
        restoredFromManifest: restored !== undefined,
        events,
      };
    }
    return {
      panelId: session.panelId,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      status: session.status,
      generation: session.generation,
      updatedAt: session.updatedAt,
      allocatedPort: this.portRegistry.get(key) ?? null,
      detectedUrl: session.url,
      upstream,
      crashLoop: {
        count: session.crashCount,
        stopped: session.crashLoopStopped,
        backoffPending: session.backoffAbort !== null,
      },
      restoredFromManifest: session.restoredFromManifest,
      events,
    };
  }

  private getOrCreateSession(projectId: string, panelId: string): DevPreviewSession {
    const key = createSessionKey(projectId, panelId);
    let session = this.sessions.get(key);
    if (session) return session;

    // A real session supersedes any restore placeholder for this key — drop the
    // manifest entry so getSessionState stops reporting "restored-stopped" once
    // the user has restarted (or anything else spawned the server).
    const hadRestoredEntry = this.restoredEntries.delete(key);

    session = {
      panelId,
      projectId,
      worktreeId: undefined,
      status: "stopped",
      url: null,
      predictedUrl: null,
      error: null,
      terminalId: null,
      isRestarting: false,
      generation: 0,
      updatedAt: Date.now(),
      updatedAtPerformanceMs: performance.now(),
      phaseLabel: undefined,
      cwd: "",
      devCommand: "",
      turbopackEnabled: true,
      env: undefined,
      buffer: "",
      lastErrorKey: null,
      pendingUrl: null,
      readinessAbort: null,
      markerSeen: false,
      needsInstall: false,
      isRunningInstall: false,
      installAttemptedGeneration: null,
      startupReplayTimer: null,
      compiling: false,
      compilingTimer: null,
      compilingClearTimer: null,
      crashCount: 0,
      devSpawnedAt: null,
      backoffAbort: null,
      crashLoopStopped: false,
      restoredFromManifest: hadRestoredEntry,
    };
    this.sessions.set(key, session);
    if (hadRestoredEntry) {
      this.recordSessionDiagnostic(session, { type: "manifest-restored" });
    }
    return session;
  }

  private getSessionState(projectId: string, panelId: string): DevPreviewSessionState {
    const key = createSessionKey(projectId, panelId);
    const session = this.sessions.get(key);
    if (!session) {
      const restored = this.restoredEntries.get(key);
      return {
        panelId,
        projectId,
        worktreeId: restored?.worktreeId,
        status: restored ? "restored-stopped" : "stopped",
        url: null,
        predictedUrl: null,
        error: null,
        terminalId: null,
        isRestarting: false,
        generation: 0,
        updatedAt: Date.now(),
        forceKilled: undefined,
        phaseLabel: undefined,
      };
    }
    return this.toPublicState(session);
  }

  private toPublicState(session: DevPreviewSession): DevPreviewSessionState {
    return {
      panelId: session.panelId,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      status: session.status,
      url: session.url,
      predictedUrl: session.predictedUrl,
      error: session.error,
      terminalId: session.terminalId,
      isRestarting: session.isRestarting,
      generation: session.generation,
      updatedAt: session.updatedAt,
      phaseLabel: session.phaseLabel,
      forceKilled: session.forceKilled,
      crashLoopStopped: session.crashLoopStopped || undefined,
      lastOutput: session.status === "stopped" ? undefined : this.getLastOutputLine(session.buffer),
    };
  }

  /**
   * Extract the last non-empty line of a terminal buffer for the dashboard
   * activity hint. Only the buffer tail is scanned, ANSI/VT control sequences
   * are stripped (Node 22 native `stripVTControlCharacters`), and the result is
   * length-capped so one runaway line can't bloat the all-sessions snapshot.
   * Splits on bare CR as well as LF so a carriage-return progress line
   * (`Compiling 90%\rDone!`) reports the final segment, not the overwritten one.
   */
  private getLastOutputLine(buffer: string): string | undefined {
    if (!buffer) return undefined;
    const stripped = stripVTControlCharacters(buffer.slice(-LAST_OUTPUT_SCAN_BYTES));
    const lines = stripped.split(/\r\n|\r|\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]!.trim();
      if (trimmed) {
        return trimmed.length > LAST_OUTPUT_MAX_CHARS
          ? trimmed.slice(0, LAST_OUTPUT_MAX_CHARS)
          : trimmed;
      }
    }
    return undefined;
  }

  /**
   * Broadcast both the single-session state (per-panel subscribers) and the
   * all-sessions snapshot (cross-worktree dashboard). Every onStateChanged
   * call site routes through here so the dashboard never goes stale — including
   * the compile-timer transitions that bypass updateSession.
   */
  private emitStateChanged(session: DevPreviewSession): void {
    this.onStateChanged(this.toPublicState(session));
    this.onAllSessionsChanged(this.getAllSessions());
  }

  private updateSession(
    session: DevPreviewSession,
    updates: Partial<
      Pick<
        DevPreviewSession,
        | "status"
        | "url"
        | "predictedUrl"
        | "error"
        | "terminalId"
        | "isRestarting"
        | "worktreeId"
        | "generation"
        | "phaseLabel"
        | "forceKilled"
        | "crashLoopStopped"
      >
    >
  ): void {
    if (this.disposed) return;
    const wasRunning = RUNNING_STATES.has(session.status);
    if (updates.status !== undefined) session.status = updates.status;
    if (updates.url !== undefined) session.url = updates.url;
    if (updates.predictedUrl !== undefined) session.predictedUrl = updates.predictedUrl;
    if (updates.error !== undefined) session.error = updates.error;
    if (updates.terminalId !== undefined) session.terminalId = updates.terminalId;
    if (updates.isRestarting !== undefined) session.isRestarting = updates.isRestarting;
    if (updates.worktreeId !== undefined) session.worktreeId = updates.worktreeId;
    if (updates.generation !== undefined) session.generation = updates.generation;
    if ("phaseLabel" in updates) session.phaseLabel = updates.phaseLabel;
    if ("forceKilled" in updates) session.forceKilled = updates.forceKilled;
    if (updates.crashLoopStopped !== undefined) session.crashLoopStopped = updates.crashLoopStopped;
    session.updatedAt = Date.now();
    session.updatedAtPerformanceMs = performance.now();
    this.emitStateChanged(session);

    // Snapshot the manifest the moment a session enters a running state so an
    // abrupt crash (SIGKILL/OOM, where shutdown hooks never run) can still
    // restore it. Leaving a running state is handled by the explicit-stop
    // sites — never here — so a shutdown PTY kill doesn't wipe the manifest.
    if (!wasRunning && RUNNING_STATES.has(session.status)) {
      this.persistManifest();
    }
  }

  private async runLocked(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.locks.get(key) === next) {
          this.locks.delete(key);
        }
      });
    this.locks.set(key, next);
    return next;
  }

  private async ensureSessionTerminal(session: DevPreviewSession): Promise<void> {
    if (session.terminalId) {
      const alive = await this.isTerminalAlive(session.terminalId, session.projectId);
      if (alive) {
        const terminalId = session.terminalId;
        this.attachTerminal(session, terminalId);
        if (!RUNNING_STATES.has(session.status)) {
          this.updateSession(session, {
            status: "starting",
            error: null,
            url: null,
            forceKilled: undefined,
          });
        }

        if ((session.status === "starting" || session.status === "installing") && !session.url) {
          await this.replayRecentOutput(terminalId);
        }

        if (
          session.status === "starting" &&
          !session.url &&
          !session.pendingUrl &&
          performance.now() - session.updatedAtPerformanceMs >= STALE_START_RECOVERY_MS
        ) {
          await this.stopSessionTerminal(session, "stale-start-recovery");
          await this.spawnSessionTerminal(session);
        }
        return;
      }
      this.detachTerminal(session);
      session.readinessAbort?.abort();
      session.readinessAbort = null;
      session.pendingUrl = null;
      session.markerSeen = false;
      session.needsInstall = false;
      session.isRunningInstall = false;
      this.updateSession(session, { terminalId: null, url: null, predictedUrl: null });
    }

    // A tripped crash-loop guard halts auto-respawn until the user restarts
    // explicitly. ensure() runs on every remount (dock↔grid, eviction
    // rehydration) with unchanged config, so without this the pane would
    // silently respawn a known-broken server on each transition. A config
    // change clears the guard upstream (resetCrashLoopGuard in ensure()), and
    // restart() clears it before spawning, so only the automatic path is held.
    if (session.crashLoopStopped) return;

    await this.spawnSessionTerminal(session);
  }

  private async replayRecentOutput(terminalId: string): Promise<void> {
    try {
      await this.ptyClient.replayHistoryAsync(terminalId, REPLAY_HISTORY_MAX_LINES);
    } catch (err) {
      console.warn("[DevPreviewSessionService] replayRecentOutput failed for terminal:", {
        terminalId,
        error: formatErrorMessage(err, "Failed to replay terminal history"),
      });
    }
  }

  /**
   * Clear the crash-loop guard for an explicit user- or config-driven restart:
   * cancel any pending backoff, zero the counter, and lift the stopped flag.
   * Callers must run this before spawning/installing so the broadcast that
   * follows reports a fresh (non-crash-looped) state.
   */
  private resetCrashLoopGuard(session: DevPreviewSession): void {
    session.backoffAbort?.abort();
    session.backoffAbort = null;
    session.crashCount = 0;
    session.crashLoopStopped = false;
  }

  /**
   * Decide whether to auto-respawn after a dev-server exit that wants a
   * (re)install, applying the crash-loop guard. A server that survived
   * CRASH_LOOP_MIN_UPTIME_MS graduates and resets the counter. Once
   * CRASH_LOOP_MAX_ATTEMPTS consecutive fast cycles accumulate, auto-respawn
   * halts and the session lands in a recoverable "stopped" state. Otherwise
   * the install is scheduled — immediately for the first attempt in a window,
   * with geometric backoff for repeats. Returns nothing; the caller must
   * `return` after invoking it (it owns the respawn decision).
   */
  private guardedReinstall(session: DevPreviewSession): void {
    const uptime =
      session.devSpawnedAt !== null ? performance.now() - session.devSpawnedAt : Infinity;
    if (uptime >= CRASH_LOOP_MIN_UPTIME_MS) {
      session.crashCount = 0;
    }
    session.crashCount += 1;

    if (session.crashCount > CRASH_LOOP_MAX_ATTEMPTS) {
      this.recordSessionDiagnostic(session, { type: "crash-loop-stopped" });
      this.updateSession(session, {
        status: "stopped",
        url: null,
        predictedUrl: null,
        error: null,
        terminalId: null,
        isRestarting: false,
        crashLoopStopped: true,
        phaseLabel: undefined,
      });
      return;
    }

    const delayMs =
      session.crashCount <= 1
        ? 0
        : Math.min(
            CRASH_LOOP_INITIAL_DELAY_MS * CRASH_LOOP_BACKOFF_MULTIPLIER ** (session.crashCount - 2),
            CRASH_LOOP_MAX_DELAY_MS
          );

    if (delayMs === 0) {
      void this.runInstall(session);
      return;
    }
    this.recordSessionDiagnostic(session, {
      type: "crash-loop-backoff",
      attempt: session.crashCount,
      delayMs,
    });
    this.scheduleBackoffRespawn(session, delayMs, () => {
      void this.runInstall(session);
    });
  }

  /**
   * Run `action` after `delayMs`, guarded so a user restart or dispose during
   * the wait cancels it. The pending AbortController is parked on the session;
   * resetCrashLoopGuard()/dispose() abort it to clear the timer, and the
   * generation check rejects a respawn whose session moved on while waiting.
   */
  private scheduleBackoffRespawn(
    session: DevPreviewSession,
    delayMs: number,
    action: () => void
  ): void {
    session.backoffAbort?.abort();
    const abort = new AbortController();
    session.backoffAbort = abort;
    const generation = session.generation;
    const timer = setTimeout(() => {
      if (session.backoffAbort === abort) session.backoffAbort = null;
      if (this.disposed || abort.signal.aborted || session.generation !== generation) return;
      action();
    }, delayMs);
    abort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }

  private async spawnSessionTerminal(session: DevPreviewSession): Promise<void> {
    const terminalId = this.createTerminalId(session);
    const nextGeneration = session.generation + 1;

    const sessionKey = createSessionKey(session.projectId, session.panelId);
    const port = await allocatePort(this.portRegistry, sessionKey);
    // dispose() can fire while allocatePort awaits its net probe. Guard here
    // so we don't spawn a terminal on a disposed service; roll back the
    // reservation to avoid a stale portRegistry entry after disposal cleared it.
    if (this.disposed) {
      releasePort(this.portRegistry, sessionKey);
      return;
    }
    // Recorded with the generation this spawn is about to become, so the whole
    // spawn lifecycle (port-allocated → spawned → …) shares one generation.
    this.recordDiagnostic(sessionKey, nextGeneration, { type: "port-allocated", port });
    const predictedUrl = `http://localhost:${port}`;

    const spawnEnv: Record<string, string> = { ...session.env, PORT: String(port) };

    // Mark the dev-server spawn time for the crash-loop graduation check. Set
    // only here (the dev server), never in runInstall — an install is part of
    // recovery, not a crash, and must not count toward the survival window.
    session.devSpawnedAt = performance.now();

    session.buffer = "";
    session.lastErrorKey = null;
    session.markerSeen = false;
    session.predictedUrl = predictedUrl;
    this.clearCompiling(session);
    this.attachTerminal(session, terminalId);
    this.updateSession(session, {
      terminalId,
      status: "starting",
      url: null,
      predictedUrl,
      error: null,
      generation: nextGeneration,
      forceKilled: undefined,
    });

    try {
      this.ptyClient.spawn(terminalId, {
        projectId: session.projectId,
        kind: "dev-preview",
        cwd: session.cwd,
        cols: 80,
        rows: 30,
        restore: false,
        env: spawnEnv,
        isEphemeral: true,
      });
      markPerformance(PERF_MARKS.DEVPREVIEW_TERMINAL_SPAWNED, {
        panelId: session.panelId,
        projectId: session.projectId,
        terminalId,
      });
      this.recordSessionDiagnostic(session, { type: "spawned", terminalId, port });

      // predictedUrl is the allocator-derived starting point for the readiness
      // poller — it's accurate for frameworks that honor env.PORT or the
      // injected --port flag, but not authoritative. UrlDetector overwrites
      // state.url when real output reveals a different bind address (e.g. next
      // dev auto-incrementing past EADDRINUSE on configs without --strictPort).
      setTimeout(() => {
        if (this.disposed) return;
        if (session.generation !== nextGeneration || session.terminalId !== terminalId) return;
        if (session.status !== "starting" || session.url || session.readinessAbort) return;

        const abort = new AbortController();
        session.readinessAbort = abort;
        this.pollServerReadiness(session, predictedUrl, abort.signal, nextGeneration);
      }, 0);
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to start dev server");
      this.recordSessionDiagnostic(session, {
        type: "spawn-failed",
        message: capDiagnosticText(message),
      });
      this.detachTerminal(session);
      this.updateSession(session, {
        status: "error",
        url: null,
        predictedUrl: null,
        error: { type: "unknown", message: `Failed to start dev server: ${message}` },
        terminalId: null,
        isRestarting: false,
      });
      return;
    }

    const trimmedCommand = session.devCommand.trim();

    const submitCommand = (cmd: string) => {
      setTimeout(() => {
        try {
          if (this.ptyClient.hasTerminal(terminalId)) {
            this.ptyClient.submit(terminalId, cmd);
          }
        } catch (err) {
          console.warn("[DevPreviewSessionService] Failed to submit dev command:", err);
        }
      }, PTY_SUBMIT_AFTER_SPAWN_MS);
    };

    void normalizeNextjsDevCommand(trimmedCommand, session.cwd, session.turbopackEnabled)
      .then((nextNormalized) => normalizeViteDevCommand(nextNormalized, session.cwd, port))
      .then((normalizedCommand) => {
        submitCommand(normalizedCommand);
      })
      .catch(() => {
        submitCommand(trimmedCommand);
      });

    this.scheduleStartupReplay(session);
  }

  private clearStartupReplay(session: DevPreviewSession): void {
    if (session.startupReplayTimer !== null) {
      clearTimeout(session.startupReplayTimer);
      session.startupReplayTimer = null;
    }
  }

  private scheduleStartupReplay(session: DevPreviewSession): void {
    this.clearStartupReplay(session);
    const generation = session.generation;
    const terminalId = session.terminalId;
    if (!terminalId) return;

    session.startupReplayTimer = setTimeout(() => {
      session.startupReplayTimer = null;
      if (
        session.generation !== generation ||
        session.terminalId !== terminalId ||
        session.status !== "starting" ||
        session.url ||
        session.pendingUrl
      ) {
        return;
      }
      void this.replayRecentOutput(terminalId);
    }, STARTUP_REPLAY_DELAY_MS);
  }

  private createTerminalId(session: DevPreviewSession): string {
    const projectToken = sanitizeToken(session.projectId);
    const panelToken = sanitizeToken(session.panelId);
    const timestampToken = Date.now().toString(36);
    const randomToken = Math.random().toString(36).slice(2, 8);
    return `dev-preview-${projectToken}-${panelToken}-${timestampToken}-${randomToken}`;
  }

  private attachTerminal(session: DevPreviewSession, terminalId: string): void {
    const key = createSessionKey(session.projectId, session.panelId);
    if (session.terminalId && session.terminalId !== terminalId) {
      this.clearStartupReplay(session);
      this.terminalToSession.delete(session.terminalId);
      this.ptyClient.setIpcDataMirror(session.terminalId, false);
    }
    this.terminalToSession.set(terminalId, key);
    this.ptyClient.setIpcDataMirror(terminalId, true);
    session.terminalId = terminalId;
  }

  private detachTerminal(session: DevPreviewSession): void {
    if (!session.terminalId) return;
    this.terminalToSession.delete(session.terminalId);
    this.ptyClient.setIpcDataMirror(session.terminalId, false);
    session.terminalId = null;
  }

  private async stopSessionTerminal(
    session: DevPreviewSession,
    context: string,
    escalationDelayMs?: number
  ): Promise<void> {
    this.clearStartupReplay(session);
    session.readinessAbort?.abort();
    session.readinessAbort = null;
    // Cancel a pending crash-loop backoff: otherwise the deferred re-install
    // fires after the terminal is gone (and, on the delete paths, after the
    // session is removed), spawning an orphan PTY on a stopped session.
    session.backoffAbort?.abort();
    session.backoffAbort = null;
    session.pendingUrl = null;
    session.markerSeen = false;
    this.clearCompiling(session);
    session.needsInstall = false;
    session.isRunningInstall = false;

    const terminalId = session.terminalId;
    if (!terminalId) return;

    this.detachTerminal(session);
    session.buffer = "";
    session.lastErrorKey = null;

    try {
      if (escalationDelayMs !== undefined) {
        this.ptyClient.kill(terminalId, `dev-preview:${context}`, { escalationDelayMs });
      } else {
        this.ptyClient.kill(terminalId, `dev-preview:${context}`);
      }
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to kill dev preview terminal");
      if (!this.isBenignMissingTerminalError(message)) {
        throw new Error(`Failed to kill terminal (${context}): ${message}`, { cause: err });
      }
    }

    const stopped = await this.waitForTerminalGone(terminalId, session.projectId);
    if (!stopped) {
      throw new Error(`Timed out waiting for terminal ${terminalId} to stop (${context})`);
    }
  }

  private isBenignMissingTerminalError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("not found") ||
      normalized.includes("does not exist") ||
      normalized.includes("terminal not found") ||
      normalized.includes("unknown terminal")
    );
  }

  /**
   * Wait for the session's registered port to release before respawning. On
   * Windows a force-killed dev server can hold the socket in TIME_WAIT, which
   * would otherwise cause the next spawn to fail with EADDRINUSE on the same
   * port (allocatePort returns the registered port without re-probing).
   * Returns true if free (or no port registered); on timeout, releases the
   * port from the registry so a subsequent allocate picks a fresh candidate
   * and surfaces an error state.
   */
  private async waitForRegisteredPortFree(
    session: DevPreviewSession,
    key: string
  ): Promise<boolean> {
    const port = this.portRegistry.get(key);
    if (port === undefined) return true;
    const abort = new AbortController();
    this.portWaitAborts.add(abort);
    const free = await waitForPortFree(port, abort.signal).finally(() => {
      this.portWaitAborts.delete(abort);
    });
    if (free) return true;
    releasePort(this.portRegistry, key);
    this.recordSessionDiagnostic(session, { type: "port-conflict", port });
    this.updateSession(session, {
      status: "error",
      url: null,
      predictedUrl: null,
      error: {
        type: "port-conflict",
        message: `Port ${port} did not release within ${PORT_FREE_TIMEOUT_MS / 1000}s. Retry to start again.`,
        port: String(port),
      },
      terminalId: null,
      isRestarting: false,
      phaseLabel: undefined,
    });
    return false;
  }

  private async waitForTerminalGone(
    terminalId: string,
    projectId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const alive = await this.isTerminalAlive(terminalId, projectId);
      if (!alive) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async isTerminalAlive(terminalId: string, projectId: string): Promise<boolean> {
    try {
      const terminal = await this.ptyClient.getTerminalAsync(terminalId);
      if (!terminal || !terminal.hasPty) return false;
      if (terminal.projectId && terminal.projectId !== projectId) return false;
      return true;
    } catch {
      return false;
    }
  }

  private clearCompiling(session: DevPreviewSession): void {
    if (session.compilingTimer !== null) {
      clearTimeout(session.compilingTimer);
      session.compilingTimer = null;
    }
    if (session.compilingClearTimer !== null) {
      clearTimeout(session.compilingClearTimer);
      session.compilingClearTimer = null;
    }
    session.compiling = false;
    if (session.phaseLabel === "Compiling") {
      session.phaseLabel = undefined;
    }
  }

  private handleData(id: string, data: string | Uint8Array): void {
    if (this.disposed) return;
    const sessionKey = this.terminalToSession.get(id);
    if (!sessionKey) return;
    const session = this.sessions.get(sessionKey);
    if (!session || session.terminalId !== id) return;

    if (session.isRunningInstall) return;

    const dataString = typeof data === "string" ? data : this.textDecoder.decode(data);
    const result = this.detector.scanOutput(dataString, session.buffer);
    session.buffer = result.buffer;

    let urlJustStarted = false;
    if (result.url && result.url !== session.url && result.url !== session.pendingUrl) {
      markPerformance(PERF_MARKS.DEVPREVIEW_URL_DETECTED, {
        panelId: session.panelId,
        projectId: session.projectId,
        terminalId: id,
        url: result.url,
      });
      this.recordSessionDiagnostic(session, {
        type: "url-detected",
        url: capDiagnosticText(result.url),
      });

      session.readinessAbort?.abort();
      const abort = new AbortController();
      session.readinessAbort = abort;
      session.pendingUrl = result.url;
      // A new URL (e.g. a port change) starts a fresh poll; allow its own
      // readiness marker to accelerate it again.
      session.markerSeen = false;

      this.pollServerReadiness(session, result.url, abort.signal, session.generation);
      urlJustStarted = true;
    }

    // A framework readiness line ("ready in N ms", "✓ Ready in", "compiled
    // successfully") confirms the HTTP server is bound. When a poll is already
    // mid-cycle (sleeping between HEAD attempts), abort it and re-probe now to
    // skip the remaining poll interval. The poll itself stays the fallback for
    // unrecognized frameworks, so no marker means no behavior change.
    if (result.readyMarker && !session.markerSeen && !urlJustStarted && session.pendingUrl) {
      session.markerSeen = true;
      session.readinessAbort?.abort();
      const abort = new AbortController();
      session.readinessAbort = abort;
      this.pollServerReadiness(session, session.pendingUrl, abort.signal, session.generation);
    }

    // Compile marker detection fires whenever the framework emits a
    // compile-start line (HMR rebuild, initial compilation burst). Uses a
    // two-stage timer: arm debounce prevents flicker from rapid marker
    // bursts, auto-clear removes the signal when markers go quiet.
    if (
      result.compileMarker &&
      session.status !== "stopped" &&
      session.status !== "error" &&
      !session.isRunningInstall
    ) {
      if (session.compiling) {
        // Already visible — reset the auto-clear timer so the signal
        // persists through a burst (HMR chains, multi-file saves).
        if (session.compilingClearTimer !== null) {
          clearTimeout(session.compilingClearTimer);
          session.compilingClearTimer = setTimeout(() => {
            session.compilingClearTimer = null;
            this.recordSessionDiagnostic(session, { type: "compile-cleared" });
            this.clearCompiling(session);
            this.emitStateChanged(session);
          }, COMPILE_CLEAR_MS);
        }
      } else if (session.compilingTimer === null) {
        // Start the arm debounce — if no additional markers arrive before
        // COMPILE_ARM_MS, publish the Compiling label.
        session.compilingTimer = setTimeout(() => {
          session.compilingTimer = null;
          if (
            session.status === "stopped" ||
            session.status === "error" ||
            session.isRunningInstall
          ) {
            return;
          }
          session.compiling = true;
          this.recordSessionDiagnostic(session, { type: "compile-started" });
          this.updateSession(session, { phaseLabel: "Compiling" });
          session.compilingClearTimer = setTimeout(() => {
            session.compilingClearTimer = null;
            this.recordSessionDiagnostic(session, { type: "compile-cleared" });
            this.clearCompiling(session);
            this.emitStateChanged(session);
          }, COMPILE_CLEAR_MS);
        }, COMPILE_ARM_MS);
      }
    }

    // A readyMarker during an active compile phase cancels both timers
    // and clears the label early — the framework signaled completion.
    if (result.readyMarker && (session.compiling || session.compilingTimer !== null)) {
      if (session.compilingTimer !== null) {
        clearTimeout(session.compilingTimer);
        session.compilingTimer = null;
      }
      if (session.compiling) {
        this.recordSessionDiagnostic(session, { type: "compile-cleared" });
      }
      this.clearCompiling(session);
      this.emitStateChanged(session);
    }

    if (!result.error) return;
    const errorKey = `${result.error.type}:${result.error.message}`;
    if (errorKey === session.lastErrorKey) return;
    session.lastErrorKey = errorKey;
    this.recordSessionDiagnostic(session, {
      type: "output-error",
      errorType: result.error.type,
      message: capDiagnosticText(result.error.message),
    });

    // Cancel any in-flight readiness poll: a server that still answers HEAD on
    // a half-started port would otherwise resolve to "running" and clobber the
    // error/installing status we are about to set.
    session.readinessAbort?.abort();
    session.readinessAbort = null;
    session.pendingUrl = null;
    session.markerSeen = false;
    this.clearCompiling(session);

    if (result.error.type === "missing-dependencies") {
      session.needsInstall = true;
      this.updateSession(session, {
        status: "installing",
        error: result.error,
        isRestarting: false,
      });
      return;
    }

    this.updateSession(session, {
      status: "error",
      error: result.error,
      url: null,
      predictedUrl: null,
      isRestarting: false,
      phaseLabel: undefined,
    });
  }

  private classifyExit(
    exitCode: number,
    signal: number | undefined,
    recentOutput: string
  ): DevServerError | null {
    // Signal-based tier first
    if (signal !== undefined) {
      // Check OOM output across all crash signals — Node.js heap OOM sends
      // SIGABRT (6), not SIGKILL (9). Kernel OOM killer uses SIGKILL.
      if (
        CRASH_SIGNALS.has(signal) &&
        /\b(FATAL ERROR|out of memory|heap out of memory|Cannot allocate memory)\b/i.test(
          recentOutput
        )
      ) {
        return {
          type: "oom",
          message: "Dev server was killed — out of memory.",
        };
      }
      if (signal === 9) {
        // SIGKILL without OOM output: fall through to output/exit-code tiers
      } else if (CRASH_SIGNALS.has(signal)) {
        return {
          type: "process-crash",
          message: `Dev server crashed (signal ${signal}).`,
        };
      }
      if (EXPECTED_TERMINATION_SIGNALS.has(signal)) {
        return null;
      }
    }

    // Output-based tier
    const outputError = detectDevServerError(recentOutput);
    if (outputError) return outputError;

    // Exit-code fallback
    if (exitCode === 0) return null;
    return {
      type: "unknown",
      message: `Dev server exited with code ${exitCode}`,
    };
  }

  private handleExit(id: string, exitCode: number, signal?: number): void {
    if (this.disposed) return;
    const sessionKey = this.terminalToSession.get(id);
    if (!sessionKey) return;
    const session = this.sessions.get(sessionKey);
    if (!session || session.terminalId !== id) return;

    this.clearStartupReplay(session);
    session.readinessAbort?.abort();
    session.readinessAbort = null;
    session.pendingUrl = null;
    session.markerSeen = false;
    this.clearCompiling(session);

    this.detachTerminal(session);
    const recentOutput = session.buffer;
    session.buffer = "";
    session.lastErrorKey = null;

    if (session.isRunningInstall) {
      session.isRunningInstall = false;
      if (exitCode === 0) {
        this.recordSessionDiagnostic(session, { type: "install-completed" });
        void this.spawnSessionTerminal(session);
        return;
      }
      this.recordSessionDiagnostic(session, {
        type: "install-failed",
        message: `Dependency installation failed (exit code ${exitCode})`,
      });
      this.updateSession(session, {
        status: "error",
        url: null,
        predictedUrl: null,
        error: {
          type: "missing-dependencies",
          message: `Dependency installation failed (exit code ${exitCode})`,
        },
        terminalId: null,
        isRestarting: false,
        phaseLabel: undefined,
      });
      return;
    }

    this.recordSessionDiagnostic(session, {
      type: "terminal-exited",
      exitCode,
      ...(signal !== undefined ? { signal } : {}),
    });

    if (session.needsInstall && session.installAttemptedGeneration !== session.generation) {
      session.needsInstall = false;
      this.guardedReinstall(session);
      return;
    }
    session.needsInstall = false;

    if (
      session.status === "starting" ||
      session.status === "installing" ||
      session.status === "error"
    ) {
      // Expected termination signals during startup/error = clean stop (user interrupted it)
      if (signal !== undefined && EXPECTED_TERMINATION_SIGNALS.has(signal)) {
        this.updateSession(session, {
          status: "stopped",
          url: null,
          predictedUrl: null,
          error: null,
          terminalId: null,
          isRestarting: false,
          phaseLabel: undefined,
        });
        return;
      }
      const error = this.classifyExit(exitCode, signal, recentOutput) ?? {
        type: "unknown",
        message: `Dev server exited with code ${exitCode}`,
      };
      this.updateSession(session, {
        status: "error",
        url: null,
        predictedUrl: null,
        error,
        terminalId: null,
        isRestarting: false,
        phaseLabel: undefined,
      });
      return;
    }

    const crashError =
      signal !== undefined && CRASH_SIGNALS.has(signal)
        ? this.classifyExit(exitCode, signal, recentOutput)
        : null;

    this.updateSession(session, {
      status: "stopped",
      url: null,
      predictedUrl: null,
      error: crashError,
      terminalId: null,
      isRestarting: false,
      phaseLabel: undefined,
    });
  }

  private async runInstall(session: DevPreviewSession): Promise<void> {
    session.installAttemptedGeneration = session.generation;
    session.isRunningInstall = true;

    const installCommand = this.detectInstallCommand(session.cwd);
    this.recordSessionDiagnostic(session, {
      type: "install-started",
      command: capDiagnosticText(installCommand),
    });

    const terminalId = this.createTerminalId(session);
    session.buffer = "";
    session.lastErrorKey = null;
    this.attachTerminal(session, terminalId);
    this.updateSession(session, {
      terminalId,
      status: "installing",
      error: {
        type: "missing-dependencies",
        message: `Running ${installCommand}...`,
      },
    });

    try {
      this.ptyClient.spawn(terminalId, {
        projectId: session.projectId,
        kind: "dev-preview",
        cwd: session.cwd,
        cols: 80,
        rows: 30,
        restore: false,
        env: session.env,
        isEphemeral: true,
      });
    } catch (error) {
      session.isRunningInstall = false;
      const message = formatErrorMessage(error, "Failed to start dependency install");
      this.recordSessionDiagnostic(session, {
        type: "install-failed",
        message: capDiagnosticText(message),
      });
      this.detachTerminal(session);
      this.updateSession(session, {
        status: "error",
        url: null,
        predictedUrl: null,
        error: { type: "unknown", message: `Failed to start dependency install: ${message}` },
        terminalId: null,
        isRestarting: false,
      });
      return;
    }

    setTimeout(() => {
      try {
        if (this.ptyClient.hasTerminal(terminalId)) {
          this.ptyClient.submit(terminalId, installCommand);
        }
      } catch (err) {
        console.warn("[DevPreviewSessionService] Failed to submit install command:", err);
      }
    }, PTY_SUBMIT_AFTER_SPAWN_MS);
  }

  private detectInstallCommand(cwd: string): string {
    const info = this.detectPackageManagerInfo(cwd);
    return `${info.packageManager} install`;
  }

  // Lockfile precedence mirrors detectInstallCommand: bun > pnpm > yarn > npm.
  // package-lock.json is only used to report the lockfile name when no other
  // lockfile is present; it does not change the install command (npm is the
  // default fallback regardless).
  private detectPackageManagerInfo(cwd: string): {
    packageManager: DevPreviewPackageManager;
    lockfileName: string | null;
  } {
    if (existsSync(path.join(cwd, "bun.lock"))) {
      return { packageManager: "bun", lockfileName: "bun.lock" };
    }
    if (existsSync(path.join(cwd, "bun.lockb"))) {
      return { packageManager: "bun", lockfileName: "bun.lockb" };
    }
    if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
      return { packageManager: "pnpm", lockfileName: "pnpm-lock.yaml" };
    }
    if (existsSync(path.join(cwd, "yarn.lock"))) {
      return { packageManager: "yarn", lockfileName: "yarn.lock" };
    }
    if (existsSync(path.join(cwd, "package-lock.json"))) {
      return { packageManager: "npm", lockfileName: "package-lock.json" };
    }
    return { packageManager: "npm", lockfileName: null };
  }

  async getDestructivePreviewMeta(
    request: DevPreviewSessionRequest
  ): Promise<DevPreviewDestructivePreviewMeta> {
    validateSessionRequest(request);
    const cwd = this.resolveSessionCwd(request);
    const [cacheDirs, nodeModules] = await Promise.all([
      Promise.all(CACHE_DIRS.map((relPath) => this.statDirMeta(cwd, relPath))),
      this.statDirMeta(cwd, "node_modules"),
    ]);
    const pmInfo = this.detectPackageManagerInfo(cwd);
    return {
      cwd,
      cacheDirs,
      nodeModules,
      packageManager: pmInfo.packageManager,
      lockfileName: pmInfo.lockfileName,
    };
  }

  async getDestructivePreviewSizes(
    request: DevPreviewDestructivePreviewSizesRequest
  ): Promise<DevPreviewDestructivePreviewSizes> {
    validateSessionRequest(request);
    const cwd = this.resolveSessionCwd(request);
    const skipNodeModules = request.skipNodeModules === true;
    const [cacheDirEntries, nodeModulesSizeBytes] = await Promise.all([
      Promise.all(
        CACHE_DIRS.map(async (relPath) => {
          const size = await this.computeDirSize(path.join(cwd, relPath));
          return [relPath, size] as const;
        })
      ),
      skipNodeModules ? Promise.resolve(null) : this.computeDirSize(path.join(cwd, "node_modules")),
    ]);
    return {
      cacheDirSizes: Object.fromEntries(cacheDirEntries),
      nodeModulesSizeBytes,
    };
  }

  private resolveSessionCwd(request: DevPreviewSessionRequest): string {
    const key = createSessionKey(request.projectId, request.panelId);
    const session = this.sessions.get(key);
    if (!session) {
      throw new Error(
        `No dev-preview session for panel ${request.panelId} in project ${request.projectId}`
      );
    }
    return session.cwd;
  }

  private async statDirMeta(cwd: string, relPath: string): Promise<DevPreviewDirMeta> {
    const fullPath = path.join(cwd, relPath);
    try {
      const stat = await fsPromises.stat(fullPath);
      if (!stat.isDirectory()) {
        return { relPath, exists: false, mtimeMs: null };
      }
      return { relPath, exists: true, mtimeMs: stat.mtimeMs };
    } catch {
      return { relPath, exists: false, mtimeMs: null };
    }
  }

  private async computeDirSize(dirPath: string): Promise<number | null> {
    try {
      const stat = await fsPromises.stat(dirPath);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
    if (process.platform === "win32") {
      return this.computeDirSizeWalk(dirPath);
    }
    return this.computeDirSizeDu(dirPath);
  }

  // POSIX path: shell out to `du -sk` (kilobytes). execFile avoids shell
  // interpretation entirely — dirPath cannot inject. `du` deduplicates
  // hardlinks by inode within the traversal, so pnpm-linked files inside
  // node_modules count once per inode (still reports apparent content size,
  // not the disk that would actually be reclaimed by deletion).
  private async computeDirSizeDu(dirPath: string): Promise<number | null> {
    return new Promise((resolve) => {
      execFile(
        "du",
        ["-sk", dirPath],
        { maxBuffer: 1024 * 1024, timeout: 30_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const firstField = stdout.trim().split(/\s+/, 1)[0];
          const kilobytes = Number.parseInt(firstField, 10);
          if (!Number.isFinite(kilobytes)) return resolve(null);
          resolve(kilobytes * 1024);
        }
      );
    });
  }

  // Windows fallback: no `du` available. Walks the tree with opendir,
  // accumulating file sizes via lstat. Tracks an inode set to dedupe
  // hardlinks where the FS reports a stable inode (NTFS returns 0/unstable
  // values in some cases — those entries simply count each time, accepting a
  // small over-report on edge filesystems).
  private async computeDirSizeWalk(dirPath: string): Promise<number | null> {
    try {
      let total = 0;
      const seenInos = new Set<string>();
      const stack: string[] = [dirPath];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        let handle: Awaited<ReturnType<typeof fsPromises.opendir>>;
        try {
          handle = await fsPromises.opendir(cur);
        } catch {
          continue;
        }
        for await (const ent of handle) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory()) {
            stack.push(full);
          } else if (ent.isFile() || ent.isSymbolicLink()) {
            try {
              const st = await fsPromises.lstat(full);
              const inoKey = st.ino ? `${st.dev}:${st.ino}` : null;
              if (inoKey && seenInos.has(inoKey)) continue;
              if (inoKey) seenInos.add(inoKey);
              total += st.size;
            } catch {
              // skip unreadable
            }
          }
        }
      }
      return total;
    } catch {
      return null;
    }
  }

  private pollServerReadiness(
    session: DevPreviewSession,
    url: string,
    signal: AbortSignal,
    generation: number
  ): void {
    void waitForServerReady(url, signal)
      .then((ready) => {
        if (signal.aborted || session.generation !== generation) return;
        if (session.readinessAbort?.signal !== signal) return;

        session.pendingUrl = null;
        session.readinessAbort = null;

        if (ready) {
          session.needsInstall = false;
          this.clearCompiling(session);
          this.recordSessionDiagnostic(session, {
            type: "readiness-probe-succeeded",
            url: capDiagnosticText(url),
          });
          this.updateSession(session, {
            status: "running",
            url,
            error: null,
            isRestarting: false,
            phaseLabel: undefined,
          });
          markPerformance(PERF_MARKS.DEVPREVIEW_RUNNING, {
            panelId: session.panelId,
            projectId: session.projectId,
            terminalId: session.terminalId,
            url,
          });
        } else {
          this.recordSessionDiagnostic(session, {
            type: "readiness-probe-timed-out",
            url: capDiagnosticText(url),
            timeoutMs: READINESS_TIMEOUT_MS,
          });
          this.updateSession(session, {
            status: "error",
            url: null,
            predictedUrl: null,
            error: {
              type: "unknown",
              message: `Dev server at ${url} did not respond within ${READINESS_TIMEOUT_MS / 1000} seconds`,
            },
            isRestarting: false,
            phaseLabel: undefined,
          });
        }
      })
      .catch((err) => {
        if (signal.aborted || session.generation !== generation) return;
        if (session.readinessAbort?.signal !== signal) return;

        session.pendingUrl = null;
        session.readinessAbort = null;

        const message = formatErrorMessage(err, "Dev server readiness check failed");
        console.warn("[DevPreviewSessionService] Readiness poll error:", {
          url,
          panelId: session.panelId,
          error: message,
        });
        this.recordSessionDiagnostic(session, {
          type: "readiness-probe-failed",
          message: capDiagnosticText(message),
        });
        this.updateSession(session, {
          status: "error",
          url: null,
          predictedUrl: null,
          error: {
            type: "unknown",
            message: `Dev server readiness check failed: ${message}`,
          },
          isRestarting: false,
          phaseLabel: undefined,
        });
      });
  }
}
