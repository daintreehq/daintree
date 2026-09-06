import fsPromises from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getInvalidCommandMessage } from "./DevPreviewCommandNormalizer.js";
import { resetCrashLoopGuard } from "./DevPreviewCrashLoopGuard.js";
import { processDevPreviewOutput } from "./DevPreviewOutputProcessor.js";
import {
  CACHE_DIRS,
  clearCacheDirs,
  computeDirSize,
  detectPackageManagerInfo,
  statDirMeta,
} from "./DevPreviewDiskUsage.js";
import {
  capDiagnosticText,
  sanitizeDiagnosticUrl,
  recordDevPreviewDiagnostic,
  type DevPreviewDiagnosticInput,
  type DevPreviewDiagnosticsRingMap,
} from "./DevPreviewDiagnosticsRing.js";
import { releasePort, waitForPortFree, PORT_FREE_TIMEOUT_MS } from "./DevPreviewPortAllocator.js";
import { waitForServerReady, READINESS_TIMEOUT_MS } from "./DevPreviewReadinessProbe.js";
import {
  createSessionKey,
  cloneEnv,
  envEquals,
  validateEnsureRequest,
  validateSessionRequest,
  validateStopByPanelRequest,
} from "./DevPreviewRequestValidators.js";
import {
  ensureSessionTerminal,
  spawnSessionTerminal,
  stopSessionTerminal,
  waitForRegisteredPortFree,
  runInstall,
  handleDevPreviewTerminalExit,
  invalidatePendingLaunch,
  clearStartupReplay,
  isBenignMissingTerminalError,
  type TerminalControllerDeps,
} from "./DevPreviewTerminalController.js";

export { normalizeNextjsDevCommand } from "./DevPreviewCommandNormalizer.js";
export { DIAGNOSTIC_RING_MAX } from "./DevPreviewDiagnosticsRing.js";
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
  DevPreviewDestructivePreviewMeta,
  DevPreviewDestructivePreviewSizes,
  DevPreviewDestructivePreviewSizesRequest,
} from "../../shared/types/ipc/devPreview.js";
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
  sawOutput: boolean;
  /**
   * Monotonic deadline (performance.now basis) for this launch's readiness, set
   * when the first poll starts and kept across marker- and URL-triggered
   * re-polls. Without it each restart handed `waitForServerReady` a fresh 30s,
   * so the 30s the UI promises could stretch to a multiple of itself.
   */
  readinessDeadline: number | null;
  /** True once any probe in this launch saw a 5xx; see waitForServerReady. */
  readinessSaw5xx: boolean;
  needsInstall: boolean;
  isRunningInstall: boolean;
  installAttemptedGeneration: number | null;
  /** See TerminalControllerSession.launchEpoch — bumped by every stop. */
  launchEpoch: number;
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

const DEV_PREVIEW_STOP_ESCALATION_MS = 5000;
// Bounds for the `lastOutput` activity hint surfaced in the cross-worktree
// dashboard. Only the buffer tail is scanned (the last line is all we need) and
// the result is capped so a single pathological line can't bloat the snapshot.
const LAST_OUTPUT_SCAN_BYTES = 2000;
const LAST_OUTPUT_MAX_CHARS = 120;

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
  private readonly diagnostics: DevPreviewDiagnosticsRingMap = new Map();
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
      clearStartupReplay(session);
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
        if (!isBenignMissingTerminalError(message)) {
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
        resetCrashLoopGuard(session);
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
        invalidatePendingLaunch(session);
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

      if (configChanged) {
        invalidatePendingLaunch(session);
        if (session.terminalId) {
          await this.stopSessionTerminal(session, "config-change");
        }
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
        resetCrashLoopGuard(session);

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

      resetCrashLoopGuard(session);

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

      const deletionError = await clearCacheDirs(session.cwd);
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

      resetCrashLoopGuard(session);

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
      resetCrashLoopGuard(session);
      // Unconditional: a post-install respawn still resolving its command has
      // no terminal yet, so the branch below would not reach stopSessionTerminal
      // and the launch would outlive the stop.
      invalidatePendingLaunch(session);

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

  /**
   * Shared happy-path for stopByPanel/stopByProject/stopByWorktree: record the
   * stop, kill the terminal, mark the session stopped, and remove it from the
   * live maps. Callers differ only in error handling (whether to also surface
   * an error state, what log fields to include, and whether to collect/rethrow
   * failures), so that stays at each call site.
   */
  private async stopAndRemoveSession(
    session: DevPreviewSession,
    context: "panel-closed" | "project-hibernated" | "worktree-delete"
  ): Promise<void> {
    const key = createSessionKey(session.projectId, session.panelId);
    this.recordSessionDiagnostic(session, { type: "stop-requested", context });
    await this.stopSessionTerminal(session, context);
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
            await this.stopAndRemoveSession(session, "panel-closed");
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
            await this.stopAndRemoveSession(session, "project-hibernated");
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
            await this.stopAndRemoveSession(session, "worktree-delete");
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
   * Append a diagnostic event to a session key's bounded ring. See
   * `recordDevPreviewDiagnostic` for coalescing/eviction behavior.
   */
  private recordDiagnostic(
    key: string,
    generation: number,
    input: DevPreviewDiagnosticInput
  ): void {
    if (this.disposed) return;
    recordDevPreviewDiagnostic(this.diagnostics, key, generation, input);
  }

  private recordSessionDiagnostic(
    session: DevPreviewSession,
    input: DevPreviewDiagnosticInput
  ): void {
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
      sawOutput: false,
      readinessDeadline: null,
      readinessSaw5xx: false,
      needsInstall: false,
      isRunningInstall: false,
      installAttemptedGeneration: null,
      launchEpoch: 0,
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

  private get terminalControllerDeps(): TerminalControllerDeps<DevPreviewSession> {
    return {
      ptyClient: this.ptyClient,
      portRegistry: this.portRegistry,
      terminalToSession: this.terminalToSession,
      portWaitAborts: this.portWaitAborts,
      isDisposed: () => this.disposed,
      recordDiagnostic: (key, generation, input) => this.recordDiagnostic(key, generation, input),
      recordSessionDiagnostic: (session, input) => this.recordSessionDiagnostic(session, input),
      updateSession: (session, updates) => this.updateSession(session, updates),
      clearCompiling: (session) => this.clearCompiling(session),
      pollServerReadiness: (session, url, signal, generation) =>
        this.pollServerReadiness(session, url, signal, generation),
    };
  }

  private async ensureSessionTerminal(session: DevPreviewSession): Promise<void> {
    return ensureSessionTerminal(session, this.terminalControllerDeps);
  }

  private async spawnSessionTerminal(session: DevPreviewSession): Promise<void> {
    return spawnSessionTerminal(session, this.terminalControllerDeps);
  }

  private async stopSessionTerminal(
    session: DevPreviewSession,
    context: string,
    escalationDelayMs?: number
  ): Promise<void> {
    return stopSessionTerminal(session, context, this.terminalControllerDeps, escalationDelayMs);
  }

  private async waitForRegisteredPortFree(
    session: DevPreviewSession,
    key: string
  ): Promise<boolean> {
    return waitForRegisteredPortFree(session, key, this.terminalControllerDeps);
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

    processDevPreviewOutput(session, id, data, {
      detector: this.detector,
      textDecoder: this.textDecoder,
      recordSessionDiagnostic: (target, input) => this.recordSessionDiagnostic(target, input),
      updateSession: (target, updates) => this.updateSession(target, updates),
      emitStateChanged: (target) => this.emitStateChanged(target),
      clearCompiling: (target) => this.clearCompiling(target),
      pollServerReadiness: (target, url, signal, generation) =>
        this.pollServerReadiness(target, url, signal, generation),
    });
  }

  private handleExit(id: string, exitCode: number, signal?: number): void {
    if (this.disposed) return;
    const sessionKey = this.terminalToSession.get(id);
    if (!sessionKey) return;
    const session = this.sessions.get(sessionKey);
    if (!session || session.terminalId !== id) return;

    handleDevPreviewTerminalExit(session, exitCode, signal, this.terminalControllerDeps);
  }

  private async runInstall(session: DevPreviewSession): Promise<void> {
    return runInstall(session, this.terminalControllerDeps);
  }

  async getDestructivePreviewMeta(
    request: DevPreviewSessionRequest
  ): Promise<DevPreviewDestructivePreviewMeta> {
    validateSessionRequest(request);
    const cwd = this.resolveSessionCwd(request);
    const [cacheDirs, nodeModules] = await Promise.all([
      Promise.all(CACHE_DIRS.map((relPath) => statDirMeta(cwd, relPath))),
      statDirMeta(cwd, "node_modules"),
    ]);
    const pmInfo = detectPackageManagerInfo(cwd);
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
          const size = await computeDirSize(path.join(cwd, relPath));
          return [relPath, size] as const;
        })
      ),
      skipNodeModules ? Promise.resolve(null) : computeDirSize(path.join(cwd, "node_modules")),
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

  private pollServerReadiness(
    session: DevPreviewSession,
    url: string,
    signal: AbortSignal,
    generation: number
  ): void {
    // One budget per launch. A ready marker or a newly detected URL restarts
    // the probe, and each restart used to get a full READINESS_TIMEOUT_MS —
    // so the deadline the error message quotes was not the one being enforced.
    // An already-spent deadline belongs to a probe that has since been
    // abandoned — an output error aborts the poll without ending the launch,
    // and re-attaching a live terminal replays its output minutes later. Reusing
    // it would hand the new probe ~0ms and report "did not respond within 30
    // seconds" without having waited at all.
    const now = performance.now();
    if (session.readinessDeadline === null || session.readinessDeadline <= now) {
      session.readinessDeadline = now + READINESS_TIMEOUT_MS;
    }
    const remainingMs = Math.max(1, Math.round(session.readinessDeadline - performance.now()));

    void waitForServerReady(url, signal, remainingMs, {
      seenServerError: session.readinessSaw5xx,
      onAttempt: (attempt) => {
        if (signal.aborted || session.generation !== generation) return;
        // Latched for the whole launch: a marker or a new URL replaces this
        // wait, and the replacement must not forget the compiling shell.
        if (attempt.outcome === "server-error") session.readinessSaw5xx = true;
        this.recordSessionDiagnostic(session, {
          type: "readiness-http-attempt",
          url: sanitizeDiagnosticUrl(attempt.url),
          outcome: attempt.outcome,
          ...(attempt.status !== undefined ? { status: attempt.status } : {}),
          ...(attempt.cause !== undefined ? { cause: attempt.cause } : {}),
          attempt: attempt.attempt,
          elapsedMs: attempt.elapsedMs,
          remainingMs: attempt.remainingMs,
        });
      },
    })
      .then((ready) => {
        if (signal.aborted || session.generation !== generation) return;
        if (session.readinessAbort?.signal !== signal) return;

        session.pendingUrl = null;
        session.readinessAbort = null;
        session.readinessDeadline = null;
        session.readinessSaw5xx = false;

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
        session.readinessDeadline = null;
        session.readinessSaw5xx = false;

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
