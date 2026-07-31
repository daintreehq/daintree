import { describe, it, expect } from "vitest";
import {
  bandForRun,
  compareWithinBand,
  countDemands,
  FLEET_BANDS,
  groupRunsByBand,
  isDemandBand,
} from "../fleetAttention";
import type { FleetRunRow } from "@shared/types/ipc/fleet";

const NOW = 1_700_000_000_000;

function run(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId: "t1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo",
    ...overrides,
  };
}

describe("bandForRun", () => {
  it("splits waiting into blocked and needs-you on the error reason", () => {
    expect(bandForRun(run({ agentState: "waiting", waitingReason: "error" }))).toBe("blocked");
    expect(bandForRun(run({ agentState: "waiting", waitingReason: "prompt" }))).toBe("needs-you");
    expect(bandForRun(run({ agentState: "waiting", waitingReason: "question" }))).toBe("needs-you");
    expect(bandForRun(run({ agentState: "waiting", waitingReason: "approval" }))).toBe("needs-you");
  });

  it("treats a waiting run with no reason as needing input, not blocked", () => {
    // Escalating an unclassified wait to the top band would make the most
    // urgent row the least trustworthy one.
    expect(bandForRun(run({ agentState: "waiting" }))).toBe("needs-you");
  });

  it("folds directing in with working rather than treating it as a demand", () => {
    expect(bandForRun(run({ agentState: "working" }))).toBe("running");
    expect(bandForRun(run({ agentState: "directing" }))).toBe("running");
  });

  it("puts every non-agent-state run in idle rather than inventing a demand", () => {
    expect(bandForRun(run({ agentState: "idle" }))).toBe("idle");
    expect(bandForRun(run({ agentState: "exited" }))).toBe("idle");
    expect(bandForRun(run())).toBe("idle");
  });
});

describe("isDemandBand", () => {
  it("agrees with countDemands about which runs are demands", () => {
    // Cross-checks the predicate against the counter rather than restating the
    // membership set, so the two can't drift apart silently.
    for (const band of FLEET_BANDS) {
      const state =
        band === "blocked"
          ? { agentState: "waiting" as const, waitingReason: "error" as const }
          : band === "needs-you"
            ? { agentState: "waiting" as const }
            : band === "review"
              ? { agentState: "completed" as const }
              : band === "running"
                ? { agentState: "working" as const }
                : { agentState: "idle" as const };
      expect(countDemands([run(state)])).toBe(isDemandBand(band) ? 1 : 0);
    }
  });

  it("classifies at least one band as a demand and at least one as not", () => {
    const demands = FLEET_BANDS.filter(isDemandBand);
    expect(demands.length).toBeGreaterThan(0);
    expect(demands.length).toBeLessThan(FLEET_BANDS.length);
  });
});

describe("compareWithinBand", () => {
  it("orders oldest demand first so fresh work cannot starve a stuck run", () => {
    const old = run({ runId: "a", since: NOW - 40 * 60_000 });
    const fresh = run({ runId: "b", since: NOW - 60_000 });
    expect([fresh, old].sort(compareWithinBand).map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("sorts an unknown age last, never first", () => {
    const unknown = run({ runId: "a" });
    const known = run({ runId: "b", since: NOW - 60_000 });
    expect([unknown, known].sort(compareWithinBand).map((r) => r.runId)).toEqual(["b", "a"]);
  });

  it("is a total order: reflexive on identity and antisymmetric", () => {
    const x = run({ runId: "a", since: NOW });
    const y = run({ runId: "b", since: NOW - 1000 });
    expect(compareWithinBand(x, x)).toBe(0);
    expect(Math.sign(compareWithinBand(x, y))).toBe(-Math.sign(compareWithinBand(y, x)));
  });

  it("ranks unknown ages consistently from either argument position", () => {
    const unknown = run({ runId: "a" });
    const other = run({ runId: "b" });
    const known = run({ runId: "c", since: NOW });
    expect(compareWithinBand(unknown, known)).toBeGreaterThan(0);
    expect(compareWithinBand(known, unknown)).toBeLessThan(0);
    // Two unknowns must still rank against each other rather than tying.
    expect(Math.sign(compareWithinBand(unknown, other))).toBe(
      -Math.sign(compareWithinBand(other, unknown))
    );
  });

  it("is transitive across known, equal and unknown ages", () => {
    const oldest = run({ runId: "a", since: NOW - 10_000 });
    const newer = run({ runId: "b", since: NOW });
    const unknown = run({ runId: "c" });
    expect(compareWithinBand(oldest, newer)).toBeLessThan(0);
    expect(compareWithinBand(newer, unknown)).toBeLessThan(0);
    expect(compareWithinBand(oldest, unknown)).toBeLessThan(0);
  });

  it("breaks ties by run id so equal ages produce a stable order", () => {
    const first = run({ runId: "a", since: NOW });
    const second = run({ runId: "b", since: NOW });
    expect([second, first].sort(compareWithinBand).map((r) => r.runId)).toEqual(["a", "b"]);
    expect([first, second].sort(compareWithinBand).map((r) => r.runId)).toEqual(["a", "b"]);
  });
});

describe("groupRunsByBand", () => {
  it("emits present bands in FLEET_BANDS order regardless of input order", () => {
    const runs = [
      run({ runId: "w", agentState: "working" }),
      run({ runId: "c", agentState: "completed" }),
      run({ runId: "b", agentState: "waiting", waitingReason: "error" }),
      run({ runId: "n", agentState: "waiting" }),
    ];
    // Derived from the constant rather than restating it — this asserts the
    // ordering INVARIANT, so it keeps working if a band is ever added.
    const emitted = groupRunsByBand(runs).map((g) => g.band);
    const expected = FLEET_BANDS.filter((b) => emitted.includes(b));
    expect(emitted).toEqual(expected);
  });

  it("places every run in exactly one band", () => {
    const runs = [
      run({ runId: "w", agentState: "working" }),
      run({ runId: "c", agentState: "completed" }),
      run({ runId: "b", agentState: "waiting", waitingReason: "error" }),
      run({ runId: "i" }),
    ];
    const placed = groupRunsByBand(runs).flatMap((g) => g.runs.map((r) => r.runId));
    expect(placed.slice().sort()).toEqual(runs.map((r) => r.runId).sort());
    expect(new Set(placed).size).toBe(runs.length);
  });

  it("puts every demand band ahead of every non-demand band", () => {
    const groups = groupRunsByBand([
      run({ runId: "w", agentState: "working" }),
      run({ runId: "b", agentState: "waiting", waitingReason: "error" }),
      run({ runId: "i" }),
      run({ runId: "c", agentState: "completed" }),
    ]);
    const firstNonDemand = groups.findIndex((g) => !isDemandBand(g.band));
    const lastDemand = groups.map((g) => isDemandBand(g.band)).lastIndexOf(true);
    expect(lastDemand).toBeLessThan(firstNonDemand);
  });

  it("produces the same grouping for any input permutation", () => {
    const runs = [
      run({ runId: "a", agentState: "waiting", since: NOW - 5000 }),
      run({ runId: "b", agentState: "completed", since: NOW - 9000 }),
      run({ runId: "c", agentState: "working", since: NOW - 1000 }),
      run({ runId: "d", agentState: "waiting", waitingReason: "error", since: NOW - 2000 }),
    ];
    const canonical = JSON.stringify(
      groupRunsByBand(runs).map((g) => [g.band, g.runs.map((r) => r.runId)])
    );
    const permutations = [
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ].map((order) => order.map((i) => runs[i]!));
    for (const perm of permutations) {
      expect(
        JSON.stringify(groupRunsByBand(perm).map((g) => [g.band, g.runs.map((r) => r.runId)]))
      ).toBe(canonical);
    }
  });

  it("does not reorder or mutate the caller's array", () => {
    const runs = Object.freeze([
      run({ runId: "b", agentState: "waiting", since: NOW }),
      run({ runId: "a", agentState: "waiting", since: NOW - 9000 }),
    ]);
    const groups = groupRunsByBand(runs);
    expect(runs.map((r) => r.runId)).toEqual(["b", "a"]);

    // Mutating a returned bucket must not reach back into the caller's array.
    groups[0]!.runs.reverse();
    expect(runs.map((r) => r.runId)).toEqual(["b", "a"]);
  });

  it("omits empty bands rather than emitting a zero heading", () => {
    const groups = groupRunsByBand([run({ agentState: "working" })]);
    expect(groups).toHaveLength(1);
    expect(groups.at(0)?.band).toBe("running");
  });

  it("orders oldest-first inside a band", () => {
    const groups = groupRunsByBand([
      run({ runId: "fresh", agentState: "waiting", since: NOW - 60_000 }),
      run({ runId: "stale", agentState: "waiting", since: NOW - 40 * 60_000 }),
    ]);
    expect(groups.at(0)?.runs.map((r) => r.runId)).toEqual(["stale", "fresh"]);
  });

  it("returns nothing for an empty fleet", () => {
    expect(groupRunsByBand([])).toEqual([]);
  });
});

describe("countDemands", () => {
  it("counts demand bands and ignores runs merely in flight", () => {
    expect(
      countDemands([
        run({ agentState: "waiting", waitingReason: "error" }),
        run({ agentState: "waiting" }),
        run({ agentState: "completed" }),
        run({ agentState: "working" }),
        run({ agentState: "idle" }),
      ])
    ).toBe(3);
  });

  it("reports zero for a fleet that is busy but asking nothing", () => {
    expect(countDemands([run({ agentState: "working" }), run({ agentState: "working" })])).toBe(0);
  });
});
