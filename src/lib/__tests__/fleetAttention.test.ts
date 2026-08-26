import { describe, it, expect } from "vitest";
import {
  bandForRun,
  bandLabel,
  bandTimestamp,
  compareWithinBand,
  emptyBandCounts,
  FLEET_BANDS,
  isAttentionBand,
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

describe("parked runs", () => {
  it("puts a parked run in the parked band regardless of agent state", () => {
    // Parking is the user's promise to themselves; an attention model that
    // overrides it the moment something looks urgent has to be re-checked
    // constantly, which is the exact cost parking removes.
    for (const agentState of [
      "waiting",
      "working",
      "directing",
      "completed",
      "idle",
      "exited",
    ] as const) {
      expect(bandForRun(run({ agentState, park: { parkedAt: NOW } }))).toBe("parked");
    }
    expect(
      bandForRun(run({ agentState: "waiting", waitingReason: "error", park: { parkedAt: NOW } }))
    ).toBe("parked");
  });

  it("never counts a parked run as a demand", () => {
    const band = bandForRun(run({ agentState: "waiting", park: { parkedAt: NOW } }));
    expect(isDemandBand(band)).toBe(false);
  });

  it("ranks parked below every live band but above idle", () => {
    const rank = (band: (typeof FLEET_BANDS)[number]) => FLEET_BANDS.indexOf(band);
    for (const live of ["blocked", "needs-you", "review", "running", "done"] as const) {
      expect(rank("parked")).toBeGreaterThan(rank(live));
    }
    expect(rank("parked")).toBeLessThan(rank("idle"));
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

  it("gives parked its own words — a shelved run must never read as idle", () => {
    expect(bandLabel("parked", run({ agentState: "waiting", park: { parkedAt: NOW } }))).not.toBe(
      bandLabel("idle", run({ agentState: "idle" }))
    );
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
  it("gives every band a count slot, so a band cannot go uncounted", () => {
    const counts = emptyBandCounts();
    for (const band of FLEET_BANDS) {
      expect(counts[band]).toBe(0);
    }
  });
});

describe("band timestamps", () => {
  it("dates each band from the decision it is actually about", () => {
    const parked = run({ since: NOW - 3 * 3_600_000, park: { parkedAt: NOW - 60_000 } });
    expect(bandTimestamp(parked, "parked")).toBe(NOW - 60_000);

    const snoozed = run({ since: NOW - 3 * 3_600_000, snooze: { snoozedAt: NOW - 60_000 } });
    expect(bandTimestamp(snoozed, "snoozed")).toBe(NOW - 60_000);

    const silent = run({ since: NOW - 3 * 3_600_000, quietSince: NOW - 60_000 });
    expect(bandTimestamp(silent, "quiet")).toBe(NOW - 60_000);

    expect(bandTimestamp(run({ since: NOW - 60_000 }), "needs-you")).toBe(NOW - 60_000);
  });

  it("orders two silent runs by their silence, not by how long they have worked", () => {
    // The one that has been quiet longest is the one worth looking at, even if
    // it is the one that started most recently.
    const longWorkShortSilence = run({
      runId: "a",
      since: NOW - 5 * 3_600_000,
      quietSince: NOW - 60_000,
    });
    const shortWorkLongSilence = run({
      runId: "b",
      since: NOW - 20 * 60_000,
      quietSince: NOW - 15 * 60_000,
    });

    expect(
      [longWorkShortSilence, shortWorkLongSilence]
        .sort((x, y) => compareWithinBand(x, y, "quiet"))
        .map((r) => r.runId)
    ).toEqual(["b", "a"]);
  });
});

describe("quiet runs", () => {
  it("splits a silent worker out of running, on presence of the stamp alone", () => {
    // Main only puts `quietSince` on the wire once the silence has crossed its
    // stall threshold, so this needs no clock of its own.
    expect(bandForRun(run({ agentState: "working", quietSince: NOW - 12 * 60_000 }))).toBe("quiet");
    expect(bandForRun(run({ agentState: "working" }))).toBe("running");
    expect(bandForRun(run({ agentState: "directing", quietSince: NOW - 60_000 }))).toBe("quiet");
  });

  it("keeps a park or a snooze above it, so a shelved run cannot resurface as quiet", () => {
    const silent = { agentState: "working" as const, quietSince: NOW - 12 * 60_000 };
    expect(bandForRun(run({ ...silent, park: { parkedAt: NOW } }))).toBe("parked");
    expect(bandForRun(run({ ...silent, snooze: { snoozedAt: NOW } }))).toBe("snoozed");
  });

  it("outranks finished work but is never counted as a demand", () => {
    // A stall nobody sees costs the rest of the morning; an unread hand-back
    // costs a minute. But nothing is asking, so the demand count stays honest.
    expect(FLEET_BANDS.indexOf("quiet")).toBeLessThan(FLEET_BANDS.indexOf("review"));
    expect(FLEET_BANDS.indexOf("quiet")).toBeGreaterThan(FLEET_BANDS.indexOf("needs-you"));
    expect(isDemandBand("quiet")).toBe(false);
    expect(isAttentionBand("quiet")).toBe(true);
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
  /** These cases are all about the ordering itself, so they bind one band. */
  const byNeed = (a: FleetRunRow, b: FleetRunRow) => compareWithinBand(a, b, "needs-you");

  it("orders oldest demand first so fresh work cannot starve a stuck run", () => {
    const old = run({ runId: "a", since: NOW - 40 * 60_000 });
    const fresh = run({ runId: "b", since: NOW - 60_000 });
    expect([fresh, old].sort(byNeed).map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("sorts an unknown age last, never first", () => {
    const unknown = run({ runId: "a" });
    const known = run({ runId: "b", since: NOW - 60_000 });
    expect([unknown, known].sort(byNeed).map((r) => r.runId)).toEqual(["b", "a"]);
  });

  it("is a total order: reflexive on identity and antisymmetric", () => {
    const x = run({ runId: "a", since: NOW });
    const y = run({ runId: "b", since: NOW - 1000 });
    expect(byNeed(x, x)).toBe(0);
    expect(Math.sign(byNeed(x, y))).toBe(-Math.sign(byNeed(y, x)));
  });

  it("ranks unknown ages consistently from either argument position", () => {
    const unknown = run({ runId: "a" });
    const other = run({ runId: "b" });
    const known = run({ runId: "c", since: NOW });
    expect(byNeed(unknown, known)).toBeGreaterThan(0);
    expect(byNeed(known, unknown)).toBeLessThan(0);
    // Two unknowns must still rank against each other rather than tying.
    expect(Math.sign(byNeed(unknown, other))).toBe(-Math.sign(byNeed(other, unknown)));
  });

  it("is transitive across known, equal and unknown ages", () => {
    const oldest = run({ runId: "a", since: NOW - 10_000 });
    const newer = run({ runId: "b", since: NOW });
    const unknown = run({ runId: "c" });
    expect(byNeed(oldest, newer)).toBeLessThan(0);
    expect(byNeed(newer, unknown)).toBeLessThan(0);
    expect(byNeed(oldest, unknown)).toBeLessThan(0);
  });

  it("breaks ties by run id so equal ages produce a stable order", () => {
    const first = run({ runId: "a", since: NOW });
    const second = run({ runId: "b", since: NOW });
    expect([second, first].sort(byNeed).map((r) => r.runId)).toEqual(["a", "b"]);
    expect([first, second].sort(byNeed).map((r) => r.runId)).toEqual(["a", "b"]);
  });
});

describe("bandForRun — snooze", () => {
  const snooze = { snoozedAt: NOW - 60_000, snoozedUntil: NOW + 900_000 };

  it("bands a snoozed run as snoozed rather than by what it is doing", () => {
    expect(bandForRun(run({ agentState: "waiting", snooze }))).toBe("snoozed");
  });

  it("keeps a snoozed run out of every demand band", () => {
    // The whole point: a snoozed run must stop counting as a demand no matter
    // how urgent its underlying state looks.
    for (const state of ["waiting", "completed", "working"] as const) {
      const band = bandForRun(run({ agentState: state, snooze }));
      expect(isDemandBand(band)).toBe(false);
    }
  });

  it("still bands an error-blocked run as snoozed when the user snoozed it", () => {
    expect(bandForRun(run({ agentState: "waiting", waitingReason: "error", snooze }))).toBe(
      "snoozed"
    );
  });

  it("lets a park outrank a snooze when a run somehow carries both", () => {
    const band = bandForRun(
      run({ agentState: "waiting", snooze, park: { parkedAt: NOW - 60_000 } })
    );
    expect(band).toBe("parked");
  });

  it("ranks snoozed below parked, agreeing with the precedence check", () => {
    // An ordering that disagreed with bandForRun's field-check order would be
    // invisible from either site alone.
    expect(FLEET_BANDS.indexOf("parked")).toBeLessThan(FLEET_BANDS.indexOf("snoozed"));
  });

  it("ranks snoozed above idle, so a shelved run outranks a dead one", () => {
    expect(FLEET_BANDS.indexOf("snoozed")).toBeLessThan(FLEET_BANDS.indexOf("idle"));
  });

  it("ranks snoozed below every demand band", () => {
    const snoozedIndex = FLEET_BANDS.indexOf("snoozed");
    for (const band of FLEET_BANDS.filter(isDemandBand)) {
      expect(FLEET_BANDS.indexOf(band)).toBeLessThan(snoozedIndex);
    }
  });

  it("bands an unsnoozed run exactly as before", () => {
    // Snooze is the only new demotion lever; nothing else may shift.
    expect(bandForRun(run({ agentState: "waiting" }))).toBe("needs-you");
    expect(bandForRun(run({ agentState: "working" }))).toBe("running");
  });

  it("gives the snoozed band its own label", () => {
    const label = bandLabel("snoozed", run());
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe(bandLabel("parked", run()));
    expect(label).not.toBe(bandLabel("idle", run()));
  });

  it("counts the snoozed band in an empty tally", () => {
    const counts = emptyBandCounts();
    // Every band must have a slot, or a snoozed run would increment undefined.
    for (const band of FLEET_BANDS) expect(counts[band]).toBe(0);
  });
});
