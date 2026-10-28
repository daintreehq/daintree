import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";

vi.mock("@/utils/logger", () => ({ logInfo: vi.fn() }));

import {
  cancelDriveLeaseHold,
  clearPanelDriveLeaseMark,
  holdForDriveLease,
  isHeldForDriveLease,
  releaseDriveLeaseHolds,
  resetDriveLeaseHoldsForTesting,
  useDriveLeaseWaitStore,
} from "../driveLeaseWaitStore";
import {
  _resetTerminalInputGateForTesting,
  setDriveLeaseSnapshot,
} from "@/services/terminal/inputGate";

const heldPanels = () => Object.keys(useDriveLeaseWaitStore.getState().heldPanelIds);

function lease(drivingHere: boolean, projectId = "p1"): DriveLeaseView {
  return {
    projectId,
    holder: {
      leaseId: 1,
      endpointId: "view-2",
      clientId: "client-2",
      clientName: "studio-01",
      isHostLocal: true,
      acquiredAt: 1,
    },
    drivingHere,
    isHolderEndpoint: drivingHere,
    viewerIsHostLocal: false,
  };
}

beforeEach(() => {
  _resetTerminalInputGateForTesting();
  setDriveLeaseSnapshot(lease(false));
});

afterEach(() => {
  resetDriveLeaseHoldsForTesting();
  _resetTerminalInputGateForTesting();
});

describe("drive lease holds", () => {
  it("marks a held pane and resumes it once this view drives its project", () => {
    const resume = vi.fn();
    holdForDriveLease("a", { projectId: "p1", resume });
    expect(heldPanels()).toEqual(["a"]);

    setDriveLeaseSnapshot(lease(false));
    setDriveLeaseSnapshot(lease(true));

    expect(resume).toHaveBeenCalledTimes(1);
    // Still marked while its launch is queued; the launch clears it.
    expect(isHeldForDriveLease("a")).toBe(true);
    clearPanelDriveLeaseMark("a");
    expect(heldPanels()).toEqual([]);
  });

  it("resumes each hold once, whatever the lease does next", () => {
    const resume = vi.fn();
    holdForDriveLease("a", { projectId: "p1", resume });

    setDriveLeaseSnapshot(lease(true));
    setDriveLeaseSnapshot({ ...lease(true), holder: { ...lease(true).holder!, leaseId: 2 } });

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("leaves a hold for another project waiting", () => {
    const resume = vi.fn();
    holdForDriveLease("a", { projectId: "p2", resume });

    setDriveLeaseSnapshot(lease(true, "p1"));

    expect(resume).not.toHaveBeenCalled();
    expect(isHeldForDriveLease("a")).toBe(true);
  });

  it("resumes in the order the launches were held", () => {
    const order: string[] = [];
    holdForDriveLease("a", { projectId: "p1", resume: () => order.push("a") });
    holdForDriveLease("b", { projectId: "p1", resume: () => order.push("b") });

    setDriveLeaseSnapshot(lease(true));

    expect(order).toEqual(["a", "b"]);
  });

  it("drops a stale hold without resuming it", () => {
    const resume = vi.fn();
    holdForDriveLease("a", { projectId: "p1", resume, isStale: () => true });

    setDriveLeaseSnapshot(lease(true));

    expect(resume).not.toHaveBeenCalled();
    expect(heldPanels()).toEqual([]);
  });

  it("keeps a deferred hold until it is released again", () => {
    const resume = vi.fn();
    let deferred = true;
    holdForDriveLease("a", { projectId: "p1", resume, isDeferred: () => deferred });

    setDriveLeaseSnapshot(lease(true));
    expect(resume).not.toHaveBeenCalled();

    deferred = false;
    releaseDriveLeaseHolds();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("cancels a hold without resuming it", () => {
    const resume = vi.fn();
    holdForDriveLease("a", { projectId: "p1", resume });

    expect(cancelDriveLeaseHold("a")).toBe(true);
    expect(cancelDriveLeaseHold("a")).toBe(false);
    setDriveLeaseSnapshot(lease(true));

    expect(resume).not.toHaveBeenCalled();
    expect(heldPanels()).toEqual([]);
  });

  it("replaces a pane's earlier hold", () => {
    const first = vi.fn();
    const second = vi.fn();
    holdForDriveLease("a", { projectId: "p1", resume: first });
    holdForDriveLease("a", { projectId: "p1", resume: second });

    setDriveLeaseSnapshot(lease(true));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("hears the lease again for a hold made after every earlier one was cancelled", () => {
    const resume = vi.fn();
    holdForDriveLease("a", { projectId: "p1", resume });
    cancelDriveLeaseHold("a");

    // A later hold subscribes afresh and still hears the lease.
    const later = vi.fn();
    holdForDriveLease("b", { projectId: "p1", resume: later });
    setDriveLeaseSnapshot(lease(true));

    expect(resume).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);
  });
});
