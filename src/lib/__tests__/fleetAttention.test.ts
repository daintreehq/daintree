import { describe, it, expect } from "vitest";
import {
  ATTENTION_FILTER_BANDS,
  bandForRun,
  bandLabel,
  bandTimestamp,
  compareWithinBand,
  DEMAND_BANDS,
  emptyBandCounts,
  FLEET_BANDS,
  fleetBandRunKey,
  isAttentionBand,
  isDemandBand,
  UNREAD_FILTER_BANDS,
} from "../fleetAttention";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";

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
  it("reads an error wait as blocked and an unread ask wait no reading placed as review", () => {
    expect(bandForRun(run({ agentState: "waiting", waitingReason: "error" }))).toBe("blocked");
    for (const waitingReason of ["question", "approval"] as const) {
      // The patterns' guess is news, never a demand: no reading, no amber.
      expect(bandForRun(run({ agentState: "waiting", waitingReason }))).toBe("review");
      const unseen = run({ agentState: "waiting", waitingReason, wait: { stoppedAt: NOW } });
      expect(bandForRun(unseen)).toBe("review");
    }
  });

  it("lands an ask wait no reading placed where an idle run does once looked at", () => {
    for (const waitingReason of ["question", "approval"] as const) {
      const looked = run({
        agentState: "waiting",
        waitingReason,
        wait: { stoppedAt: NOW - 60_000, seenAt: NOW - 30_000 },
      });
      // Never done: it hasn't finished anything.
      expect(bandForRun(looked)).toBe("idle");
    }
    // A wait's seen mark is no excuse for an error.
    const error = run({
      agentState: "waiting",
      waitingReason: "error",
      wait: { stoppedAt: NOW - 60_000, seenAt: NOW - 30_000 },
    });
    expect(bandForRun(error)).toBe("blocked");
  });

  it("reads a stop with no watched work before it as idle, not a demand", () => {
    // Sitting at a prompt asks nothing; only a wait that names what it wants is
    // the agent waiting on the user. A finish main never saw the work for has
    // handed nothing back either.
    for (const waitingReason of [undefined, "prompt"] as const) {
      const band = bandForRun(run({ agentState: "waiting", waitingReason }));
      expect(band).toBe("idle");
      expect(isDemandBand(band)).toBe(false);
    }
    expect(bandForRun(run({ agentState: "completed", since: NOW }))).toBe("idle");
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
    const asking = run({ agentState: "waiting", waitingReason: "question" });
    const handedBack = run({ agentState: "waiting", handBack: { stoppedAt: NOW - 60_000 } });
    for (const row of [asking, handedBack]) {
      expect(isDemandBand(bandForRun(row))).toBe(true);
      const band = bandForRun({ ...row, park: { parkedAt: NOW } });
      expect(band).toBe("parked");
      expect(isDemandBand(band)).toBe(false);
    }
  });

  it("ranks parked below every live band but above idle", () => {
    const rank = (band: (typeof FLEET_BANDS)[number]) => FLEET_BANDS.indexOf(band);
    for (const live of ["blocked", "needs-you", "review", "running", "done"] as const) {
      expect(rank("parked")).toBeGreaterThan(rank(live));
    }
    expect(rank("parked")).toBeLessThan(rank("idle"));
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

  it("stops calling a seen hand-back ready for review", () => {
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
    const unseen = { stoppedAt: NOW - 60_000 };
    for (const row of [
      run({ agentState: "waiting", waitingReason: "question" }),
      run({ agentState: "waiting", handBack: unseen }),
      run({ agentState: "completed", handBack: unseen }),
    ]) {
      expect(isDemandBand(bandForRun(row))).toBe(true);
      const band = bandForRun({ ...row, snooze });
      expect(band).toBe("snoozed");
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

  it("gives the snoozed band its own label", () => {
    const label = bandLabel("snoozed", run());
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe(bandLabel("parked", run()));
    expect(label).not.toBe(bandLabel("idle", run()));
  });
});

describe("watched hand-backs", () => {
  const unseen = { stoppedAt: NOW - 60_000 };
  const seen = { stoppedAt: NOW - 60_000, seenAt: NOW - 30_000 };

  it("bands a generic wait after a watched hand-back by whether it was seen", () => {
    expect(bandForRun(run({ agentState: "waiting", handBack: unseen }))).toBe("review");
    expect(
      bandForRun(run({ agentState: "waiting", waitingReason: "prompt", handBack: seen }))
    ).toBe("done");
  });

  it("bands a completion by its own hand-back's seen state", () => {
    expect(bandForRun(run({ agentState: "completed", since: NOW, handBack: unseen }))).toBe(
      "review"
    );
    expect(bandForRun(run({ agentState: "completed", since: NOW, handBack: seen }))).toBe("done");
  });

  it("reads an unseen hand-back marked unread again as review", () => {
    const remarked = { ...seen, markedUnreadAt: NOW };
    expect(bandForRun(run({ agentState: "waiting", handBack: remarked }))).toBe("review");
  });

  it("never lets a hand-back speak for an ask wait or a run back at work", () => {
    // The record is an earlier stop's: its seen mark says nothing of this wait.
    for (const waitingReason of ["approval", "question"] as const) {
      expect(bandForRun(run({ agentState: "waiting", waitingReason, handBack: seen }))).toBe(
        "review"
      );
    }
    expect(bandForRun(run({ agentState: "waiting", waitingReason: "error", handBack: seen }))).toBe(
      "blocked"
    );
    expect(bandForRun(run({ agentState: "working", handBack: seen }))).toBe("running");
  });

  it("dates a hand-back's band from the stop, not the slide after it", () => {
    const row = run({ agentState: "waiting", since: NOW, handBack: unseen });
    expect(bandTimestamp(row, bandForRun(row))).toBe(unseen.stoppedAt);
  });
});

describe("Canopy refinements", () => {
  const ASKED = {
    kind: "asked",
    quote: "Want me to update the tests too?",
    readAt: NOW,
    seen: false,
  } as const;
  const NOT_ASKING = {
    kind: "not-asking",
    quote: "All 14 tests pass.",
    readAt: NOW,
    seen: false,
  } as const;
  const STALLED = {
    kind: "stalled",
    quote: "Waiting for background terminal",
    readAt: NOW,
    stalledSince: NOW - 15 * 60_000,
  } as const;

  const ASKING_STOPS = [
    { agentState: "completed" },
    { agentState: "waiting" },
    { agentState: "waiting", waitingReason: "prompt" },
    { agentState: "waiting", waitingReason: "question" },
    { agentState: "waiting", waitingReason: "approval" },
  ] as const;

  it("puts a stop Canopy read asking in needs-you, whatever wait the patterns named", () => {
    for (const handBack of [
      { stoppedAt: NOW - 60_000 },
      { stoppedAt: NOW - 60_000, seenAt: NOW - 30_000 },
      undefined,
    ]) {
      for (const stop of ASKING_STOPS) {
        const row = run({ ...stop, ...(handBack ? { handBack } : {}), canopy: ASKED });
        expect(bandForRun(row)).toBe("needs-you");
      }
    }
  });

  it("lands an ask the user has read where an idle run does, never done", () => {
    const read = { ...ASKED, seen: true };
    for (const handBack of [
      { stoppedAt: NOW - 60_000 },
      { stoppedAt: NOW - 60_000, seenAt: NOW - 30_000 },
      undefined,
    ]) {
      for (const stop of ASKING_STOPS) {
        const row = run({ ...stop, ...(handBack ? { handBack } : {}), canopy: read });
        expect(bandForRun(row)).toBe("idle");
      }
    }
    // A new ask on a later turn is unread again, and amber again.
    expect(
      bandForRun(run({ agentState: "waiting", waitingReason: "approval", canopy: ASKED }))
    ).toBe("needs-you");
  });

  it("only ever puts a run in needs-you on an unread Canopy ask", () => {
    const states = [
      ...ASKING_STOPS,
      { agentState: "waiting", waitingReason: "error" },
      { agentState: "working" },
      { agentState: "directing" },
      { agentState: "idle" },
      { agentState: "exited" },
    ] as const;
    const handBacks = [undefined, { stoppedAt: NOW - 60_000 }];
    const waits = [undefined, { stoppedAt: NOW - 60_000 }];
    for (const state of states) {
      for (const handBack of handBacks) {
        for (const wait of waits) {
          for (const canopy of [undefined, NOT_ASKING, STALLED, { ...ASKED, seen: true }]) {
            const row = run({
              ...state,
              ...(handBack ? { handBack } : {}),
              ...(wait ? { wait } : {}),
              ...(canopy ? { canopy } : {}),
            });
            expect(bandForRun(row)).not.toBe("needs-you");
          }
        }
      }
    }
  });

  it("never lets an ask clear an error wait", () => {
    const row = run({ agentState: "waiting", waitingReason: "error", canopy: ASKED });
    expect(bandForRun(row)).toBe("blocked");
  });

  it("leaves the user's own decisions above an ask", () => {
    const asking = { agentState: "completed", canopy: ASKED } as const;
    expect(bandForRun(run({ ...asking, park: { parkedAt: NOW } }))).toBe("parked");
    expect(bandForRun(run({ ...asking, snooze: { snoozedAt: NOW } }))).toBe("snoozed");
  });

  it("drops an ask held from a turn the run has since left", () => {
    expect(bandForRun(run({ agentState: "working", canopy: ASKED }))).toBe("running");
  });

  it("clears a question wait that asks nothing into a stop of its own, unseen until its turn is read", () => {
    // A question wait is never recorded as a hand-back: on a run's first turn
    // there is no record at all, and that is not a stop that handed nothing back.
    const wait = {
      agentState: "waiting",
      waitingReason: "question",
      since: NOW - 2_000,
      canopy: NOT_ASKING,
    } as const;
    expect(bandForRun(run(wait))).toBe("review");
    expect(bandTimestamp(run(wait), "review")).toBe(NOW - 2_000);
    const read = run({ ...wait, canopy: { ...NOT_ASKING, seen: true } });
    expect(bandForRun(read)).toBe("done");
    expect(bandTimestamp(read, "done")).toBe(NOW - 2_000);
  });

  it("never lets an earlier stop's read mark speak for a question wait that asks nothing", () => {
    // Later turns carry the record of the stop before, seen before this wait began.
    const earlier = { stoppedAt: NOW - 60 * 60_000, seenAt: NOW - 50 * 60_000 };
    const wait = run({
      agentState: "waiting",
      waitingReason: "question",
      since: NOW - 2_000,
      handBack: earlier,
      canopy: NOT_ASKING,
    });
    expect(bandForRun(wait)).toBe("review");
    // Dated from this wait, not the old stop.
    expect(bandTimestamp(wait, "review")).toBe(NOW - 2_000);
    // Nor does an earlier stop left unseen hold back a turn the user has read.
    const read = run({
      agentState: "waiting",
      waitingReason: "question",
      handBack: { stoppedAt: NOW - 60 * 60_000 },
      canopy: { ...NOT_ASKING, seen: true },
    });
    expect(bandForRun(read)).toBe("done");
  });

  it("leaves the user's own decisions above a question wait that asks nothing", () => {
    const wait = { agentState: "waiting", waitingReason: "question", canopy: NOT_ASKING } as const;
    expect(bandForRun(run({ ...wait, park: { parkedAt: NOW } }))).toBe("parked");
    expect(bandForRun(run({ ...wait, snooze: { snoozedAt: NOW } }))).toBe("snoozed");
  });

  it("never lets a reading that asks nothing clear an approval or an error", () => {
    for (const waitingReason of ["approval", "error"] as const) {
      const observed = bandForRun(run({ agentState: "waiting", waitingReason }));
      expect(bandForRun(run({ agentState: "waiting", waitingReason, canopy: NOT_ASKING }))).toBe(
        observed
      );
    }
  });

  it("flags a stalled working run quiet and dates it from the stall", () => {
    const row = run({ agentState: "working", since: NOW - 60 * 60_000, canopy: STALLED });
    expect(bandForRun(row)).toBe("quiet");
    expect(bandTimestamp(row, "quiet")).toBe(STALLED.stalledSince);
  });

  it("keeps Daintree's own silence as the clock when it already called the run quiet", () => {
    const row = run({ agentState: "working", quietSince: NOW - 5 * 60_000, canopy: STALLED });
    expect(bandForRun(row)).toBe("quiet");
    expect(bandTimestamp(row, "quiet")).toBe(NOW - 5 * 60_000);
  });
});

describe("Canopy asks keep their age", () => {
  it("dates an ask on a hand-back from the stop, through the slide into a prompt wait", () => {
    const canopy = { kind: "asked", quote: "Ship it?", readAt: NOW, seen: false } as const;
    const handBack = { stoppedAt: NOW - 10 * 60_000 };
    const completed = run({ agentState: "completed", since: NOW - 10 * 60_000, handBack, canopy });
    const slid = run({
      agentState: "waiting",
      waitingReason: "prompt",
      since: NOW,
      handBack,
      canopy,
    });
    expect(bandTimestamp(completed, "needs-you")).toBe(handBack.stoppedAt);
    expect(bandTimestamp(slid, "needs-you")).toBe(handBack.stoppedAt);
    // An ask read on a wait the patterns named is its own stop: an earlier
    // hand-back the run carries is not when it began.
    const observed = run({
      agentState: "waiting",
      waitingReason: "question",
      since: NOW - 5_000,
      handBack,
      canopy,
    });
    expect(bandTimestamp(observed, "needs-you")).toBe(NOW - 5_000);
    const tracked = run({ ...observed, wait: { stoppedAt: NOW - 8_000 } });
    expect(bandTimestamp(tracked, "needs-you")).toBe(NOW - 8_000);
  });

  it("dates an ask wait no reading placed from its own stop, never an earlier hand-back", () => {
    const row = run({
      agentState: "waiting",
      waitingReason: "approval",
      since: NOW - 5_000,
      handBack: { stoppedAt: NOW - 60 * 60_000 },
      wait: { stoppedAt: NOW - 8_000 },
    });
    expect(bandForRun(row)).toBe("review");
    expect(bandTimestamp(row, "review")).toBe(NOW - 8_000);
    const { wait: _wait, ...untracked } = row;
    expect(bandTimestamp(untracked, "review")).toBe(NOW - 5_000);
  });
});

describe("fleetBandRunKey", () => {
  function snapshot(runs: FleetRunRow[]): FleetSnapshot {
    return { runs, changedAt: NOW, degraded: false, lastSuccessfulAt: NOW };
  }

  const unseen = { stoppedAt: NOW - 60_000 };
  const seen = { stoppedAt: NOW - 60_000, seenAt: NOW - 30_000 };
  const fleet = snapshot([
    run({ runId: "approval", agentState: "waiting", waitingReason: "approval" }),
    run({ runId: "error", agentState: "waiting", waitingReason: "error" }),
    run({ runId: "unread", agentState: "completed", handBack: unseen }),
    run({ runId: "read", agentState: "waiting", handBack: seen }),
    run({ runId: "bare-prompt", agentState: "waiting", waitingReason: "prompt" }),
    run({
      runId: "parked-ask",
      agentState: "waiting",
      waitingReason: "question",
      park: { parkedAt: NOW },
    }),
    run({
      runId: "snoozed-hand-back",
      agentState: "waiting",
      handBack: unseen,
      snooze: { snoozedAt: NOW - 60_000, snoozedUntil: NOW + 900_000 },
    }),
    run({
      runId: "canopy-ask",
      agentState: "completed",
      handBack: seen,
      canopy: { kind: "asked", quote: "Ship it?", readAt: NOW, seen: false },
    }),
    run({
      runId: "canopy-approval",
      agentState: "waiting",
      waitingReason: "approval",
      canopy: { kind: "asked", quote: "Run npm test?", readAt: NOW, seen: false },
    }),
    run({
      runId: "read-ask",
      agentState: "waiting",
      waitingReason: "question",
      canopy: { kind: "asked", quote: "Ship it?", readAt: NOW, seen: true },
    }),
    run({
      runId: "looked-approval",
      agentState: "waiting",
      waitingReason: "approval",
      wait: { stoppedAt: NOW - 60_000, seenAt: NOW - 30_000 },
    }),
    run({ runId: "working", agentState: "working" }),
  ]);

  it("holds Canopy's unread asks for Attention, and unread hand-backs and waits for Unread", () => {
    expect(fleetBandRunKey(fleet, ATTENTION_FILTER_BANDS).split("\n")).toEqual([
      "canopy-approval",
      "canopy-ask",
      "error",
    ]);
    expect(fleetBandRunKey(fleet, UNREAD_FILTER_BANDS).split("\n")).toEqual(["approval", "unread"]);
  });

  it("splits the demands between the two with nothing shared or left over", () => {
    const attention = fleetBandRunKey(fleet, ATTENTION_FILTER_BANDS).split("\n");
    const unread = fleetBandRunKey(fleet, UNREAD_FILTER_BANDS).split("\n");
    expect(attention.filter((id) => unread.includes(id))).toEqual([]);
    expect(fleetBandRunKey(fleet, DEMAND_BANDS).split("\n")).toEqual(
      [...attention, ...unread].sort()
    );
  });

  it("holds nobody before the first snapshot", () => {
    expect(fleetBandRunKey(null, ATTENTION_FILTER_BANDS)).toBe("");
    expect(fleetBandRunKey(snapshot([]), UNREAD_FILTER_BANDS)).toBe("");
  });

  it("reads the same set from a new snapshot in a different order", () => {
    const reordered = snapshot([...fleet.runs].reverse());
    expect(fleetBandRunKey(reordered, ATTENTION_FILTER_BANDS)).toBe(
      fleetBandRunKey(fleet, ATTENTION_FILTER_BANDS)
    );
  });

  it("drops a hand-back from Unread once it is seen, and takes it back when marked unread", () => {
    const one = (handBack: FleetRunRow["handBack"]) =>
      fleetBandRunKey(
        snapshot([run({ runId: "t1", agentState: "waiting", handBack })]),
        UNREAD_FILTER_BANDS
      );
    expect(one(unseen)).toBe("t1");
    expect(one(seen)).toBe("");
    expect(one({ ...seen, markedUnreadAt: NOW })).toBe("t1");
  });
});
