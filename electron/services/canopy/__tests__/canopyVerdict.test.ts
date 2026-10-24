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
  return { id: "a", agentState: "waiting", waitingReason: "question", ...overrides } as FleetRunRow;
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
    });
  });

  it("refines nothing when the reading has no quote from the screen", () => {
    const observed = run({ agentState: "completed", waitingReason: undefined });
    const input = entry(observed);
    const evidence = { ...input.evidence!, question: null };
    expect(refinementOf({ ...input, evidence }, observed, null, 2_000)).toBeNull();
  });

  it("refines nothing from a reading of an earlier turn on another screen", () => {
    const observed = run({ agentState: "completed", waitingReason: undefined });
    const input = entry(observed);
    const evidence = { ...input.evidence!, turn: 1, hash: "older" };
    expect(refinementOf({ ...input, evidence }, observed, null, 2_000)).toBeNull();
  });

  it("refines nothing while a newer pass is in flight", () => {
    const observed = run({ agentState: "completed", waitingReason: undefined });
    expect(refinementOf(entry(observed, { pending: true }), observed, null, 2_000)).toBeNull();
  });
});

describe("returnsToInbox", () => {
  const prompt = "Overwrite the file?";

  it("keeps a run aside while its screen is unchanged", () => {
    const disposition = { contentHash: "same", question: null, sawWork: true };
    expect(returnsToInbox(disposition, "same", prompt)).toBe(false);
  });

  it("keeps a run aside when the same prompt is still drawn", () => {
    const disposition = { contentHash: "before", question: promptKey(prompt), sawWork: false };
    expect(returnsToInbox(disposition, "after", prompt)).toBe(false);
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
});
