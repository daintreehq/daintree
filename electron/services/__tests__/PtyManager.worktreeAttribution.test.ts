/**
 * `PtyManager.updateWorktreeId` is where a renderer-side move becomes the
 * authoritative record the fleet palette groups by (#12060), and where the
 * ownership identity is checked.
 *
 * The check lands here rather than in main because this is the only place both
 * halves are known synchronously — naming the terminal's project in main would
 * have cost an await, and with it the FIFO ordering that makes two rapid moves
 * settle on the second one.
 */
import { describe, it, expect, vi } from "vitest";
import { PtyManager } from "../PtyManager.js";

function managerWith(record: { projectId?: string | null } | undefined) {
  const setWorktreeId = vi.fn();
  const terminal = record
    ? { getInfo: () => ({ projectId: record.projectId }), setWorktreeId }
    : undefined;
  const manager = Object.create(PtyManager.prototype) as PtyManager;
  Object.defineProperty(manager, "registry", {
    value: { get: (id: string) => (id === "t1" ? terminal : undefined) },
    configurable: true,
  });
  return { manager, setWorktreeId };
}

describe("PtyManager.updateWorktreeId", () => {
  it("writes the move onto the record when the sender owns the run", () => {
    const { manager, setWorktreeId } = managerWith({ projectId: "project-a" });

    manager.updateWorktreeId("t1", "/repo/.worktrees/feature", "project-a");

    expect(setWorktreeId).toHaveBeenCalledWith("/repo/.worktrees/feature");
  });

  it("refuses a move for a run owned by another project", () => {
    // The fleet snapshot pushes every run to every view, so a foreign terminal
    // id is always in reach. Without this the palette could report project B's
    // run paired with one of project A's worktrees.
    const { manager, setWorktreeId } = managerWith({ projectId: "project-b" });

    manager.updateWorktreeId("t1", "/project-a/.worktrees/feature", "project-a");

    expect(setWorktreeId).not.toHaveBeenCalled();
  });

  it("treats null as an identity, not a wildcard, in both directions", () => {
    // An unbound window (Cmd+N on the project picker) reaches its own
    // projectless terminals and nothing else; a project-owned sender must not
    // reach a projectless run either.
    const unbound = managerWith({ projectId: undefined });
    unbound.manager.updateWorktreeId("t1", "/repo", null);
    expect(unbound.setWorktreeId).toHaveBeenCalledWith("/repo");

    const owned = managerWith({ projectId: "project-a" });
    owned.manager.updateWorktreeId("t1", "/repo", null);
    expect(owned.setWorktreeId).not.toHaveBeenCalled();

    const projectless = managerWith({ projectId: undefined });
    projectless.manager.updateWorktreeId("t1", "/repo", "project-a");
    expect(projectless.setWorktreeId).not.toHaveBeenCalled();
  });

  it("carries an explicit clear through to the record", () => {
    const { manager, setWorktreeId } = managerWith({ projectId: "project-a" });

    manager.updateWorktreeId("t1", null, "project-a");

    expect(setWorktreeId).toHaveBeenCalledWith(null);
  });

  it("is a no-op for a run that has already gone", () => {
    // Never a synthetic record: the renderer store keeps the filing either way.
    const { manager, setWorktreeId } = managerWith(undefined);

    manager.updateWorktreeId("gone", "/repo", "project-a");

    expect(setWorktreeId).not.toHaveBeenCalled();
  });
});
