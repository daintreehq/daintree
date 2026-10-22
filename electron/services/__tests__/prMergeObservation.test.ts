import { describe, expect, it } from "vitest";
import type { PRMergeIntent } from "../../../shared/types/forge.js";
import {
  applyMergeObservation,
  sameMergeEpisode,
  type MergeObservation,
} from "../prMergeObservation.js";

const armed = (enabledAt: number): PRMergeIntent => ({
  kind: "auto-merge",
  method: "squash",
  enabledAt,
});
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

function observe(
  prior: MergeObservation | undefined,
  intent: PRMergeIntent | null | undefined,
  head: string | undefined
): MergeObservation {
  const next: MergeObservation = {};
  applyMergeObservation(next, prior, intent, head);
  return next;
}

describe("applyMergeObservation", () => {
  it("records the head an arming episode was first seen on", () => {
    expect(observe(undefined, armed(1), H1)).toEqual({
      mergeIntent: armed(1),
      armedHeadSha: H1,
      headMovedWhileArmed: undefined,
    });
  });

  it("flags a head that moves while the same episode stays armed, and keeps the flag", () => {
    const first = observe(undefined, armed(1), H1);
    const moved = observe(first, armed(1), H2);
    expect(moved.headMovedWhileArmed).toBe(true);
    expect(moved.armedHeadSha).toBe(H1);
    // Sticky: a later read on the new head doesn't make the unreviewed push go away.
    expect(observe(moved, armed(1), H2).headMovedWhileArmed).toBe(true);
  });

  it("continues the episode from armed into the merge queue", () => {
    const first = observe(undefined, armed(1), H1);
    const queued = observe(first, { kind: "queued", position: null }, H2);
    expect(queued.headMovedWhileArmed).toBe(true);
  });

  it("starts a new episode when auto-merge is re-armed", () => {
    const moved = observe(observe(undefined, armed(1), H1), armed(1), H2);
    const rearmed = observe(moved, armed(2), H2);
    expect(rearmed).toEqual({
      mergeIntent: armed(2),
      armedHeadSha: H2,
      headMovedWhileArmed: undefined,
    });
  });

  it("clears everything once nothing is pending", () => {
    const moved = observe(observe(undefined, armed(1), H1), armed(1), H2);
    expect(observe(moved, null, H2)).toEqual({
      mergeIntent: null,
      armedHeadSha: undefined,
      headMovedWhileArmed: undefined,
    });
  });

  it("keeps what was known when a read didn't carry the fields", () => {
    const first = observe(undefined, armed(1), H1);
    expect(observe(first, undefined, undefined)).toEqual(first);
  });
});

describe("sameMergeEpisode", () => {
  it("separates re-arms, continues into the queue, and lets an unreported read match", () => {
    expect(sameMergeEpisode(armed(1), armed(1))).toBe(true);
    expect(sameMergeEpisode(armed(1), armed(2))).toBe(false);
    expect(sameMergeEpisode(armed(1), { kind: "queued", position: null })).toBe(true);
    expect(sameMergeEpisode(armed(1), null)).toBe(false);
    expect(sameMergeEpisode(undefined, armed(1))).toBe(true);
  });
});
