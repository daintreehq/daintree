import { describe, expect, it, vi } from "vitest";
import type { ActionError } from "../../../../shared/types/actions.js";
import type { TerminalProcessRecord, WorktreeMatchOptions } from "../worktreeProcessGuard.js";
import {
  planWorktreeRetirement,
  refuseUnlessCleanAndPushed,
  retirementStopped,
  tearDownForRetirement,
  type RetirementAttribution,
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
  unpushedCommits: 0,
};

const record = (id: string, overrides: Partial<TerminalProcessRecord> = {}): TerminalProcessRecord => ({
  id,
  worktreeId: WORKTREE,
  cwd: WORKTREE,
  isExited: false,
  launchGeneration: 1,
  ...overrides,
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

  it("names uncommitted work before unpushed commits", () => {
    const refusal = refuseUnlessCleanAndPushed(WORKTREE, {
      ...CLEAN,
      conflicted: 1,
      unpushedCommits: 2,
    });
    expect(refusal?.details).toMatchObject({ check: "clean", conflicted: 1 });
    expect(refusal?.message).toContain("1 conflicted path");
  });

  it("names the pushed check with the commit count and where it was measured from", () => {
    const refusal = refuseUnlessCleanAndPushed(WORKTREE, { ...CLEAN, unpushedCommits: 2 });
    expect(refusal?.details).toMatchObject({ check: "pushed", unpushedCommits: 2 });
    expect(refusal?.message).toContain("2 commits reachable from bbbbbbbbbbbb are on no");
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
      [record("open"), record("trashed", { isTrashed: true }), record("gone", { isExited: true })],
      { open: MINE, trashed: MINE_CLOSED, gone: MINE }
    );
    expect(result).toEqual({ plan: { close: ["open", "gone"], awaitExit: ["open", "trashed"] } });
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
    [
      "its own pane it no longer holds",
      record("lost"),
      { ...MINE, closableByThisSession: false },
    ],
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
  function steps(overrides: Partial<RetirementTeardownSteps> = {}): RetirementTeardownSteps {
    return {
      signal: new AbortController().signal,
      closePane: vi.fn(async () => undefined),
      waitForExits: vi.fn(async (ids: readonly string[]) => ({
        result: {
          processes: ids.map((terminalId) => ({ terminalId, outcome: "exited" as const })),
        },
      })),
      recheck: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it("closes in order, waits for the running ones, checks again, and reports what it did", async () => {
    const run = steps();
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: ["a", "b"], awaitExit: ["a", "c"] },
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
    expect(run.waitForExits).toHaveBeenCalledWith(["a", "c"]);
    expect(run.recheck).toHaveBeenCalledOnce();
  });

  it("stops at a close that fails, reporting the panes already closed", async () => {
    const failure: ActionError = { code: "EXECUTION_ERROR", message: "Close failed." };
    const run = steps({
      closePane: vi.fn(async (id: string) => (id === "b" ? failure : undefined)),
    });
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: ["a", "b", "c"], awaitExit: ["a", "b", "c"] },
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

  it("answers a first close that fails as the plain failure, since nothing changed", async () => {
    const failure: ActionError = { code: "RESOURCE_NOT_OWNED", message: "Not yours." };
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: ["a"], awaitExit: ["a"] },
      steps({ closePane: async () => failure })
    );
    expect(result).toEqual({
      ok: false,
      error: { ...failure, message: "Not yours. Nothing was closed or deleted." },
    });
  });

  it("treats an unknown exit like a running one", async () => {
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: ["a"], awaitExit: ["a"] },
      steps({
        waitForExits: async () => ({
          result: { processes: [{ terminalId: "a", outcome: "unknown" as const }] },
        }),
      })
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PARTIAL_SUCCESS",
        details: { failedStep: "wait", processes: [{ terminalId: "a", outcome: "unknown" }] },
      },
    });
  });

  it("starts nothing more once the call is cancelled", async () => {
    const controller = new AbortController();
    const run = steps({
      signal: controller.signal,
      closePane: vi.fn(async () => {
        controller.abort();
        return undefined;
      }),
    });
    const result = await tearDownForRetirement(
      WORKTREE,
      { close: ["a", "b"], awaitExit: ["a", "b"] },
      run
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PARTIAL_SUCCESS", details: { failedStep: "close", closedTerminalIds: ["a"] } },
    });
    expect(run.closePane).toHaveBeenCalledOnce();
    expect(run.waitForExits).not.toHaveBeenCalled();
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
    expect(error.details).toMatchObject({ deleteDispatched: true, cause });
  });

  it("passes a delete's own answer through when the call changed nothing", () => {
    expect(
      retirementStopped(WORKTREE, "delete", { closedTerminalIds: [], processes: [] }, cause)
    ).toBe(cause);
  });
});
