import { describe, expect, it } from "vitest";

import {
  LAUNCH_CASES,
  LAUNCH_SESSION_ID,
  NEGATIVE_LOOKUP_IDS,
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
import { agentRosterScenarios } from "../scenarios/agentRoster";
import { EXPECTED_SCENARIO_IDS } from "../scenarios";

/**
 * The graders are the thing worth testing. Each PERF-350..353 predicate is a
 * comparison between what the roster declared and what a product function
 * produced, and a grader that stopped detecting a difference reports a clean
 * zero forever. So each one is driven here with a deliberately WRONG subject as
 * well as a right one — the perf run itself only ever sees the right one.
 */

const CLAUDE = "claude";

describe("agent roster fixture oracles", () => {
  it("reads the roster off disk and agrees with the product's own id list", async () => {
    const mods = await loadRosterModules();
    const onDisk = agentIdsOnDisk();
    expect(onDisk.length).toBeGreaterThanOrEqual(18);
    expect([...onDisk].sort()).toEqual([...mods.BUILT_IN_AGENT_IDS].sort());
    expect(onDisk).not.toContain("completionSourceHelpers");
  });

  it("builds a lookup table whose negative rows include the prototype keys", () => {
    const cases = buildLookupCases(["claude", "codex"]);
    expect(cases.filter((testCase) => testCase.expectRegistered)).toHaveLength(2);
    expect(cases.filter((testCase) => !testCase.expectRegistered).length).toBe(
      NEGATIVE_LOOKUP_IDS.length
    );
    for (const key of ["toString", "constructor", "__proto__"]) {
      expect(NEGATIVE_LOOKUP_IDS).toContain(key);
    }
  });

  it("scores a healthy pattern compile at zero and a broken one above it", async () => {
    const mods = await loadRosterModules();
    const config = mods.getEffectiveAgentConfig(CLAUDE);
    const expectations = expectedPatternSlots(config, mods.UNIVERSAL_APPROVAL_HINT_PATTERNS);
    const healthy = mods.buildActivityMonitorOptions(CLAUDE, {});

    expect(gradePatternSlots(healthy, expectations).misses).toBe(0);
    expect(gradePatternSlots(healthy, expectations).compiledCount).toBeGreaterThan(20);

    // Compiled nothing.
    expect(gradePatternSlots({}, expectations).misses).toBeGreaterThan(0);

    // Compiled the right count of the wrong things.
    const invented: ActivityMonitorOptionsLike = {
      ...healthy,
      promptHintPatterns: (healthy.promptHintPatterns ?? []).map(() => /never-declared/im),
    };
    expect(gradePatternSlots(invented, expectations).misses).toBeGreaterThan(0);

    // Right sources, wrong flags — the case a source-only comparison misses.
    const unflagged: ActivityMonitorOptionsLike = {
      ...healthy,
      promptHintPatterns: (healthy.promptHintPatterns ?? []).map(
        (pattern) => new RegExp(pattern.source)
      ),
    };
    expect(gradePatternSlots(unflagged, expectations).misses).toBe(
      healthy.promptHintPatterns?.length
    );
  });

  it("expects undefined, not an empty array, for a slot the agent declares nothing for", async () => {
    const mods = await loadRosterModules();
    const bare = expectedPatternSlots(undefined, mods.UNIVERSAL_APPROVAL_HINT_PATTERNS);
    const primary = bare.find((slot) => slot.slot === "primary");
    expect(primary?.expectedSources).toEqual([]);
    expect(gradePatternSlots({ patternConfig: { primaryPatterns: [] } }, bare)).toMatchObject({
      misses: expect.any(Number),
    });
    expect(
      gradePatternSlots({ patternConfig: { primaryPatterns: [] } }, bare).misses
    ).toBeGreaterThan(0);
  });

  it("scores a healthy launch command at zero and both failure directions above it", async () => {
    const mods = await loadRosterModules();
    const config = mods.getEffectiveAgentConfig(CLAUDE);
    const base = config?.command ?? CLAUDE;

    for (const launchCase of LAUNCH_CASES) {
      const command = mods.generateAgentCommand(base, launchCase.entry, CLAUDE, launchCase.options);
      expect(gradeLaunchCommand(mods, CLAUDE, launchCase, command)).toBe(0);
    }

    const inlineCase = LAUNCH_CASES[0];
    const headlessCase = LAUNCH_CASES[2];
    const dangerousCase = LAUNCH_CASES[3];
    expect(inlineCase && headlessCase && dangerousCase).toBeTruthy();

    // Emitted nothing but the binary.
    expect(gradeLaunchCommand(mods, CLAUDE, dangerousCase!, base)).toBeGreaterThan(0);
    // Emitted a token the row forbids.
    const dangerousArg = mods.DEFAULT_DANGEROUS_ARGS[CLAUDE] as string;
    const overEager = `${mods.generateAgentCommand(base, inlineCase!.entry, CLAUDE, inlineCase!.options)} ${dangerousArg}`;
    expect(gradeLaunchCommand(mods, CLAUDE, inlineCase!, overEager)).toBeGreaterThan(0);
    // Handed a session id to a row that did not ask for one.
    const leaked = `${mods.generateAgentCommand(base, headlessCase!.entry, CLAUDE, headlessCase!.options)} ${LAUNCH_SESSION_ID}`;
    expect(gradeLaunchCommand(mods, CLAUDE, headlessCase!, leaked)).toBeGreaterThan(0);
  });

  it("tolerates the shell quoting the builder applies to non-flag args", async () => {
    const mods = await loadRosterModules();
    // `goose` declares a bare `session` arg, which `escapeShellArg` quotes.
    const config = mods.getEffectiveAgentConfig("goose");
    if (!config?.args?.length) return;
    const command = mods.generateAgentCommand(
      config.command,
      LAUNCH_CASES[0]!.entry,
      "goose",
      LAUNCH_CASES[0]!.options
    );
    expect(gradeLaunchCommand(mods, "goose", LAUNCH_CASES[0]!, command)).toBe(0);
  });

  it("builds a user tier that both adds an agent and collides with a built-in", async () => {
    const mods = await loadRosterModules();
    const sample = mods.getEffectiveAgentConfig(CLAUDE);
    expect(sample).toBeDefined();
    const tier = userTierRegistry(sample!);
    expect(Object.keys(tier)).toContain(USER_TIER_AGENT_ID);
    expect(Object.keys(tier)).toContain(CLAUDE);
    expect(tier[CLAUDE]?.command).not.toBe(sample!.command);
  });
});

describe("agent roster perf scenarios", () => {
  it("declares ids that are in the matrix and predicates on every one", () => {
    for (const scenario of agentRosterScenarios) {
      expect(EXPECTED_SCENARIO_IDS.has(scenario.id)).toBe(true);
      expect(scenario.correctness?.length ?? 0).toBeGreaterThan(0);
    }
    expect(agentRosterScenarios.map((scenario) => scenario.id)).toEqual([
      "PERF-350",
      "PERF-351",
      "PERF-352",
      "PERF-353",
    ]);
  });

  it("leaves the user registry empty after PERF-350 mutates it", async () => {
    const mods = await loadRosterModules();
    const scenario = agentRosterScenarios.find((entry) => entry.id === "PERF-350");
    await scenario!.run({ mode: "smoke", now: () => performance.now() });
    expect(mods.getEffectiveAgentIds()).not.toContain(USER_TIER_AGENT_ID);
  });
});
