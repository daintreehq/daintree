import { describe, expect, it, vi } from "vitest";
import type { WorktreeLocalWork } from "../../../../shared/types/worktreeLocalWork.js";
import {
  closedPaneOf,
  closingAgentPane,
  closingAgentPaneFromLaunch,
  readClosedPaneWorktrees,
  readClosingAgentPaneFrom,
  withCloseWorktree,
  type ClosedPaneWorktreeRequest,
} from "../closedPaneWorktree.js";

const observed = (unpushedCommits: number, hiddenFromStatus = 0): WorktreeLocalWork => ({
  kind: "observed",
  unpushedCommits,
  changedEntries: 0,
  hiddenFromStatus,
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

describe("readClosingAgentPaneFrom (#18173)", () => {
  const launch = {
    facts: { launchAgentId: "claude", projectId: "p1", worktreeId: "/wt/launch" },
    detectedAgentIds: [],
  };

  it("takes the host's record over the launch facts while there is one", async () => {
    const launchOf = vi.fn(() => launch);
    expect(
      await readClosingAgentPaneFrom(
        "t1",
        async () => ({ projectId: "p1", worktreeId: "/wt/now", detectedAgentId: "claude" }),
        launchOf
      )
    ).toEqual({ terminalId: "t1", projectId: "p1", worktreeId: "/wt/now" });
    // A live shell is a shell, whatever was launched under the id before.
    expect(
      await readClosingAgentPaneFrom("t1", async () => ({ projectId: "p1" }), launchOf)
    ).toBeNull();
    expect(launchOf).not.toHaveBeenCalled();
  });

  it("falls back on the launch facts when the host has no record or doesn't answer", async () => {
    const pane = { terminalId: "t1", projectId: "p1", worktreeId: "/wt/launch" };
    expect(
      await readClosingAgentPaneFrom(
        "t1",
        async () => null,
        () => launch
      )
    ).toEqual(pane);
    expect(
      await readClosingAgentPaneFrom(
        "t1",
        async () => {
          throw new Error("TIMEOUT");
        },
        () => launch
      )
    ).toEqual(pane);
    // Nothing on this host knows the id: not an agent pane it can speak for.
    expect(
      await readClosingAgentPaneFrom(
        "t1",
        async () => {
          throw new Error("TIMEOUT");
        },
        () => undefined
      )
    ).toBeNull();
  });
});

describe("closedPaneOf (#18173)", () => {
  it("reads another project's run under the same id as unreadable, never as this pane", () => {
    const pane = { terminalId: "t1", projectId: "p-b", worktreeId: "/wt/b" };
    expect(closedPaneOf(pane, "p-a")).toEqual({ terminalId: "t1", unread: true });
    expect(closedPaneOf(pane, "p-b")).toBe(pane);
    // Either side unknown: nothing to tell them apart by.
    expect(closedPaneOf(pane, undefined)).toBe(pane);
    const unplaced = { terminalId: "t1", worktreeId: "/wt/b" };
    expect(closedPaneOf(unplaced, "p-a")).toBe(unplaced);
    expect(closedPaneOf(null, "p-a")).toBeNull();
  });
});

describe("readClosedPaneWorktrees (#18173)", () => {
  const signal = new AbortController().signal;

  it("asks only for panes in a worktree, in one call, and answers every pane in order", async () => {
    const read = vi.fn(async (panes: readonly ClosedPaneWorktreeRequest[], _signal: AbortSignal) =>
      panes.map((_, index) => observed(index + 1, index))
    );

    const answers = await readClosedPaneWorktrees(
      read,
      [
        { terminalId: "a", projectId: "p1", worktreeId: "/wt/a" },
        { terminalId: "none", projectId: "p1" },
        // A pane whose record couldn't be read is never asked about, even
        // with a worktree to its name.
        { terminalId: "lost", worktreeId: "/wt/lost", unread: true },
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
      observed(1, 0),
      { kind: "not-applicable" },
      { kind: "unreadable" },
      observed(2, 1),
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
    const failed = { ok: false as const, error: { code: "NOT_FOUND" as const, message: "no" } };
    expect(withCloseWorktree(failed, observed(1))).toBe(failed);
    const odd = { ok: true as const, result: { sent: true } };
    expect(withCloseWorktree(odd, observed(1))).toBe(odd);
    const empty = { ok: true as const, result: null };
    expect(withCloseWorktree(empty, observed(1))).toBe(empty);
  });
});
