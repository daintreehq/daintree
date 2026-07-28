import { AGENT_REGISTRY, getEffectiveAgentConfig } from "../config/agentRegistry.js";
import type { BuiltInAgentId } from "../config/agentIds.js";
import { escapeShellArg, escapeShellArgOptional } from "../utils/shellEscape.js";

/**
 * Tri-state permission-bypass intent. `"on"`/`"off"` are explicit user choices
 * (force-enable / force-disable); `"inherit"` defers to the next level up
 * (preset → agent → global). Modeled after VS Code workspace-vs-user override
 * and IAM explicit-deny precedence: a more-specific `"off"` always vetoes a
 * broader `"on"` (principle of least privilege).
 */
export type DangerousMode = "inherit" | "on" | "off";

/**
 * Tri-state alt-screen intent, stored on the `inlineMode` field. `"on"` =
 * inline rendering (inject the agent's `inlineModeFlag`, e.g. `--no-alt-screen`);
 * `"off"` = full-screen alternate buffer (inject the agent's `altScreenFlag`,
 * e.g. `--fullscreen`, or no flag when it declares none and rides its own CLI
 * default); `"inherit"` defers to the next level up (preset → agent registry
 * default → the global "Use alt-screen mode by default" switch). Value polarity
 * intentionally matches the legacy
 * `inlineMode` boolean (`true` was inline), so a persisted boolean maps
 * literally — `true → "on"`, `false → "off"` (see {@link resolveInlineMode}).
 * The UI labels are decoupled from these values (the Settings control presents
 * the choice in alt-screen terms).
 */
export type InlineMode = "inherit" | "on" | "off";

export interface AgentSettingsEntry {
  /**
   * Tri-state pin for the toolbar: `true` (explicit pin), `false` (explicit
   * unpin), or `undefined` (no explicit intent — follow live CLI availability).
   * Use `isAgentToolbarVisible(entry, availability)` from
   * `shared/utils/agentPinned.ts` for toolbar visibility so installing or
   * uninstalling a CLI flips the button without ever needing to write a
   * concrete value here. `isAgentPinned()` reads the explicit user intent
   * directly (see #7673).
   */
  pinned?: boolean;
  customFlags?: string;
  /** Additional args appended when dangerous mode is enabled */
  dangerousArgs?: string;
  /**
   * Legacy boolean toggle to include dangerousArgs in the final command.
   * Superseded by {@link AgentSettingsEntry.dangerousMode}; still read for
   * back-compat (`true` → `"on"`, `false`/absent → `"inherit"`) by
   * {@link resolveDangerousMode}. New writes set `dangerousMode` and keep this
   * mirrored (`true` only when `"on"`) so boolean readers (toolbar badges,
   * setup wizard) keep working.
   */
  dangerousEnabled?: boolean;
  /**
   * Tri-state permission-bypass intent for this agent's Default scope (#10432
   * follow-up): `"on"` force-enables bypass, `"off"` force-disables it (an
   * explicit veto that beats the global override), `"inherit"`/absent defers to
   * the global "Skip permission prompts for agents" switch. Resolved (with
   * legacy fallback) by {@link resolveDangerousMode}; preset overrides layer on
   * top via {@link combineDangerousModes}.
   */
  dangerousMode?: DangerousMode;
  /**
   * Alt-screen rendering intent for this agent's Default scope (#10876). Tri-state
   * {@link InlineMode}: `"on"` = inline (inject `inlineModeFlag`), `"off"` =
   * alt-screen, `"inherit"`/absent defers to the agent registry default and then
   * the global `globalUseAltScreen` switch. A persisted legacy boolean is read
   * literally by {@link resolveInlineMode} (`true → "on"`, `false → "off"`);
   * preset overrides layer on top via {@link combineInlineModes}.
   */
  inlineMode?: boolean | InlineMode;
  /** When true, inject --include-directories for the clipboard temp directory (Gemini only) */
  shareClipboardDirectory?: boolean;
  /**
   * Agent-level default preset ID (persists across worktrees). Used as the
   * fallback when a worktree has no scoped override. Set from Settings →
   * Presets; the toolbar dropdown writes to `worktreePresets` instead so
   * picking a preset in one worktree doesn't silently change what launches
   * in another.
   */
  presetId?: string;
  /**
   * Per-worktree preset overrides, keyed by worktreeId. Wins over `presetId`
   * when resolving the effective launch preset. Updates via
   * `updateWorktreePreset` in the renderer store so the IPC shallow-merge
   * doesn't clobber sibling worktree keys.
   */
  worktreePresets?: Record<string, string>;
  /** User-defined custom presets for this agent (persisted, editable from Settings) */
  customPresets?: Array<{
    id: string;
    name: string;
    description?: string;
    env?: Record<string, string>;
    args?: string[];
    dangerousEnabled?: boolean;
    /**
     * Tri-state bypass override for this preset, layered on top of the agent's
     * resolved mode (see {@link combineDangerousModes}). `"off"` vetoes the
     * agent/global value; `"inherit"`/absent defers to the agent's Default
     * scope. Legacy `dangerousEnabled` is read as a fallback.
     */
    dangerousMode?: DangerousMode;
    customFlags?: string;
    /**
     * Tri-state alt-screen override for this preset ({@link InlineMode}), layered
     * on top of the agent's resolved mode via {@link combineInlineModes}. `"off"`
     * (alt-screen) vetoes an agent/global `"on"`; `"inherit"`/absent defers to the
     * agent's Default scope. Legacy boolean is read literally by
     * {@link resolveInlineMode}.
     */
    inlineMode?: boolean | InlineMode;
    color?: string;
    /** Ordered preset IDs to fall over to when provider is unreachable. */
    fallbacks?: string[];
  }>;
  /**
   * Environment variables applied to every launch of this agent, regardless of preset.
   * Preset-level env overrides these when keys overlap.
   */
  globalEnv?: Record<string, string>;
  [key: string]: unknown;
}

export interface AgentSettings {
  agents: Record<string, AgentSettingsEntry>;
  /**
   * Schema version for the persisted store. Absent on stores written by
   * versions before the tri-state pin fix (#7673); presence of `1` signals
   * that the one-shot migration has cleared eagerly-seeded `pinned` values
   * so toolbar visibility can follow live CLI availability. Stamped by the
   * main-process IPC handler on the first write after migration.
   */
  settingsVersion?: number;
  /**
   * Global "skip permission prompts" override (#10432). When `true`, every
   * agent whose config declares `supports.permissionBypass === true` launches
   * in permission-bypass mode regardless of its per-agent/preset
   * `dangerousEnabled` toggle. Default off — this is a high-blast-radius,
   * opt-in switch. It is a *live override*, not a default: it is OR-ed into
   * the effective bypass at flag-generation time (see {@link resolveEffectiveBypass})
   * and never mutates per-agent `dangerousEnabled`, so toggling it off
   * immediately stops injecting bypass flags on future spawns/restarts/resumes.
   * Scoped to normal agent terminals; Daintree Assistant / help sessions keep
   * their own independent bypass setting.
   */
  globalSkipPermissions?: boolean;
  /**
   * Global "use alt-screen mode by default" override (#10876). Controls what an
   * agent's `"inherit"` inline-mode resolves to when no per-agent/preset choice
   * and no curated registry default apply. Default off — so `inlineMode`
   * resolves to inline (no alt-screen) globally unless something overrides it,
   * mirroring how `globalSkipPermissions` defaults off. A curated per-agent
   * registry `defaultInlineMode` (when an agent declares one) still wins over this
   * switch; an explicit per-agent/preset `"on"`/`"off"` always vetoes it. Like
   * the bypass override it is a *live* value OR-ed in at flag-generation time
   * (see {@link resolveEffectiveInlineMode}), never mutating per-agent state.
   */
  globalUseAltScreen?: boolean;
}

export const DEFAULT_DANGEROUS_ARGS: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  gemini: "--yolo",
  antigravity: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  grok: "--always-approve",
  cursor: "--force",
  interpreter: "--auto_run",
  amp: "--dangerously-allow-all",
  aider: "--yes-always",
  qwen: "--yolo",
  kimi: "--yolo",
  crush: "--yolo",
  kiro: "--trust-all-tools",
  // opencode intentionally absent: --dangerously-skip-permissions exists only
  // on the `run` subcommand, not the bare TUI launch (verified on 1.14.48)
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  agents: Object.fromEntries(
    (Object.keys(AGENT_REGISTRY) as BuiltInAgentId[]).map((id) => [
      id,
      {
        customFlags: "",
        dangerousArgs: DEFAULT_DANGEROUS_ARGS[id] ?? "",
        dangerousEnabled: false,
        // `inlineMode` is intentionally NOT seeded (#10876). Leaving it absent
        // means an untouched agent resolves to `"inherit"`, so the agent's
        // curated registry `defaultInlineMode` and then the global
        // `globalUseAltScreen` switch decide — a concrete seed here would pin
        // every agent and make the new global toggle a no-op for new users.
        // Existing persisted booleans are still honoured via resolveInlineMode.
      },
    ])
  ),
  globalSkipPermissions: false,
  globalUseAltScreen: false,
};

/**
 * Whether an agent opts into permission-bypass via its config
 * (`supports.permissionBypass === true`). Strict — agents that omit the field
 * or set it `false` are NOT bypass-supported, so the global skip-permissions
 * override must never inject their dangerous flag (#10432).
 */
export function isAgentBypassSupported(agentId: string | undefined): boolean {
  if (!agentId) return false;
  const supports = getEffectiveAgentConfig(agentId)?.supports;
  // `supports` is `AssistantSupports | false | undefined`; only the structured
  // form carries `permissionBypass`.
  return supports !== false && supports?.permissionBypass === true;
}

/**
 * Reads the tri-state {@link DangerousMode} from a settings entry or preset,
 * falling back to the legacy `dangerousEnabled` boolean. Legacy `true` →
 * `"on"`; legacy `false`/absent → `"inherit"` (the historical "fall through to
 * the global override" semantics). An explicit `"off"` veto is reachable only
 * via the newer `dangerousMode` field, so legacy stores never gain a veto they
 * didn't ask for.
 */
export function resolveDangerousMode(source: {
  dangerousMode?: DangerousMode;
  dangerousEnabled?: boolean;
}): DangerousMode {
  return source.dangerousMode ?? (source.dangerousEnabled ? "on" : "inherit");
}

/**
 * Layers a preset's mode on top of the agent's resolved mode: the preset wins
 * unless it defers (`"inherit"`). This makes preset `"off"` a true veto over an
 * agent `"on"`, and preset `"on"` an override of an agent `"off"` — the
 * specific-overrides-general rule applied one level down.
 */
export function combineDangerousModes(
  agentMode: DangerousMode,
  presetMode?: DangerousMode
): DangerousMode {
  return presetMode && presetMode !== "inherit" ? presetMode : agentMode;
}

/**
 * Reads the tri-state {@link InlineMode} from a settings entry or preset (#10876).
 * A persisted legacy boolean is mapped LITERALLY — `true → "on"` (inline),
 * `false → "off"` (alt-screen) — not `false → "inherit"` the way
 * {@link resolveDangerousMode} treats `dangerousEnabled`. The difference is
 * deliberate: `inlineMode` was historically seeded with a concrete per-agent
 * boolean (Grok `false`, Codex `true`), so a `false → "inherit"` mapping would
 * retroactively hand those established choices to the new global switch. Only a
 * genuinely-absent value resolves to `"inherit"`.
 */
export function resolveInlineMode(source: { inlineMode?: boolean | InlineMode }): InlineMode {
  const value = source.inlineMode;
  if (value === undefined) return "inherit";
  if (typeof value === "boolean") return value ? "on" : "off";
  return value;
}

/**
 * Layers a preset's inline mode on top of the agent's resolved mode: the preset
 * wins unless it defers (`"inherit"`). Mirrors {@link combineDangerousModes} —
 * a preset `"off"` (alt-screen) is a true veto over an agent `"on"` (inline).
 */
export function combineInlineModes(agentMode: InlineMode, presetMode?: InlineMode): InlineMode {
  return presetMode && presetMode !== "inherit" ? presetMode : agentMode;
}

/**
 * Resolves the effective alt-screen decision for a launch from the (already
 * preset-merged) entry's tri-state mode. Returns `true` when the agent should
 * render inline — i.e. when the agent's `inlineModeFlag` should be injected.
 *
 * - `"on"`  → inline (inject `inlineModeFlag`).
 * - `"off"` → alt-screen (inject `altScreenFlag` when the agent declares one,
 *   otherwise no flag); an explicit veto that beats the global switch.
 * - `"inherit"` → a curated per-agent registry `capabilities.defaultInlineMode`
 *   wins if declared (no shipped agent pins one today — they all follow the
 *   global switch so it stays user-overridable); otherwise defer to the global
 *   "Use alt-screen mode by default" switch (`globalUseAltScreen` on →
 *   alt-screen, off → inline).
 *
 * Callers that resolve a launch from a preset must bake the combined mode onto
 * the entry first (see `applyPresetBehaviorOverrides`) so this single chokepoint
 * sees the final intent.
 */
export function resolveEffectiveInlineMode(
  entry: AgentSettingsEntry,
  agentId: string | undefined,
  globalUseAltScreen?: boolean
): boolean {
  const mode = resolveInlineMode(entry);
  if (mode === "on") return true;
  if (mode === "off") return false;
  const registryDefault = agentId
    ? getEffectiveAgentConfig(agentId)?.capabilities?.defaultInlineMode
    : undefined;
  if (typeof registryDefault === "boolean") return registryDefault;
  return !globalUseAltScreen;
}

/**
 * Picks the single screen-mode token a launch should carry, plus the full set
 * of tokens the launch path owns (and must therefore strip when they're stale).
 *
 * The two capabilities are opposite polarities of one decision: `inlineModeFlag`
 * (e.g. `--no-alt-screen`) forces inline, `altScreenFlag` (e.g. `--fullscreen`)
 * forces the alternate buffer. An agent may declare either, both, or neither.
 * `wanted` is `undefined` when the agent declares no flag for the resolved
 * direction — it then rides its own CLI default, which is exactly the
 * one-directional gap `altScreenFlag` exists to close (#11423).
 */
function resolveScreenModeTokens(
  capabilities: { inlineModeFlag?: string; altScreenFlag?: string } | undefined,
  effectiveInline: boolean
): { wanted: string | undefined; managed: string[] } {
  const inlineFlag = capabilities?.inlineModeFlag;
  const altFlag = capabilities?.altScreenFlag;
  const managed = [...new Set([inlineFlag, altFlag].filter((f): f is string => !!f))];
  return { wanted: effectiveInline ? inlineFlag : altFlag, managed };
}

/**
 * Reconciles a persisted `agentLaunchFlags` snapshot against the current
 * effective inline-mode decision (#10876) — the alt-screen analog of
 * {@link reconcileBypassFlags}'s "resume trap" fix.
 *
 * The agent's canonical single-token screen-mode flags (`inlineModeFlag` and,
 * since #11423, its opposite-polarity `altScreenFlag`) are baked into
 * `agentLaunchFlags` by the same `buildAgentLaunchFlags` that captures the
 * bypass flag, so a snapshot can carry a stale token forward after the user (or
 * the global switch) flips the decision. Exactly one token survives: the first
 * managed token found is rewritten in place to the wanted one (keeping its
 * position so an already-correct snapshot is untouched), later managed tokens
 * are dropped, and the wanted token is appended only when the snapshot carried
 * none — which is also how a pre-#11423 snapshot picks up its first
 * `--fullscreen`. Idempotent across every spawn/restart/restore/resume. Agents
 * declaring neither flag are left untouched.
 */
export function reconcileInlineModeFlag(
  flags: readonly string[],
  agentId: string,
  effectiveInline: boolean
): string[] {
  const { wanted, managed } = resolveScreenModeTokens(
    getEffectiveAgentConfig(agentId)?.capabilities,
    effectiveInline
  );
  if (managed.length === 0) return [...flags];

  const reconciled: string[] = [];
  let placed = false;
  for (const flag of flags) {
    if (!managed.includes(flag)) {
      reconciled.push(flag);
      continue;
    }
    if (!placed && wanted) {
      reconciled.push(wanted);
      placed = true;
    }
  }
  if (wanted && !placed) reconciled.push(wanted);
  return reconciled;
}

/**
 * Resolves the effective permission-bypass decision for a launch from the
 * (already preset-merged) effective entry's tri-state mode:
 *
 * - `"on"`  → bypass (unguarded — preserves per-agent toggles like Gemini's
 *   `--yolo` even for agents that don't declare `supports.permissionBypass`).
 * - `"off"` → no bypass; an explicit veto that beats the global override.
 * - `"inherit"` → defer to the global "Skip permission prompts for agents"
 *   switch, which only applies to agents that declare bypass support so it
 *   can't inject a dangerous flag into an agent that rejects it.
 *
 * Callers that resolve a launch from a preset must bake the combined mode onto
 * the entry first (see `applyPresetBehaviorOverrides`) so this single chokepoint
 * sees the final intent.
 *
 * @param entry - The effective settings entry (after preset overrides applied).
 */
export function resolveEffectiveBypass(
  entry: AgentSettingsEntry,
  agentId: string | undefined,
  globalSkipPermissions?: boolean
): boolean {
  const mode = resolveDangerousMode(entry);
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !!globalSkipPermissions && isAgentBypassSupported(agentId);
}

/**
 * Reconciles a persisted `agentLaunchFlags` snapshot against the current
 * effective bypass setting (#10432, the "resume trap").
 *
 * Strips the agent's canonical bypass flag (the resolved `dangerousArgs`, plus
 * the registry default as a fallback so a snapshot captured under a different
 * `dangerousArgs` still gets cleaned) from `flags`, then re-appends it only
 * when `effectiveBypass` is true. This makes every spawn/restart/restore/resume
 * idempotent: flipping the resolved decision off stops carrying a stale bypass
 * flag forward, and flipping it on re-adds it.
 *
 * `effectiveBypass` is the single source of truth — it already encodes the full
 * tri-state decision (preset/agent `"on"`/`"off"` and the support-gated global
 * inherit, via {@link resolveEffectiveBypass}). So this applies uniformly even
 * to agents that don't declare `supports.permissionBypass`: their `"on"` flag
 * (e.g. Gemini's `--yolo`) is preserved when `effectiveBypass` is true, and an
 * explicit `"off"` veto strips a stale token when it is false. Agents with no
 * canonical token (no `DEFAULT_DANGEROUS_ARGS` entry and no `dangerousArgs`)
 * fall through the empty-strip-set guard below and are left untouched.
 *
 * All known bypass flags in {@link DEFAULT_DANGEROUS_ARGS} are single tokens;
 * the strip matches whole tokens so flag *values* are never collaterally
 * removed.
 *
 * @param bypassArgs - The agent's currently-resolved dangerous args (e.g.
 *   `entry.dangerousArgs`); falls back to `DEFAULT_DANGEROUS_ARGS[agentId]`.
 */
export function reconcileBypassFlags(
  flags: readonly string[],
  agentId: string,
  effectiveBypass: boolean,
  bypassArgs?: string
): string[] {
  const resolved = (bypassArgs?.trim() || DEFAULT_DANGEROUS_ARGS[agentId] || "").trim();
  // Strip both the resolved args and the registry default: a snapshot may have
  // been captured before the user customized `dangerousArgs`, so cleaning only
  // the current value could leave a stale default token behind.
  const stripTokens = new Set<string>();
  for (const source of [resolved, DEFAULT_DANGEROUS_ARGS[agentId]]) {
    if (!source) continue;
    for (const token of source.trim().split(/\s+/)) {
      if (token) stripTokens.add(token);
    }
  }
  if (stripTokens.size === 0) return [...flags];

  if (!effectiveBypass || !resolved) {
    // Bypass not wanted: drop every occurrence of the canonical token(s).
    return flags.filter((flag) => !stripTokens.has(flag));
  }

  // Bypass wanted: replace the first canonical occurrence in place with the
  // currently-resolved args (preserving flag order so a snapshot that already
  // carries the right flag is left untouched), drop any duplicates, and append
  // if the flag was absent.
  const resolvedTokens = resolved.split(/\s+/).filter(Boolean);
  const reconciled: string[] = [];
  let inserted = false;
  for (const flag of flags) {
    if (stripTokens.has(flag)) {
      if (!inserted) {
        reconciled.push(...resolvedTokens);
        inserted = true;
      }
    } else {
      reconciled.push(flag);
    }
  }
  if (!inserted) reconciled.push(...resolvedTokens);
  return reconciled;
}

export function getAgentSettingsEntry(
  settings: AgentSettings | null | undefined,
  agentId: string
): AgentSettingsEntry {
  if (!settings || !settings.agents) return {};
  return settings.agents[agentId] ?? {};
}

/**
 * Resolves the effective preset ID for a launch: worktree-scoped override
 * wins, then agent-level default, else `undefined`. Single source of truth
 * shared by `useAgentLauncher` and the toolbar components so resolution
 * can't drift between call sites.
 */
export function resolveEffectivePresetId(
  entry: AgentSettingsEntry | null | undefined,
  worktreeId: string | null | undefined
): string | undefined {
  if (!entry) return undefined;
  const scoped =
    worktreeId && entry.worktreePresets ? entry.worktreePresets[worktreeId] : undefined;
  return scoped ?? entry.presetId;
}

export interface GenerateAgentFlagsOptions {
  /** Absolute path to the clipboard temp directory (e.g. /tmp/daintree-clipboard) */
  clipboardDirectory?: string;
  /**
   * Global skip-permissions override (#10432). When true, OR-ed into the
   * effective bypass for agents that declare `supports.permissionBypass`, so
   * the agent's dangerous flag is injected even when its per-agent toggle is off.
   */
  globalSkipPermissions?: boolean;
}

export function generateAgentFlags(
  entry: AgentSettingsEntry,
  agentId?: string,
  options?: GenerateAgentFlagsOptions
): string[] {
  const flags: string[] = [];
  if (resolveEffectiveBypass(entry, agentId, options?.globalSkipPermissions)) {
    // Use entry.dangerousArgs if set, otherwise fall back to default for this agent
    const dangerousArgs =
      entry.dangerousArgs?.trim() || (agentId ? DEFAULT_DANGEROUS_ARGS[agentId] : "");
    if (dangerousArgs) {
      flags.push(...dangerousArgs.split(/\s+/));
    }
  }
  if (entry.customFlags) {
    const trimmed = entry.customFlags.trim();
    if (trimmed) {
      flags.push(...trimmed.split(/\s+/));
    }
  }

  // Inject --include-directories for Gemini clipboard image access
  if (
    agentId === "gemini" &&
    entry.shareClipboardDirectory !== false &&
    options?.clipboardDirectory
  ) {
    const dir = options.clipboardDirectory;
    // Deduplicate: skip if user already added this exact directory in custom flags
    const alreadyIncluded = flags.some(
      (f, i) => f === "--include-directories" && flags[i + 1] === dir
    );
    if (!alreadyIncluded) {
      flags.push("--include-directories", dir);
    }
  }

  return flags;
}

export interface GenerateAgentCommandOptions {
  /** Initial prompt to pass to the agent CLI */
  initialPrompt?: string;
  /** If true, agent runs in interactive mode (default). If false, runs one-shot/print mode. */
  interactive?: boolean;
  /** Absolute path to the clipboard temp directory for --include-directories injection */
  clipboardDirectory?: string;
  /** Model ID to pass via --model flag (e.g., "claude-opus-4-6") */
  modelId?: string;
  /** Additional CLI arguments from recipe terminal (whitespace-separated string) */
  recipeArgs?: string;
  /** Additional CLI arguments from agent preset (whitespace-separated string) */
  presetArgs?: string;
  /** Global skip-permissions override (#10432); forwarded to {@link generateAgentFlags}. */
  globalSkipPermissions?: boolean;
  /**
   * Global "use alt-screen mode by default" override (#10876); resolves an
   * agent's `"inherit"` inline mode when no per-agent/preset choice or curated
   * registry default applies (see {@link resolveEffectiveInlineMode}).
   */
  globalUseAltScreen?: boolean;
}

/**
 * Generates a complete agent command string including base command, flags, and optional initial prompt.
 *
 * @param baseCommand - The base command for the agent (e.g., "claude", "gemini")
 * @param entry - Agent settings entry containing flags configuration
 * @param agentId - The agent identifier (e.g., "claude", "gemini", "codex")
 * @param options - Optional configuration including initial prompt and interactive mode
 * @returns The complete command string to spawn the agent
 *
 * @example
 * // Claude interactive with prompt
 * generateAgentCommand("claude", entry, "claude", { initialPrompt: "Fix the bug" });
 * // => "claude --flags 'Fix the bug'"
 *
 * // Claude one-shot (print mode)
 * generateAgentCommand("claude", entry, "claude", { initialPrompt: "Fix the bug", interactive: false });
 * // => "claude --flags -p 'Fix the bug'"
 */
export function generateAgentCommand(
  baseCommand: string,
  entry: AgentSettingsEntry,
  agentId?: string,
  options?: GenerateAgentCommandOptions
): string {
  const flags = generateAgentFlags(entry, agentId, {
    clipboardDirectory: options?.clipboardDirectory,
    globalSkipPermissions: options?.globalSkipPermissions,
  });
  const parts: string[] = [baseCommand];

  // Add default args from agent registry (before user flags)
  if (agentId) {
    const agentConfig = getEffectiveAgentConfig(agentId);
    if (agentConfig?.args?.length) {
      // Apply same escaping logic as user flags
      for (const arg of agentConfig.args) {
        if (arg.startsWith("-")) {
          parts.push(arg);
        } else {
          parts.push(escapeShellArg(arg));
        }
      }
    }

    // Add the screen-mode flag matching the resolved tri-state, when the agent
    // declares one for that direction (#10876, #11423). resolveEffectiveInlineMode
    // encodes the full chain: explicit on/off → preset (already baked onto the
    // entry) → curated registry default → the global `globalUseAltScreen` switch.
    // Screen mode only applies to the interactive TUI, so a headless one-shot
    // (`interactive: false` — e.g. opencode's `run` subcommand, which rejects
    // `--mini`) must carry neither polarity.
    if (options?.interactive ?? true) {
      const { wanted: screenModeFlag } = resolveScreenModeTokens(
        agentConfig?.capabilities,
        resolveEffectiveInlineMode(entry, agentId, options?.globalUseAltScreen)
      );
      if (screenModeFlag) parts.push(screenModeFlag);
    }
  }

  // Add --model flag if a specific model was selected for this launch
  if (options?.modelId) {
    parts.push("--model", options.modelId);
  }

  // Add preset-level args (env overrides applied separately via spawn env)
  if (options?.presetArgs) {
    for (const token of options.presetArgs.trim().split(/\s+/).filter(Boolean)) {
      if (token.startsWith("-")) {
        parts.push(token);
      } else {
        parts.push(escapeShellArg(token));
      }
    }
  }

  // Add recipe-level args (per-terminal overrides from recipe editor)
  if (options?.recipeArgs) {
    for (const token of options.recipeArgs.trim().split(/\s+/).filter(Boolean)) {
      if (token.startsWith("-")) {
        parts.push(token);
      } else {
        parts.push(escapeShellArg(token));
      }
    }
  }

  // Add flags, escaping non-flag values
  for (const flag of flags) {
    if (flag.startsWith("-")) {
      parts.push(flag);
    } else {
      parts.push(escapeShellArg(flag));
    }
  }

  // Add initial prompt if provided
  const prompt = options?.initialPrompt?.trim();
  if (prompt) {
    const interactive = options?.interactive ?? true;
    // Normalize multi-line prompts to single line (replace newlines with spaces)
    const normalizedPrompt = prompt.replace(/\r\n/g, " ").replace(/\n/g, " ");
    const escapedPrompt = escapeShellArg(normalizedPrompt);

    switch (agentId) {
      case "claude":
        // Claude: -p for print mode (non-interactive), otherwise just the prompt
        if (!interactive) {
          parts.push("-p");
        }
        parts.push(escapedPrompt);
        break;

      case "gemini":
        // Gemini: -i for interactive with prompt; bare positional launches
        // the interactive TUI (verified on 0.41.2), so headless needs -p
        if (interactive) {
          parts.push("-i", escapedPrompt);
        } else {
          parts.push("-p", escapedPrompt);
        }
        break;

      case "qwen":
        // Qwen Code (Gemini-CLI fork): explicit -i/-p flags — bare-positional
        // semantics have drifted between fork generations, flags are stable
        if (interactive) {
          parts.push("-i", escapedPrompt);
        } else {
          parts.push("-p", escapedPrompt);
        }
        break;

      case "antigravity":
        // Antigravity (agy): rejects bare positional prompts ("Error: empty
        // prompt"), so the mode flag is mandatory — -i (--prompt-interactive)
        // or -p (--print)
        if (interactive) {
          parts.push("-i", escapedPrompt);
        } else {
          parts.push("-p", escapedPrompt);
        }
        break;

      case "codex":
        // Codex: "exec" subcommand for non-interactive, otherwise just the prompt
        if (!interactive) {
          parts.push("exec");
        }
        parts.push(escapedPrompt);
        break;

      case "copilot":
        // Copilot: -i for interactive prompt injection, -p for one-shot
        if (interactive) {
          parts.push("-i", escapedPrompt);
        } else {
          parts.push("-p", escapedPrompt);
        }
        break;

      case "opencode":
        // opencode: bare positional is a project PATH (verified on 1.14.48);
        // --prompt seeds the TUI, the run subcommand is the one-shot path
        if (interactive) {
          parts.push("--prompt", escapedPrompt);
        } else {
          parts.push("run", escapedPrompt);
        }
        break;

      case "aider":
        // Aider: positionals are filenames; -m sends one message then exits
        // (no interactive-with-prompt mode exists)
        parts.push("-m", escapedPrompt);
        break;

      case "goose": {
        // goose session accepts no prompt (verified on 1.33.1) — swap the
        // registry's `session` arg (pushed shell-escaped above) for `run -t`,
        // staying interactive after the initial input when requested
        const sessionIdx = parts.findIndex(
          (p) => p === "session" || p === escapeShellArg("session")
        );
        if (sessionIdx !== -1) {
          parts[sessionIdx] = "run";
        } else {
          parts.splice(1, 0, "run");
        }
        parts.push("-t", escapedPrompt);
        if (interactive) {
          parts.push("--interactive");
        }
        break;
      }

      case "amp":
        // Amp: -x/--execute runs one-shot; the TUI ignores positionals, so
        // interactive launches keep the (best-effort) positional form
        if (!interactive) {
          parts.push("-x");
        }
        parts.push(escapedPrompt);
        break;

      case "crush":
        // Crush: the run subcommand is the only prompt path; the root TUI
        // has no pre-seed flag, so interactive keeps the positional form
        if (!interactive) {
          parts.push("run");
        }
        parts.push(escapedPrompt);
        break;

      case "kimi":
        // Kimi: no bare-positional prompt form; --prompt/-p runs the query
        // in both modes
        parts.push("-p", escapedPrompt);
        break;

      case "mistral":
        // Vibe: bare positional seeds the TUI; headless needs --prompt
        if (!interactive) {
          parts.push("--prompt");
        }
        parts.push(escapedPrompt);
        break;

      case "kiro":
        // Kiro: bare positional seeds the implicit chat TUI; headless needs
        // the explicit chat --no-interactive form
        if (!interactive) {
          parts.push("chat", "--no-interactive");
        }
        parts.push(escapedPrompt);
        break;

      case "grok":
        // Grok Build: a bare positional seeds the interactive TUI
        // (`grok "fix the bug"`, per `grok --help`); headless one-shot uses
        // -p/--single.
        if (!interactive) {
          parts.push("-p");
        }
        parts.push(escapedPrompt);
        break;

      default:
        // Generic agent: just append the prompt
        parts.push(escapedPrompt);
    }
  }

  return parts.join(" ");
}

/**
 * Builds the array of process-level launch flags to persist alongside the session ID.
 * These flags must be re-supplied on every CLI invocation (they are not embedded in the session).
 *
 * Includes: registry default args, inline mode flag, dangerous args, custom flags.
 * Excludes: clipboard directory (dynamic runtime value), initial prompt.
 */
export function buildAgentLaunchFlags(
  entry: AgentSettingsEntry,
  agentId: string,
  options?: {
    modelId?: string;
    presetArgs?: string[];
    globalSkipPermissions?: boolean;
    globalUseAltScreen?: boolean;
  }
): string[] {
  const agentConfig = getEffectiveAgentConfig(agentId);
  const flags: string[] = [];

  // Registry default args (e.g. fixed CLI flags)
  if (agentConfig?.args?.length) {
    flags.push(...agentConfig.args);
  }

  // Screen-mode flag matching the resolved tri-state, when the agent declares
  // one for that direction (#10876, #11423) — same resolution chain as
  // generateAgentCommand. No interactive gate: these flags are persisted for the
  // interactive restart/resume paths that replay them.
  const { wanted: screenModeFlag } = resolveScreenModeTokens(
    agentConfig?.capabilities,
    resolveEffectiveInlineMode(entry, agentId, options?.globalUseAltScreen)
  );
  if (screenModeFlag) flags.push(screenModeFlag);

  // Model flag for per-panel model selection
  if (options?.modelId) {
    flags.push("--model", options.modelId);
  }

  // Preset-level args are process-level launch configuration. Persist them so
  // restart/resume paths reproduce the same provider/mode selection as launch.
  if (options?.presetArgs?.length) {
    flags.push(...options.presetArgs);
  }

  // Dangerous args and custom flags (from generateAgentFlags, excluding clipboard dir)
  const settingsFlags = generateAgentFlags(entry, agentId, {
    globalSkipPermissions: options?.globalSkipPermissions,
  });
  flags.push(...settingsFlags);

  return flags;
}

/**
 * Builds a resume command for an agent using a previously captured session ID.
 * When launchFlags are provided, they are prepended before the resume args
 * to restore the original process-level configuration.
 *
 * Dispatches on `resume.kind` (see {@link AgentResume}). The `sessionId`
 * parameter is passed verbatim — for `named-target` it is reinterpreted as
 * the user-named target — so existing call sites that pass a session ID
 * positionally continue to work without an API change.
 *
 * @returns The resume command string, or undefined if the agent has no resume config.
 */
export function buildResumeCommand(
  agentId: string,
  sessionId: string,
  launchFlags?: string[],
  baseCommand?: string
): string | undefined {
  const agentConfig = getEffectiveAgentConfig(agentId);
  const resume = agentConfig?.resume;
  if (!agentConfig || !resume) return undefined;

  const parts = [baseCommand ?? agentConfig.command];

  // Prepend persisted launch flags (original process-level flags)
  if (launchFlags?.length) {
    for (const flag of launchFlags) {
      if (flag.startsWith("-")) {
        parts.push(flag);
      } else {
        parts.push(escapeShellArg(flag));
      }
    }
  }

  let args: string[];
  switch (resume.kind) {
    case "session-id":
      args = resume.args(sessionId);
      break;
    case "rolling-history":
      args = resume.args();
      break;
    case "named-target":
      args = resume.argsForTarget(sessionId);
      break;
    case "project-scoped":
      args = resume.args();
      break;
    default: {
      const _exhaustive: never = resume;
      void _exhaustive;
      return undefined;
    }
  }

  for (const arg of args) {
    if (arg.startsWith("-")) {
      parts.push(arg);
    } else {
      parts.push(escapeShellArgOptional(arg));
    }
  }
  return parts.join(" ");
}

/**
 * Builds a "resume the most recent session" launch command for agents whose
 * `session-id` resume config declares `resumeLatestArgs`. Used as a fallback
 * when the graceful-shutdown pattern-match capture loop failed to harvest a
 * session ID — instead of launching fresh and losing the user's context, the
 * CLI's own "continue last" flag picks up the prior conversation in the
 * launch CWD (Claude `--continue`, Gemini `-r latest`, Codex `resume --last`,
 * etc.).
 *
 * Persisted launch flags are prepended using the same shell-escape rules as
 * {@link buildResumeCommand} (raw for `-`-prefixed tokens, escaped for
 * positional values).
 *
 * @returns The resume-latest command string, or `undefined` if the agent
 *   has no resume config, isn't a `session-id` kind, or doesn't declare
 *   `resumeLatestArgs`.
 */
export function buildResumeLatestCommand(
  agentId: string,
  launchFlags?: string[],
  baseCommand?: string
): string | undefined {
  const agentConfig = getEffectiveAgentConfig(agentId);
  const resume = agentConfig?.resume;
  if (!agentConfig || !resume) return undefined;
  if (resume.kind !== "session-id") return undefined;
  const fallbackArgs = resume.resumeLatestArgs;
  if (!fallbackArgs || fallbackArgs.length === 0) return undefined;

  const parts = [baseCommand ?? agentConfig.command];

  if (launchFlags?.length) {
    for (const flag of launchFlags) {
      if (flag.startsWith("-")) {
        parts.push(flag);
      } else {
        parts.push(escapeShellArg(flag));
      }
    }
  }

  for (const arg of fallbackArgs) {
    if (arg.startsWith("-")) {
      parts.push(arg);
    } else {
      parts.push(escapeShellArgOptional(arg));
    }
  }
  return parts.join(" ");
}

export interface BuildLaunchCommandFromFlagsOptions {
  /** Absolute path to the clipboard temp directory (re-injected for agents that support it) */
  clipboardDirectory?: string;
  /**
   * Current `shareClipboardDirectory` setting for the agent entry. When not `false`
   * and the agent supports clipboard injection (e.g. Gemini), `--include-directories
   * <clipboardDirectory>` is appended if not already present.
   */
  shareClipboardDirectory?: boolean;
}

/**
 * Reconstructs an agent launch command from persisted launch flags.
 *
 * Used on respawn/restart paths when no resumable session is available but
 * the original `agentLaunchFlags` are persisted. Mirrors the shell-escaping
 * rules of `buildResumeCommand` (raw for flag-style `-`-prefixed tokens,
 * `escapeShellArg` for positional values).
 *
 * Re-injects runtime-dynamic values that `buildAgentLaunchFlags` deliberately
 * excluded at capture time — today, only Gemini's `--include-directories
 * <clipboardDirectory>` (with dedup if already present in the persisted flags).
 */
export function buildLaunchCommandFromFlags(
  baseCommand: string,
  agentId: string,
  launchFlags: readonly string[],
  options?: BuildLaunchCommandFromFlagsOptions
): string {
  const flags: string[] = [...launchFlags];

  if (
    agentId === "gemini" &&
    options?.shareClipboardDirectory !== false &&
    options?.clipboardDirectory
  ) {
    const dir = options.clipboardDirectory;
    const alreadyIncluded = flags.some(
      (flag, i) => flag === "--include-directories" && flags[i + 1] === dir
    );
    if (!alreadyIncluded) {
      flags.push("--include-directories", dir);
    }
  }

  const parts: string[] = [baseCommand];
  for (const flag of flags) {
    if (flag.startsWith("-")) {
      parts.push(flag);
    } else {
      parts.push(escapeShellArg(flag));
    }
  }
  return parts.join(" ");
}
