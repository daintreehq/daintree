import { describe, expect, it, vi } from "vitest";
import {
  liveTerminalsInWorktree,
  readPtyTerminalProcesses,
  refuseWorktreeDeleteWhileRunning,
  type TerminalProcessRecord,
  type WorktreeLiveTerminal,
} from "../worktreeProcessGuard.js";

const POSIX = { caseInsensitive: false };
const WINDOWS = { caseInsensitive: true };

function ids(records: readonly TerminalProcessRecord[]): string[] {
  return records.map((record) => record.id);
}

describe("liveTerminalsInWorktree (#15729)", () => {
  it("matches by attribution or by a spawn directory inside the worktree", () => {
    const records: TerminalProcessRecord[] = [
      { id: "attributed", worktreeId: "/wt/task", cwd: "/elsewhere", isExited: false },
      { id: "spawned-in-sub", worktreeId: "/wt/other", cwd: "/wt/task/src", isExited: false },
      { id: "spawned-at-root", cwd: "/wt/task/", isExited: false },
      { id: "sibling-prefix", worktreeId: "/wt/task-other", cwd: "/wt/task-other" },
      { id: "parent", worktreeId: "/wt", cwd: "/wt" },
    ];

    expect(ids(liveTerminalsInWorktree(records, "/wt/task", POSIX))).toEqual([
      "attributed",
      "spawned-in-sub",
      "spawned-at-root",
    ]);
  });

  it("counts anything short of a reported exit as running", () => {
    const records: TerminalProcessRecord[] = [
      { id: "exited", worktreeId: "/wt/task", isExited: true },
      { id: "trashed", worktreeId: "/wt/task", isExited: false, isTrashed: true },
      { id: "never-said", worktreeId: "/wt/task" },
    ];

    expect(ids(liveTerminalsInWorktree(records, "/wt/task", POSIX))).toEqual([
      "trashed",
      "never-said",
    ]);
  });

  it("folds case and separators only where the platform does", () => {
    const records: TerminalProcessRecord[] = [
      { id: "shell", worktreeId: "c:\\Repo\\WT\\task\\", isExited: false },
    ];

    expect(ids(liveTerminalsInWorktree(records, "C:/repo/wt/task", WINDOWS))).toEqual(["shell"]);
    expect(liveTerminalsInWorktree(records, "C:/repo/wt/task", POSIX)).toEqual([]);
  });
});

describe("refuseWorktreeDeleteWhileRunning (#15729)", () => {
  const notMine = () => false;

  it("allows the delete when nothing in the worktree is running", async () => {
    const refusal = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      async () => [
        { id: "done", worktreeId: "/wt/task", isExited: true },
        { id: "elsewhere", worktreeId: "/wt/other", isExited: false },
      ],
      notMine,
      POSIX
    );

    expect(refusal).toBeUndefined();
  });

  it("names each running terminal, whose it is, and how long a trashed one has left", async () => {
    const createdBy = vi.fn((terminalId: string, generation: number | undefined) => {
      return terminalId === "mine" && generation === 3;
    });

    const refusal = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      async () => [
        {
          id: "mine",
          worktreeId: "/wt/task",
          isExited: false,
          isTrashed: true,
          trashExpiresAt: 1_700_000_020_000,
          launchGeneration: 3,
        },
        { id: "user-shell", cwd: "/wt/task", isExited: false, trashExpiresAt: 99 },
      ],
      createdBy,
      POSIX
    );

    expect(refusal?.code).toBe("DISABLED");
    const details = refusal?.details as { reason: string; terminals: WorktreeLiveTerminal[] };
    expect(details.reason).toBe("worktree-has-running-terminals");
    expect(details.terminals).toEqual([
      {
        terminalId: "mine",
        createdByThisSession: true,
        trashed: true,
        trashExpiresAt: 1_700_000_020_000,
      },
      // An expiry on a terminal that is not in the trash means nothing.
      {
        terminalId: "user-shell",
        createdByThisSession: false,
        trashed: false,
        trashExpiresAt: null,
      },
    ]);
    expect(createdBy).toHaveBeenCalledWith("user-shell", undefined);
    expect(refusal?.message).toContain("'mine' (created by this session, closed and still");
    expect(refusal?.message).toContain("'user-shell' (not created by this session)");
    expect(refusal?.message).toContain("Wait for this session's closed terminals to exit.");
    expect(refusal?.message).toContain("not its to stop");
    expect(refusal?.message).not.toContain("terminal.closeOwned");
  });

  it("tells a caller with a terminal still open to close it first", async () => {
    const refusal = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      async () => [{ id: "mine", worktreeId: "/wt/task", isExited: false }],
      () => true,
      POSIX
    );

    expect(refusal?.message).toContain("'terminal.closeOwned'");
    expect(refusal?.message).not.toContain("not its to stop");
  });

  it("refuses when the host cannot be read, or when there is no reader at all", async () => {
    const failed = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      () => Promise.reject(new Error("shard timed out")),
      notMine,
      POSIX
    );
    const absent = await refuseWorktreeDeleteWhileRunning("/wt/task", undefined, notMine, POSIX);

    for (const refusal of [failed, absent]) {
      expect(refusal?.code).toBe("EXECUTION_ERROR");
      expect(refusal?.details).toEqual({
        reason: "terminal-processes-unreadable",
        worktreeId: "/wt/task",
      });
    }
  });
});

describe("readPtyTerminalProcesses (#15729)", () => {
  it("returns the host's records with main's generation for each running incarnation", async () => {
    const client = {
      getAllTerminalsWithCompletenessAsync: vi.fn().mockResolvedValue({
        terminals: [
          {
            id: "a",
            worktreeId: "/wt/task",
            cwd: "/wt/task",
            isExited: false,
            isTrashed: true,
            trashExpiresAt: 5,
            agentState: "working",
          },
          { id: "b", cwd: "/wt/other", isExited: true },
        ],
        degraded: false,
      }),
      getLiveGeneration: vi.fn((id: string) => (id === "a" ? 7 : null)),
    };

    await expect(readPtyTerminalProcesses(client)).resolves.toEqual([
      {
        id: "a",
        worktreeId: "/wt/task",
        cwd: "/wt/task",
        isExited: false,
        isTrashed: true,
        trashExpiresAt: 5,
        launchGeneration: 7,
      },
      { id: "b", cwd: "/wt/other", isExited: true },
    ]);
  });

  it("rejects a census a shard did not answer, and a missing host", async () => {
    const degraded = {
      getAllTerminalsWithCompletenessAsync: vi
        .fn()
        .mockResolvedValue({ terminals: [], degraded: true }),
      getLiveGeneration: vi.fn(() => null),
    };

    await expect(readPtyTerminalProcesses(degraded)).rejects.toThrow();
    await expect(readPtyTerminalProcesses(null)).rejects.toThrow();
  });
});
