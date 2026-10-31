import { describe, expect, it, vi } from "vitest";
import {
  liveTerminalsInWorktree,
  readPtyTerminalProcesses,
  refuseWorktreeDeleteWhileRunning,
  type TerminalAttribution,
  type TerminalProcessRecord,
  type WorktreeLiveTerminal,
  type WorktreeMatchOptions,
} from "../worktreeProcessGuard.js";

/** No path resolves: every comparison is lexical. */
const missing = () => Promise.reject(new Error("ENOENT"));
const POSIX: WorktreeMatchOptions = {
  caseInsensitive: false,
  realpath: missing,
  resolveDeadlineMs: 1_000,
};
const WINDOWS: WorktreeMatchOptions = { ...POSIX, caseInsensitive: true };
/** A resolver that answers at once, except for a spawn directory on a dead mount. */
const HUNG: WorktreeMatchOptions = {
  ...POSIX,
  realpath: (path) =>
    path.startsWith("/net/stale") ? new Promise<string>(() => {}) : Promise.resolve(path),
  resolveDeadlineMs: 20,
};

function ids(census: { terminals: readonly TerminalProcessRecord[] }): string[] {
  return census.terminals.map((record) => record.id);
}

const FOREIGN: TerminalAttribution = { createdByThisSession: false, closableByThisSession: false };
const OWN_OPEN: TerminalAttribution = { createdByThisSession: true, closableByThisSession: true };

describe("liveTerminalsInWorktree (#15729)", () => {
  it("matches by attribution or by a spawn directory inside the worktree", async () => {
    const records: TerminalProcessRecord[] = [
      { id: "attributed", worktreeId: "/wt/task", cwd: "/elsewhere", isExited: false },
      { id: "spawned-in-sub", worktreeId: "/wt/other", cwd: "/wt/task/src", isExited: false },
      { id: "spawned-at-root", cwd: "/wt/task/", isExited: false },
      { id: "sibling-prefix", worktreeId: "/wt/task-other", cwd: "/wt/task-other" },
      { id: "parent", worktreeId: "/wt", cwd: "/wt" },
      { id: "no-cwd", cwd: "" },
    ];

    expect(ids(await liveTerminalsInWorktree(records, "/wt/task", POSIX))).toEqual([
      "attributed",
      "spawned-in-sub",
      "spawned-at-root",
    ]);
  });

  it("counts anything short of a reported exit as running", async () => {
    const records: TerminalProcessRecord[] = [
      { id: "exited", worktreeId: "/wt/task", isExited: true },
      { id: "trashed", worktreeId: "/wt/task", isExited: false, isTrashed: true },
      { id: "never-said", worktreeId: "/wt/task" },
    ];

    expect(ids(await liveTerminalsInWorktree(records, "/wt/task", POSIX))).toEqual([
      "trashed",
      "never-said",
    ]);
  });

  it("folds case and separators only where the platform does", async () => {
    const records: TerminalProcessRecord[] = [
      { id: "shell", worktreeId: "c:\\Repo\\WT\\task\\", isExited: false },
    ];

    expect(ids(await liveTerminalsInWorktree(records, "C:/repo/wt/task", WINDOWS))).toEqual([
      "shell",
    ]);
    expect(ids(await liveTerminalsInWorktree(records, "C:/repo/wt/task", POSIX))).toEqual([]);
  });

  it("follows a spawn directory that reaches the worktree through a symlink", async () => {
    const links: Record<string, string> = {
      "/tmp/task-link": "/real/wt/task",
      "/wt/task": "/real/wt/task",
      "/tmp/other-link": "/real/wt/other",
    };
    const options: WorktreeMatchOptions = {
      ...POSIX,
      // As realpath does: a link anywhere along the path resolves.
      realpath: (path) => {
        for (const [link, target] of Object.entries(links)) {
          if (path === link || path.startsWith(`${link}/`)) {
            return Promise.resolve(`${target}${path.slice(link.length)}`);
          }
        }
        return Promise.reject(new Error("ENOENT"));
      },
    };
    const records: TerminalProcessRecord[] = [
      { id: "via-link", worktreeId: "/repo", cwd: "/tmp/task-link/src", isExited: false },
      { id: "linked-root", worktreeId: "/repo", cwd: "/tmp/task-link", isExited: false },
      { id: "other-link", worktreeId: "/repo", cwd: "/tmp/other-link", isExited: false },
    ];

    expect(ids(await liveTerminalsInWorktree(records, "/wt/task", options))).toEqual([
      "via-link",
      "linked-root",
    ]);
  });

  it("names an id two shards both report once, placed by any of its records", async () => {
    const inside: TerminalProcessRecord = { id: "moved", worktreeId: "/wt/task", isExited: false };
    const outside: TerminalProcessRecord = {
      id: "moved",
      worktreeId: "/wt/other",
      isExited: false,
    };
    const exited: TerminalProcessRecord = { ...inside, isExited: true };

    for (const records of [
      [inside, { ...inside }],
      [outside, inside],
      [inside, outside],
      [exited, inside],
    ]) {
      expect(ids(await liveTerminalsInWorktree(records, "/wt/task", POSIX))).toEqual(["moved"]);
    }
  });

  it("resolves nothing when the plain spelling already placed every running terminal", async () => {
    const realpath = vi.fn(missing);

    await liveTerminalsInWorktree(
      [
        { id: "exited", cwd: "/elsewhere", isExited: true },
        { id: "here", worktreeId: "/wt/task", isExited: false },
      ],
      "/wt/task",
      { ...POSIX, realpath }
    );

    expect(realpath).not.toHaveBeenCalled();
  });

  it("calls a census incomplete when resolving a spawn directory runs out of time", async () => {
    const census = await liveTerminalsInWorktree(
      [
        { id: "here", worktreeId: "/wt/task", isExited: false },
        { id: "on-a-dead-mount", cwd: "/net/stale", isExited: false },
      ],
      "/wt/task",
      HUNG
    );

    expect(census).toEqual({
      terminals: [expect.objectContaining({ id: "here" })],
      complete: false,
    });
  });
});

describe("refuseWorktreeDeleteWhileRunning (#15729)", () => {
  const foreign = () => FOREIGN;

  it("allows the delete when nothing in the worktree is running", async () => {
    const refusal = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      async () => [
        { id: "done", worktreeId: "/wt/task", isExited: true },
        { id: "elsewhere", worktreeId: "/wt/other", isExited: false },
      ],
      foreign,
      POSIX
    );

    expect(refusal).toBeUndefined();
  });

  it("names each running terminal, whose it is, and how long a trashed one has left", async () => {
    const attribute = vi.fn(
      (terminalId: string, generation: number | undefined): TerminalAttribution =>
        terminalId === "mine" && generation === 3
          ? { createdByThisSession: true, closableByThisSession: false }
          : FOREIGN
    );

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
      attribute,
      POSIX
    );

    expect(refusal?.code).toBe("DISABLED");
    const details = refusal?.details as { reason: string; terminals: WorktreeLiveTerminal[] };
    expect(details.reason).toBe("worktree-has-running-terminals");
    expect(details.terminals).toEqual([
      {
        terminalId: "mine",
        createdByThisSession: true,
        closableByThisSession: false,
        trashed: true,
        trashExpiresAt: 1_700_000_020_000,
      },
      // An expiry on a terminal that is not in the trash means nothing.
      {
        terminalId: "user-shell",
        createdByThisSession: false,
        closableByThisSession: false,
        trashed: false,
        trashExpiresAt: null,
      },
    ]);
    expect(attribute).toHaveBeenCalledWith("user-shell", undefined);
    expect(refusal?.message).toContain("'mine' (created by this session, closed and still");
    expect(refusal?.message).toContain("'user-shell' (not recorded as created by this session)");
    expect(refusal?.message).toContain("Wait for this session's closed terminals to exit.");
    expect(refusal?.message).toContain("not its to stop");
    expect(refusal?.message).not.toContain("terminal.closeOwned");
  });

  it("tells a caller with a terminal still open to close it first", async () => {
    const refusal = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      async () => [{ id: "mine", worktreeId: "/wt/task", isExited: false }],
      () => OWN_OPEN,
      POSIX
    );

    expect(refusal?.code).toBe("DISABLED");
    expect(refusal?.message).toContain("'mine' (created by this session)");
    expect(refusal?.message).toContain("'terminal.closeOwned'");
    expect(refusal?.message).not.toContain("not its to stop");
  });

  it("never tells a caller to close a run it created but can no longer close", async () => {
    // Closed by this session, then restored by the person: the run is the
    // same one, but the close released this session's hold on it.
    const refusal = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      async () => [{ id: "restored", worktreeId: "/wt/task", isExited: false, isTrashed: false }],
      () => ({ createdByThisSession: true, closableByThisSession: false }),
      POSIX
    );

    expect(refusal?.message).toContain("'restored' (created by this session, no longer closable");
    expect(refusal?.message).not.toContain("terminal.closeOwned");
    expect(refusal?.message).not.toContain("Wait for");
    expect(refusal?.message).toContain("not its to stop");
  });

  it("refuses on what it found, or as unconfirmed, when a spawn directory cannot be resolved", async () => {
    const found = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      async () => [
        { id: "here", worktreeId: "/wt/task", isExited: false },
        { id: "on-a-dead-mount", cwd: "/net/stale", isExited: false },
      ],
      foreign,
      HUNG
    );
    const nothingFound = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      async () => [{ id: "on-a-dead-mount", cwd: "/net/stale", isExited: false }],
      foreign,
      HUNG
    );

    expect(found?.code).toBe("DISABLED");
    expect(found?.message).toContain("'here'");
    expect(nothingFound).toMatchObject({
      code: "EXECUTION_ERROR",
      details: { reason: "terminal-processes-unreadable" },
    });
  });

  it("refuses when the host cannot be read, or when there is no reader at all", async () => {
    const failed = await refuseWorktreeDeleteWhileRunning(
      "/wt/task",
      () => Promise.reject(new Error("shard timed out")),
      foreign,
      POSIX
    );
    const absent = await refuseWorktreeDeleteWhileRunning("/wt/task", undefined, foreign, POSIX);

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
            // The host's own count; main's is the one creations were noted against.
            launchGeneration: 2,
            agentState: "working",
          },
          { id: "b", cwd: "/wt/other", isExited: true, launchGeneration: 4 },
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

    await expect(readPtyTerminalProcesses(degraded)).rejects.toThrow("did not answer");
    await expect(readPtyTerminalProcesses(null)).rejects.toThrow("not available");
  });
});
