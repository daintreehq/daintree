import { describe, it, expect } from "vitest";
import { PtyManager } from "../PtyManager.js";

function managerWith(projects: Record<string, string | null | undefined>) {
  const manager = Object.create(PtyManager.prototype) as PtyManager;
  Object.defineProperty(manager, "registry", {
    value: {
      get: (id: string) =>
        id in projects ? { getInfo: () => ({ projectId: projects[id] }) } : undefined,
    },
    configurable: true,
  });
  Object.defineProperty(manager, "driveLeases", {
    value: new Map(),
    writable: true,
    configurable: true,
  });
  return manager;
}

const LOCAL_WINDOW = 3;
const HOLDER = -7;
const OTHER_REMOTE = -9;

describe("PtyManager drive lease", () => {
  it("arbitrates nothing until a lease names the project", () => {
    const manager = managerWith({ a1: "project-a", loose: null });
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(true);
    manager.setDriveLeases([{ projectId: "project-b", leaseId: 1, holderConnection: HOLDER }]);
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(true);
    // No known project: not spawned yet, or never filed.
    expect(manager.mayDriveFrom("loose", OTHER_REMOTE)).toBe(true);
    expect(manager.mayDriveFrom("unknown", OTHER_REMOTE)).toBe(true);
  });

  it("lets only the remote holder's connection drive, including this machine's windows", () => {
    const manager = managerWith({ a1: "project-a" });
    manager.setDriveLeases([{ projectId: "project-a", leaseId: 5, holderConnection: HOLDER }]);
    expect(manager.mayDriveFrom("a1", HOLDER, 5)).toBe(true);
    expect(manager.mayDriveFrom("a1", HOLDER)).toBe(true);
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(false);
    expect(manager.mayDriveFrom("a1", LOCAL_WINDOW)).toBe(false);
  });

  it("lets every local window drive when this machine holds, and no remote port", () => {
    const manager = managerWith({ a1: "project-a" });
    manager.setDriveLeases([{ projectId: "project-a", leaseId: 5, holderConnection: null }]);
    expect(manager.mayDriveFrom("a1", LOCAL_WINDOW)).toBe(true);
    expect(manager.mayDriveFrom("a1", LOCAL_WINDOW + 1)).toBe(true);
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(false);
  });

  it("refuses work stamped with a lease a takeover replaced, and trusts a newer one", () => {
    const manager = managerWith({ a1: "project-a" });
    manager.setDriveLeases([{ projectId: "project-a", leaseId: 5, holderConnection: HOLDER }]);
    // Queued before the takeover that produced lease 5.
    expect(manager.mayDriveFrom("a1", HOLDER, 4)).toBe(false);
    // Main granted lease 6 to another endpoint; the table has yet to hear.
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE, 6)).toBe(true);

    manager.setDriveLeases([]);
    expect(manager.mayDriveFrom("a1", OTHER_REMOTE)).toBe(true);
  });
});
