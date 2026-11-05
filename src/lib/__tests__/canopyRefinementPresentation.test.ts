import { describe, expect, it } from "vitest";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import { canopyEvidence, canopyPlacementForRun } from "../canopyRefinementPresentation";

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

describe("canopyPlacementForRun", () => {
  const ASKED = { kind: "asked", quote: "Ship it?", readAt: NOW, seen: false } as const;
  const row = (runId: string, overrides: Partial<FleetRunRow> = {}): FleetRunRow => ({
    runId,
    workspaceId: "p1",
    spawnedAt: NOW - 60_000,
    cwd: "/repo",
    agentState: "waiting",
    waitingReason: "prompt",
    canopy: ASKED,
    ...overrides,
  });
  const fleet = (runs: FleetRunRow[]): FleetSnapshot => ({
    runs,
    changedAt: NOW,
    degraded: false,
    lastSuccessfulAt: NOW,
  });

  it("names the reading where it placed the run, and none where the agent's report, a park or nothing did", () => {
    const snapshot = fleet([
      row("canopy"),
      row("agent", { handbackReport: "needs-you" }),
      row("parked", { park: { parkedAt: NOW } }),
      row("plain", { canopy: undefined }),
      // A report the run has gone back to work past places nothing, so the
      // reading of a stall still speaks for it.
      row("working", {
        agentState: "working",
        waitingReason: undefined,
        handbackReport: "needs-you",
        canopy: { kind: "stalled", quote: "Compiling…", readAt: NOW, stalledSince: NOW - 1 },
      }),
    ]);
    expect(canopyPlacementForRun(snapshot, "canopy")).toBe(ASKED);
    expect(canopyPlacementForRun(snapshot, "agent")).toBeUndefined();
    expect(canopyPlacementForRun(snapshot, "parked")).toBeUndefined();
    expect(canopyPlacementForRun(snapshot, "plain")).toBeUndefined();
    expect(canopyPlacementForRun(snapshot, "working")?.kind).toBe("stalled");
    expect(canopyPlacementForRun(null, "canopy")).toBeUndefined();
  });
});
