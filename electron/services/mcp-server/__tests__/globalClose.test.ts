import { describe, expect, it, vi } from "vitest";
import type { GlobalCloseTarget } from "../../assistants/GlobalWorkerSteer.js";
import {
  globalCloseBatchQuestion,
  globalCloseQuestion,
  readGlobalCloseWorktrees,
  sameGlobalCloseTarget,
  settleGlobalCloseAnswer,
} from "../globalClose.js";

/** What the relay carries of one question line (#13501). */
const RELAY_LINE_MAX_CHARS = 1_000;

const TARGET: GlobalCloseTarget = {
  generation: 4,
  closeClass: "handback",
  agentId: "claude",
  agentState: "waiting",
  waitingReason: "prompt",
  lastStateChange: 1_000,
  lastTypedInputAt: 900,
  title: "Fix the flaky test",
};

describe("the global close's worktree read (#18151)", () => {
  const signal = new AbortController().signal;
  const clean = {
    kind: "observed",
    unpushedCommits: 0,
    changedEntries: 0,
    hiddenFromStatus: 0,
  } as const;

  it("reads nothing when no panel sits in a worktree", async () => {
    const read = vi.fn(async () => [clean]);
    expect(await readGlobalCloseWorktrees(read, "p", [{}], signal)).toEqual([
      { kind: "not-applicable" },
    ]);
    expect(read).not.toHaveBeenCalled();
  });

  it("leaves each panel in a worktree unreadable when the read fails, is missing, or comes back short", async () => {
    const targets = [{ worktreeId: "/wt/a" }, {}, { worktreeId: "/wt/b" }];
    const unreadable = [{ kind: "unreadable" }, { kind: "not-applicable" }, { kind: "unreadable" }];
    expect(await readGlobalCloseWorktrees(undefined, "p", targets, signal)).toEqual(unreadable);
    expect(
      await readGlobalCloseWorktrees(
        async () => {
          throw new Error("no git");
        },
        "p",
        targets,
        signal
      )
    ).toEqual(unreadable);
    expect(await readGlobalCloseWorktrees(async () => [clean], "p", targets, signal)).toEqual([
      clean,
      { kind: "not-applicable" },
      { kind: "unreadable" },
    ]);
  });

  it("puts what only this machine holds on the panel's line, and nothing for a clean one", () => {
    const line = (worktree: Parameters<typeof globalCloseQuestion>[2]) =>
      globalCloseQuestion("t-1", TARGET, worktree).lines[1];
    expect(line(clean)).not.toContain("—");
    expect(line({ ...clean, unpushedCommits: 72, changedEntries: 1 })).toMatch(
      / — 72 commits on no remote, 1 file changed or untracked$/
    );
    expect(line({ kind: "unreadable" })).toMatch(/ — Worktree state unreadable$/);
  });
});

describe("the global close's question (#16750)", () => {
  it("keeps every line inside what the relay carries, whatever the id or title", () => {
    const longId = `terminal-${"x".repeat(1_500)}`;
    const target = { ...TARGET, title: "t".repeat(2_000) };
    const single = globalCloseQuestion(longId, target);
    const batch = globalCloseBatchQuestion([{ terminalId: longId, target }], 2);

    for (const line of [...single.lines, ...batch.lines]) {
      expect(line.length).toBeLessThanOrEqual(RELAY_LINE_MAX_CHARS);
    }
    // The stop is never cut off, and the id keeps its end.
    const errorStop = globalCloseBatchQuestion(
      [{ terminalId: longId, target: { ...target, closeClass: "requires-person" } }],
      0
    );
    expect(errorStop.lines[0]).toContain("may pick up again");
    expect(errorStop.lines[0]).toContain(longId.slice(-20));
    expect(single.subject.length).toBeLessThanOrEqual(256);
  });

  it("names an agent stopped on an error as one that may pick up again", () => {
    const question = globalCloseQuestion("t-1", {
      ...TARGET,
      closeClass: "requires-person",
      waitingReason: "error",
    });
    expect(question.lines.join("\n")).toContain("may pick up again");
  });

  it("says how many of the call's own panels close with the batch", () => {
    const lines = (own: number) =>
      globalCloseBatchQuestion([{ terminalId: "t-1", target: TARGET }], own).lines.join("\n");
    expect(lines(0)).not.toContain("also closes");
    expect(lines(3)).toContain("also closes up to 3 panels");
  });
});

describe("sameGlobalCloseTarget (#16750)", () => {
  it.each([
    ["generation", { generation: 5 }],
    ["close class", { closeClass: "requires-person" as const }],
    ["agent", { agentId: "codex" }],
    ["state", { agentState: "completed" as const }],
    ["waiting reason", { waitingReason: undefined }],
    ["typed input", { lastTypedInputAt: 950 }],
    ["state change", { lastStateChange: 1_200 }],
  ])("tells a changed %s apart", (_what, change) => {
    expect(sameGlobalCloseTarget(TARGET, { ...TARGET, ...change })).toBe(false);
  });

  it("takes an unchanged run as the same, and no run as not", () => {
    expect(sameGlobalCloseTarget(TARGET, { ...TARGET })).toBe(true);
    expect(sameGlobalCloseTarget(TARGET, null)).toBe(false);
  });
});

describe("settleGlobalCloseAnswer (#16750)", () => {
  it("carries an answer's deadline, and tells a person's yes from a skip", () => {
    expect(settleGlobalCloseAnswer({ decision: "approved", deadline: 9 }, false, "'t'")).toEqual({
      kind: "approved",
      deadline: 9,
    });
    expect(
      settleGlobalCloseAnswer(
        { decision: "approved", deadline: 9, authorization: "skip-preference" },
        false,
        "'t'"
      )
    ).toEqual({ kind: "skipped", deadline: 9 });
  });

  it("takes no skip for a close only the person may approve", () => {
    const settled = settleGlobalCloseAnswer(
      { decision: "approved", deadline: 9, authorization: "skip-preference" },
      true,
      "'t'"
    );
    expect(settled).toMatchObject({ kind: "refused", error: { code: "CONFIRMATION_REQUIRED" } });
  });
});
