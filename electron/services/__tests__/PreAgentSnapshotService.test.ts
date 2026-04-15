import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStash = vi.fn();
const mockStashList = vi.fn();
const mockRaw = vi.fn();
const mockStatus = vi.fn();
const mockReset = vi.fn();
const mockClean = vi.fn();

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => ({
    stash: mockStash,
    stashList: mockStashList,
    raw: mockRaw,
    status: mockStatus,
    reset: mockReset,
    clean: mockClean,
  })),
  validateCwd: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { events, type CanopyEventMap } from "../events.js";
import { preAgentSnapshotService } from "../PreAgentSnapshotService.js";

function emitStateChange(previousState: string, state: string, worktreeId?: string) {
  events.emit("agent:state-changed", {
    state,
    previousState,
    worktreeId,
    terminalId: "term-1",
    timestamp: Date.now(),
    trigger: "heuristic",
    confidence: 1.0,
  } as CanopyEventMap["agent:state-changed"]);
}

describe("PreAgentSnapshotService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preAgentSnapshotService.initialize();
  });

  afterEach(() => {
    preAgentSnapshotService.dispose();
  });

  describe("snapshot creation", () => {
    it("creates snapshot on idle → working transition", async () => {
      mockStatus.mockResolvedValue({ conflicted: [] });
      mockStashList
        .mockResolvedValueOnce({ total: 0 }) // before
        .mockResolvedValueOnce({ total: 1 }); // after
      mockStash.mockResolvedValue(undefined);

      emitStateChange("idle", "working", "/test/worktree");

      // Allow the async createSnapshot to complete
      await vi.waitFor(() => {
        expect(mockStash).toHaveBeenCalledWith(
          expect.arrayContaining([
            "push",
            "--include-untracked",
            "-m",
            expect.stringContaining("daintree:pre-agent:"),
          ])
        );
      });

      // Should apply stash back so agent has files
      expect(mockStash).toHaveBeenCalledWith(["apply", "--index", "stash@{0}"]);

      const snapshot = preAgentSnapshotService.getSnapshot("/test/worktree");
      expect(snapshot).not.toBeNull();
      expect(snapshot!.hasChanges).toBe(true);
      expect(snapshot!.worktreeId).toBe("/test/worktree");
    });

    it("skips snapshot when working tree is clean", async () => {
      mockStatus.mockResolvedValue({ conflicted: [] });
      mockStashList.mockResolvedValueOnce({ total: 0 }).mockResolvedValueOnce({ total: 0 }); // no change = clean tree
      mockStash.mockResolvedValue(undefined);

      emitStateChange("idle", "working", "/test/worktree");

      await vi.waitFor(() => {
        expect(mockStash).toHaveBeenCalled();
      });

      const snapshot = preAgentSnapshotService.getSnapshot("/test/worktree");
      expect(snapshot).not.toBeNull();
      expect(snapshot!.hasChanges).toBe(false);
    });

    it("does not create snapshot on waiting → working transition", async () => {
      emitStateChange("waiting", "working", "/test/worktree");

      // Give it time to ensure no async operations were started
      await new Promise((r) => setTimeout(r, 50));
      expect(mockStash).not.toHaveBeenCalled();
    });

    it("does not create duplicate snapshots for same worktree", async () => {
      mockStatus.mockResolvedValue({ conflicted: [] });
      mockStashList.mockResolvedValueOnce({ total: 0 }).mockResolvedValueOnce({ total: 1 });
      mockStash.mockResolvedValue(undefined);

      emitStateChange("idle", "working", "/test/worktree");

      await vi.waitFor(() => {
        expect(mockStash).toHaveBeenCalled();
      });

      // Reset and try again
      mockStash.mockClear();
      emitStateChange("idle", "working", "/test/worktree");

      await new Promise((r) => setTimeout(r, 50));
      expect(mockStash).not.toHaveBeenCalled();
    });

    it("skips snapshot when conflicts are detected", async () => {
      mockStatus.mockResolvedValue({ conflicted: ["file.txt"] });

      emitStateChange("idle", "working", "/test/worktree");

      await new Promise((r) => setTimeout(r, 50));
      expect(mockStash).not.toHaveBeenCalled();
      expect(preAgentSnapshotService.getSnapshot("/test/worktree")).toBeNull();
    });

    it("does not create snapshot without worktreeId", async () => {
      emitStateChange("idle", "working");

      await new Promise((r) => setTimeout(r, 50));
      expect(mockStash).not.toHaveBeenCalled();
    });
  });

  describe("snapshot revert", () => {
    it("reverts to snapshot successfully", async () => {
      // First create a snapshot
      mockStatus.mockResolvedValue({ conflicted: [] });
      mockStashList.mockResolvedValueOnce({ total: 0 }).mockResolvedValueOnce({ total: 1 });
      mockStash.mockResolvedValue(undefined);

      emitStateChange("idle", "working", "/test/worktree");
      await vi.waitFor(() => {
        const snap = preAgentSnapshotService.getSnapshot("/test/worktree");
        expect(snap).not.toBeNull();
        expect(snap!.hasChanges).toBe(true);
      });

      // Now set up for revert
      mockRaw.mockResolvedValue(
        "stash@{0} 1700000000 On main: daintree:pre-agent:/test/worktree:1700000000"
      );
      mockReset.mockResolvedValue(undefined);
      mockClean.mockResolvedValue(undefined);
      mockStash.mockClear();
      mockStash.mockResolvedValue(undefined);

      const result = await preAgentSnapshotService.revertToSnapshot("/test/worktree");

      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);
      expect(mockReset).toHaveBeenCalledWith(["--hard", "HEAD"]);
      expect(mockClean).toHaveBeenCalledWith(["-fd"]);
      expect(preAgentSnapshotService.getSnapshot("/test/worktree")).toBeNull();
    });

    it("returns error for missing snapshot", async () => {
      const result = await preAgentSnapshotService.revertToSnapshot("/nonexistent");
      expect(result.success).toBe(false);
      expect(result.message).toContain("No snapshot found");
    });
  });

  describe("snapshot listing", () => {
    it("lists all snapshots", async () => {
      mockStatus.mockResolvedValue({ conflicted: [] });
      mockStashList.mockResolvedValueOnce({ total: 0 }).mockResolvedValueOnce({ total: 1 });
      mockStash.mockResolvedValue(undefined);

      emitStateChange("idle", "working", "/test/worktree-1");
      await vi.waitFor(() => {
        expect(preAgentSnapshotService.listSnapshots().length).toBe(1);
      });

      const snapshots = preAgentSnapshotService.listSnapshots();
      expect(snapshots[0].worktreeId).toBe("/test/worktree-1");
    });
  });

  describe("dispose", () => {
    it("clears all snapshots and unsubscribes", () => {
      preAgentSnapshotService.dispose();
      expect(preAgentSnapshotService.listSnapshots()).toHaveLength(0);
    });
  });
});
