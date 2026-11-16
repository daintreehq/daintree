import { describe, expect, it } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import { parkedPanelsEquivalent } from "../dockPanelParkedSnapshot";

function panel(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "p1",
    title: "Claude",
    kind: "terminal",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "dock",
    ...overrides,
  } as PtyPanelData;
}

describe("parkedPanelsEquivalent", () => {
  it("ignores everything the status buffer rewrites per frame", () => {
    const before = panel({ runtimeStatus: "running" });
    const after = panel({
      activityHeadline: "Reading",
      activityStatus: "working",
      activityType: "interactive",
      lastCommand: "ls",
      flowStatus: "paused-backpressure",
      flowStatusTimestamp: 5,
      heldDurationMs: 40,
      runtimeStatus: "paused-backpressure",
    });
    expect(parkedPanelsEquivalent(before, after)).toBe(true);
  });

  it("lets lifecycle through: an exit or an error is not churn", () => {
    expect(parkedPanelsEquivalent(panel(), panel({ runtimeStatus: "exited" }))).toBe(false);
    expect(parkedPanelsEquivalent(panel(), panel({ runtimeStatus: "error" }))).toBe(false);
    expect(
      parkedPanelsEquivalent(panel({ runtimeStatus: "exited" }), panel({ runtimeStatus: "error" }))
    ).toBe(true);
  });

  it("lets identity and configuration changes through", () => {
    expect(parkedPanelsEquivalent(panel(), panel({ title: "Renamed" }))).toBe(false);
    expect(parkedPanelsEquivalent(panel(), panel({ agentState: "working" }))).toBe(false);
    expect(parkedPanelsEquivalent(panel(), panel({ isRestarting: true }))).toBe(false);
    expect(parkedPanelsEquivalent(panel(), panel({ worktreeId: "wt-2" }))).toBe(false);
  });
});
