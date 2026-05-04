import { describe, it, expect } from "vitest";
import {
  progressReducer,
  getStageLabel,
  type ProgressState,
  type ItemStatus,
} from "../bulkCreateReducer";

function emptyState(): ProgressState {
  return { phase: "idle", total: 0, items: new Map() };
}

function makeStatus(overrides: Partial<ItemStatus> = {}): ItemStatus {
  return { stage: "pending", attempt: 0, ...overrides };
}

describe("progressReducer", () => {
  it("START initializes items from empty state", () => {
    const next = progressReducer(emptyState(), { type: "START", issueNumbers: [1, 2] });
    expect(next.phase).toBe("executing");
    expect(next.total).toBe(2);
    expect(next.items.size).toBe(2);
    expect(next.items.get(1)!.stage).toBe("pending");
    expect(next.items.get(2)!.stage).toBe("pending");
  });

  it("START preserves succeeded items from previous run", () => {
    const prev = emptyState();
    prev.items.set(1, makeStatus({ stage: "succeeded" }));
    const next = progressReducer(prev, { type: "START", issueNumbers: [1, 2] });
    expect(next.items.get(1)!.stage).toBe("succeeded");
    expect(next.items.get(2)!.stage).toBe("pending");
  });

  it("START resets non-succeeded items", () => {
    const prev = emptyState();
    prev.items.set(1, makeStatus({ stage: "failed" }));
    const next = progressReducer(prev, { type: "START", issueNumbers: [1] });
    expect(next.items.get(1)!.stage).toBe("pending");
  });

  it("ITEM_WORKTREE_CREATING updates stage and attempt", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, { type: "ITEM_WORKTREE_CREATING", issueNumber: 1, attempt: 1 });
    expect(state.items.get(1)!.stage).toBe("worktree-creating");
    expect(state.items.get(1)!.attempt).toBe(1);
  });

  it("ITEM_WORKTREE_CREATED stores worktree info", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, {
      type: "ITEM_WORKTREE_CREATED",
      issueNumber: 1,
      worktreeId: "wt-1",
      worktreePath: "/path/1",
      branch: "feature/1",
    });
    const item = state.items.get(1)!;
    expect(item.stage).toBe("worktree-created");
    expect(item.worktreeId).toBe("wt-1");
    expect(item.worktreePath).toBe("/path/1");
    expect(item.resolvedBranch).toBe("feature/1");
  });

  it("ITEM_TERMINALS_SPAWNING updates stage", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, { type: "ITEM_TERMINALS_SPAWNING", issueNumber: 1 });
    expect(state.items.get(1)!.stage).toBe("terminals-spawning");
  });

  it("ITEM_TERMINALS_RESULT with failures sets terminals-error", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, {
      type: "ITEM_TERMINALS_RESULT",
      issueNumber: 1,
      spawnedTerminalIds: ["t1"],
      failedTerminalIndices: [0],
    });
    const item = state.items.get(1)!;
    expect(item.stage).toBe("terminals-error");
    expect(item.failedTerminalIndices).toEqual([0]);
    expect(item.spawnedTerminalIds).toContain("t1");
    expect(item.error).toContain("1 terminal(s) failed");
  });

  it("ITEM_TERMINALS_RESULT success returns to worktree-created", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    // Start from a state that has been through the flow
    state = progressReducer(state, { type: "ITEM_WORKTREE_CREATING", issueNumber: 1, attempt: 1 });
    state = progressReducer(state, {
      type: "ITEM_TERMINALS_RESULT",
      issueNumber: 1,
      spawnedTerminalIds: ["t1"],
      failedTerminalIndices: [],
    });
    expect(state.items.get(1)!.stage).toBe("worktree-created");
    expect(state.items.get(1)!.spawnedTerminalIds).toEqual(["t1"]);
  });

  it("ITEM_TERMINALS_RESULT accumulates spawned IDs across calls", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, {
      type: "ITEM_TERMINALS_RESULT",
      issueNumber: 1,
      spawnedTerminalIds: ["t1"],
      failedTerminalIndices: [],
    });
    state = progressReducer(state, {
      type: "ITEM_TERMINALS_RESULT",
      issueNumber: 1,
      spawnedTerminalIds: ["t2"],
      failedTerminalIndices: [],
    });
    expect(state.items.get(1)!.spawnedTerminalIds).toEqual(["t1", "t2"]);
  });

  it("ITEM_ASSIGNING updates stage", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, { type: "ITEM_ASSIGNING", issueNumber: 1 });
    expect(state.items.get(1)!.stage).toBe("assigning");
  });

  it("ITEM_VERIFYING updates stage", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, { type: "ITEM_VERIFYING", issueNumber: 1 });
    expect(state.items.get(1)!.stage).toBe("verifying");
  });

  it("ITEM_SUCCEEDED marks item done", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, { type: "ITEM_SUCCEEDED", issueNumber: 1 });
    expect(state.items.get(1)!.stage).toBe("succeeded");
  });

  it("ITEM_FAILED stores error and attempt info", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, {
      type: "ITEM_FAILED",
      issueNumber: 1,
      error: "boom",
      attempts: 2,
      failedStep: "worktree",
    });
    const item = state.items.get(1)!;
    expect(item.stage).toBe("failed");
    expect(item.error).toBe("boom");
    expect(item.attempt).toBe(2);
    expect(item.failedStep).toBe("worktree");
  });

  it("DONE transitions phase", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state = progressReducer(state, { type: "DONE" });
    expect(state.phase).toBe("done");
  });

  it("RETRY_FAILED resets failed/error items to pending", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1, 2] });
    state.items.set(1, makeStatus({ stage: "failed", error: "oops" }));
    state.items.set(2, makeStatus({ stage: "terminals-error" }));
    state = progressReducer(state, { type: "RETRY_FAILED" });
    expect(state.phase).toBe("executing");
    expect(state.total).toBe(2);
    expect(state.items.get(1)!.stage).toBe("pending");
    expect(state.items.get(1)!.error).toBeUndefined();
    expect(state.items.get(2)!.stage).toBe("pending");
  });

  it("RETRY_FAILED leaves succeeded items alone", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1, 2] });
    state.items.set(1, makeStatus({ stage: "succeeded" }));
    state.items.set(2, makeStatus({ stage: "failed" }));
    state = progressReducer(state, { type: "RETRY_FAILED" });
    expect(state.items.get(1)!.stage).toBe("succeeded");
    expect(state.items.get(2)!.stage).toBe("pending");
  });

  it("RESET returns idle state", () => {
    let state = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    state.items.set(1, makeStatus({ stage: "succeeded", worktreeId: "wt-1" }));
    state = progressReducer(state, { type: "RESET" });
    expect(state.phase).toBe("idle");
    expect(state.total).toBe(0);
    expect(state.items.size).toBe(0);
  });

  it("mutations are immutable (do not mutate previous state)", () => {
    const prev = progressReducer(emptyState(), { type: "START", issueNumbers: [1] });
    const prevItems = prev.items;
    const next = progressReducer(prev, { type: "ITEM_SUCCEEDED", issueNumber: 1 });
    expect(next.items).not.toBe(prevItems);
    expect(prev.items.get(1)!.stage).toBe("pending");
  });
});

describe("getStageLabel", () => {
  it("returns null for undefined status", () => {
    expect(getStageLabel(undefined)).toBeNull();
  });

  it("returns label for worktree-creating", () => {
    expect(getStageLabel(makeStatus({ stage: "worktree-creating" }))).toBe("Creating worktree…");
  });

  it("returns label for terminals-spawning", () => {
    expect(getStageLabel(makeStatus({ stage: "terminals-spawning" }))).toBe("Spawning terminals…");
  });

  it("returns label for assigning", () => {
    expect(getStageLabel(makeStatus({ stage: "assigning" }))).toBe("Assigning issue…");
  });

  it("returns label for verifying", () => {
    expect(getStageLabel(makeStatus({ stage: "verifying" }))).toBe("Verifying…");
  });

  it("returns terminal spawn failed for failed+terminals", () => {
    expect(getStageLabel(makeStatus({ stage: "failed", failedStep: "terminals" }))).toBe(
      "Terminal spawn failed"
    );
  });

  it("returns missing terminals for failed+verification", () => {
    expect(getStageLabel(makeStatus({ stage: "failed", failedStep: "verification" }))).toBe(
      "Missing terminals"
    );
  });

  it("returns null for generic failed without step", () => {
    expect(getStageLabel(makeStatus({ stage: "failed" }))).toBeNull();
  });

  it("returns null for succeeded", () => {
    expect(getStageLabel(makeStatus({ stage: "succeeded" }))).toBeNull();
  });

  it("returns null for pending", () => {
    expect(getStageLabel(makeStatus({ stage: "pending" }))).toBeNull();
  });
});
