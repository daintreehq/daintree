// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PluginAgentPane } from "@shared/types/plugin";
import {
  buildSendToAgentRows,
  canSelectSendToAgentRow,
  filterSendToAgentRows,
  groupHeadingFor,
  type SendToAgentRow,
  type SendToAgentRowInputs,
} from "../sendToAgentRows";

function pane(
  terminalId: string,
  worktreeId: string | null,
  overrides: Partial<PluginAgentPane> = {}
): PluginAgentPane {
  return {
    terminalId,
    title: `Claude: ${terminalId}`,
    agentId: "claude",
    worktree: worktreeId ? { id: worktreeId, name: `${worktreeId}-name` } : null,
    isFocused: false,
    canDraft: true,
    ...overrides,
  };
}

const AGENT = { agentId: "claude", agentName: "Claude" };

function rows(overrides: Partial<SendToAgentRowInputs>): SendToAgentRow[] {
  return buildSendToAgentRows({
    panes: [],
    requestedWorktreeId: undefined,
    activeWorktreeId: "wt-main",
    worktreeNames: new Map([
      ["wt-main", "main"],
      ["wt-feat", "feature"],
    ]),
    agent: AGENT,
    ...overrides,
  });
}

const ids = (list: SendToAgentRow[]) => list.map((row) => row.id);

describe("buildSendToAgentRows", () => {
  const panes = [
    pane("main-1", "wt-main", { isFocused: true }),
    pane("feat-1", "wt-feat"),
    pane("main-2", "wt-main"),
    pane("feat-2", "wt-feat"),
  ];

  it("groups agents by worktree and appends the two creation rows", () => {
    expect(ids(rows({ panes }))).toEqual([
      "main-1",
      "main-2",
      "feat-1",
      "feat-2",
      "new-here",
      "new-worktree",
    ]);
  });

  it("opens on an agent in the worktree the plugin named, ahead of the focused one", () => {
    const result = rows({ panes, requestedWorktreeId: "wt-feat" });
    expect(ids(result).slice(0, 4)).toEqual(["feat-1", "feat-2", "main-1", "main-2"]);
    expect(result.find((row) => row.kind === "new-here")).toMatchObject({
      worktreeId: "wt-feat",
      worktreeName: "feature",
    });
  });

  it("skips an agent that cannot draft when choosing what to open on", () => {
    const result = rows({
      panes: [
        pane("main-1", "wt-main", { isFocused: true }),
        pane("feat-locked", "wt-feat", { canDraft: false, draftRefusal: "input-locked" }),
        pane("feat-ok", "wt-feat"),
      ],
      requestedWorktreeId: "wt-feat",
    });
    const firstSelectable = result.find(canSelectSendToAgentRow);
    expect(firstSelectable?.id).toBe("feat-ok");
    expect(ids(result)).toContain("feat-locked");
  });

  it("starts the new agent in the active worktree when nothing else names one", () => {
    const result = rows({ panes: [] });
    expect(result.find((row) => row.kind === "new-here")).toMatchObject({
      worktreeId: "wt-main",
      worktreeName: "main",
    });
  });

  it("never offers New agent here in a worktree this project doesn't have", () => {
    const result = rows({ panes: [], requestedWorktreeId: "wt-other", activeWorktreeId: null });
    expect(ids(result)).toEqual(["new-worktree"]);
    const fallback = rows({ panes: [], requestedWorktreeId: "wt-other" });
    expect(fallback.find((row) => row.kind === "new-here")).toMatchObject({
      worktreeId: "wt-main",
    });
  });

  it("offers no creation rows when no agent can launch", () => {
    expect(ids(rows({ panes, agent: null }))).toEqual(["main-1", "main-2", "feat-1", "feat-2"]);
  });
});

describe("filterSendToAgentRows", () => {
  const all = rows({ panes: [pane("auth", "wt-main"), pane("billing", "wt-feat")] });

  it("narrows agents by title and keeps the creation rows", () => {
    expect(ids(filterSendToAgentRows(all, "billing"))).toEqual([
      "billing",
      "new-here",
      "new-worktree",
    ]);
  });

  it("keeps the creation rows when nothing matches", () => {
    expect(ids(filterSendToAgentRows(all, "zzzz"))).toEqual(["new-here", "new-worktree"]);
  });
});

describe("groupHeadingFor", () => {
  const list = rows({ panes: [pane("a", "wt-main"), pane("b", "wt-main"), pane("c", "wt-feat")] });

  it("heads each worktree's run once, and nothing else", () => {
    expect(list.map((_row, index) => groupHeadingFor(list, index, true))).toEqual([
      "wt-main-name",
      null,
      "wt-feat-name",
      null,
      null,
    ]);
  });

  it("draws no headings for a single worktree", () => {
    expect(list.map((_row, index) => groupHeadingFor(list, index, false))).toEqual(
      list.map(() => null)
    );
  });
});
