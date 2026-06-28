import type { AgentId } from "../agent.js";
import type { AgentInstallBlock, AgentInstallOS } from "../../config/agentRegistry.js";

/** Open external URL payload */
export interface SystemOpenExternalPayload {
  url: string;
}

/** Payload for opening a path */
export interface SystemOpenPathPayload {
  path: string;
}

/** Payload for opening a file in the configured external editor */
export interface SystemOpenInEditorPayload {
  path: string;
  line?: number;
  col?: number;
}

/** System wake event payload */
export interface SystemWakePayload {
  /** Duration of sleep in milliseconds */
  sleepDuration: number;
  /** Timestamp when the system woke */
  timestamp: number;
}

/**
 * Availability for an individual agent CLI.
 *
 * - `missing`: binary not found via any probe (PATH, native installer path, npm global bin).
 * - `installed`: binary found but cannot be launched directly (e.g. WSL-detected on
 *   Windows, where direct spawn isn't wired up yet).
 * - `ready`: binary found, launchable, and credentials confirmed. Auth discovery
 *   succeeded — the agent can start without a login prompt.
 * - `blocked`: binary exists but execution was denied (security software like Santa,
 *   CrowdStrike, SentinelOne, or Windows Defender, or missing execute permission).
 *   Distinct from `missing` because the fix is a permissions/allowlist change, not
 *   a reinstall.
 * - `unauthenticated`: binary found and launchable, but the passive auth probe found
 *   no credentials. The CLI will prompt for login on first launch. Distinct from
 *   `ready` so the UI can show a "Login required" nudge without gating launch.
 */
export type AgentAvailabilityState =
  | "missing"
  | "installed"
  | "ready"
  | "blocked"
  | "unauthenticated";

/** CLI availability status for AI agents */
export type CliAvailability = Record<AgentId, AgentAvailabilityState>;

/**
 * Which probe layer located the CLI binary. Populated alongside
 * {@link AgentCliDetail.resolvedPath} for the Settings diagnostics surface.
 */
export type AgentCliProbeSource = "which" | "native" | "npm-global" | "wsl";

/**
 * Reason a binary exists but cannot be executed. Only set when
 * {@link AgentCliDetail.state} is `"blocked"`.
 */
export type AgentCliBlockReason = "security" | "permissions";

/**
 * Detailed CLI detection info surfaced for diagnostics. Kept as a parallel
 * type so the existing {@link CliAvailability} IPC surface stays unchanged.
 *
 * `resolvedPath` contract:
 * - For `which`/`native`/`npm-global` probes: absolute filesystem path to the binary.
 * - For `wsl`: synthetic `wsl:<distro>` (execution target, not a Windows path).
 * - `null` when the binary was not found or execution was blocked before
 *   a path could be resolved.
 */
export interface AgentCliDetail {
  state: AgentAvailabilityState;
  resolvedPath: string | null;
  via: AgentCliProbeSource | null;
  /** Human-readable diagnostic message for UI (e.g. blocked-by-security reason). */
  message?: string;
  /** Reason when `state === "blocked"`. */
  blockReason?: AgentCliBlockReason;
  /** WSL distribution used when `via === "wsl"`. */
  wslDistro?: string;
  /**
   * All paths emitted by the shell probe (`which -a` / `where.exe`), in PATH
   * order. Populated only when the probe succeeded via `which`. The first
   * entry equals {@link AgentCliDetail.resolvedPath}; additional entries are
   * the duplicate installs that drove the duplicate-detection notification.
   */
  allResolvedPaths?: string[];
  /**
   * Passive auth discovery result. Populated alongside the binary probe to
   * drive onboarding nudges ("Needs Setup" tray section, Settings auth
   * panel) without gating launch.
   *
   * - `true`: a credential file or env var was detected for this agent.
   * - `false`: the agent declares an `authCheck` in the registry, the check
   *   ran, and nothing was found (or it failed / timed out). Show the nudge.
   * - `undefined`: no `authCheck` is configured, or the agent is in a state
   *   where discovery doesn't apply (WSL-capped, blocked, missing). Do not
   *   show a nudge.
   */
  authConfirmed?: boolean;
}

/** Map of agent ID → detailed detection result. */
export type AgentCliDetails = Partial<Record<AgentId, AgentCliDetail>>;

/** Version information for an agent */
export interface AgentVersionInfo {
  /** Agent ID */
  agentId: AgentId;
  /** Current installed version (null if not installed) */
  installedVersion: string | null;
  /** Latest available version (null if unable to check) */
  latestVersion: string | null;
  /** Whether an update is available */
  updateAvailable: boolean;
  /** Last check timestamp */
  lastChecked: number | null;
  /** Error message if version check failed */
  error?: string;
}

/** Agent update settings */
export interface AgentUpdateSettings {
  /** Enable automatic update checks */
  autoCheck: boolean;
  /** Check frequency in hours (default: 24) */
  checkFrequencyHours: number;
  /** Last automatic check timestamp */
  lastAutoCheck: number | null;
}

/** Payload for starting an agent update */
export interface StartAgentUpdatePayload {
  agentId: AgentId;
  /** Preferred update method (e.g., "npm", "brew") */
  method?: string;
}

/** Result of starting an agent update */
export interface StartAgentUpdateResult {
  /** Terminal ID where update is running */
  terminalId: string;
  /** Update command being executed */
  command: string;
}

/** Severity level for a prerequisite check */
export type PrerequisiteSeverity = "fatal" | "warn" | "silent";

/** Declarative specification for a single prerequisite tool */
export interface PrerequisiteSpec {
  /** Binary/tool name used for PATH lookup (e.g. "git", "gh", "claude") */
  tool: string;
  /** Human-readable display name (e.g. "Git", "GitHub CLI") */
  label: string;
  /** Binary to execute for PATH lookup (defaults to tool if omitted) */
  command?: string;
  /** Arguments to retrieve version (e.g. ["--version"]) */
  versionArgs: string[];
  /** How critical this prerequisite is */
  severity: PrerequisiteSeverity;
  /** Minimum semver version required (e.g. "18.0.0") */
  minVersion?: string;
  /** URL for installation instructions */
  installUrl?: string;
  /** OS-specific install instructions shown inline when the tool is missing */
  installBlocks?: Partial<Record<AgentInstallOS, AgentInstallBlock[]>>;
}

/** Result of checking a single system prerequisite */
export interface PrerequisiteCheckResult {
  /** Tool name (e.g. "git", "node", "npm") */
  tool: string;
  /** Human-readable display name */
  label: string;
  /** Whether the tool was found in PATH */
  available: boolean;
  /** Detected version string (e.g. "2.43.0"), null if not available */
  version: string | null;
  /** Severity level from the spec */
  severity: PrerequisiteSeverity;
  /** Whether the installed version meets the minimum requirement */
  meetsMinVersion: boolean;
  /** Minimum version required (for UI display), undefined if none */
  minVersion?: string;
  /** Installation URL (for UI display), undefined if none */
  installUrl?: string;
  /** OS-specific install instructions (for UI display), undefined if none */
  installBlocks?: Partial<Record<AgentInstallOS, AgentInstallBlock[]>>;
}

/** Full system health check result */
export interface SystemHealthCheckResult {
  /** Results for each checked prerequisite */
  prerequisites: PrerequisiteCheckResult[];
  /** True when all fatal prerequisites are available and meet minimum version */
  allRequired: boolean;
}

/** Hardware information for computing panel limit defaults */
export interface HardwareInfo {
  totalMemoryBytes: number;
  logicalCpuCount: number;
}

/** Summary of real app memory metrics from app.getAppMetrics() */
export interface AppMetricsSummary {
  /** Aggregate working-set across Daintree's Electron processes, in MB. 0 when unavailable. */
  totalMemoryMB: number;
  /** Set when the metric could not be read; the renderer should suppress the value rather than show 0. */
  unavailable?: true;
}

/** Per-process metrics entry from app.getAppMetrics() */
export interface ProcessMetricEntry {
  pid: number;
  type: string;
  name: string;
  memoryMB: number;
  cpuPercent: number;
}

/** V8 heap statistics from the main process */
export interface HeapStats {
  usedMB: number;
  limitMB: number;
  percent: number;
  externalMB: number;
}

/** Diagnostics info including uptime and event loop lag */
export interface DiagnosticsInfo {
  uptimeSeconds: number;
  eventLoopP99Ms: number;
  /** Total physical RAM (MB) from os.totalmem(); omitted when unreadable. */
  systemTotalMB?: number;
  /** Available physical RAM (MB) — free (+ purgeable on macOS) from process.getSystemMemoryInfo(); omitted when unreadable. */
  systemAvailableMB?: number;
}

/** Payload returned by the review collection IPC. */
export interface DiagnosticsReviewPayload {
  /** Raw diagnostic data (keyed by section). */
  payload: Record<string, unknown>;
  /** Ordered section keys for the review dialog. */
  sectionKeys: string[];
  /** Safe-stringified JSON preview (already redacted). */
  previewJson: string;
  /**
   * Approximate epoch (ms) the app process started, captured in the main
   * process. Backs the "Since application launch" time-window option so the
   * renderer can compute an absolute cutoff without a separate IPC round-trip.
   */
  appLaunchTimestamp: number;
}

/** User selections sent to the save-bundle IPC. */
export interface DiagnosticsBundleSavePayload {
  /** The reviewed and filtered payload (what the user saw in preview). */
  payload: Record<string, unknown>;
  /** Sections the user chose to include. */
  enabledSections: Record<string, boolean>;
  /** Find-and-replace redaction rules. */
  replacements: Array<{ kind?: "literal" | "regex"; find: string; replace: string }>;
  /**
   * Absolute epoch (ms) cutoff for log inclusion. Entries and rotated log
   * files older than this are excluded from the bundle. `null`/omitted means
   * full history (no time bound).
   */
  timeWindowStartMs?: number | null;
}

/**
 * Result of starting a renderer CPU profile recording. `expiresAt` is the
 * epoch (ms) when the main-side auto-stop fires; the renderer derives its
 * countdown from it rather than running an independent timer.
 */
export type RendererCpuProfileStartResult =
  | { status: "started"; expiresAt: number }
  | {
      status: "failed";
      reason: "already-recording" | "webcontents-destroyed" | "cdp-error";
      message?: string;
    };

/**
 * Result of collecting a renderer CPU profile. `canceled` means the user
 * dismissed the save dialog (silent, not an error). `devtools-detached`
 * means something (typically DevTools) stole the CDP session mid-recording
 * and the profile data is unrecoverable.
 */
export type RendererCpuProfileStopResult =
  | { status: "saved" }
  | { status: "canceled" }
  | {
      status: "failed";
      reason: "not-recording" | "already-stopping" | "devtools-detached" | "save-failed";
      message?: string;
    };

/** Payload for starting an agent install via setup wizard */
export interface AgentInstallPayload {
  agentId: string;
  /** Index of the install method to use (defaults to 0) */
  methodIndex?: number;
  /** Unique job identifier for progress correlation */
  jobId: string;
}

/** Result of an agent install job */
export interface AgentInstallResult {
  success: boolean;
  exitCode: number | null;
  error?: string;
}

/** Progress event streamed during agent install */
export interface AgentInstallProgressEvent {
  jobId: string;
  chunk: string;
  stream: "stdout" | "stderr";
}

/**
 * Lightweight enrichment payload for the "Report issue" deeplink. Fetched
 * synchronously at click time — must NOT call the slow diagnostics collector
 * (which spawns subprocesses and runs up to 5s per section). Encoded into
 * the GitHub URL body as collapsible `<details>` sections, gated by the
 * Sentry consent state on the renderer side.
 */
export interface ReportIssueEnrichment {
  /** Compact pre-formatted system snapshot (one short line per fact). */
  systemInfo: string;
  /**
   * Up to 10 most-recent action breadcrumbs (oldest first). Already
   * scrubbed at storage time via `safeArgs`; the URL formatter trims them
   * further to fit the budget.
   */
  recentActions: import("./crashRecovery.js").ActionBreadcrumb[];
}

/** Status of the installed Daintree CLI tool */
export interface CliInstallStatus {
  /** Whether the CLI script is installed */
  installed: boolean;
  /** Whether the installed CLI is current (symlink target or file contents match the bundled source) */
  upToDate: boolean;
  /** Absolute path where the CLI is installed */
  path: string;
}
