import { describe, expect, it } from "vitest";
import { findCoordinationHold, type CoordinationHoldSources } from "../coordinationHolds.js";

function sources(overrides: Partial<CoordinationHoldSources> = {}): CoordinationHoldSources {
  const owners: Record<string, string> = { a1: "proj-a", a2: "proj-a", b1: "proj-b" };
  return {
    hasUnsettledScheduledRun: () => false,
    projectOfTerminal: (id) => owners[id] ?? null,
    waitingRunProjectIds: () => [],
    unseenHandBackRunIds: () => [],
    gatedParks: () => [],
    replyWaitTerminalIds: () => [],
    notifyProjectIds: () => [],
    ...overrides,
  };
}

describe("findCoordinationHold", () => {
  it("holds nothing when no source has pending work", () => {
    expect(findCoordinationHold("proj-a", sources())).toBeNull();
  });

  it("names an unsettled scheduled run in the project, and only that project", () => {
    const s = sources({ hasUnsettledScheduledRun: (projectId) => projectId === "proj-a" });
    expect(findCoordinationHold("proj-a", s)).toBe("scheduled-run");
    expect(findCoordinationHold("proj-b", s)).toBeNull();
  });

  it("names a waiting run in the project, and only that project", () => {
    const s = sources({ waitingRunProjectIds: () => ["proj-a"] });
    expect(findCoordinationHold("proj-a", s)).toBe("waiting-run");
    expect(findCoordinationHold("proj-b", s)).toBeNull();
  });

  it("names an unseen hand-back through its run's project", () => {
    const s = sources({ unseenHandBackRunIds: () => ["a1"] });
    expect(findCoordinationHold("proj-a", s)).toBe("unseen-hand-back");
    expect(findCoordinationHold("proj-b", s)).toBeNull();
  });

  it("protects both ends of a park gated across projects", () => {
    const s = sources({ gatedParks: () => [{ runId: "a1", gateRunId: "b1" }] });
    expect(findCoordinationHold("proj-a", s)).toBe("gated-park");
    expect(findCoordinationHold("proj-b", s)).toBe("gated-park");
  });

  it("names a reply wait through its bound terminal", () => {
    const s = sources({ replyWaitTerminalIds: () => ["b1"] });
    expect(findCoordinationHold("proj-b", s)).toBe("pending-reply-wait");
    expect(findCoordinationHold("proj-a", s)).toBeNull();
  });

  it("holds every project for a reply wait that has not bound", () => {
    const s = sources({ replyWaitTerminalIds: () => [undefined] });
    expect(findCoordinationHold("proj-a", s)).toBe("unattributed");
    expect(findCoordinationHold("proj-b", s)).toBe("unattributed");
  });

  it("holds every project for a record whose terminal has no known project", () => {
    const s = sources({ unseenHandBackRunIds: () => ["gone"] });
    expect(findCoordinationHold("proj-a", s)).toBe("unattributed");
  });

  it("prefers a named hold over an unattributed one", () => {
    const s = sources({
      unseenHandBackRunIds: () => ["gone"],
      notifyProjectIds: () => ["proj-a"],
    });
    expect(findCoordinationHold("proj-a", s)).toBe("queued-notify");
    expect(findCoordinationHold("proj-b", s)).toBe("unattributed");
  });
});
