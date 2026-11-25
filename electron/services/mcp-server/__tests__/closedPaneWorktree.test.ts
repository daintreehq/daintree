import { describe, expect, it, vi } from "vitest";
import type { WorktreeLocalWork } from "../../../../shared/types/worktreeLocalWork.js";
import {
  closingAgentPane,
  closingAgentPaneFromLaunch,
  readClosedPaneWorktrees,
  withCloseWorktree,
  type ClosedPaneWorktreeRequest,
} from "../closedPaneWorktree.js";

const observed = (unpushedCommits: number): WorktreeLocalWork => ({
  kind: "observed",
  unpushedCommits,
  changedEntries: 0,
  hiddenFromStatus: 0,
});

describe("closingAgentPane (#18173)", () => {
  it("takes a pane launched for an agent, or one seen running one now or before", () => {
    const placed = { projectId: "p1", worktreeId: "/wt/a" };
    expect(closingAgentPane("t1", { ...placed, launchAgentId: "claude" })).toEqual({
      terminalId: "t1",
      ...placed,
    });
    expect(closingAgentPane("t1", { ...placed, detectedAgentId: "codex" })).toEqual({
      terminalId: "t1",
      ...placed,
    });
    // A finished agent whose detection cleared is still the agent's pane.
    expect(closingAgentPane("t1", { everDetectedAgent: true })).toEqual({ terminalId: "t1" });
  });

  it("passes over a plain shell, the Assistant's own terminal, and a missing record", () => {
    expect(closingAgentPane("t1", { projectId: "p1", worktreeId: "/wt/a" })).toBeNull();
    expect(closingAgentPane("t1", { everDetectedAgent: false })).toBeNull();
    expect(
      closingAgentPane("t1", { isAssistantTerminal: true, launchAgentId: "claude" })
    ).toBeNull();
    expect(closingAgentPane("t1", null)).toBeNull();
  });

  it("falls back on the launch facts main kept after the host dropped the record", () => {
    expect(
      closingAgentPaneFromLaunch("t1", {
        facts: { launchAgentId: "claude", projectId: "p1", worktreeId: "/wt/a" },
        detectedAgentIds: [],
      })
    ).toEqual({ terminalId: "t1", projectId: "p1", worktreeId: "/wt/a" });
    expect(
      closingAgentPaneFromLaunch("t1", {
        facts: { worktreeId: "/wt/a" },
        detectedAgentIds: ["claude"],
      })
    ).toEqual({ terminalId: "t1", worktreeId: "/wt/a" });
    expect(
      closingAgentPaneFromLaunch("t1", { facts: { worktreeId: "/wt/a" }, detectedAgentIds: [] })
    ).toBeNull();
    expect(closingAgentPaneFromLaunch("t1", undefined)).toBeNull();
  });
});

describe("readClosedPaneWorktrees (#18173)", () => {
  const signal = new AbortController().signal;

  it("asks only for panes in a worktree, in one call, and answers every pane in order", async () => {
    const read = vi.fn(async (panes: readonly ClosedPaneWorktreeRequest[]) =>
      panes.map((_, index) => observed(index + 1))
    );

    const answers = await readClosedPaneWorktrees(
      read,
      [
        { terminalId: "a", projectId: "p1", worktreeId: "/wt/a" },
        { terminalId: "none", projectId: "p1" },
        { terminalId: "lost", unread: true },
        { terminalId: "b", worktreeId: "/wt/b" },
      ],
      signal
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toEqual([
      { projectId: "p1", worktreeId: "/wt/a" },
      { projectId: undefined, worktreeId: "/wt/b" },
    ]);
    expect(read.mock.calls[0]![1]).toBe(signal);
    expect(answers).toEqual([
      observed(1),
      { kind: "not-applicable" },
      { kind: "unreadable" },
      observed(2),
    ]);
  });

  it("never reads as clean what the reader couldn't answer", async () => {
    const panes = [
      { terminalId: "a", worktreeId: "/wt/a" },
      { terminalId: "b", worktreeId: "/wt/b" },
    ];
    expect(
      await readClosedPaneWorktrees(
        async () => {
          throw new Error("git went away");
        },
        panes,
        signal
      )
    ).toEqual([{ kind: "unreadable" }, { kind: "unreadable" }]);
    expect(await readClosedPaneWorktrees(async () => [observed(3)], panes, signal)).toEqual([
      observed(3),
      { kind: "unreadable" },
    ]);
    expect(await readClosedPaneWorktrees(undefined, panes, signal)).toEqual([
      { kind: "unreadable" },
      { kind: "unreadable" },
    ]);
  });

  it("reads nothing when no pane sits in a worktree", async () => {
    const read = vi.fn(async () => []);
    expect(await readClosedPaneWorktrees(read, [{ terminalId: "a" }], signal)).toEqual([
      { kind: "not-applicable" },
    ]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("withCloseWorktree (#18173)", () => {
  it("adds the facts to a successful close and leaves anything else alone", () => {
    expect(
      withCloseWorktree({ ok: true, result: { closedIds: ["t1"], processes: [] } }, observed(1))
    ).toEqual({ ok: true, result: { closedIds: ["t1"], processes: [], worktree: observed(1) } });
    const failed = { ok: false as const, error: { code: "X", message: "no" } };
    expect(withCloseWorktree(failed, observed(1))).toBe(failed);
    const odd = { ok: true as const, result: { sent: true } };
    expect(withCloseWorktree(odd, observed(1))).toBe(odd);
  });
});
