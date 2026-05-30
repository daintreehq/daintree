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
