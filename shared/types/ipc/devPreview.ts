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
}

export interface DevPreviewStateChangedPayload {
  state: DevPreviewSessionState;
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
