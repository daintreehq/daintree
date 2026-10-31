import { describe, expect, it, vi } from "vitest";
import type { ActionError } from "../../../../shared/types/actions.js";
import type { TerminalProcessRecord, WorktreeMatchOptions } from "../worktreeProcessGuard.js";
import {
  planWorktreeRetirement,
  refuseUnlessCleanAndPushed,
  retirementStopped,
  tearDownForRetirement,
  type RetirementAttribution,
  type RetirementClose,
  type RetirementTeardownSteps,
} from "../worktreeRetirement.js";
import type { WorktreeGitObservation } from "../worktreeRetirementGit.js";

const WORKTREE = "/wt/task";

const POSIX: WorktreeMatchOptions = {
  caseInsensitive: false,
  realpath: async (path) => path,
  resolveDeadlineMs: 2_000,
};

const CLEAN: WorktreeGitObservation = {
  headOid: "b".repeat(40),
  branch: "topic",
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
  hiddenFromStatus: 0,
  unpushedCommits: 0,
};

const record = (
  id: string,
  overrides: Partial<TerminalProcessRecord> = {}
): TerminalProcessRecord => ({
  id,
  worktreeId: WORKTREE,
  cwd: WORKTREE,
  isExited: false,
  launchGeneration: 1,
  ...overrides,
});

const pane = (terminalId: string, launchGeneration: number | undefined): RetirementClose => ({
  terminalId,
  launchGeneration,
});

const MINE: RetirementAttribution = {
  createdByThisSession: true,
  closableByThisSession: true,
  closedByThisSession: false,
};
const MINE_CLOSED: RetirementAttribution = {
  createdByThisSession: true,
  closableByThisSession: false,
  closedByThisSession: true,
};
const NOT_MINE: RetirementAttribution = {
  createdByThisSession: false,
  closableByThisSession: false,
  closedByThisSession: false,
};

function plan(
  records: TerminalProcessRecord[],
  attributions: Record<string, RetirementAttribution>,
  options: WorktreeMatchOptions = POSIX
) {
  return planWorktreeRetirement(
    WORKTREE,
    async () => records,
    (id) => attributions[id] ?? NOT_MINE,
    options
  );
}

describe("refuseUnlessCleanAndPushed", () => {
  it("passes a clean tree whose commits are all on a remote", () => {
    expect(refuseUnlessCleanAndPushed(WORKTREE, CLEAN)).toBeUndefined();
  });

  it.each([
    ["staged", "1 staged change"],
    ["unstaged", "1 unstaged change"],
    ["untracked", "1 untracked entry"],
    ["conflicted", "1 conflicted path"],
  ] as const)("refuses one %s entry alone, naming it", (field, named) => {
    const refusal = refuseUnlessCleanAndPushed(WORKTREE, { ...CLEAN, [field]: 1 });
    expect(refusal?.details).toMatchObject({ check: "clean", [field]: 1 });
    expect(refusal?.message).toContain(named);
  });

  it("refuses files status never checks, as part of the clean check", () => {
    const refusal = refuseUnlessCleanAndPushed(WORKTREE, { ...CLEAN, hiddenFromStatus: 1 });
    expect(refusal?.details).toMatchObject({
      check: "clean",
      reason: "worktree-has-unchecked-files",
      hiddenFromStatus: 1,
    });
  });

  it("names uncommitted work before unpushed commits", () => {
    const refusal = refuseUnlessCleanAndPushed(WORKTREE, {
      ...CLEAN,
      conflicted: 1,
      unpushedCommits: 2,
    });
    expect(refusal?.details).toMatchObject({ check: "clean", conflicted: 1 });
  });

  it("refuses a single commit no remote holds, saying where it was measured from", () => {
    const refusal = refuseUnlessCleanAndPushed(WORKTREE, { ...CLEAN, unpushedCommits: 1 });
    expect(refusal?.details).toMatchObject({ check: "pushed", unpushedCommits: 1 });
    expect(refusal?.message).toContain("1 commit reachable from bbbbbbbbbbbb is on no");
  });

  it("refuses a branch with no commit rather than reading it as pushed", () => {
    expect(
      refuseUnlessCleanAndPushed(WORKTREE, { ...CLEAN, headOid: null, unpushedCommits: null })
        ?.details
    ).toMatchObject({ check: "pushed", reason: "worktree-head-unborn" });
  });
});

describe("planWorktreeRetirement", () => {
  it("closes and awaits an open pane of its own, and only awaits one it already closed", async () => {
    const result = await plan(
      [
        record("open", { launchGeneration: 4 }),
        record("trashed", { isTrashed: true }),
        record("gone", { isExited: true, launchGeneration: undefined }),
      ],
      { open: MINE, trashed: MINE_CLOSED, gone: MINE }
    );
    expect(result).toEqual({
      plan: { close: [pane("open", 4), pane("gone", undefined)], awaitExit: ["open", "trashed"] },
    });
  });

  it("leaves exited terminals that are not its own alone", async () => {
    const result = await plan([record("old-shell", { isExited: true })], {});
    expect(result).toEqual({ plan: { close: [], awaitExit: [] } });
  });

  it("ignores terminals outside the worktree", async () => {
    const result = await plan(
      [record("elsewhere", { worktreeId: "/wt/other", cwd: "/wt/other" })],
      {}
    );
    expect(result).toEqual({ plan: { close: [], awaitExit: [] } });
  });

  it.each([
    ["someone else's running terminal", record("foreign"), NOT_MINE],
    ["its own pane it no longer holds", record("lost"), { ...MINE, closableByThisSession: false }],
    [
      "a trashed pane with no close of its own on record",
      record("trash", { isTrashed: true, trashExpiresAt: 5 }),
      { ...MINE, closableByThisSession: false },
    ],
  ])("refuses %s, naming it and closing nothing", async (_label, blocker, attribution) => {
    const result = await plan([record("open"), blocker], { open: MINE, [blocker.id]: attribution });
    expect(result).toMatchObject({
      refusal: {
        code: "DISABLED",
        details: {
          check: "processes",
          terminals: [expect.objectContaining({ terminalId: blocker.id })],
        },
      },
    });
    expect("refusal" in result && result.refusal.message).toContain(
      "Nothing was closed or deleted."
    );
  });

  it("refuses when some spawn directory could not be resolved in time", async () => {
    const hung: WorktreeMatchOptions = {
      ...POSIX,
      realpath: () => new Promise(() => {}),
      resolveDeadlineMs: 10,
    };
    const result = await plan(
      [record("open"), record("far", { worktreeId: undefined, cwd: "/mnt/stale" })],
      { open: MINE },
      hung
    );
    expect(result).toMatchObject({
      refusal: { code: "EXECUTION_ERROR", details: { reason: "terminal-processes-unreadable" } },
    });
  });

  it("refuses when the host cannot be read", async () => {
    const result = await planWorktreeRetirement(
      WORKTREE,
      async () => {
        throw new Error("down");
      },
      () => MINE,
      POSIX
    );
    expect(result).toMatchObject({ refusal: { code: "EXECUTION_ERROR" } });
  });
});

describe("tearDownForRetirement", () => {
  /** Steps that log each call as it starts and as it finishes, in one sequence. */
  function steps(overrides: Partial<RetirementTeardownSteps> = {}) {
    const log: string[] = [];
    const run: RetirementTeardownSteps = {
      signal: new AbortController().signal,
      closePane: vi.fn(async ({ terminalId }: RetirementClose) => {
        log.push(`close ${terminalId}`);
        await Promise.resolve();
        log.push(`closed ${terminalId}`);
        return undefined;
      }),
      waitForExits: vi.fn(async (ids: readonly string[]) => {
        log.push(`wait ${ids.join(",")}`);
        await Promise.resolve();
        log.push("waited");
        return {
          result: {
            processes: ids.map((terminalId) => ({ terminalId, outcome: "exited" as const })),
          },
        };
      }),
      recheck: vi.fn(async () => {
        log.push("recheck");
        return undefined;
      }),
      ...overrides,
    };
    return { run, log };
  }

  it("closes each pane in turn, then waits, then checks again, and reports what it did", async () => {
    const { run, log } = steps();
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: [pane("a", 3), pane("b", 7)], awaitExit: ["a", "c"] },
      run
    );
    expect(result).toEqual({
      ok: true,
      progress: {
        closedTerminalIds: ["a", "b"],
        processes: [
          { terminalId: "a", outcome: "exited" },
          { terminalId: "c", outcome: "exited" },
        ],
      },
    });
    expect(log).toEqual([
      "close a",
      "closed a",
      "close b",
      "closed b",
      "wait a,c",
      "waited",
      "recheck",
    ]);
    expect(run.closePane).toHaveBeenNthCalledWith(1, pane("a", 3));
    expect(run.closePane).toHaveBeenNthCalledWith(2, pane("b", 7));
  });

  it("stops at a close that fails, reporting the panes already closed", async () => {
    const failure: ActionError = { code: "EXECUTION_ERROR", message: "Close failed." };
    const { run } = steps({
      closePane: vi.fn(async ({ terminalId }: RetirementClose) =>
        terminalId === "b" ? failure : undefined
      ),
    });
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: [pane("a", 1), pane("b", 1), pane("c", 1)], awaitExit: ["a", "b", "c"] },
      run
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PARTIAL_SUCCESS",
        details: { failedStep: "close", closedTerminalIds: ["a"], cause: failure },
      },
    });
    expect(run.closePane).toHaveBeenCalledTimes(2);
    expect(run.waitForExits).not.toHaveBeenCalled();
  });

  it("keeps the panes already closed when a later close throws", async () => {
    const { run } = steps({
      closePane: vi.fn(async ({ terminalId }: RetirementClose) => {
        if (terminalId === "b") throw new Error("bridge gone");
        return undefined;
      }),
    });
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: [pane("a", 1), pane("b", 1)], awaitExit: ["a", "b"] },
      run
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PARTIAL_SUCCESS",
        details: {
          failedStep: "close",
          closedTerminalIds: ["a"],
          cause: { message: "bridge gone" },
        },
      },
    });
    expect(run.waitForExits).not.toHaveBeenCalled();
  });

  it("does not claim nothing was closed when the first close fails, since it may have", async () => {
    const failure: ActionError = { code: "EXECUTION_ERROR", message: "Layout write failed." };
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: [pane("a", 1)], awaitExit: ["a"] },
      steps({ closePane: async () => failure }).run
    );
    expect(result).toEqual({
      ok: false,
      error: { ...failure, message: "Layout write failed. No delete was sent." },
    });
  });

  it("keeps the closed panes when the wait itself fails, and checks nothing more", async () => {
    const { run } = steps({
      waitForExits: vi.fn(async () => {
        throw new Error("host gone");
      }),
    });
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: [pane("a", 1)], awaitExit: ["a"] },
      run
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PARTIAL_SUCCESS",
        details: { failedStep: "wait", closedTerminalIds: ["a"], cause: { message: "host gone" } },
      },
    });
    expect(run.recheck).not.toHaveBeenCalled();
  });

  it("treats an unknown exit like a running one", async () => {
    const { run } = steps({
      waitForExits: async () => ({
        result: { processes: [{ terminalId: "a", outcome: "unknown" as const }] },
      }),
    });
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: [pane("a", 1)], awaitExit: ["a"] },
      run
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PARTIAL_SUCCESS",
        details: { failedStep: "wait", processes: [{ terminalId: "a", outcome: "unknown" }] },
      },
    });
    expect(run.recheck).not.toHaveBeenCalled();
  });

  describe("once the call is cancelled, starts nothing more", () => {
    it("after a close", async () => {
      const controller = new AbortController();
      const { run } = steps({
        signal: controller.signal,
        closePane: vi.fn(async () => {
          controller.abort();
          return undefined;
        }),
      });
      const result = await tearDownForRetirement(
        WORKTREE,
        { close: [pane("a", 1)], awaitExit: ["a"] },
        run
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "PARTIAL_SUCCESS",
          details: { failedStep: "wait", closedTerminalIds: ["a"] },
        },
      });
      expect(run.waitForExits).not.toHaveBeenCalled();
    });

    it("during the wait", async () => {
      const controller = new AbortController();
      const { run } = steps({ signal: controller.signal });
      const wait = run.waitForExits;
      run.waitForExits = vi.fn(async (ids: readonly string[]) => {
        controller.abort();
        return wait(ids);
      });
      const result = await tearDownForRetirement(
        WORKTREE,
        { close: [pane("a", 1)], awaitExit: ["a"] },
        run
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "PARTIAL_SUCCESS",
          details: { failedStep: "recheck", closedTerminalIds: ["a"] },
        },
      });
      expect(run.recheck).not.toHaveBeenCalled();
    });

    it("during the recheck", async () => {
      const controller = new AbortController();
      const { run } = steps({
        signal: controller.signal,
        recheck: vi.fn(async () => {
          controller.abort();
          return undefined;
        }),
      });
      const result = await tearDownForRetirement(
        WORKTREE,
        { close: [pane("a", 1)], awaitExit: ["a"] },
        run
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "PARTIAL_SUCCESS", details: { failedStep: "recheck" } },
      });
    });
  });
});

describe("retirementStopped", () => {
  const cause: ActionError = { code: "CONFIRMATION_TIMEOUT", message: "No answer in time." };

  it("counts an ended grace as a change even with nothing closed", () => {
    const error = retirementStopped(
      WORKTREE,
      "delete",
      {
        closedTerminalIds: [],
        processes: [{ terminalId: "a", outcome: "exited", graceEnded: true }],
      },
      cause
    );
    expect(error.code).toBe("PARTIAL_SUCCESS");
    expect(error.details).toMatchObject({ deleteAttempted: true, cause });
  });

  it("passes a delete's own answer through when nothing was closed and no grace ended", () => {
    expect(
      retirementStopped(
        WORKTREE,
        "delete",
        { closedTerminalIds: [], processes: [{ terminalId: "a", outcome: "exited" }] },
        cause
      )
    ).toBe(cause);
  });
});
