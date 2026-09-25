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
  Object.defineProperty(manager, "resizeHeldElsewhere", {
    value: new Set<string>(),
    writable: true,
    configurable: true,
  });
  return manager;
}

describe("PtyManager resize lease", () => {
  it("holds a terminal only while another client drives its project", () => {
    const manager = managerWith({ a1: "project-a", b1: "project-b", loose: null });
    expect(manager.isResizeHeldElsewhere("a1")).toBe(false);

    manager.setResizeHeldElsewhere(["project-a"]);
    expect(manager.isResizeHeldElsewhere("a1")).toBe(true);
    expect(manager.isResizeHeldElsewhere("b1")).toBe(false);
    expect(manager.isResizeHeldElsewhere("loose")).toBe(false);
    // Not spawned yet: no known project, so nothing to hold.
    expect(manager.isResizeHeldElsewhere("unknown")).toBe(false);

    manager.setResizeHeldElsewhere([]);
    expect(manager.isResizeHeldElsewhere("a1")).toBe(false);
  });
});
