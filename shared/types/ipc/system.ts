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

/** Three-state availability for an individual agent CLI */
export type AgentAvailabilityState = "missing" | "installed" | "ready";

/** CLI availability status for AI agents */
export type CliAvailability = Record<AgentId, AgentAvailabilityState>;

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
  totalMemoryMB: number;
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
}

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

/** Status of the installed Canopy CLI tool */
export interface CliInstallStatus {
  /** Whether the CLI script is installed */
  installed: boolean;
  /** Whether the installed CLI is current (symlink target or file contents match the bundled source) */
  upToDate: boolean;
  /** Absolute path where the CLI is installed */
  path: string;
}
