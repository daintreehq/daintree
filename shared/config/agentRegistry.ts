import type { AgentRoutingConfig } from "../types/agentSettings.js";
import type { PrerequisiteSpec } from "../types/ipc/system.js";

export interface AgentHelpConfig {
  args: string[];
  title?: string;
}

export type AgentInstallOS = "macos" | "windows" | "linux" | "generic";

export interface AgentInstallBlock {
  label?: string;
  steps?: string[];
  commands?: string[];
  notes?: string[];
}

export interface AgentInstallHelp {
  docsUrl?: string;
  byOs?: Partial<Record<AgentInstallOS, AgentInstallBlock[]>>;
  troubleshooting?: string[];
}

/**
 * Configuration for pattern-based working state detection.
 * Patterns are matched against terminal output to detect when an agent is actively working.
 */
export interface AgentDetectionConfig {
  /**
   * Primary patterns that indicate working state (high confidence).
   * Patterns are matched against the last N lines of terminal output.
   * Use strings that will be converted to RegExp with case-insensitive flag.
   */
  primaryPatterns: string[];

  /**
   * Fallback patterns for early-stage output (medium confidence).
   * Checked when primary patterns don't match.
   */
  fallbackPatterns?: string[];

  /**
   * Patterns that indicate the agent has completed boot and is ready.
   * Use strings that will be converted to RegExp with case-insensitive flag.
   */
  bootCompletePatterns?: string[];

  /**
   * Patterns that indicate the agent is waiting for user input (prompt visible).
   * Use strings that will be converted to RegExp with case-insensitive flag.
   */
  promptPatterns?: string[];

  /**
   * Patterns that indicate an empty input prompt is visible.
   * Safe to scan from visible lines even when the cursor line is active output.
   */
  promptHintPatterns?: string[];

  /**
   * Number of lines from end of output to scan (default: 10).
   */
  scanLineCount?: number;

  /**
   * Number of lines from end of output to scan for prompt detection (default: 6).
   */
  promptScanLineCount?: number;

  /**
   * Activity debounce period in ms (default: 4000).
   * Time to wait after last activity before transitioning to idle.
   */
  debounceMs?: number;

  /**
   * Minimum quiet-output ms before the prompt fast-path can fire (default: 3000).
   * Lower values make the busy→idle transition snappier when a prompt is detected.
   * Agents with deterministic completion markers (e.g. Cursor) can use shorter
   * values; agents with silent inter-tool-call gaps (Claude/Codex) need the
   * default to avoid working↔waiting jitter (Issue #3606).
   */
  promptFastPathMinQuietMs?: number;

  /**
   * Confidence level when primary pattern matches (default: 0.95).
   */
  primaryConfidence?: number;

  /**
   * Confidence level when fallback pattern matches (default: 0.75).
   */
  fallbackConfidence?: number;

  /**
   * Confidence level when prompt pattern matches (default: 0.85).
   */
  promptConfidence?: number;

  /**
   * Patterns that indicate the agent successfully completed a task.
   * When detected, briefly transition to "completed" state before settling to "waiting".
   * Use strings that will be converted to RegExp with case-insensitive flag.
   */
  completionPatterns?: string[];

  /**
   * Confidence level when completion pattern matches (default: 0.90).
   */
  completionConfidence?: number;

  /**
   * Patterns matched against terminal window title (OSC 0/2) for state detection.
   * Substrings checked via includes() against the title string.
   */
  titleStatePatterns?: {
    working: string[];
    waiting: string[];
  };
}

export interface AgentModelConfig {
  id: string;
  name: string;
  shortLabel: string;
}

/**
 * Passive auth discovery probe. The result is surfaced as
 * `AgentCliDetail.authConfirmed` (true / false / undefined) to drive onboarding
 * UI, but never gates launch — an agent whose binary is on PATH is always
 * `ready`. Registry entries use this to light up setup nudges in the tray and
 * settings when a credential can't be found.
 */
export interface AgentAuthCheck {
  /** Platform-specific config file paths to check (relative to os.homedir()) */
  configPaths?: Partial<Record<"darwin" | "linux" | "win32", string[]>>;
  /** Platform-independent config file paths (relative to os.homedir()) */
  configPathsAll?: string[];
  /** Environment variable(s) that indicate auth when present */
  envVar?: string | string[];
}

export interface AgentPreset {
  id: string;
  name: string;
  description?: string;
  env?: Record<string, string>;
  args?: string[];
  /** Per-preset override: when set, overrides the agent-level dangerousEnabled setting */
  dangerousEnabled?: boolean;
  /** Per-preset override: extra CLI flags merged on top of agent-level customFlags */
  customFlags?: string;
  /** Per-preset override: when set, overrides the agent-level inlineMode setting */
  inlineMode?: boolean;
  /** Optional brand color (CSS hex) used to tint the agent icon for this preset */
  color?: string;
  /**
   * Ordered list of preset IDs to try when this preset's provider becomes
   * unavailable (connection errors, hard auth failures). Each entry must be
   * an ID of another preset for the SAME agent. Self-references, duplicates,
   * and unknown IDs are stripped by `getMergedPresets` validation. Capped at
   * `FALLBACK_CHAIN_MAX` entries.
   */
  fallbacks?: string[];
}

/** Max fallback presets that can be chained after the primary. */
export const FALLBACK_CHAIN_MAX = 3;

export interface AgentProviderTemplate {
  id: string;
  name: string;
  description?: string;
  env?: Record<string, string>;
  args?: string[];
  dangerousEnabled?: boolean;
  customFlags?: string;
  inlineMode?: boolean;
}

/**
 * Cross-package-manager install metadata for an agent. Each field names the
 * package as known to that ecosystem; CliAvailabilityService and probe code
 * use these to synthesize default lookup paths when `nativePaths` are not
 * supplied. Fields are additive — none are mutually exclusive — and an agent
 * may declare any subset relevant to how it ships.
 */
export interface AgentPackages {
  /** npm package name (e.g. "@anthropic-ai/claude-code"). Probed via npm-global bin shim. */
  npm?: string;
  /** PyPI package name (e.g. "open-interpreter"). Drives uv/pipx path synthesis. */
  pypi?: string;
  /** Homebrew formula name (e.g. "opencode"). Surfaced by install/update help only today. */
  brew?: string;
  /** winget package id (e.g. "Anthropic.Claude"). Surfaced by install/update help only today. */
  winget?: string;
  /** Scoop package coordinates — bucket plus formula name. */
  scoop?: { bucket: string; name: string };
  /** Cargo crate name. Surfaced by install/update help only today. */
  cargo?: string;
  /** Go module path (e.g. "github.com/owner/repo/cmd/agent"). Surfaced by install/update help only today. */
  go?: string;
}

/**
 * Discriminated union describing how an agent's prior session can be resumed.
 * The `kind` field selects the shape:
 *
 * - `session-id` — agent emits a session ID on quit (Claude/Gemini/Codex/etc.).
 *   `quitCommand` is sent to the running process; `sessionIdPattern` (a regex
 *   with one capture group) is matched against the post-quit output to harvest
 *   the ID, which is then passed to `args(id)` on the next launch.
 * - `rolling-history` — agent has no session model but records a chronological
 *   history that can be resumed in order. `args()` returns the resume flags;
 *   no ID is captured.
 * - `named-target` — agent resumes a user-named target (e.g. a plan name).
 *   `argsForTarget(name)` produces the launch args for the chosen target.
 * - `project-scoped` — agent stores session state on disk keyed by project
 *   directory. `args()` returns the resume flags; nothing is captured at
 *   shutdown. Used by directory-aware CLIs like Kiro.
 *
 * `quitCommand` and `shutdownKeySequence` apply to all kinds — the PTY host
 * sends the quit command (or the key sequence, if provided) on graceful
 * shutdown. `sessionIdPattern` applies only to `session-id` and is the only
 * field that triggers the PTY host's pattern-match capture loop.
 */
export type AgentResume =
  | {
      kind: "session-id";
      /** Returns CLI args for resuming a captured session (e.g. ["--resume", id]). */
      args: (sessionId: string) => string[];
      /** Command sent to the running agent to trigger graceful exit (e.g. "/quit"). */
      quitCommand: string;
      /** Regex with a single capture group for the session ID emitted post-quit. */
      sessionIdPattern: string;
      /** Optional raw key sequence sent before `quitCommand` (e.g. Ctrl-C). */
      shutdownKeySequence?: string;
    }
  | {
      kind: "rolling-history";
      args: () => string[];
      quitCommand?: string;
      shutdownKeySequence?: string;
    }
  | {
      kind: "named-target";
      argsForTarget: (target: string) => string[];
      quitCommand?: string;
      shutdownKeySequence?: string;
    }
  | {
      kind: "project-scoped";
      args: () => string[];
      quitCommand?: string;
      shutdownKeySequence?: string;
    };

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  /** Default CLI arguments to pass at spawn (before user flags) */
  args?: string[];
  color: string;
  iconId: string;
  /** Available models for per-panel model selection at launch time */
  models?: AgentModelConfig[];
  supportsContextInjection: boolean;
  shortcut?: string | null;
  tooltip?: string;
  usageUrl?: string;
  help?: AgentHelpConfig;
  install?: AgentInstallHelp;
  capabilities?: {
    scrollback?: number;
    blockAltScreen?: boolean;
    blockMouseReporting?: boolean;
    resizeStrategy?: "default" | "settled";
    /** CLI flag to disable alt-screen and use inline rendering (e.g., "--no-alt-screen") */
    inlineModeFlag?: string;
    /** Whether the agent CLI supports bracketed paste input (default: true) */
    supportsBracketedPaste?: boolean;
    /** Escape sequence sent for Shift+Enter / soft newline (default: "\x1b\r") */
    softNewlineSequence?: string;
    /** Input sequences the activity monitor should ignore (default: ["\x1b\r"]) */
    ignoredInputSequences?: string[];
    /** Delay in ms before sending Enter key after body write (default: 200) */
    submitEnterDelayMs?: number;
  };
  /**
   * Configuration for pattern-based working state detection.
   * If not specified, built-in patterns for the agent ID are used.
   */
  detection?: AgentDetectionConfig;
  /**
   * Version detection configuration.
   */
  version?: {
    /** Command arguments to get version (e.g., ["--version"]) */
    args: string[];
    /** npm package name for version lookup (e.g., "@anthropic-ai/claude-code") */
    npmPackage?: string;
    /**
     * PyPI package name for version lookup (e.g., "open-interpreter"). When
     * set, AgentVersionService queries https://pypi.org/pypi/<pkg>/json after
     * github/npm fall through.
     */
    pypiPackage?: string;
    /** GitHub repository for version lookup (e.g., "owner/repo") */
    githubRepo?: string;
    /** Release notes URL template (use {version} placeholder) */
    releaseNotesUrl?: string;
  };
  /**
   * Update command configuration. Each key names the install method whose
   * upgrade command lives in the value (e.g. `npm: "npm install -g foo@latest"`).
   * Recognised keys mirror {@link AgentPackages} plus shell-script flavours
   * (`curl`, `powershell`); unknown keys are surfaced verbatim by the UI.
   */
  update?: Partial<Record<keyof AgentPackages | "curl" | "powershell" | (string & {}), string>>;
  /**
   * Routing configuration for intelligent agent dispatch.
   * Used by orchestrators to select the best agent for a given task.
   */
  routing?: AgentRoutingConfig;
  /**
   * Approximate context window size in tokens for this agent's model.
   * Used to warn when context usage is high.
   */
  contextWindow?: number;
  /**
   * Per-agent env vars (reserved for future use; currently unused because all
   * terminals share a universal env — see
   * `docs/architecture/terminal-identity.md`).
   */
  env?: Record<string, string>;
  /**
   * Resume + graceful-shutdown configuration. The `kind` discriminator
   * selects how the PTY host treats this agent on quit: only `session-id`
   * runs the post-quit pattern-match capture loop; the other kinds send
   * `quitCommand` (or `shutdownKeySequence`) and exit without scraping IDs.
   *
   * See {@link AgentResume} for the full shape per variant.
   */
  resume?: AgentResume;
  /**
   * Prerequisites required for this agent to function.
   * Merged with baseline prerequisites during health checks.
   */
  prerequisites?: PrerequisiteSpec[];
  /**
   * Authentication check configuration.
   * Used by CliAvailabilityService to distinguish "installed" from "ready".
   */
  authCheck?: AgentAuthCheck;
  /**
   * Absolute filesystem paths to probe when PATH-based lookup (`which`/`where`)
   * fails. Used to detect agents installed by native installers into locations
   * the Electron process may not inherit in PATH — notably `~/.local/bin/claude`
   * for Anthropic's native installer on macOS/Linux, and
   * `%LOCALAPPDATA%\claude-code\bin\claude.exe` on Windows.
   *
   * Tilde (`~`) is expanded to `os.homedir()` and Windows `%VAR%` tokens are
   * expanded against `process.env` by CliAvailabilityService before probing
   * (see `expandWindowsEnvVars()` in electron/setup/environment.ts). Paths are
   * tried in listed order; first accessible file wins.
   */
  nativePaths?: string[];
  /**
   * Cross-package-manager install metadata. When set, the relevant
   * `CliAvailabilityService` probes are activated automatically:
   *  - `packages.npm` → npm-global bin-shim probe (replaces `npmGlobalPackage`).
   *  - `packages.pypi` → uv/pipx/local-bin path synthesis on macOS/Linux and
   *    `%USERPROFILE%`/`%APPDATA%`/`%LOCALAPPDATA%` paths on Windows.
   *  - Other fields (`brew`/`winget`/`scoop`/`cargo`/`go`) are surfaced today
   *    only by install-help UI; probe synthesis for those ecosystems may be
   *    added later.
   *
   * Prefer `packages` over the deprecated top-level `npmGlobalPackage` when
   * authoring new agents.
   */
  packages?: AgentPackages;
  /**
   * @deprecated Use `packages.npm` instead. Kept as a backward-compatible
   * alias so persisted `UserAgentRegistryService` entries continue to work
   * during the transition. Will be removed in a future release.
   *
   * npm package name to use as a last-resort detection probe. When PATH and
   * native-path probes both miss, `CliAvailabilityService` queries
   * `npm config get prefix` and checks whether the package's installed bin
   * shim exists at `<prefix>/bin/<command>` (POSIX) or `<prefix>\<command>.cmd`
   * (Windows). This positively confirms the binary is globally installed and
   * launchable from a plain shell — unlike the earlier npx-cache probe, which
   * produced false positives whenever the package had been run once via
   * `npx <pkg>` (the ephemeral `~/.npm/_npx` cache hits even when no global
   * bin shim exists).
   *
   * Omit this field to opt out of the npm-global probe for agents not
   * distributed via npm.
   */
  npmGlobalPackage?: string;
  /**
   * When `true`, CliAvailabilityService will additionally probe WSL on Windows
   * if all other probes fail. Used for agents (e.g. Codex) that may only be
   * available via a WSL distribution on Windows hosts. WSL detection is
   * exposed through `AgentCliDetail.via === "wsl"` for diagnostics; actual
   * launch routing via `wsl.exe` is out of scope for the detection service.
   */
  supportsWsl?: boolean;
  /**
   * Available presets for this agent — variants sharing the same base CLI
   * but differing in env overrides, args, or routing (e.g. CCR-routed models).
   * Populated at runtime by services like CcrConfigService.
   */
  presets?: AgentPreset[];
  /**
   * ID of the preset to use when none is explicitly selected.
   * If omitted, the first preset in the array is the default.
   */
  defaultPresetId?: string;
  /**
   * Suggested environment variable overrides for this agent, shown as UI hints
   * in the preset and global-env editors. Discovery-only — no default values.
   */
  envSuggestions?: Array<{ key: string; hint: string }>;
  /**
   * Named provider templates for preset creation. When present, the "Add Preset"
   * dialog offers a "From template" option that pre-fills non-secret env vars
   * (base URL, model aliases, timeout) but leaves API-key fields blank.
   */
  providerTemplates?: AgentProviderTemplate[];
}

import { config as claudeConfig } from "./agents/claude.js";
import { config as geminiConfig } from "./agents/gemini.js";
import { config as codexConfig } from "./agents/codex.js";
import { config as opencodeConfig } from "./agents/opencode.js";
import { config as cursorConfig } from "./agents/cursor.js";
import { config as kiroConfig } from "./agents/kiro.js";
import { config as copilotConfig } from "./agents/copilot.js";
import { config as gooseConfig } from "./agents/goose.js";
import { config as crushConfig } from "./agents/crush.js";
import { config as qwenConfig } from "./agents/qwen.js";
import { config as interpreterConfig } from "./agents/interpreter.js";
import { config as mistralConfig } from "./agents/mistral.js";

// Built-in agent registry. Per-agent configs live in `./agents/<id>.ts`
// (mirroring `src/services/actions/definitions/`). When adding a new agent,
// create the per-agent file, import it here, add the entry below, and add
// the ID to `BUILT_IN_AGENT_IDS` in `agentIds.ts` — the runtime check after
// this declaration throws if any built-in is missing.
export const AGENT_REGISTRY: Record<string, AgentConfig> = {
  claude: claudeConfig,
  gemini: geminiConfig,
  codex: codexConfig,
  opencode: opencodeConfig,
  cursor: cursorConfig,
  kiro: kiroConfig,
  copilot: copilotConfig,
  goose: gooseConfig,
  crush: crushConfig,
  qwen: qwenConfig,
  interpreter: interpreterConfig,
  mistral: mistralConfig,
};

import { BUILT_IN_AGENT_IDS } from "./agentIds.js";

// Runtime check: every BuiltInAgentId must have an entry in the registry.
for (const id of BUILT_IN_AGENT_IDS) {
  if (!(id in AGENT_REGISTRY)) {
    throw new Error(
      `AGENT_REGISTRY is missing entry for built-in agent "${id}". Update AGENT_REGISTRY or BUILT_IN_AGENT_IDS.`
    );
  }
}

export function getAgentIds(): string[] {
  return Object.keys(AGENT_REGISTRY);
}

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  return AGENT_REGISTRY[agentId];
}

export function isRegisteredAgent(agentId: string): boolean {
  return agentId in AGENT_REGISTRY;
}

let userRegistry: Record<string, AgentConfig> = {};

export function setUserRegistry(registry: Record<string, AgentConfig>): void {
  userRegistry = registry;
}

export function getUserRegistry(): Record<string, AgentConfig> {
  return userRegistry;
}

export function getEffectiveRegistry(): Record<string, AgentConfig> {
  return { ...userRegistry, ...AGENT_REGISTRY };
}

export function getEffectiveAgentIds(): string[] {
  return Object.keys(getEffectiveRegistry());
}

export function getEffectiveAgentConfig(agentId: string): AgentConfig | undefined {
  return getEffectiveRegistry()[agentId];
}

export function isEffectivelyRegisteredAgent(agentId: string): boolean {
  return agentId in getEffectiveRegistry();
}

export function isBuiltInAgent(agentId: string): boolean {
  return agentId in AGENT_REGISTRY;
}

export function isUserDefinedAgent(agentId: string): boolean {
  return agentId in userRegistry && !(agentId in AGENT_REGISTRY);
}

export function getAgentModelConfig(
  agentId: string,
  modelId: string
): AgentModelConfig | undefined {
  const config = getEffectiveAgentConfig(agentId);
  return config?.models?.find((m) => m.id === modelId);
}

/**
 * Default fast/cost-efficient model IDs for the assistant (HelpPanel) use case.
 * Used as fallback when no user-configured assistantModelId is stored.
 */
export const ASSISTANT_FAST_MODELS: Record<string, string> = {
  claude: "claude-sonnet-4-6",
  gemini: "gemini-2.5-flash",
  codex: "gpt-5.3-codex-spark",
};

export function getAgentDisplayTitle(agentId: string, modelId?: string): string {
  const config = getEffectiveAgentConfig(agentId);
  const baseName = config?.name ?? agentId;
  if (!modelId) return baseName;
  const model = config?.models?.find((m) => m.id === modelId);
  return model ? `${baseName} (${model.shortLabel})` : baseName;
}

export function getAgentPreset(agentId: string, presetId?: string): AgentPreset | undefined {
  const config = getEffectiveAgentConfig(agentId);
  if (!config?.presets?.length) return undefined;
  if (!presetId) {
    const defaultId = config.defaultPresetId;
    if (defaultId) return config.presets.find((f) => f.id === defaultId);
    return config.presets[0];
  }
  return config.presets.find((f) => f.id === presetId);
}

export function setAgentPresets(agentId: string, presets: AgentPreset[]): void {
  const config = AGENT_REGISTRY[agentId];
  if (config) {
    (config as { presets?: AgentPreset[] }).presets = presets;
  }
}
