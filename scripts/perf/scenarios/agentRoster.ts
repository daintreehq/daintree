import { performance } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import { percentile } from "../lib/stats";
import {
  LAUNCH_CASES,
  LAUNCH_SESSION_ID,
  USER_TIER_AGENT_ID,
  agentIdsOnDisk,
  buildLookupCases,
  expectedPatternSlots,
  gradeLaunchCommand,
  gradePatternSlots,
  loadRosterModules,
  userTierRegistry,
  type ActivityMonitorOptionsLike,
} from "../lib/agentRosterFixture";

/**
 * The agent roster — 43 KB of config covering 18 CLIs, read on every terminal
 * launch and every agent-state decision, and previously unmeasured.
 *
 * `lib/agentRosterFixture.ts` states the scope; the short version is that
 * nothing here is stubbed, nothing touches user agent config, and nothing
 * spawns anything.
 *
 * PERF-035 already prices the per-chunk analysis pipeline. This family measures
 * what PERF-035 holds constant: the merge, the lookup, the launch-command
 * assembly, and — the reading most likely to be worth acting on — the
 * `new RegExp` storm every spawn pays before its first byte of output, which
 * nothing memoizes.
 */

const NEGATIVE_LOOKUP_SWEEPS = 40;
const REPEAT_SPAWNS = 24;

/**
 * Chunks the detector probe scores, all authored against DECLARED product data
 * rather than against what any agent happens to claim.
 *
 * `INERT_CHUNK` matches nothing any config declares, so every detector must
 * reject it. `INTERRUPT_CHUNK` carries the interrupt hint `UNIVERSAL_PATTERN_CONFIG`
 * is built around, so the fallback detector an unknown agent gets must claim it.
 * `APPROVAL_CHUNK` satisfies two of the twelve exported
 * UNIVERSAL_APPROVAL_HINT_PATTERNS, which every named agent's hint slot inherits.
 */
const INERT_CHUNK = "plain output with nothing an agent pattern would ever claim\r\n";
const INTERRUPT_CHUNK = "\u001b[2m\u2726\u001b[0m Thinking\u2026 (12s \u00b7 esc to interrupt)";
const APPROVAL_CHUNK = "  \u276f Allow once? [y/n]";

export const agentRosterScenarios: PerfScenario[] = [
  {
    id: "PERF-350",
    name: "Agent Roster - Effective Registry Merge",
    description:
      "The plugin ⊕ user ⊕ built-in merge behind getEffectiveRegistry(), re-run through the " +
      "product's own invalidateEffectiveRegistryCache() so the cold merge is measured rather than " +
      "the memoized read, and reported alongside the warm read it replaces. rosterMisses grades the " +
      "roster against the FILESYSTEM — one file per agent under shared/config/agents/ — which is " +
      "the one oracle a registry cannot satisfy out of its own tables. mergePrecedenceMisses drives " +
      "a synthetic user tier through setUserRegistry that both adds an agent and tries to shadow a " +
      "built-in: the addition must land and the shadowing must lose, so neither a merge that " +
      "returns the built-ins unchanged nor one that spreads in the wrong order can pass both.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 16, nightly: 22 },
    warmups: 2,
    correctness: ["rosterMisses", "mergePrecedenceMisses"],
    async run() {
      const mods = await loadRosterModules();
      const onDisk = agentIdsOnDisk();
      const MERGES = 24;

      const perMerge: number[] = [];
      let warmMs = 0;
      let effective: Record<string, unknown> = {};

      const start = performance.now();
      for (let i = 0; i < MERGES; i += 1) {
        mods.invalidateEffectiveRegistryCache();
        const t0 = performance.now();
        effective = mods.getEffectiveRegistry();
        perMerge.push(performance.now() - t0);

        const t1 = performance.now();
        mods.getEffectiveRegistry();
        warmMs += performance.now() - t1;
      }
      const coldMergeMs = performance.now() - start;

      // Precedence probe, outside the timed loop: it mutates the singleton.
      const sample = mods.AGENT_REGISTRY[mods.BUILT_IN_AGENT_IDS[0] as string];
      let mergePrecedenceMisses = 0;
      if (!sample) {
        mergePrecedenceMisses += 1;
      } else {
        mods.setUserRegistry(userTierRegistry(sample));
        const withUser = mods.getEffectiveAgentIds();
        if (!withUser.includes(USER_TIER_AGENT_ID)) mergePrecedenceMisses += 1;
        if (mods.getEffectiveAgentConfig(USER_TIER_AGENT_ID)?.id !== USER_TIER_AGENT_ID) {
          mergePrecedenceMisses += 1;
        }
        // Built-ins are spread last and must win the collision.
        if (mods.getEffectiveAgentConfig(sample.id)?.command !== sample.command) {
          mergePrecedenceMisses += 1;
        }
        if (mods.isBuiltInAgent(USER_TIER_AGENT_ID)) mergePrecedenceMisses += 1;
        if (!mods.isEffectivelyRegisteredAgent(USER_TIER_AGENT_ID)) mergePrecedenceMisses += 1;

        mods.setUserRegistry({});
        if (mods.getEffectiveAgentIds().includes(USER_TIER_AGENT_ID)) mergePrecedenceMisses += 1;
      }

      const durationMs = coldMergeMs;

      const effectiveIds = new Set(Object.keys(effective));
      let rosterMisses = 0;
      for (const id of onDisk) if (!effectiveIds.has(id)) rosterMisses += 1;
      for (const id of effectiveIds) if (!onDisk.includes(id)) rosterMisses += 1;
      // A roster entry that is present but empty is the same failure with a
      // different shape, so each one is read rather than merely counted.
      for (const id of onDisk) {
        const config = mods.getEffectiveAgentConfig(id);
        if (config?.id !== id) rosterMisses += 1;
        if (typeof config?.command !== "string" || config.command.length === 0) rosterMisses += 1;
        if (typeof config?.name !== "string" || config.name.length === 0) rosterMisses += 1;
      }

      let patternSourceCount = 0;
      let modelCount = 0;
      for (const id of onDisk) {
        const detection = mods.getEffectiveAgentConfig(id)?.detection;
        patternSourceCount +=
          (detection?.primaryPatterns?.length ?? 0) +
          (detection?.fallbackPatterns?.length ?? 0) +
          (detection?.bootCompletePatterns?.length ?? 0) +
          (detection?.promptPatterns?.length ?? 0) +
          (detection?.promptHintPatterns?.length ?? 0) +
          (detection?.completionPatterns?.length ?? 0);
        modelCount += mods.getEffectiveAgentConfig(id)?.models?.length ?? 0;
      }

      return {
        durationMs,
        metrics: {
          builtInAgentCount: mods.BUILT_IN_AGENT_IDS.length,
          agentConfigFileCount: onDisk.length,
          effectiveAgentCount: effectiveIds.size,
          launchableAgentCount: mods.LAUNCHABLE_AGENT_IDS.length,
          declaredPatternSourceCount: patternSourceCount,
          declaredModelCount: modelCount,
          rosterJsonBytes: Buffer.byteLength(JSON.stringify(effective), "utf8"),
          avgColdMergeMs: perMerge.reduce((sum, ms) => sum + ms, 0) / perMerge.length,
          p95ColdMergeMs: percentile(perMerge, 95),
          warmReadMs: warmMs,
          rosterMisses,
          mergePrecedenceMisses,
        },
      };
    },
  },
  {
    id: "PERF-351",
    name: "Agent Roster - Lookup Sweep",
    description:
      "getEffectiveAgentConfig and the four derived lookups over an expectation table naming every " +
      "id that must resolve and every id that must not. The negative rows carry the prototype keys " +
      "(toString, constructor, __proto__): the registry is a plain object, so a lookup written as " +
      "registry[id] answers them with a function, and it is FASTER than the own-key check the " +
      "product actually performs. Only a negative row separates the two — a lookup that returns " +
      "something for every key wins every duration in this scenario and fails ten rows per sweep.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 16, nightly: 22 },
    warmups: 2,
    correctness: ["lookupMisses"],
    async run() {
      const mods = await loadRosterModules();
      const cases = buildLookupCases(mods.BUILT_IN_AGENT_IDS);
      const SWEEPS = 12;

      interface Observed {
        registered: boolean;
        idMatches: boolean;
        builtIn: boolean;
        title: string;
        continuityTier: string | null;
      }

      const perSweep: number[] = [];
      let observations: Observed[] = [];

      const start = performance.now();
      for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
        const sweepObservations: Observed[] = [];
        const t0 = performance.now();
        for (const testCase of cases) {
          const config = mods.getEffectiveAgentConfig(testCase.agentId);
          sweepObservations.push({
            registered: config !== undefined,
            idMatches: config?.id === testCase.agentId,
            builtIn: mods.isBuiltInAgent(testCase.agentId),
            title: mods.getAgentDisplayTitle(testCase.agentId),
            continuityTier: config ? mods.resolveAgentContinuity(testCase.agentId).tier : null,
          });
        }
        perSweep.push(performance.now() - t0);
        observations = sweepObservations;
      }

      // The miss-lookup cost on its own: the branch a palette filter or a
      // terminal title resolution takes for every non-agent terminal.
      const negativeStart = performance.now();
      for (let i = 0; i < NEGATIVE_LOOKUP_SWEEPS; i += 1) {
        for (const testCase of cases) {
          if (!testCase.expectRegistered) mods.getEffectiveAgentConfig(testCase.agentId);
        }
      }
      const negativeSweepMs = performance.now() - negativeStart;
      const durationMs = performance.now() - start;

      let lookupMisses = 0;
      cases.forEach((testCase, index) => {
        const observed = observations[index];
        if (!observed) {
          lookupMisses += 1;
          return;
        }
        if (observed.registered !== testCase.expectRegistered) lookupMisses += 1;
        if (testCase.expectRegistered) {
          if (!observed.idMatches) lookupMisses += 1;
          if (!observed.builtIn) lookupMisses += 1;
          if (observed.title.length === 0) lookupMisses += 1;
          if (!observed.continuityTier) lookupMisses += 1;
        } else if (observed.builtIn) {
          lookupMisses += 1;
        }
      });

      const totalLookups = cases.length * SWEEPS;
      return {
        durationMs,
        metrics: {
          lookupCaseCount: cases.length,
          negativeCaseCount: cases.filter((testCase) => !testCase.expectRegistered).length,
          resolvedLookupCount: totalLookups,
          avgSweepMs: perSweep.reduce((sum, ms) => sum + ms, 0) / perSweep.length,
          p95SweepMs: percentile(perSweep, 95),
          negativeSweepMs,
          lookupMisses,
        },
      };
    },
  },
  {
    id: "PERF-352",
    name: "Agent Roster - Pattern Compile On Spawn",
    description:
      "buildActivityMonitorOptions across the whole roster — the new RegExp work every terminal " +
      "spawn pays before its first byte of output, and the number most likely to be worth acting " +
      "on: nothing memoizes it, so the same agent recompiles its whole pattern set on every spawn " +
      "and on every re-detection. Reported as a roster-wide sweep and again as 24 spawns of one " +
      "agent, which is where the absence of a cache shows. patternCompileMisses grades the compiled " +
      "RegExp objects against the declared source STRINGS in both directions — a slot missing a " +
      "declared pattern, a slot carrying one nobody declared, a slot materialised where the product " +
      "promises undefined, or a regex compiled without the case-insensitive flags the detector " +
      "depends on. detectorMisses then exercises the objects: every detector must reject an inert " +
      "chunk, the fallback detector an unknown agent gets must claim one carrying the interrupt " +
      "hint its config is built around, and every agent's inherited approval hints must match a " +
      "crafted approval line and nothing else — so a set that matches everything and a set that " +
      "matches nothing, both cheaper than a working one, are both scored.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 6, ci: 12, nightly: 16 },
    warmups: 2,
    correctness: ["patternCompileMisses", "detectorMisses"],
    async run() {
      const mods = await loadRosterModules();
      const ids = [...mods.BUILT_IN_AGENT_IDS];
      const deps = {};

      const buildOne = (agentId: string): ActivityMonitorOptionsLike =>
        mods.buildActivityMonitorOptions(agentId, deps);
      const built: Array<{ agentId: string; options: ActivityMonitorOptionsLike }> = [];

      const sweepStart = performance.now();
      for (const agentId of ids) {
        built.push({ agentId, options: buildOne(agentId) });
      }
      const rosterSweepMs = performance.now() - sweepStart;

      // The fleet case: one agent, many panes. Every one of these repeats the
      // whole compile, because there is no cache between them.
      const repeatAgent = ids[0] as string;
      const repeatStart = performance.now();
      let repeatCompiledPatternCount = 0;
      for (let i = 0; i < REPEAT_SPAWNS; i += 1) {
        const options = buildOne(repeatAgent);
        repeatCompiledPatternCount +=
          (options.patternConfig?.primaryPatterns?.length ?? 0) +
          (options.patternConfig?.fallbackPatterns?.length ?? 0) +
          (options.bootCompletePatterns?.length ?? 0) +
          (options.promptPatterns?.length ?? 0) +
          (options.promptHintPatterns?.length ?? 0) +
          (options.completionPatterns?.length ?? 0);
      }
      const repeatCompileMs = performance.now() - repeatStart;

      const detectors = ids.map((agentId) => ({
        agentId,
        detector: mods.createPatternDetector(agentId),
      }));
      const fallbackDetector = mods.createPatternDetector(undefined);
      const detectStart = performance.now();
      const inertClaims: boolean[] = [];
      for (const { detector } of detectors)
        inertClaims.push(detector.detect(INERT_CHUNK).isWorking);
      const fallbackInertClaim = fallbackDetector.detect(INERT_CHUNK).isWorking;
      const fallbackWorkingClaim = fallbackDetector.detect(INTERRUPT_CHUNK).isWorking;
      const detectMs = performance.now() - detectStart;

      const durationMs = rosterSweepMs + repeatCompileMs + detectMs;

      let patternCompileMisses = 0;
      let compiledPatternCount = 0;
      let agentsWithPatterns = 0;
      for (const { agentId, options } of built) {
        const config = mods.getEffectiveAgentConfig(agentId);
        const expectations = expectedPatternSlots(config, mods.UNIVERSAL_APPROVAL_HINT_PATTERNS);
        const graded = gradePatternSlots(options, expectations);
        patternCompileMisses += graded.misses;
        compiledPatternCount += graded.compiledCount;
        if (graded.compiledCount > 0) agentsWithPatterns += 1;
        // Every named agent inherits the universal approval hints, so an empty
        // hint slot is a defect regardless of what the agent declared.
        if (
          (options.promptHintPatterns?.length ?? 0) < mods.UNIVERSAL_APPROVAL_HINT_PATTERNS.length
        ) {
          patternCompileMisses += 1;
        }
      }

      // A compile is only worth paying for if the objects it produced actually
      // work, and both failure directions are cheaper than working: a set that
      // matches nothing and a set that matches everything both finish sooner.
      // Every row here is authored against declared product data, so none of it
      // is the subject grading itself.
      let detectorMisses = 0;
      for (const claimed of inertClaims) if (claimed) detectorMisses += 1;
      if (fallbackInertClaim) detectorMisses += 1;
      if (!fallbackWorkingClaim) detectorMisses += 1;
      for (const { options } of built) {
        const hints = options.promptHintPatterns ?? [];
        if (!hints.some((pattern) => pattern.test(APPROVAL_CHUNK))) detectorMisses += 1;
        if (hints.some((pattern) => pattern.test(INERT_CHUNK))) detectorMisses += 1;
      }

      return {
        durationMs,
        metrics: {
          rosterAgentCount: ids.length,
          compiledPatternCount,
          compiledPatternAgentCount: agentsWithPatterns,
          repeatSpawnCount: REPEAT_SPAWNS,
          repeatCompiledPatternCount,
          universalHintCount: mods.UNIVERSAL_APPROVAL_HINT_PATTERNS.length,
          detectorProbeCount: detectors.length + 2 + built.length * 2,
          rosterSweepMs,
          repeatCompileMs,
          detectMs,
          patternCompileMisses,
          detectorMisses,
        },
      };
    },
  },
  {
    id: "PERF-353",
    name: "Agent Roster - Launch Command Assembly",
    description:
      "generateAgentCommand and buildAgentLaunchFlags across every launchable agent under the five " +
      "shapes a spawn actually takes: interactive inline, interactive alt-screen, headless one-shot, " +
      "dangerous mode, and a pre-assigned session id. This is what the roster is asked for at the " +
      "moment a terminal starts. launchCommandMisses grades each command against the agent's own " +
      "declared args, capabilities and resume block, in both directions — a builder that emits the " +
      "bare command misses on every agent that declares anything, and one that appends everything " +
      "it knows misses on the rows that FORBID a token: the headless row where neither screen-mode " +
      "polarity is legal, the opposite polarity on every other row, and the agents whose resume " +
      "kind means they must never be handed a session id.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 2,
    correctness: ["launchCommandMisses"],
    async run() {
      const mods = await loadRosterModules();
      const ids = [...mods.LAUNCHABLE_AGENT_IDS];

      interface BuiltCommand {
        agentId: string;
        caseIndex: number;
        command: string;
        flagCount: number;
      }

      const perBuild: number[] = [];
      let builds: BuiltCommand[] = [];
      let flagTokenCount = 0;

      const start = performance.now();
      const round: BuiltCommand[] = [];
      for (const agentId of ids) {
        const config = mods.getEffectiveAgentConfig(agentId);
        const baseCommand = config?.command ?? agentId;
        LAUNCH_CASES.forEach((launchCase, caseIndex) => {
          const t0 = performance.now();
          const command = mods.generateAgentCommand(
            baseCommand,
            launchCase.entry,
            agentId,
            launchCase.options
          );
          const flags = mods.buildAgentLaunchFlags(launchCase.entry, agentId, {
            globalUseAltScreen: launchCase.options.globalUseAltScreen,
          });
          perBuild.push(performance.now() - t0);
          flagTokenCount += flags.length;
          round.push({ agentId, caseIndex, command, flagCount: flags.length });
        });
      }
      builds = round;
      const durationMs = performance.now() - start;

      let launchCommandMisses = 0;
      for (const build of builds) {
        const launchCase = LAUNCH_CASES[build.caseIndex];
        if (!launchCase) {
          launchCommandMisses += 1;
          continue;
        }
        launchCommandMisses += gradeLaunchCommand(mods, build.agentId, launchCase, build.command);
      }

      const sessionCapableCount = ids.filter((agentId) =>
        mods.supportsSessionIdAssignment(agentId)
      ).length;
      const screenModeCapableCount = ids.filter((agentId) => {
        const capabilities = mods.getEffectiveAgentConfig(agentId)?.capabilities;
        return Boolean(capabilities?.inlineModeFlag ?? capabilities?.altScreenFlag);
      }).length;

      return {
        durationMs,
        metrics: {
          launchableAgentCount: ids.length,
          launchShapeCount: LAUNCH_CASES.length,
          builtCommandCount: builds.length,
          flagTokenCount,
          sessionAssignableAgentCount: sessionCapableCount,
          screenModeCapableAgentCount: screenModeCapableCount,
          commandCharCount: builds.reduce((total, build) => total + build.command.length, 0),
          avgBuildMs: perBuild.reduce((sum, ms) => sum + ms, 0) / perBuild.length,
          p95BuildMs: percentile(perBuild, 95),
          launchCommandMisses,
        },
      };
    },
  },
];

/** Re-exported so the unit test can name the session id without a second copy. */
export { LAUNCH_SESSION_ID };
