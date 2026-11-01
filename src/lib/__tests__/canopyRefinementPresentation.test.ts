import { describe, expect, it } from "vitest";
import { canopyEvidence } from "../canopyRefinementPresentation";

const NOW = 1_700_000_000_000;

describe("canopyEvidence", () => {
  it("quotes the question and says who read it, and when", () => {
    expect(
      canopyEvidence(
        {
          kind: "asked",
          quote: "Should I also migrate the tests?",
          readAt: NOW - 3 * 60_000,
          seen: false,
        },
        NOW
      )
    ).toBe('Asked: "Should I also migrate the tests?" · read by Canopy 3m ago');
  });

  it("names each kind of reading by what it saw", () => {
    const stalled = canopyEvidence(
      { kind: "stalled", quote: "Running tests", readAt: NOW, stalledSince: NOW - 600_000 },
      NOW
    );
    const notAsking = canopyEvidence(
      { kind: "not-asking", quote: "Done.", readAt: NOW, seen: false },
      NOW
    );
    expect(stalled.startsWith('Screen unchanged: "Running tests"')).toBe(true);
    expect(notAsking.startsWith('Not asking: "Done."')).toBe(true);
    expect(notAsking.endsWith("read by Canopy just now")).toBe(true);
  });

  it("cuts a long quote short with an ellipsis rather than spilling the screen line", () => {
    const text = canopyEvidence(
      { kind: "asked", quote: "x".repeat(400), readAt: NOW, seen: false },
      NOW
    );
    const quoted = /"(.*)"/.exec(text)?.[1] ?? "";
    expect(quoted.length).toBeLessThan(400);
    expect(quoted.endsWith("…")).toBe(true);
  });
});
