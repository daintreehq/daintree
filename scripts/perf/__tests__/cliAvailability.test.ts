import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../../shared/config/agentRegistry";
import type { CliAvailability } from "../../../shared/types/ipc";
import {
  ALWAYS_ABSENT_AGENT_ID,
  addRefreshGrade,
  authEnvVars,
  duplicateMilestoneKey,
  emptyRefreshGrade,
  expectedAuthState,
  expectedSpawnsFor,
  foundAgentIds,
  gradeRefresh,
  refreshMisses,
  type CliArm,
  type CliModules,
} from "../lib/cliAvailabilityFixture";
import { classifyMetric } from "../lib/comparability";
import { allScenarios } from "../scenarios";

/**
 * The stub experiment for the availability family, written down.
 *
 * The scenarios drive the real service against real `which` subprocesses, which
 * needs the module-resolution hooks Vitest does not run. What is pinned here is
 * the half that matters for review: the spawn arithmetic the oracle compares
 * against, and that each predicate goes non-zero for the specific way its
 * operation breaks — including the two cheap wrong answers, "everything is
 * missing" and "everything is ready", which a one-directional found-set test
 * would let through.
 */

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "Agent", command: "agent", ...overrides } as AgentConfig;
}

const REGISTRY: Record<string, AgentConfig> = {
  alpha: agent({ name: "Alpha", command: "alpha" }),
  beta: agent({ name: "Beta", command: "beta", packages: { npm: "@scope/beta" } }),
  [ALWAYS_ABSENT_AGENT_ID]: agent({ name: "Kiro", command: "kiro-cli" }),
};

const MODULES: CliModules = {
  registry: REGISTRY,
  agentIds: Object.keys(REGISTRY),
  // Never constructed in these tests: the graders take data, not a service.
  CliAvailabilityService: class {} as unknown as CliModules["CliAvailabilityService"],
};

function armFor(plantedIds: string[], viaPrepend = false): CliArm {
  return {
    label: "half",
    plantedIds,
    // Two directories that do not exist, so the hermeticity sweep finds nothing
    // to complain about and the term stays a real reading rather than a
    // constant.
    path: "/daintree-perf-nonexistent-a:/daintree-perf-nonexistent-b",
    prepend: viaPrepend ? "/daintree-perf-nonexistent-a" : null,
    expectedSpawns: expectedSpawnsFor(REGISTRY, plantedIds, viaPrepend),
    hasDuplicate: false,
  };
}

function availabilityWhere(found: string[]): CliAvailability {
  const map: Record<string, string> = {};
  for (const id of Object.keys(REGISTRY)) map[id] = found.includes(id) ? "ready" : "missing";
  return map as unknown as CliAvailability;
}

const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

function gradeAgainst(
  arm: CliArm,
  availability: CliAvailability,
  spawns: number,
  refreshPathCalls = 1
): ReturnType<typeof gradeRefresh> {
  process.env.PATH = arm.path;
  return gradeRefresh(MODULES, arm, {
    availability,
    spawns,
    refreshPathCalls,
    expectedRefreshPathCalls: 1,
  });
}

describe("perf cli-availability spawn arithmetic", () => {
  it("prices a POSIX miss at two starts and a PATH hit at one", () => {
    // On POSIX `which -a` exiting non-zero cannot be told apart from a `which`
    // that rejects `-a`, so the service runs the probe a second time.
    const perMiss = process.platform === "win32" ? 1 : 2;
    // beta declares an npm package, so a refresh in which beta misses also
    // pays one `npm config get prefix`.
    expect(expectedSpawnsFor(REGISTRY, [], false)).toBe(3 * perMiss + 1);
    expect(expectedSpawnsFor(REGISTRY, ["alpha"], false)).toBe(1 + 2 * perMiss + 1);
    expect(expectedSpawnsFor(REGISTRY, ["alpha", "beta"], false)).toBe(2 + perMiss);
  });

  it("prices a prepended-path hit at zero starts", () => {
    const perMiss = process.platform === "win32" ? 1 : 2;
    expect(expectedSpawnsFor(REGISTRY, ["alpha", "beta"], true)).toBe(perMiss);
    expect(expectedSpawnsFor(REGISTRY, Object.keys(REGISTRY), true)).toBe(0);
  });
});

describe("perf cli-availability graders", () => {
  it("scores a healthy refresh at zero on every term", () => {
    const arm = armFor(["alpha", "beta"]);
    const grade = gradeAgainst(arm, availabilityWhere(["alpha", "beta"]), arm.expectedSpawns);
    expect(refreshMisses(grade)).toEqual({
      foundSetMisses: 0,
      absentAgentMisses: 0,
      stateCoverageMisses: 0,
      spawnCountMisses: 0,
      authStateMisses: 0,
      authHermeticityMisses: 0,
      authSplitMisses: 0,
      pathRefreshMisses: 0,
      pathHermeticityMisses: 0,
    });
  });

  it("catches a probe that answers missing for everything", () => {
    const arm = armFor(["alpha", "beta"]);
    const grade = gradeAgainst(arm, availabilityWhere([]), 0);
    expect(grade.foundSetMisses).toBe(2);
    // Signed: positive means the ladder did LESS work than it is supposed to.
    expect(grade.spawnCountMisses).toBe(arm.expectedSpawns);
    expect(grade.spawnCountMisses).toBeGreaterThan(0);
  });

  it("catches a probe that answers ready for everything", () => {
    const arm = armFor(["alpha"]);
    const grade = gradeAgainst(arm, availabilityWhere(Object.keys(REGISTRY)), arm.expectedSpawns);
    // beta and the never-planted agent are both false positives.
    expect(grade.foundSetMisses).toBe(2);
    expect(grade.absentAgentMisses).toBe(1);
  });

  it("catches a fan-out that lost entries from the returned map", () => {
    const arm = armFor(["alpha", "beta"]);
    process.env.PATH = arm.path;
    const partial = { alpha: "ready", beta: "ready" } as unknown as CliAvailability;
    const grade = gradeRefresh(MODULES, arm, {
      availability: partial,
      spawns: arm.expectedSpawns,
      refreshPathCalls: 1,
      expectedRefreshPathCalls: 1,
    });
    expect(grade.stateCoverageMisses).toBe(1);
    expect(grade.absentAgentMisses).toBe(1);
  });

  it("signs the spawn term negative when the ladder over-probes", () => {
    const arm = armFor(["alpha", "beta"]);
    const grade = gradeAgainst(arm, availabilityWhere(["alpha", "beta"]), arm.expectedSpawns + 5);
    expect(grade.spawnCountMisses).toBe(-5);
  });

  it("catches a refresh that stopped refreshing PATH", () => {
    const arm = armFor(["alpha", "beta"]);
    const grade = gradeAgainst(arm, availabilityWhere(["alpha", "beta"]), arm.expectedSpawns, 0);
    expect(grade.pathRefreshMisses).toBe(1);
  });

  it("catches a PATH that is no longer the arm's own", () => {
    const arm = armFor(["alpha", "beta"]);
    process.env.PATH = "/usr/bin";
    const grade = gradeRefresh(MODULES, arm, {
      availability: availabilityWhere(["alpha", "beta"]),
      spawns: arm.expectedSpawns,
      refreshPathCalls: 1,
      expectedRefreshPathCalls: 1,
    });
    expect(grade.pathHermeticityMisses).toBeGreaterThan(0);
  });

  it("reads the found set as everything not reported missing", () => {
    const mixed = { alpha: "installed", beta: "unauthenticated", kiro: "missing" };
    expect(foundAgentIds(mixed as unknown as CliAvailability).sort()).toEqual(["alpha", "beta"]);
  });

  it("sums grades across arms", () => {
    const total = emptyRefreshGrade();
    addRefreshGrade(total, { ...emptyRefreshGrade(), spawnCountMisses: 4 });
    addRefreshGrade(total, { ...emptyRefreshGrade(), spawnCountMisses: -1 });
    expect(total.spawnCountMisses).toBe(3);
  });
});

/**
 * The auth half of the oracle, on a roster this test controls.
 *
 * `expectedAuthState` is the whole expectation `authStateMisses` grades
 * against, and its one subtlety is that two agents can share a credential file
 * — `antigravity` and `gemini` both read `.gemini/oauth_creds.json` in the real
 * roster — so the expectation is derived from the PATHS planted rather than
 * from the agents chosen.
 */
describe("perf cli-availability auth expectations", () => {
  const withAuth = (paths: string[], envVar?: string | string[]): AgentConfig =>
    agent({ authCheck: { configPathsAll: paths, ...(envVar ? { envVar } : {}) } });

  it("calls an agent with no auth check ready, whatever was planted", () => {
    expect(expectedAuthState(agent(), new Set())).toBe("ready");
    expect(expectedAuthState(agent(), new Set([".claude.json"]))).toBe("ready");
  });

  it("calls an agent ready only when one of its own paths was planted", () => {
    const config = withAuth([".alpha/auth.json", ".alpharc"]);
    expect(expectedAuthState(config, new Set())).toBe("unauthenticated");
    expect(expectedAuthState(config, new Set([".beta/auth.json"]))).toBe("unauthenticated");
    expect(expectedAuthState(config, new Set([".alpharc"]))).toBe("ready");
  });

  it("authenticates an agent through a credential file planted for a sibling", () => {
    // The shape `antigravity` and `gemini` have in the shipped roster.
    const shared = ".shared/oauth_creds.json";
    const planted = new Set([shared]);
    expect(expectedAuthState(withAuth([shared]), planted)).toBe("ready");
    expect(expectedAuthState(withAuth([shared, ".other.json"]), planted)).toBe("ready");
  });

  it("collects every credential env var the roster recognises", () => {
    const registry: Record<string, AgentConfig> = {
      one: withAuth([".one"], "ONE_KEY"),
      two: withAuth([".two"], ["TWO_KEY", "ONE_KEY"]),
      three: agent(),
    };
    expect(authEnvVars(registry).sort()).toEqual(["ONE_KEY", "TWO_KEY"]);
  });

  it("names the milestone key notifyDuplicateInstalls writes", () => {
    expect(duplicateMilestoneKey("claude")).toBe("duplicate-cli-warning:claude");
  });
});

/**
 * `authStateMisses` in both directions on one roster, which is the property the
 * scenario relies on: half the planted agents are expected `ready` and half
 * `unauthenticated`, so neither "everything ready" nor "everything
 * unauthenticated" passes.
 */
describe("perf cli-availability auth grading", () => {
  const AUTH_REGISTRY: Record<string, AgentConfig> = {
    alpha: agent({
      name: "Alpha",
      command: "alpha",
      authCheck: { configPathsAll: [".alpha/auth.json"] },
    }),
    beta: agent({
      name: "Beta",
      command: "beta",
      packages: { npm: "@scope/beta" },
      authCheck: { configPathsAll: [".beta/auth.json"] },
    }),
    [ALWAYS_ABSENT_AGENT_ID]: agent({ name: "Kiro", command: "kiro-cli" }),
  };

  const AUTH_MODULES: CliModules = {
    registry: AUTH_REGISTRY,
    agentIds: Object.keys(AUTH_REGISTRY),
    CliAvailabilityService: class {} as unknown as CliModules["CliAvailabilityService"],
  };

  function authArm(): CliArm {
    return {
      label: "allHit",
      plantedIds: ["alpha", "beta"],
      path: "/daintree-perf-nonexistent-a:/daintree-perf-nonexistent-b",
      prepend: null,
      expectedSpawns: expectedSpawnsFor(AUTH_REGISTRY, ["alpha", "beta"], false),
      hasDuplicate: false,
    };
  }

  function grade(states: Record<string, string>): ReturnType<typeof gradeRefresh> {
    const arm = authArm();
    process.env.PATH = arm.path;
    const availability = { ...states, [ALWAYS_ABSENT_AGENT_ID]: "missing" };
    return gradeRefresh(AUTH_MODULES, arm, {
      availability: availability as unknown as CliAvailability,
      spawns: arm.expectedSpawns,
      refreshPathCalls: 1,
      expectedRefreshPathCalls: 1,
    });
  }

  // Nothing is planted under Vitest (the credential planting runs from
  // `buildArms`, which needs the module hooks), so every agent that declares an
  // auth check is expected `unauthenticated` here. That is enough to drive the
  // term in both directions and to prove the split check fires.
  it("scores a probe that reports ready where no credential was planted", () => {
    expect(grade({ alpha: "ready", beta: "ready" }).authStateMisses).toBe(2);
  });

  it("scores nothing when every state matches the plant", () => {
    const result = grade({ alpha: "unauthenticated", beta: "unauthenticated" });
    expect(result.authStateMisses).toBe(0);
  });

  it("flags a one-sided roster on the split term", () => {
    // Both planted agents land in the same class, so the arm cannot catch a
    // probe that answers that class for everything.
    expect(grade({ alpha: "unauthenticated", beta: "unauthenticated" }).authSplitMisses).toBe(1);
  });

  it("leaves the split term alone once both classes are present", () => {
    const arm = authArm();
    process.env.PATH = arm.path;
    const modules: CliModules = {
      ...AUTH_MODULES,
      registry: {
        ...AUTH_REGISTRY,
        // A planted credential path for alpha only exists when the fixture
        // wrote one; simulate the mixed roster by giving beta no auth check at
        // all, which makes it expected-ready.
        beta: agent({ name: "Beta", command: "beta", packages: { npm: "@scope/beta" } }),
      },
    };
    const result = gradeRefresh(modules, arm, {
      availability: {
        alpha: "unauthenticated",
        beta: "ready",
        [ALWAYS_ABSENT_AGENT_ID]: "missing",
      } as unknown as CliAvailability,
      spawns: arm.expectedSpawns,
      refreshPathCalls: 1,
      expectedRefreshPathCalls: 1,
    });
    expect(result.authStateMisses).toBe(0);
    // Only one planted agent declares an auth check now, so there is no split
    // to claim and the term must stay silent rather than firing spuriously.
    expect(result.authSplitMisses).toBe(0);
  });
});

describe("perf cli-availability scenarios", () => {
  it("declares both scenarios with count-class predicates", () => {
    for (const id of ["PERF-393", "PERF-394"]) {
      const scenario = allScenarios.find((candidate) => candidate.id === id);
      expect(scenario).toBeDefined();
      const correctness = scenario?.correctness ?? [];
      expect(correctness.length).toBeGreaterThan(0);
      for (const name of correctness) {
        expect(`${name}:${classifyMetric(name)}`).toBe(`${name}:count`);
      }
    }
  });

  it("marks both scenarios diagnostic on Windows", () => {
    // The WSL probe path reaches the user's real WSL installation, and the
    // shell probe costs one start rather than two. Both are stated rather than
    // silently carried into a cross-platform comparison.
    for (const id of ["PERF-393", "PERF-394"]) {
      const scenario = allScenarios.find((candidate) => candidate.id === id);
      expect(scenario?.platforms?.win32).toBe("diagnostic");
    }
  });
});
