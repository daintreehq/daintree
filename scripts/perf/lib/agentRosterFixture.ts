import { readdirSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../../../shared/config/agentRegistry";

/**
 * The REAL agent roster for PERF-350..353, in a plain Node process.
 *
 * `shared/config/agentRegistry.ts` is 43 KB describing 18 agent CLIs, and every
 * terminal launch and every agent-state decision reads it. Nothing measured it.
 * Unusually for this harness, nothing has to be stubbed: the whole roster graph
 * — the registry, `shared/config/agentIds.ts`, `shared/config/pluginAgentRegistry.ts`,
 * all 18 files under `shared/config/agents/`, `shared/types/agentSettings.ts`,
 * `electron/services/pty/terminalActivityPatterns.ts` and
 * `electron/services/pty/AgentPatternDetector.ts` — imports no `electron`, no
 * `import.meta.env`, no Node builtin and no path alias. It is loaded unmodified.
 *
 * WHAT IS REAL
 *   - `AGENT_REGISTRY` and all 18 agent config objects, built at module eval.
 *   - `getEffectiveRegistry` / `getEffectiveAgentConfig` / `setUserRegistry` /
 *     `invalidateEffectiveRegistryCache` — the plugin ⊕ user ⊕ built-in merge and
 *     its memoization.
 *   - `generateAgentCommand`, `buildAgentLaunchFlags`, `generateAgentFlags`,
 *     `buildAssignedSessionIdArgs` and the screen-mode / dangerous-mode
 *     resolution chains they run — the renderer's launch-command builder.
 *   - `buildActivityMonitorOptions` and the five `build*Patterns` helpers, i.e.
 *     the `new RegExp` work a terminal spawn pays before the first byte of
 *     output, and `AgentPatternDetector`'s constructor and `detect()`.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **No terminal.** `TerminalProcess`, `AnalysisSession` and `ActivityMonitor`
 *     are not constructed: they pull node-pty and the whole PTY stack. So this
 *     family prices what a launch asks OF THE ROSTER, not the launch.
 *   - **No user registry and no plugin registry, except where a scenario installs
 *     a synthetic one through the product's own `setUserRegistry`.** The
 *     real user tier is populated by `UserAgentRegistryService` out of
 *     electron-store, which needs Electron. Counts here are the built-in floor.
 *   - **No user agent config is read, and none could be.** Importing the roster
 *     performs zero filesystem I/O: `authCheck.configPaths`, `nativePaths` and
 *     `completionSources` are inert descriptor strings whose only consumers
 *     (`CliAvailabilityService`, `CompletionDiscoveryEngine`) are never called
 *     from here. Nothing in this family touches `~/.claude`, `~/.codex` or
 *     `~/.gemini`, and nothing spawns a CLI.
 *   - **No process spawn and no network.** Every function driven here is pure.
 *
 * PERF-035 already measures the per-chunk cost of the analysis pipeline under a
 * virtual clock. This family deliberately measures what PERF-035 holds constant:
 * roster construction, lookup, launch-command assembly, and the pattern compile
 * that happens once per spawn before any chunk arrives.
 */

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const AGENTS_DIR = pathResolve(REPO_ROOT, "shared/config/agents");

/** Not an agent — a shared builder for `completionSources` descriptors. */
const AGENT_DIR_NON_CONFIGS = new Set(["completionSourceHelpers"]);

/**
 * Agent ids implied by the FILESYSTEM, read straight out of
 * `shared/config/agents/`.
 *
 * This is the roster oracle that owes nothing to the registry: one file per
 * agent, each exporting a single `config`. A registry that registered nothing
 * would still satisfy a predicate derived from its own tables — it cannot
 * satisfy one derived from the directory the configs live in.
 */
export function agentIdsOnDisk(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => name.slice(0, -3))
    .filter((id) => !AGENT_DIR_NON_CONFIGS.has(id))
    .sort();
}

// --- product module handles --------------------------------------------------

export interface AgentSettingsEntryLike {
  customFlags?: string;
  dangerousArgs?: string;
  dangerousEnabled?: boolean;
  dangerousMode?: "on" | "off" | "inherit";
  inlineMode?: boolean | "on" | "off" | "inherit";
  shareClipboardDirectory?: boolean;
}

export interface GenerateAgentCommandOptionsLike {
  initialPrompt?: string;
  interactive?: boolean;
  clipboardDirectory?: string;
  modelId?: string;
  recipeArgs?: string;
  presetArgs?: string;
  globalSkipPermissions?: boolean;
  globalUseAltScreen?: boolean;
  sessionId?: string;
}

export interface PatternDetectionConfigLike {
  primaryPatterns: RegExp[];
  fallbackPatterns?: RegExp[];
  scanLineCount?: number;
  primaryConfidence?: number;
  fallbackConfidence?: number;
}

export interface ActivityMonitorOptionsLike {
  patternConfig?: PatternDetectionConfigLike;
  bootCompletePatterns?: RegExp[];
  promptPatterns?: RegExp[];
  promptHintPatterns?: RegExp[];
  completionPatterns?: RegExp[];
  ignoredInputSequences?: string[];
  idleDebounceMs?: number;
}

export interface PatternDetectionResultLike {
  isWorking: boolean;
  confidence?: number;
  matchedPattern?: string;
}

export interface RosterModules {
  AGENT_REGISTRY: Record<string, AgentConfig>;
  BUILT_IN_AGENT_IDS: readonly string[];
  LAUNCHABLE_AGENT_IDS: readonly string[];
  getAgentIds: () => string[];
  getAgentConfig: (agentId: string) => AgentConfig | undefined;
  getEffectiveRegistry: () => Record<string, AgentConfig>;
  getEffectiveAgentIds: () => string[];
  getEffectiveAgentConfig: (agentId: string) => AgentConfig | undefined;
  isBuiltInAgent: (agentId: string) => boolean;
  isEffectivelyRegisteredAgent: (agentId: string) => boolean;
  getAgentDisplayTitle: (agentId: string, modelId?: string) => string;
  getAgentModelConfig: (agentId: string, modelId: string) => unknown;
  resolveAgentContinuity: (agentId: string) => { tier: string } & Record<string, unknown>;
  setUserRegistry: (registry: Record<string, AgentConfig>) => void;
  invalidateEffectiveRegistryCache: () => void;
  generateAgentCommand: (
    baseCommand: string,
    entry: AgentSettingsEntryLike,
    agentId?: string,
    options?: GenerateAgentCommandOptionsLike
  ) => string;
  buildAgentLaunchFlags: (
    entry: AgentSettingsEntryLike,
    agentId: string,
    options?: {
      modelId?: string;
      presetArgs?: string[];
      globalSkipPermissions?: boolean;
      globalUseAltScreen?: boolean;
    }
  ) => string[];
  buildAssignedSessionIdArgs: (agentId: string, sessionId: string) => string[] | undefined;
  supportsSessionIdAssignment: (agentId: string | undefined) => boolean;
  DEFAULT_DANGEROUS_ARGS: Record<string, string>;
  buildActivityMonitorOptions: (
    effectiveAgentId: string | undefined,
    deps: Record<string, unknown>
  ) => ActivityMonitorOptionsLike;
  UNIVERSAL_APPROVAL_HINT_PATTERNS: string[];
  createPatternDetector: (agentId?: string) => {
    detect: (output: string, opts?: { alreadyStripped?: boolean }) => PatternDetectionResultLike;
  };
}

let modulesPromise: Promise<RosterModules> | null = null;

export function loadRosterModules(): Promise<RosterModules> {
  modulesPromise ??= (async () => {
    const [registry, ids, settings, patterns, detector] = await Promise.all([
      import("../../../shared/config/agentRegistry"),
      import("../../../shared/config/agentIds"),
      import("../../../shared/types/agentSettings"),
      import("../../../electron/services/pty/terminalActivityPatterns"),
      import("../../../electron/services/pty/AgentPatternDetector"),
    ]);

    return {
      AGENT_REGISTRY: registry.AGENT_REGISTRY as Record<string, AgentConfig>,
      BUILT_IN_AGENT_IDS: ids.BUILT_IN_AGENT_IDS,
      LAUNCHABLE_AGENT_IDS: ids.LAUNCHABLE_AGENT_IDS,
      getAgentIds: registry.getAgentIds,
      getAgentConfig: registry.getAgentConfig,
      getEffectiveRegistry: registry.getEffectiveRegistry as RosterModules["getEffectiveRegistry"],
      getEffectiveAgentIds: registry.getEffectiveAgentIds,
      getEffectiveAgentConfig: registry.getEffectiveAgentConfig,
      isBuiltInAgent: registry.isBuiltInAgent,
      isEffectivelyRegisteredAgent: registry.isEffectivelyRegisteredAgent,
      getAgentDisplayTitle: registry.getAgentDisplayTitle,
      getAgentModelConfig: registry.getAgentModelConfig,
      resolveAgentContinuity:
        registry.resolveAgentContinuity as RosterModules["resolveAgentContinuity"],
      setUserRegistry: registry.setUserRegistry as RosterModules["setUserRegistry"],
      invalidateEffectiveRegistryCache: registry.invalidateEffectiveRegistryCache,
      generateAgentCommand: settings.generateAgentCommand as RosterModules["generateAgentCommand"],
      buildAgentLaunchFlags:
        settings.buildAgentLaunchFlags as RosterModules["buildAgentLaunchFlags"],
      buildAssignedSessionIdArgs: settings.buildAssignedSessionIdArgs,
      supportsSessionIdAssignment: settings.supportsSessionIdAssignment,
      DEFAULT_DANGEROUS_ARGS: settings.DEFAULT_DANGEROUS_ARGS,
      buildActivityMonitorOptions:
        patterns.buildActivityMonitorOptions as RosterModules["buildActivityMonitorOptions"],
      UNIVERSAL_APPROVAL_HINT_PATTERNS: patterns.UNIVERSAL_APPROVAL_HINT_PATTERNS,
      createPatternDetector:
        detector.createPatternDetector as RosterModules["createPatternDetector"],
    };
  })();
  return modulesPromise;
}

// --- lookup expectation table ------------------------------------------------

export interface LookupCase {
  agentId: string;
  /** Whether the roster must answer with a config at all. */
  expectRegistered: boolean;
  /** Why this row exists — printed by the unit test, not by the scenario. */
  reason: string;
}

/**
 * Ids that must NOT resolve, alongside every id that must.
 *
 * The prototype keys are the ones worth stating: the registry is a plain
 * object, so a lookup written as `registry[id]` — rather than the own-key check
 * the product actually uses — answers `getEffectiveAgentConfig("toString")`
 * with a function. A lookup that returns something for every key is faster than
 * one that checks, and only a negative row can tell them apart.
 */
export const NEGATIVE_LOOKUP_IDS: readonly string[] = [
  "toString",
  "constructor",
  "hasOwnProperty",
  "__proto__",
  "valueOf",
  "claude-code",
  "gpt",
  "",
  "CLAUDE",
  "openai",
];

export function buildLookupCases(builtInIds: readonly string[]): LookupCase[] {
  const cases: LookupCase[] = builtInIds.map((agentId) => ({
    agentId,
    expectRegistered: true,
    reason: "declared built-in",
  }));
  for (const agentId of NEGATIVE_LOOKUP_IDS) {
    cases.push({
      agentId,
      expectRegistered: false,
      reason: agentId === "" ? "empty id" : "unregistered or prototype key",
    });
  }
  return cases;
}

// --- pattern-compile expectations -------------------------------------------

/** One compiled slot of `ActivityMonitorOptions`, with the strings it owes. */
export interface PatternSlotExpectation {
  slot: "primary" | "fallback" | "bootComplete" | "prompt" | "promptHint" | "completion";
  /** Declared source strings that `new RegExp(p, "im")` accepts. */
  expectedSources: string[];
}

/**
 * What a roster-wide `buildActivityMonitorOptions` sweep owes, per agent.
 *
 * Derived from each config's own `detection` block rather than hardcoded, so a
 * roster edit moves the expectation instead of breaking the oracle — but it is
 * still an INDEPENDENT reading: the expectation comes from the declared source
 * STRINGS, and the subject is the compiled `RegExp` objects. A compiler that
 * returns nothing, drops the `i` flag, or invents a pattern outside the
 * declared set is caught by comparing those two, and none of it is visible in
 * a duration.
 *
 * Two product rules are encoded here because they are documented decisions
 * rather than compilation behaviour:
 *   - a slot whose declared list is empty yields `undefined`, not `[]`;
 *   - `buildPatternConfig` returns `undefined` outright when `primaryPatterns`
 *     is empty, which drops that agent's `fallbackPatterns` with it (`amp.ts`
 *     carries a comment acknowledging exactly this).
 */
export function expectedPatternSlots(
  config: AgentConfig | undefined,
  universalHints: readonly string[]
): PatternSlotExpectation[] {
  const detection = config?.detection;
  // Canonicalised through the engine's own escaping rule, because
  // `RegExp.prototype.source` rewrites an unescaped `/` as `\\/` — comparing
  // raw config strings against compiled sources would report four real agents
  // as broken. The expectation still comes from the DECLARED strings; only the
  // spelling is normalised, and an unparseable pattern drops out here exactly
  // as `compilePatterns` drops it.
  const valid = (patterns: readonly string[] | undefined): string[] => {
    const sources: string[] = [];
    for (const pattern of patterns ?? []) {
      try {
        sources.push(new RegExp(pattern, "im").source);
      } catch {
        // Unparseable: the product silently skips it, so nothing is owed.
      }
    }
    return sources;
  };

  const primary = valid(detection?.primaryPatterns);
  // Primary empty ⇒ the whole pattern config is dropped, fallback included.
  const fallback = primary.length > 0 ? valid(detection?.fallbackPatterns) : [];

  return [
    { slot: "primary", expectedSources: primary },
    { slot: "fallback", expectedSources: fallback },
    { slot: "bootComplete", expectedSources: valid(detection?.bootCompletePatterns) },
    { slot: "prompt", expectedSources: valid(detection?.promptPatterns) },
    {
      slot: "promptHint",
      // The universal approval hints are appended for every named agent,
      // whether or not it declares any of its own.
      expectedSources: [...valid(detection?.promptHintPatterns), ...valid(universalHints)],
    },
    { slot: "completion", expectedSources: valid(detection?.completionPatterns) },
  ];
}

/** Read the compiled regexes out of one slot of a built `ActivityMonitorOptions`. */
export function compiledSlot(
  options: ActivityMonitorOptionsLike,
  slot: PatternSlotExpectation["slot"]
): RegExp[] | undefined {
  switch (slot) {
    case "primary":
      return options.patternConfig?.primaryPatterns;
    case "fallback":
      return options.patternConfig?.fallbackPatterns;
    case "bootComplete":
      return options.bootCompletePatterns;
    case "prompt":
      return options.promptPatterns;
    case "promptHint":
      return options.promptHintPatterns;
    case "completion":
      return options.completionPatterns;
  }
}

/**
 * Grade one built options object against its expectation table.
 *
 * Counts in BOTH directions: a declared pattern that never got compiled, a
 * compiled pattern nobody declared, a slot that materialised as `[]` where the
 * product promises `undefined`, and a regex compiled without the case-insensitive
 * multiline flags the detector's matching depends on.
 */
export function gradePatternSlots(
  options: ActivityMonitorOptionsLike,
  expectations: readonly PatternSlotExpectation[]
): { misses: number; compiledCount: number } {
  let misses = 0;
  let compiledCount = 0;

  for (const expectation of expectations) {
    const compiled = compiledSlot(options, expectation.slot);
    if (expectation.expectedSources.length === 0) {
      if (compiled !== undefined) misses += 1;
      continue;
    }
    if (compiled === undefined) {
      misses += expectation.expectedSources.length;
      continue;
    }
    compiledCount += compiled.length;

    const remaining = new Map<string, number>();
    for (const source of expectation.expectedSources) {
      remaining.set(source, (remaining.get(source) ?? 0) + 1);
    }
    for (const regex of compiled) {
      if (regex.flags !== "im") misses += 1;
      const outstanding = remaining.get(regex.source);
      if (outstanding === undefined || outstanding === 0) {
        // Compiled something nobody declared.
        misses += 1;
        continue;
      }
      remaining.set(regex.source, outstanding - 1);
    }
    for (const outstanding of remaining.values()) misses += outstanding;
  }

  return { misses, compiledCount };
}

// --- launch-command expectations ---------------------------------------------

export interface LaunchCase {
  name: string;
  entry: AgentSettingsEntryLike;
  options: GenerateAgentCommandOptionsLike;
  /** Screen-mode polarity the row demands, or null when neither may appear. */
  expectScreenMode: "inline" | "altScreen" | null;
  /** Whether the row must carry the agent's dangerous args. */
  expectDangerous: boolean;
  /** Whether the row must carry assigned-session-id args (when supported). */
  expectSessionId: boolean;
}

export const LAUNCH_SESSION_ID = "perf-0000-1111-2222-3333";

/**
 * The launch shapes a terminal spawn actually produces, each with what the
 * agent's own config says the command owes.
 *
 * Every row is graded against the agent's declared `args`, `capabilities`
 * and `resume` — so a builder that emits only the bare command misses on every
 * agent that declares anything, and a builder that appends everything it knows
 * misses on the rows that forbid a token: the headless row (where screen-mode
 * flags are illegal), the opposite polarity, and the agents whose `resume.kind`
 * is not `session-id` and must therefore never see an assigned id.
 */
export const LAUNCH_CASES: readonly LaunchCase[] = [
  {
    name: "interactive, inline",
    entry: { inlineMode: "on" },
    options: { interactive: true },
    expectScreenMode: "inline",
    expectDangerous: false,
    expectSessionId: false,
  },
  {
    name: "interactive, alt-screen",
    entry: { inlineMode: "off" },
    options: { interactive: true },
    expectScreenMode: "altScreen",
    expectDangerous: false,
    expectSessionId: false,
  },
  {
    name: "headless one-shot carries neither screen-mode polarity",
    entry: { inlineMode: "on" },
    options: { interactive: false },
    expectScreenMode: null,
    expectDangerous: false,
    expectSessionId: false,
  },
  {
    name: "dangerous mode on",
    entry: { inlineMode: "off", dangerousMode: "on" },
    options: { interactive: true },
    expectScreenMode: "altScreen",
    expectDangerous: true,
    expectSessionId: false,
  },
  {
    name: "assigned session id",
    entry: { inlineMode: "off" },
    options: { interactive: true, sessionId: LAUNCH_SESSION_ID },
    expectScreenMode: "altScreen",
    expectDangerous: false,
    expectSessionId: true,
  },
];

/** Shell-word split that keeps quoted runs whole, matching the builder's escaping. */
function commandTokens(command: string): string[] {
  return command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
}

/**
 * Whether a token is present, quoted or not.
 *
 * `escapeShellArg` quotes any argument that does not start with `-`, and picks
 * its quote character from the host platform — so `goose`'s declared `session`
 * arrives as `'session'` on POSIX and `"session"` on Windows. A raw
 * `includes()` reports the same healthy build as a miss on both.
 */
function hasToken(tokens: readonly string[], value: string): boolean {
  return tokens.some(
    (token) => token === value || token === `'${value}'` || token === `"${value}"`
  );
}

/**
 * Grade one built launch command against what the agent's own config declares.
 *
 * Returns a miss count, never throws: a benchmark that dies on an unexpected
 * roster shape reports nothing at all, which is strictly worse than reporting
 * the miss.
 */
export function gradeLaunchCommand(
  mods: RosterModules,
  agentId: string,
  launchCase: LaunchCase,
  command: string
): number {
  const config = mods.getEffectiveAgentConfig(agentId);
  const tokens = commandTokens(command);
  let misses = 0;

  if (!config) return 1;
  if (tokens[0] !== config.command) misses += 1;

  for (const arg of config.args ?? []) {
    if (!hasToken(tokens, arg)) misses += 1;
  }

  const inlineFlag = config.capabilities?.inlineModeFlag;
  const altFlag = config.capabilities?.altScreenFlag;
  const wanted =
    launchCase.expectScreenMode === "inline"
      ? inlineFlag
      : launchCase.expectScreenMode === "altScreen"
        ? altFlag
        : undefined;
  const forbidden = [inlineFlag, altFlag].filter(
    (flag): flag is string => typeof flag === "string" && flag !== wanted
  );
  if (wanted !== undefined && !tokens.includes(wanted)) misses += 1;
  for (const flag of forbidden) {
    if (tokens.includes(flag)) misses += 1;
  }

  const dangerous = mods.DEFAULT_DANGEROUS_ARGS[agentId];
  if (dangerous) {
    const dangerousTokens = dangerous.split(/\s+/).filter(Boolean);
    for (const token of dangerousTokens) {
      const present = tokens.includes(token);
      if (launchCase.expectDangerous !== present) misses += 1;
    }
  }

  const assigned = mods.buildAssignedSessionIdArgs(agentId, LAUNCH_SESSION_ID);
  if (launchCase.expectSessionId && assigned) {
    for (const arg of assigned) {
      if (!hasToken(tokens, arg)) misses += 1;
    }
  }
  if (!launchCase.expectSessionId || !mods.supportsSessionIdAssignment(agentId)) {
    // An agent that cannot be told its session id must never be handed one.
    if (command.includes(LAUNCH_SESSION_ID)) misses += 1;
  }

  return misses;
}

// --- synthetic user-registry tier -------------------------------------------

/** Id of the user-tier agent the merge scenario installs and then removes. */
export const USER_TIER_AGENT_ID = "perf-user-agent";

/**
 * A user-registry snapshot that both ADDS an agent and tries to SHADOW a
 * built-in one.
 *
 * The merge spreads built-ins last, so the added id must appear and the
 * shadowing attempt must lose. That pair is what makes the merge gradeable: a
 * merge that returned `AGENT_REGISTRY` unchanged passes the precedence half and
 * fails the addition half, and a merge that spread in the wrong order passes
 * the addition half and fails precedence.
 */
export function userTierRegistry(builtInSample: AgentConfig): Record<string, AgentConfig> {
  return {
    [USER_TIER_AGENT_ID]: {
      id: USER_TIER_AGENT_ID,
      name: "Perf User Agent",
      command: "perf-user-agent",
    } as AgentConfig,
    [builtInSample.id]: {
      ...builtInSample,
      command: "perf-shadowed-command",
    } as AgentConfig,
  };
}
