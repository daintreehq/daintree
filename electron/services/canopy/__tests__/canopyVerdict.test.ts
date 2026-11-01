import { describe, expect, it } from "vitest";
import type { FleetRunRow } from "../../../../shared/types/ipc/fleet.js";
import type { ClassifierResult } from "../canopyProviders.js";
import { newReadTrack } from "../canopyReads.js";
import { promptKey } from "../canopyScreen.js";
import {
  CANOPY_CLASSIFIER_ANCHORS,
  classifierPriority,
  observedKey,
  readingFloor,
  refinementOf,
  returnsToInbox,
  verdictOf,
  type RefinementInput,
} from "../canopyVerdict.js";

function run(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId: "a",
    workspaceId: "w",
    spawnedAt: 0,
    cwd: "/repo",
    agentState: "waiting",
    waitingReason: "question",
    ...overrides,
  };
}

function reading(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
  return {
    category: "question",
    confidence: 0.9,
    attention: 0.9,
    blocked: 0.95,
    question: "Which file should I edit?",
    status: null,
    ...overrides,
  };
}

function entry(observed: FleetRunRow, overrides: Partial<RefinementInput> = {}): RefinementInput {
  return {
    card: null,
    cleared: false,
    classified: reading(),
    evidence: {
      turn: 0,
      hash: "screen",
      state: observedKey(observed),
      question: "Which file should I edit?",
      status: null,
    },
    contentHash: "screen",
    reads: newReadTrack(),
    pending: false,
    readState: observedKey(observed),
    readAt: 1_000,
    ...overrides,
  };
}

describe("refinementOf", () => {
  it("refines nothing while Daintree has observed no state", () => {
    const observed = run({ agentState: undefined });
    expect(refinementOf(entry(observed), observed, null, 2_000)).toBeNull();
  });

  it("quotes the screen's own words for an ask read at a hand-back stop", () => {
    const observed = run({ agentState: "completed", waitingReason: undefined });
    expect(refinementOf(entry(observed), observed, null, 2_000)).toEqual({
      kind: "asked",
      quote: "Which file should I edit?",
      readAt: 1_000,
      seen: true,
    });
  });

  describe("an ask", () => {
    const stops = [
      run({ agentState: "completed", waitingReason: undefined }),
      run({ agentState: "waiting", waitingReason: undefined }),
      run({ agentState: "waiting", waitingReason: "prompt" }),
      run({ agentState: "waiting", waitingReason: "question" }),
      run({ agentState: "waiting", waitingReason: "approval" }),
    ];

    it("is read at any stop that could be asking, whatever wait the patterns named", () => {
      for (const observed of stops) {
        for (const category of ["question", "approval"] as const) {
          const input = entry(observed, { classified: reading({ category }) });
          expect(refinementOf(input, observed, null, 2_000)).toEqual({
            kind: "asked",
            quote: "Which file should I edit?",
            readAt: 1_000,
            seen: true,
          });
        }
      }
    });

    it("carries whether the user has read its turn", () => {
      const unread = { ...newReadTrack(), turn: 1, readTurn: 0 };
      for (const observed of stops) {
        const input = entry(observed, {
          reads: unread,
          evidence: { ...entry(observed).evidence!, turn: 1 },
        });
        expect(refinementOf(input, observed, null, 2_000)).toMatchObject({
          kind: "asked",
          seen: false,
        });
      }
      const marked = { ...newReadTrack(), markedUnreadAt: 500 };
      const observed = stops[4]!;
      expect(refinementOf(entry(observed, { reads: marked }), observed, null, 2_000)).toMatchObject(
        { seen: false }
      );
    });

    it("is never read at an error wait", () => {
      const observed = run({ agentState: "waiting", waitingReason: "error" });
      for (const category of ["question", "approval"] as const) {
        const input = entry(observed, { classified: reading({ category }) });
        expect(refinementOf(input, observed, null, 2_000)).toBeNull();
      }
    });

    it("is not taken from an unsure reading", () => {
      const observed = run({ agentState: "waiting", waitingReason: "approval" });
      const unsure = entry(observed, {
        classified: reading({ category: "approval", confidence: 0.49 }),
      });
      expect(refinementOf(unsure, observed, null, 2_000)).toBeNull();
      const sure = entry(observed, {
        classified: reading({ category: "approval", confidence: 0.5 }),
      });
      expect(refinementOf(sure, observed, null, 2_000)).toMatchObject({ kind: "asked" });
    });

    it("is not taken from a reading of the run at work", () => {
      const observed = run({ agentState: "waiting", waitingReason: "approval" });
      const input = entry(observed, { readState: "working:" });
      expect(refinementOf(input, observed, null, 2_000)).toBeNull();
    });

    it("needs the screen's own words for the ask", () => {
      const observed = run({ agentState: "waiting", waitingReason: "approval" });
      const input = entry(observed, { classified: reading({ category: "approval" }) });
      const evidence = { ...input.evidence!, question: "   " };
      expect(refinementOf({ ...input, evidence }, observed, null, 2_000)).toBeNull();
    });

    it("leaves an approval wait read as asking nothing to the free rules", () => {
      const observed = run({ agentState: "waiting", waitingReason: "approval" });
      const input = entry(observed, {
        classified: reading({ category: "finished", question: null }),
        evidence: { ...entry(observed).evidence!, question: null, status: "All tests pass." },
      });
      expect(refinementOf(input, observed, null, 2_000)).toBeNull();
    });
  });

  it("refines nothing when the reading has no quote from the screen", () => {
    const observed = run({ agentState: "completed", waitingReason: undefined });
    const input = entry(observed);
    const evidence = { ...input.evidence!, question: null };
    expect(refinementOf({ ...input, evidence }, observed, null, 2_000)).toBeNull();
  });

  describe("a reading taken in an earlier turn", () => {
    const observed = run({ agentState: "completed", waitingReason: undefined });
    const input = entry(observed, { reads: { ...newReadTrack(), turn: 1 } });

    it("refines nothing once the screen has moved", () => {
      const evidence = { ...input.evidence!, hash: "older" };
      expect(refinementOf({ ...input, evidence }, observed, null, 2_000)).toBeNull();
    });

    it("refines nothing once the observed state has moved", () => {
      const evidence = { ...input.evidence!, state: "working:" };
      expect(refinementOf({ ...input, evidence }, observed, null, 2_000)).toBeNull();
    });

    it("speaks for this turn while the screen and observed state are the ones it read", () => {
      expect(refinementOf(input, observed, null, 2_000)).toMatchObject({ kind: "asked" });
    });
  });

  it("refines nothing while a newer pass is in flight", () => {
    const observed = run({ agentState: "completed", waitingReason: undefined });
    expect(refinementOf(entry(observed, { pending: true }), observed, null, 2_000)).toBeNull();
  });

  describe("a question Daintree observed", () => {
    const observed = run();
    const finished = reading({ category: "finished", question: null });
    const input = entry(observed, {
      classified: finished,
      evidence: { ...entry(observed).evidence!, question: null, status: "All tests pass." },
    });

    it("is read as asking nothing, quoting the screen, and keeps the observed state", () => {
      const read = { ...newReadTrack(), turn: 1, readTurn: 1 };
      expect(refinementOf({ ...input, reads: read }, observed, null, 2_000)).toEqual({
        kind: "not-asking",
        quote: "All tests pass.",
        readAt: 1_000,
        seen: true,
      });
      expect(observed).toMatchObject({ agentState: "waiting", waitingReason: "question" });
    });

    it("carries whether the user has seen the turn", () => {
      const unread = { ...newReadTrack(), turn: 1, readTurn: 0 };
      expect(refinementOf({ ...input, reads: unread }, observed, null, 2_000)).toMatchObject({
        seen: false,
      });
    });

    it("is left alone by a reading of another wait", () => {
      expect(refinementOf({ ...input, readState: "completed:" }, observed, null, 2_000)).toBeNull();
    });
  });

  describe("a busy run", () => {
    const observed = run({ agentState: "working", waitingReason: undefined });
    const card = { activity: "Running the test suite", glance: { doing: null } };
    const input = entry(observed, { card } as Partial<RefinementInput>);

    it("is read as stalled from when its screen stood still, quoting what it shows", () => {
      expect(refinementOf(input, observed, 500, 2_000)).toEqual({
        kind: "stalled",
        quote: "Running the test suite",
        readAt: 2_000,
        stalledSince: 500,
      });
    });

    it("is not stalled while its screen moves, or once it is blank", () => {
      expect(refinementOf(input, observed, null, 2_000)).toBeNull();
      expect(refinementOf({ ...input, cleared: true }, observed, 500, 2_000)).toBeNull();
    });
  });
});

describe("returnsToInbox", () => {
  const prompt = "Overwrite the file?";

  it("keeps a run aside while its screen is unchanged", () => {
    const disposition = { contentHash: "same", question: null, sawWork: true };
    expect(returnsToInbox(disposition, "same", prompt)).toBe(false);
  });

  it("keeps a run aside when the same prompt is still drawn, however it is redrawn", () => {
    const disposition = { contentHash: "before", question: promptKey(prompt), sawWork: false };
    expect(returnsToInbox(disposition, "after", prompt)).toBe(false);
    expect(returnsToInbox(disposition, "after", "❯  OVERWRITE the   file?")).toBe(false);
    expect(returnsToInbox(disposition, "after", null)).toBe(false);
  });

  it("brings a run back for a different question, or a stop after work", () => {
    const asked = { contentHash: "before", question: promptKey(prompt), sawWork: false };
    expect(returnsToInbox(asked, "after", "Delete the branch?")).toBe(true);
    expect(returnsToInbox({ ...asked, sawWork: true }, "after", prompt)).toBe(true);
  });
});

describe("classifier ranking", () => {
  it("ranks a confident question at its anchor, and holds it as a floor", () => {
    const observed = run();
    expect(classifierPriority(reading(), observed)).toBe(CANOPY_CLASSIFIER_ANCHORS.question);
    expect(readingFloor(reading(), observed)).toBe(CANOPY_CLASSIFIER_ANCHORS.question);
  });

  it("ranks an unsure question as a finished turn", () => {
    expect(classifierPriority(reading({ confidence: 0.2 }), run())).toBe(
      CANOPY_CLASSIFIER_ANCHORS.finished
    );
  });

  it("gives the same verdict however the finer score drifts", () => {
    const observed = run();
    expect(verdictOf(reading({ attention: 0.91 }), observed)).toBe(
      verdictOf(reading({ attention: 0.97 }), observed)
    );
  });

  it("gives a busy run a new verdict once it reads as stuck", () => {
    const observed = run({ agentState: "working", waitingReason: undefined });
    const busy = (attention: number) => reading({ category: "working", question: null, attention });
    expect(verdictOf(busy(0.79), observed)).not.toBe(verdictOf(busy(0.81), observed));
  });
});
