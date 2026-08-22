import type { PrerequisiteSpec } from "../types/ipc/system.js";
import type { CompletionSourceConfig } from "../types/completionSources.js";

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
  /**
   * The command hands off to an external/GUI installer and returns before that
   * installer finishes, so a zero exit code does NOT mean the tool is
   * installed. `xcode-select --install` is the canonical case. Callers must
   * surface a "finish it, then re-check" state rather than reporting success.
   */
  opensExternalInstaller?: boolean;
}

export interface AgentInstallHelp {
  docsUrl?: string;
  byOs?: Partial<Record<AgentInstallOS, AgentInstallBlock[]>>;
  troubleshooting?: string[];
}

/**
 * A curated external link surfaced in the agent button context menu.
 * Labels are sentence case with no trailing period ("View usage",
 * "View docs", "Billing settings"). Only declare links to genuinely
 * useful destinations — omit the field rather than pointing at a
 * product homepage.
 */
export interface AgentExternalLink {
  label: string;
  url: string;
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
   * Activity debounce period in ms — time to wait after last activity before
   * transitioning to idle. `buildActivityMonitorOptions` floors this to
   * AGENT_WAITING_QUIET_MS (8000) to prevent working↔waiting jitter during
   * silent inter-tool-call gaps (#3606); sub-floor values are not honored.
   * Omit to accept the 8000ms default.
   */
  debounceMs?: number;

  /**
   * Minimum quiet-output ms before the prompt fast-path can fire.
   * `buildActivityMonitorOptions` floors this to the effective idle debounce
   * (>= AGENT_WAITING_QUIET_MS, 8000) for the same #3606 jitter guard —
   * sub-floor values are not honored. Omit to accept the default.
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
  /** Legacy per-preset bypass override; superseded by `dangerousMode`. */
  dangerousEnabled?: boolean;
  /**
   * Per-preset tri-state bypass override (`DangerousMode`), layered on top of
   * the agent's resolved mode: `"off"` vetoes the agent/global value,
   * `"inherit"`/absent defers to the agent's Default scope. Inlined union to
   * avoid a config→types import cycle.
   */
  dangerousMode?: "inherit" | "on" | "off";
  /** Per-preset override: extra CLI flags merged on top of agent-level customFlags */
  customFlags?: string;
  /**
   * Per-preset tri-state alt-screen override (`InlineMode`), layered on top of
   * the agent's resolved mode: `"off"` (alt-screen) vetoes an agent/global
   * `"on"` (inline), `"inherit"`/absent defers to the agent's Default scope. A
   * legacy boolean is read literally (`true → "on"`). Inlined union to avoid a
   * config→types import cycle.
   */
  inlineMode?: boolean | "inherit" | "on" | "off";
  /** Optional brand color (CSS hex) this preset's mark inks are derived from */
  color?: string;
  /** Optional free-form panel/button title; falls back to `name` when unset */
  displayTitle?: string;
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
  dangerousMode?: "inherit" | "on" | "off";
  customFlags?: string;
  inlineMode?: boolean | "inherit" | "on" | "off";
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
 * A shutdown signal that escalates one key press at a time, gated on the
 * agent's own output rather than on a fixed press count (#11851).
 *
 * `shutdownKeySequence` is written exactly once, which is safe only for agents
 * where one press is either enough or harmless. Codex is neither: while its
 * Ratatui TUI holds raw mode a Ctrl-C is just a keystroke, but the instant
 * cooked mode returns the next one is a real SIGINT that kills the process
 * before it can print its resume hint. Measured on `codex-cli 0.147.0`: two
 * presses print the hint in 0.76-1.16s depending on state, three print nothing
 * at all. The press count needed varies with state (leftover composer text
 * costs one, being mid-turn costs another), so no constant is correct.
 *
 * `gateText` is the escape hatch: the TUI prints a confirm-to-quit footer after
 * an absorbed press, so a fresh match is positive proof the TUI is still alive
 * and in raw mode — i.e. that the next press is still a keystroke. Send one,
 * wait for a fresh match, and only then send the next.
 *
 * Declaring this REPLACES the `quitCommand` path entirely: no input-clear
 * prelude, no slash command, no fallback. Writing `quitCommand` after a stalled
 * escalation would put the very text into the user's transcript that this
 * exists to keep out.
 *
 * Per-agent evidence only. Do not copy this to another agent without measuring
 * that agent's own TUI — the gate string, the press economics, and the raw-mode
 * boundary are all specific to the CLI that was measured.
 */
export interface AgentGatedKeyEscalation {
  kind: "gated-key-escalation";
  /** Raw bytes written per press (e.g. Ctrl-C). */
  keySequence: string;
  /**
   * Literal substring (NOT a regex) matched against ANSI-stripped output
   * produced since the last press. A literal keeps an unescapable TUI glyph
   * from silently compiling into a pattern that never matches.
   */
  gateText: string;
  /**
   * Hard cap on presses. A safety net, not the mechanism — the gate is what
   * actually decides whether another press is safe. Reaching the cap stops the
   * escalation but does NOT end the teardown.
   */
  maxPresses: number;
  /**
   * How long to wait for a fresh `gateText` match after a press. On expiry the
   * escalation stops and the teardown keeps listening for the session pattern
   * on its remaining budget — a press that quit the agent outright, or one that
   * dismissed a modal without redrawing the footer, still gets its hint read.
   */
  perPressTimeoutMs: number;
}

interface AgentSessionIdResumeBase {
  kind: "session-id";
  /** Returns CLI args for resuming a captured session (e.g. ["--resume", id]). */
  args: (sessionId: string) => string[];
  /**
   * Regex with a single capture group for the session ID emitted post-quit.
   *
   * OMIT when the agent prints no resume hint this tree can match against real
   * output. An omitted pattern skips the teardown capture loop outright, which
   * is the honest shape for an agent whose id can't be observed: a fabricated
   * pattern spends the whole shutdown budget matching nothing and reports
   * `exited-no-match`, which reads as a broken regex rather than as an agent
   * that never had a hint to scrape (#11851 — Antigravity, 0 captures in 6).
   * `resumeLatestArgs` stays available to such an agent as its resume path.
   */
  sessionIdPattern?: string;
  /**
   * CLI args for resuming the most recent session without a captured ID
   * (e.g. ["--continue"] for Claude, ["-r", "latest"] for Gemini,
   * ["resume", "--last"] for Codex). When present, the relaunch path uses
   * these args as a fallback when `sessionIdPattern` capture missed
   * (timeout, no match). Scoped to the launch CWD by the underlying CLI.
   * Omit for agents that have no resume-latest flag.
   */
  resumeLatestArgs?: string[];
  /**
   * CLI args that ASSIGN a caller-supplied session id at launch, for CLIs
   * that accept one (e.g. Claude's `--session-id <uuid>`). Declaring this
   * inverts how the id is obtained (#11782): instead of scraping it out of
   * the TUI during teardown, Daintree mints the id up front and hands it to
   * the CLI, so the id is known before the session exists.
   *
   * That removes the scrape's whole failure surface for this agent. The
   * teardown scrape only works when the agent is idle and unblocked at the
   * exact moment we tear it down — a mid-turn agent swallows `quitCommand`
   * as chat text, a modal (trust/approval prompt) eats the keystrokes, and
   * an empty session exits without printing a hint at all. A pre-assigned
   * id also survives the paths the scrape can never reach: force quit, a
   * crash, a SIGKILL, or a pty-host death, none of which run a teardown.
   *
   * ONE-SHOT, NOT IDEMPOTENT. The id may only be assigned when creating a
   * NEW conversation — re-sending an already-used id is an error, not a
   * resume (`claude --session-id <used>` exits with "Session ID <id> is
   * already in use"). Resuming that conversation later goes through
   * {@link AgentResume.args} (`--resume <id>`), which reuses the original
   * id rather than minting a new one. So: assign once at fresh launch,
   * resume by id forever after, and mint a DISTINCT id for a duplicated
   * pane (see `buildAssignedSessionIdArgs`).
   *
   * Omit for CLIs that only hand out their own ids — those keep the
   * `sessionIdPattern` teardown scrape as their sole capture path.
   */
  assignSessionIdArgs?: (sessionId: string) => string[];
}

/**
 * `session-id` resume, with its shutdown protocol as a closed choice: EITHER
 * the structured gated escalation OR the one-shot `quitCommand` (plus optional
 * `shutdownKeySequence`) that every other scrape agent uses. The two are
 * mutually exclusive at the type level because combining them is always a bug —
 * a gated Ctrl-C exists precisely to avoid writing a slash command, so a config
 * carrying both would defeat itself on the fallback path.
 */
export type AgentSessionIdResume = AgentSessionIdResumeBase &
  (
    | {
        shutdownSignal: AgentGatedKeyEscalation;
        quitCommand?: never;
        shutdownKeySequence?: never;
      }
    | {
        shutdownSignal?: never;
        /** Command sent to the running agent to trigger graceful exit (e.g. "/quit"). */
        quitCommand: string;
        /** Optional raw key sequence sent before `quitCommand` (e.g. Ctrl-C). */
        shutdownKeySequence?: string;
      }
  );

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
 * shutdown. `sessionIdPattern` and `shutdownSignal` apply only to `session-id`;
 * `sessionIdPattern` is the only field that triggers the PTY host's
 * pattern-match capture loop.
 */
export type AgentResume =
  | AgentSessionIdResume
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

/**
 * How an agent's conversation history fares when its project folder is moved or
 * renamed (#11282, phase 5). Surfaced in the relocation preview so the user is
 * warned BEFORE a move when a conversation can't be resumed at the new path.
 *
 * The tier is a static property of the provider's resume mechanism, computed
 * live from this config at preview time and never persisted (a captured tier
 * would go stale as CLIs change). `resume.kind` alone is NOT a reliable
 * discriminator: two agents can both be `kind: "session-id"` yet differ — Codex
 * resumes by a globally-addressable id, while Claude's store is path-slug-scoped
 * and can't resume at a new path.
 *
 * - `preserved` — a captured session resumes automatically at the new path
 *   (globally-addressable session ids, e.g. Codex, Copilot).
 * - `project-local` — the history physically lives inside the project folder, so
 *   it travels with the move and resumes at the new path (e.g. Aider, which
 *   writes `.aider.chat.history.md` into the git root). A cwd-scoped LOOKUP into
 *   a home-dir store is NOT this tier — that's `provider-migration`.
 * - `provider-migration` — the conversation persists on disk but the provider
 *   can't resume it at the new path, and Daintree must never touch the
 *   provider's private store (#4100), so recovery needs a manual provider step
 *   (e.g. Claude Code's path-slug store, Kiro's absolute-path-keyed SQLite).
 * - `unavailable` — the agent has no usable resume path for a moved folder
 *   (e.g. Gemini's retired CLI, Crush which omits `resume` entirely).
 * - `unverified` — continuity across a move hasn't been confirmed for this
 *   provider; the default for any unclassified agent so we never overclaim.
 *
 * `CONVERSATION_CONTINUITY_TIERS` below is the canonical runtime list; the type
 * is derived from it so a single source of truth backs both. Tests iterate that
 * tuple instead of re-declaring the union (which would just duplicate a typed
 * literal).
 */
export const CONVERSATION_CONTINUITY_TIERS = [
  "preserved",
  "project-local",
  "provider-migration",
  "unavailable",
  "unverified",
] as const;

export type ConversationContinuityTier = (typeof CONVERSATION_CONTINUITY_TIERS)[number];

export interface AgentContinuity {
  tier: ConversationContinuityTier;
  /**
   * One short, provider-specific sentence shown beneath the tier in the
   * relocation preview. Sentence case, no trailing period. Omit to let the UI
   * fall back to a generic per-tier line.
   */
  detail?: string;
}

/**
 * Capability shape describing how an agent participates in the Daintree
 * assistant overlay. Each field captures a distinct wiring concern; the older
 * `supportsAssistant: boolean` collapsed all of them into one bit and
 * couldn't represent partial wiring.
 */
export interface AssistantSupports {
  /**
   * How MCP servers are injected into the agent's session.
   * - `"project-config"`: written to per-session config files (e.g. Claude's
   *   `.mcp.json` plus `.claude/settings.json` overlay).
   * - `"cli-flags"`: passed as `-c key=value` flags at spawn time (e.g. Codex).
   * - `"env-only"`: connection details are passed purely through PTY env vars
   *   the agent reads itself (`DAINTREE_MCP_URL`, `DAINTREE_MCP_TOKEN`, …) —
   *   no config file written, no CLI flags (e.g. Daintree Assistant).
   */
  mcpInjection: "project-config" | "cli-flags" | "env-only";
  /**
   * Whether the agent reads a session-dir settings overlay that bakes in
   * permissions / project-MCP trust (e.g. Claude's `.claude/settings.json`
   * with `enableAllProjectMcpServers: true`).
   */
  settingsOverlay: boolean;
  /**
   * Whether this agent exposes a `--dangerously-skip-*` CLI flag that the
   * help-session launch path appends when the user turns on bypass
   * permissions. Keyed off the `bypassPermissions` snapshot, not the MCP
   * capability tier — the two controls are orthogonal. Corresponds to entries
   * in `DEFAULT_DANGEROUS_ARGS`.
   */
  permissionBypass: boolean;
  /**
   * Whether the agent's workspace-trust dialog is fully handled by the
   * session-dir overlay (so the user is never re-prompted inside the agent
   * after Daintree has launched it).
   */
  trustDialog: boolean;
  /**
   * Whether version-probe data is wired up for this agent's CLI.
   */
  versionProbe: boolean;
  /**
   * Visibility tier in the assistant settings dropdown.
   * - `"stable"`: shown to users; this is the path the old `true` boolean
   *   took. Maintained and supported.
   * - `"experimental"`: structurally enabled but hidden from the picker
   *   until promoted. Use for partial wiring that hasn't been validated end
   *   to end yet.
   * - `"deprecated"`: was wired, now retired from the assistant overlay. The
   *   wiring shape is preserved for historical reference, but the agent is
   *   excluded from both the picker and the help-session launch path. The
   *   agent still launches normally from the main toolbar.
   */
  tier: "stable" | "experimental" | "deprecated";
}

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
  /**
   * Marks {@link models} as the authoritative set this CLI accepts, not just an
   * offline fallback. `AgentModelCatalogService` then lets the remote
   * models.dev catalog enrich these entries (names, context windows) but never
   * contribute IDs of its own, because models.dev groups by *provider* — every
   * model OpenAI or Anthropic publishes — not by what the CLI's `--model` flag
   * takes. Leave unset for agents whose list is a partial seed and should keep
   * growing from remote discovery. A live CLI-derived catalog (Codex's
   * `debug models --bundled`) still outranks a curated list.
   */
  curatedModels?: boolean;
  supportsContextInjection: boolean;
  /**
   * Per-concern wiring shape for the Daintree assistant overlay. Replaces the
   * older `supportsAssistant?: boolean`, which collapsed several distinct
   * concerns (MCP injection mechanism, settings overlay, permission bypass,
   * trust dialog, version probe) into a single yes/no and prevented
   * representing partial wiring.
   *
   * Use `false` for agents that are structurally ineligible (e.g. an MCP
   * server rather than a client) — leave a comment explaining why. Use
   * `undefined` for agents that simply aren't wired yet.
   *
   * `tier` controls visibility in the assistant dropdown: `"stable"` is
   * shown (this is the path the old `true` boolean took); `"experimental"`
   * is structurally enabled but hidden from the picker until promoted.
   */
  supports?: AssistantSupports | false;
  /**
   * Minimum installed CLI semver required for the Daintree Assistant launch
   * path. Compared against the live `AgentVersionService.getVersion()` probe
   * before `provisionHelpSession` runs — when the installed version is
   * definitively below this floor, `HelpPanel` surfaces an inline upgrade
   * prompt instead of minting a session token. A `null` probe result (CLI
   * missing or version unparseable) passes through so existing missing-CLI
   * surfaces handle it. Omit when no minimum applies.
   */
  assistantMinVersion?: string;
  shortcut?: string | null;
  tooltip?: string;
  usageUrl?: string;
  /** Curated links shown in the agent button context menu; omit when none apply */
  externalLinks?: AgentExternalLink[];
  help?: AgentHelpConfig;
  install?: AgentInstallHelp;
  capabilities?: {
    scrollback?: number;
    blockAltScreen?: boolean;
    blockMouseReporting?: boolean;
    /** Use `settled` for sticky cursor-relative TUIs that should receive one stable final grid. */
    resizeStrategy?: "default" | "settled";
    /** CLI flag to disable alt-screen and use inline rendering (e.g., "--no-alt-screen") */
    inlineModeFlag?: string;
    /**
     * CLI flag that forces the full-screen alternate buffer (e.g. "--fullscreen"),
     * the opposite polarity of {@link inlineModeFlag}. Declare it for a CLI that
     * picks inline on its own — via its own config file or terminal
     * auto-detection — so choosing "Alt screen" is more than the absence of the
     * inline flag (#11423). Omit it when the CLI already defaults to alt-screen;
     * dropping `inlineModeFlag` is then enough.
     *
     * Both are single tokens and mutually exclusive: exactly one is injected per
     * launch, and the launch path strips the other. Never pair this with
     * `blockAltScreen: true` — forcing a full-screen TUI while the terminal
     * strips its alt-screen escape sequences leaves the agent unusable.
     */
    altScreenFlag?: string;
    /**
     * Default inline-mode state when the user hasn't chosen one. Agents with an
     * `inlineModeFlag` otherwise default to inline (`true`); set this to `false`
     * for a full-screen TUI that renders better on the alternate screen (clean
     * scroll region, no garbled redraw history in scrollback) while still
     * exposing the inline flag as an opt-in.
     */
    defaultInlineMode?: boolean;
    /** Whether the agent CLI supports bracketed paste input (default: true) */
    supportsBracketedPaste?: boolean;
    /** Escape sequence sent for Shift+Enter / soft newline (default: "\x1b\r") */
    softNewlineSequence?: string;
    /** Input sequences the activity monitor should ignore (default: ["\x1b\r"]) */
    ignoredInputSequences?: string[];
    /** Delay in ms before sending Enter key after body write (default: 200) */
    submitEnterDelayMs?: number;
    /**
     * How the graceful-shutdown path submits the quit command to the agent
     * PTY. Ink-based TUIs (Claude) treat any gap between the command body
     * and Enter as deliberate slow typing and never submit the slash
     * command, so they require a single combined write. Ratatui-based TUIs
     * (Codex) read the PTY buffer atomically and conflate a combined write
     * as a paste, so they require the body and Enter as separate writes.
     * Default: split-write — safe for Codex and readline-based CLIs.
     */
    quitSubmitMode?: "single-write" | "split-write";
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
   * How this agent's conversation history fares across a project-folder move
   * (#11282, phase 5). Read live by the relocation preview via
   * {@link resolveAgentContinuity}; unset ⇒ `unverified`, so an unclassified
   * agent never claims its conversation survives. See
   * {@link ConversationContinuityTier}.
   */
  continuity?: AgentContinuity;
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
  /**
   * Declarative input-bar completion sources. The Main-process discovery engine
   * (`electron/services/completions/`) resolves these path templates, scans them
   * with the named parser, and merges/dedupes generically — replacing the
   * per-`agentId` branching in the former `SlashCommandService`. Omit for agents
   * with no discoverable completions. See {@link CompletionSourceConfig}.
   */
  completionSources?: readonly CompletionSourceConfig[];
}

import { config as claudeConfig } from "./agents/claude.js";
import { config as opencodeConfig } from "./agents/opencode.js";
import { config as aiderConfig } from "./agents/aider.js";
import { config as geminiConfig } from "./agents/gemini.js";
import { config as antigravityConfig } from "./agents/antigravity.js";
import { config as codexConfig } from "./agents/codex.js";
import { config as grokConfig } from "./agents/grok.js";
import { config as cursorConfig } from "./agents/cursor.js";
import { config as copilotConfig } from "./agents/copilot.js";
import { config as gooseConfig } from "./agents/goose.js";
import { config as ampConfig } from "./agents/amp.js";
import { config as crushConfig } from "./agents/crush.js";
import { config as qwenConfig } from "./agents/qwen.js";
import { config as kimiConfig } from "./agents/kimi.js";
import { config as interpreterConfig } from "./agents/interpreter.js";
import { config as mistralConfig } from "./agents/mistral.js";
import { config as kiroConfig } from "./agents/kiro.js";
import { config as daintreeAssistantConfig } from "./agents/daintree-assistant.js";

// Built-in agent registry. Per-agent configs live in `./agents/<id>.ts`
// (mirroring `src/services/actions/definitions/`). When adding a new agent,
// create the per-agent file, import it here, add the entry below, and add
// the ID to `BUILT_IN_AGENT_IDS` in `agentIds.ts` — the `Record<BuiltInAgentId,
// AgentConfig>` type enforces exact-key match at compile time.
//
// Key order matches `BUILT_IN_AGENT_IDS` (most popular -> least popular).
// Iteration order does not affect runtime — UI sites iterate
// `BUILT_IN_AGENT_IDS` directly — but we mirror the order for readability.
import { BUILT_IN_AGENT_IDS, isBuiltInAgentId } from "./agentIds.js";
import type { BuiltInAgentId } from "./agentIds.js";
import { getPluginAgentRegistry } from "./pluginAgentRegistry.js";

/**
 * Mapping from `models.dev/api.json` provider keys to our agent IDs. The
 * remote catalog groups models by provider (e.g. `"anthropic"` → claude),
 * which is the inverse of how the local registry is keyed. Only agents whose
 * model lists are covered by the remote catalog appear here; agents like
 * `copilot` (multi-provider) and `aider` (broker without a single provider)
 * stay on their bundled snapshot.
 */
export const PROVIDER_TO_AGENT_ID: Record<string, BuiltInAgentId> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  alibaba: "qwen",
  mistral: "mistral",
};

export const AGENT_REGISTRY: Record<BuiltInAgentId, AgentConfig> = {
  claude: claudeConfig,
  opencode: opencodeConfig,
  aider: aiderConfig,
  gemini: geminiConfig,
  antigravity: antigravityConfig,
  codex: codexConfig,
  grok: grokConfig,
  cursor: cursorConfig,
  copilot: copilotConfig,
  goose: gooseConfig,
  amp: ampConfig,
  crush: crushConfig,
  qwen: qwenConfig,
  kimi: kimiConfig,
  interpreter: interpreterConfig,
  mistral: mistralConfig,
  kiro: kiroConfig,
  "daintree-assistant": daintreeAssistantConfig,
};

export function getAgentIds(): string[] {
  return Object.keys(AGENT_REGISTRY);
}

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  return isBuiltInAgentId(agentId) ? AGENT_REGISTRY[agentId] : undefined;
}

let userRegistry: Record<string, AgentConfig> = {};

export function setUserRegistry(registry: Record<string, AgentConfig>): void {
  userRegistry = registry;
  cachedEffectiveRegistry = null;
}

export function getUserRegistry(): Record<string, AgentConfig> {
  return userRegistry;
}

let cachedEffectiveRegistry: Record<string, AgentConfig> | null = null;
let cachedPluginSnapshot: Record<string, AgentConfig> | null = null;

/** Invalidate the memoized effective registry (tests that patch `AGENT_REGISTRY` entries). */
export function invalidateEffectiveRegistryCache(): void {
  cachedEffectiveRegistry = null;
}

export function getEffectiveRegistry(): Record<string, AgentConfig> {
  // Memoized: invalidated by `setUserRegistry` and whenever the plugin snapshot
  // reference changes (it is replaced wholesale on every plugin mutation).
  // `AGENT_REGISTRY` entries are never reassigned in production code.
  const pluginSnapshot = getPluginAgentRegistry();
  if (cachedEffectiveRegistry === null || cachedPluginSnapshot !== pluginSnapshot) {
    // Merge order is priority order (later spreads win): plugin agents are the
    // lowest tier (additive, never shadowing), user-registry overlays them, and
    // built-ins always win last so a plugin or user can never patch a built-in.
    cachedEffectiveRegistry = { ...pluginSnapshot, ...userRegistry, ...AGENT_REGISTRY };
    cachedPluginSnapshot = pluginSnapshot;
  }
  return cachedEffectiveRegistry;
}

export function getEffectiveAgentIds(): string[] {
  return Object.keys(getEffectiveRegistry());
}

export function getEffectiveAgentConfig(agentId: string): AgentConfig | undefined {
  // Own-key check to match `isEffectivelyRegisteredAgent` below: `agentId` can
  // come from a plugin manifest, and a bare index would return an inherited
  // `Object.prototype` member (e.g. `toString`) as a truthy "config".
  const registry = getEffectiveRegistry();
  return Object.hasOwn(registry, agentId) ? registry[agentId] : undefined;
}

export function isEffectivelyRegisteredAgent(agentId: string): boolean {
  return Object.prototype.hasOwnProperty.call(getEffectiveRegistry(), agentId);
}

/**
 * Resolve an agent's conversation-continuity classification for the relocation
 * preview (#11282, phase 5). Reads the effective registry so plugin/user agents
 * resolve too, and defaults to `unverified` for any agent that hasn't declared a
 * `continuity` block — we never assume a conversation survives a move. Pure and
 * side-effect free; computed live at preview time, never cached or persisted.
 */
export function resolveAgentContinuity(agentId: string): AgentContinuity {
  return getEffectiveAgentConfig(agentId)?.continuity ?? { tier: "unverified" };
}

export function isBuiltInAgent(agentId: string): boolean {
  // Own-key check: a user agent legitimately named `toString` passes the
  // safe-id rules, and `in` would falsely reject it as a built-in.
  return Object.hasOwn(AGENT_REGISTRY, agentId);
}

export function getAgentModelConfig(
  agentId: string,
  modelId: string
): AgentModelConfig | undefined {
  const config = getEffectiveAgentConfig(agentId);
  return config?.models?.find((m) => m.id === modelId);
}

/**
 * IDs of agents (built-in and user-defined) whose assistant wiring is at the
 * `"stable"` tier. Used by the HelpPanel agent picker to filter the visible
 * options and by the `helpPanelStore` rehydration guard to drop stale
 * persisted preferences for agents that aren't wired for the assistant overlay.
 *
 * Built-in agents appear first (in `BUILT_IN_AGENT_IDS` popularity order),
 * followed by user-defined agents in registration order. Built-in entries
 * shadow user-defined entries with the same ID (enforced by `getEffectiveRegistry`).
 *
 * Excludes agents marked `supports: false` (structurally ineligible),
 * `supports: undefined` (not yet wired), `tier: "experimental"`, and
 * `tier: "deprecated"`.
 */
export function getAssistantSupportedAgentIds(): string[] {
  const effective = getEffectiveRegistry();
  const supported = new Set<string>();
  // Built-in first (preserves existing order and tests)
  for (const id of BUILT_IN_AGENT_IDS) {
    const supports = effective[id]?.supports;
    if (supports !== false && supports?.tier === "stable") {
      supported.add(id);
    }
  }
  // Then user-defined agents not already covered
  for (const id of Object.keys(effective)) {
    if (supported.has(id)) continue;
    const supports = effective[id]?.supports;
    if (supports !== false && supports?.tier === "stable") {
      supported.add(id);
    }
  }
  return [...supported];
}

/**
 * IDs of agents (built-in and user-defined) whose assistant wiring is
 * structurally complete and active (tier `"stable"` or `"experimental"`).
 * Used by `HelpSessionService`'s provision validator and `lifecycle.ts`'s
 * help-launch detector — both must accept experimental agents so a help
 * session can spawn under them, even though the picker (driven by
 * `getAssistantSupportedAgentIds`) keeps them hidden until promoted.
 *
 * Built-in agents appear first (in `BUILT_IN_AGENT_IDS` popularity order),
 * followed by user-defined agents in registration order.
 *
 * Uses a positive allow-list (tier is `"stable"` or `"experimental"`), so it
 * excludes `supports: false` (structurally ineligible), `supports: undefined`
 * (not yet wired), and `tier: "deprecated"` (retired from the overlay). Any
 * future tier addition is excluded by default until explicitly allow-listed.
 */
export function getAssistantWiredAgentIds(): string[] {
  const effective = getEffectiveRegistry();
  const wired = new Set<string>();
  const isWired = (supports: AgentConfig["supports"]): boolean =>
    supports !== false &&
    supports !== undefined &&
    (supports.tier === "stable" || supports.tier === "experimental");
  for (const id of BUILT_IN_AGENT_IDS) {
    if (isWired(effective[id]?.supports)) {
      wired.add(id);
    }
  }
  for (const id of Object.keys(effective)) {
    if (wired.has(id)) continue;
    if (isWired(effective[id]?.supports)) {
      wired.add(id);
    }
  }
  return [...wired];
}

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
  if (!isBuiltInAgentId(agentId)) return;
  const config = AGENT_REGISTRY[agentId];
  if (config) {
    (config as { presets?: AgentPreset[] }).presets = presets;
  }
}
