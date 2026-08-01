import { describe, it, expect } from "vitest";
import {
  bandForRun,
  bandLabel,
  BAND_TONE,
  compareWithinBand,
  emptyBandCounts,
  FLEET_BANDS,
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

describe("acknowledged completions", () => {
  it("demotes a completion the user has already seen out of the demand bands", () => {
    // Without the watermark every finished run demands attention forever, and a
    // user who reviewed everything still reads "3 agents need you".
    const finished = run({ agentState: "completed", since: NOW - 60_000 });
    expect(bandForRun(finished)).toBe("review");
    expect(isDemandBand(bandForRun(finished))).toBe(true);

    const seen = bandForRun(finished, NOW);
    expect(seen).toBe("done");
    expect(isDemandBand(seen)).toBe(false);
  });

  it("keeps a completion newer than the watermark outstanding", () => {
    const finished = run({ agentState: "completed", since: NOW });
    expect(bandForRun(finished, NOW - 60_000)).toBe("review");
  });

  it("treats a completion exactly at the watermark as seen", () => {
    expect(bandForRun(run({ agentState: "completed", since: NOW }), NOW)).toBe("done");
  });

  it("leaves a completion with no timestamp outstanding", () => {
    // Unknown is not evidence of having been seen.
    expect(bandForRun(run({ agentState: "completed" }), NOW)).toBe("review");
  });

  it("ignores the watermark for states that are not completions", () => {
    expect(bandForRun(run({ agentState: "waiting", since: NOW - 60_000 }), NOW)).toBe("needs-you");
    expect(bandForRun(run({ agentState: "working", since: NOW - 60_000 }), NOW)).toBe("running");
  });
});

describe("bandLabel", () => {
  it("names every band", () => {
    for (const band of FLEET_BANDS) {
      expect(bandLabel(band, run()).length).toBeGreaterThan(0);
    }
  });

  it("splits the bands that cover two situations a user can tell apart", () => {
    expect(bandLabel("running", run({ agentState: "directing" }))).not.toBe(
      bandLabel("running", run({ agentState: "working" }))
    );
    expect(bandLabel("idle", run({ agentState: "exited" }))).not.toBe(
      bandLabel("idle", run({ agentState: "idle" }))
    );
  });

  it("stops calling an acknowledged completion a hand-back", () => {
    // The label has to move at the same moment the band does, or the row sorts
    // as done while still reading "ready for review".
    expect(bandLabel("done", run({ agentState: "completed" }))).not.toBe(
      bandLabel("review", run({ agentState: "completed" }))
    );
  });
});

describe("band presentation", () => {
  it("gives every band a tone and a count slot, so neither can miss one", () => {
    const counts = emptyBandCounts();
    for (const band of FLEET_BANDS) {
      expect(BAND_TONE[band]).toBeDefined();
      expect(counts[band]).toBe(0);
    }
  });
});

describe("isDemandBand", () => {
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
