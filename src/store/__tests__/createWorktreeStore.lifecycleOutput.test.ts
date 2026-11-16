import { describe, expect, it } from "vitest";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import type { WorktreeLifecycleStatus } from "@shared/types/worktree";

let seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: "lifecycle-output", seq: ++seq };
}

function makeSnapshot(
  lifecycleStatus: WorktreeLifecycleStatus,
  setupRun?: WorktreeLifecycleStatus
): WorktreeSnapshot {
  return {
    id: "wt-1",
    worktreeId: "wt-1",
    name: "wt-1",
    branch: "feature/x",
    path: "/repo/wt-1",
    isCurrent: false,
    isMainWorktree: false,
    lifecycleStatus,
    setupRun,
  };
}

const running: WorktreeLifecycleStatus = {
  phase: "setup",
  state: "running",
  commandIndex: 0,
  totalCommands: 2,
  currentCommand: "node scripts/link.mjs",
  startedAt: 1_000,
  commandStartedAt: 1_000,
  output: "Refreshing it with npm ci\n",
};

describe("createWorktreeStore — a running phase's live status (#17115)", () => {
  it("takes an update that only adds output", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot(running)], nextV());

    store
      .getState()
      .applyUpdate(
        makeSnapshot({ ...running, output: `${running.output}added 1200 packages\n` }),
        nextV()
      );

    expect(store.getState().worktrees.get("wt-1")?.lifecycleStatus?.output).toBe(
      "Refreshing it with npm ci\nadded 1200 packages\n"
    );
  });

  it("takes an update that only moves the command's start", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot(running)], nextV());

    store.getState().applyUpdate(makeSnapshot({ ...running, commandStartedAt: 4_000 }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.lifecycleStatus?.commandStartedAt).toBe(4_000);
  });

  it("takes an update that only adds the log's path", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot(running)], nextV());

    store.getState().applyUpdate(makeSnapshot({ ...running, logPath: "/logs/1.log" }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.lifecycleStatus?.logPath).toBe("/logs/1.log");
  });

  it("takes an update that only records a finished setup run", () => {
    const store = createWorktreeStore();
    const check: WorktreeLifecycleStatus = {
      phase: "resource-status",
      state: "success",
      startedAt: 9,
    };
    store.getState().applySnapshot([makeSnapshot(check)], nextV());

    const setupRun: WorktreeLifecycleStatus = { ...running, state: "success", completedAt: 5_000 };
    store.getState().applyUpdate(makeSnapshot(check, setupRun), nextV());

    expect(store.getState().worktrees.get("wt-1")?.setupRun).toEqual(setupRun);
  });

  it("keeps the row as it was for a copy of the same status", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot(running)], nextV());
    const row = store.getState().worktrees.get("wt-1");

    store.getState().applyUpdate(makeSnapshot({ ...running }), nextV());

    expect(store.getState().worktrees.get("wt-1")).toBe(row);
  });
});
