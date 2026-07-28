import type { DevServerError } from "../../utils/devServerErrors.js";

export type DevPreviewSessionStatus =
  | "stopped"
  | "starting"
  | "installing"
  | "running"
  | "stopping"
  | "error"
  // Synthesized at launch for a panel whose dev server was running when
  // Daintree last closed (clean exit or crash). Distinct from "stopped" so the
  // UI can offer a one-click restart instead of the generic empty state. The
  // process is NOT reattached — only spawn metadata is restored.
  | "restored-stopped";

export interface DevPreviewEnsureRequest {
  panelId: string;
  projectId: string;
  cwd: string;
  devCommand: string;
  worktreeId?: string;
  env?: Record<string, string>;
  turbopackEnabled?: boolean;
}

export interface DevPreviewSessionRequest {
  panelId: string;
  projectId: string;
}

export interface DevPreviewStopByPanelRequest {
  panelId: string;
}

export interface DevPreviewSessionState {
  panelId: string;
  projectId: string;
  worktreeId?: string;
  status: DevPreviewSessionStatus;
  url: string | null;
  predictedUrl: string | null;
  error: DevServerError | null;
  terminalId: string | null;
  isRestarting: boolean;
  generation: number;
  updatedAt: number;
  phaseLabel?: "Compiling";
  forceKilled?: boolean;
  // True when the per-session crash-loop guard halted auto-respawn after
  // repeated fast install→crash cycles. The session lands in a recoverable
  // "stopped" state (not a permanent lockout); an explicit restart clears it.
  crashLoopStopped?: boolean;
  // Last non-empty line of the session's terminal output, ANSI-stripped and
  // length-capped. Surfaced for the cross-worktree dev-server dashboard so each
  // row can show a one-line activity hint. Omitted while the session is stopped
  // (the buffer is cleared on stop, so there is nothing meaningful to show).
  lastOutput?: string;
}

export interface DevPreviewStateChangedPayload {
  state: DevPreviewSessionState;
}

// Snapshot of every dev-preview session across all worktrees, pushed on the
// dedicated DEV_PREVIEW_ALL_SESSIONS_CHANGED channel and returned by the
// getAllSessions invoke. Powers the cross-worktree dev-server dashboard.
export interface DevPreviewAllSessionsPayload {
  sessions: DevPreviewSessionState[];
}

export interface DevPreviewGetByWorktreeRequest {
  worktreeId: string;
}

export type DevPreviewPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface DevPreviewDirMeta {
  relPath: string;
  exists: boolean;
  mtimeMs: number | null;
}

export interface DevPreviewDestructivePreviewMeta {
  cwd: string;
  cacheDirs: DevPreviewDirMeta[];
  nodeModules: DevPreviewDirMeta;
  packageManager: DevPreviewPackageManager;
  lockfileName: string | null;
}

export interface DevPreviewDestructivePreviewSizesRequest extends DevPreviewSessionRequest {
  // When true, skip the (potentially multi-second) node_modules walk. The
  // cache-clear tier only needs cache-dir sizes, so the reinstall-only walk
  // is wasted wall-time otherwise.
  skipNodeModules?: boolean;
}

export interface DevPreviewDestructivePreviewSizes {
  cacheDirSizes: Record<string, number | null>;
  nodeModulesSizeBytes: number | null;
}

export interface DevPreviewStopByWorktreeRequest {
  worktreeId: string;
}

export interface DevPreviewRestartByWorktreeRequest {
  worktreeId: string;
}

export interface DevPreviewStopDevServerByWorktreeRequest {
  worktreeId: string;
}

export interface DevPreviewProxyInfo {
  /** The live port the dev-preview reverse proxy is listening on (#9100). */
  port: number;
}

export interface DevPreviewMintBrowserTokenRequest {
  panelId: string;
  projectId: string;
  // Path (+ query) the external browser should land on after the bootstrap
  // redirect, e.g. `/dashboard?tab=1`. Untrusted; the proxy re-validates and
  // falls back to `/` for anything that isn't a same-origin absolute path.
  redirectPath: string;
}

export interface DevPreviewMintBrowserTokenResult {
  // Full `http://dp-*.localhost:<port>/_daintree/bootstrap?...` URL to hand to
  // the system browser. The token is short-lived (≤60s) and single-use.
  bootstrapUrl: string;
}

// Why a proxied request failed. `no-session` = the subdomain matches no known
// session (stale origin, wrong window); `not-running` = the session exists but
// has no live server to dial; the `upstream-*` causes classify a dial that was
// attempted and failed.
export type DevPreviewProxyFailureCause =
  "no-session" | "not-running" | "upstream-refused" | "upstream-timeout" | "upstream-error";

// What the proxy would dial for a subdomain right now. Splits the old
// `{port,isHttps} | null` resolver result so a 502 can say WHY there is no
// upstream instead of collapsing every miss into "not responding".
export type DevPreviewUpstreamResolution =
  | { kind: "ok"; port: number; isHttps: boolean }
  | { kind: "not-running"; status: DevPreviewSessionStatus }
  | { kind: "unknown-subdomain" };

// Per-session lifecycle facts, recorded into a bounded ring by
// DevPreviewSessionService (see DIAGNOSTIC_RING_MAX there). Diagnostic state
// only — never persisted, never part of panel layout. `seq` is monotonic per
// session key so ring eviction shows up as a gap instead of silence; `count`
// coalesces consecutive identical proxy events so a hammering webview can't
// evict the lifecycle history.
export type DevPreviewDiagnosticEventType = DevPreviewDiagnosticEvent["type"];

interface DevPreviewDiagnosticEventBase {
  at: number;
  seq: number;
  generation: number;
  count?: number;
}

export type DevPreviewDiagnosticEvent = DevPreviewDiagnosticEventBase &
  (
    | { type: "ensure-requested"; configChanged: boolean }
    | { type: "config-changed"; changed: string[] }
    | { type: "command-invalid"; message: string }
    | { type: "port-allocated"; port: number }
    | { type: "port-conflict"; port: number }
    | { type: "spawned"; terminalId: string; port: number }
    | { type: "spawn-failed"; message: string }
    | { type: "install-started"; command: string }
    | { type: "install-completed" }
    | { type: "install-failed"; message: string }
    | { type: "url-detected"; url: string }
    | { type: "readiness-probe-succeeded"; url: string }
    | { type: "readiness-probe-timed-out"; url: string; timeoutMs: number }
    | { type: "readiness-probe-failed"; message: string }
    | { type: "compile-started" }
    | { type: "compile-cleared" }
    | { type: "output-error"; errorType: string; message: string }
    | { type: "restart-requested"; mode: "restart" | "clear-cache" | "reinstall" }
    | { type: "stop-requested"; context: string }
    | { type: "terminal-exited"; exitCode: number; signal?: number }
    | { type: "crash-loop-backoff"; attempt: number; delayMs: number }
    | { type: "crash-loop-stopped" }
    | { type: "manifest-restored" }
    | { type: "proxy-502"; cause: DevPreviewProxyFailureCause; code?: string }
    | { type: "proxy-ws-failed"; cause: DevPreviewProxyFailureCause; code?: string }
  );

export interface DevPreviewDiagnosticsSnapshot {
  panelId: string;
  projectId: string;
  worktreeId?: string;
  status: DevPreviewSessionStatus;
  generation: number;
  updatedAt: number;
  /** Port the allocator reserved for this session; null when none is registered. */
  allocatedPort: number | null;
  /** URL the dev server actually announced — may disagree with allocatedPort. */
  detectedUrl: string | null;
  /** What the proxy would dial for this panel right now. */
  upstream: DevPreviewUpstreamResolution;
  crashLoop: { count: number; stopped: boolean; backoffPending: boolean };
  /** True when this session was created from a restore-manifest entry. */
  restoredFromManifest: boolean;
  events: DevPreviewDiagnosticEvent[];
}

export interface DevPreviewProxyDiagnosticsInfo {
  port: number;
  /** True when the fixed proxy port was taken and an OS-assigned port is in use. */
  usedPortFallback: boolean;
}

export interface DevPreviewDiagnosticsResult {
  // Null when the session service was never created this app session — there
  // is no timeline to report and the query must not spin the service up.
  session: DevPreviewDiagnosticsSnapshot | null;
  // Null when the proxy hasn't started; the query must not start it.
  proxy: DevPreviewProxyDiagnosticsInfo | null;
}
