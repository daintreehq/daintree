import { describe, it, expect } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import { buildDestructivePreview } from "../destructiveSessionConfirm";

type PanelFields = Pick<PtyPanelData, "id"> &
  Partial<Pick<PtyPanelData, "worktreeId" | "detectedAgentId" | "agentState">>;

function panel(fields: PanelFields): PtyPanelData {
  return {
    kind: "terminal",
    location: "grid",
    title: "shell",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...fields,
  };
}

const titles = (id: string | undefined) => (id ? `wt:${id}` : undefined);

describe("buildDestructivePreview", () => {
  it("flags only terminals whose agent is observed working, not every agent terminal", () => {
    const groups = buildDestructivePreview(
      [
        panel({ id: "working", worktreeId: "a", detectedAgentId: "claude", agentState: "working" }),
        panel({ id: "waiting", worktreeId: "a", detectedAgentId: "claude", agentState: "waiting" }),
        panel({ id: "idle-agent", worktreeId: "a", detectedAgentId: "codex", agentState: "idle" }),
        panel({ id: "plain", worktreeId: "a" }),
      ],
      titles
    );
    const flagged = groups
      .flatMap((g) => g.terminals)
      .filter((t) => t.hasRunningAgent)
      .map((t) => t.terminalId);
    expect(flagged).toEqual(["working"]);
  });

  it("accounts for every target exactly once, grouped by worktree in first-seen order", () => {
    const ids = ["b1", "a1", "b2", "loose"];
    const input = [
      panel({ id: "b1", worktreeId: "b" }),
      panel({ id: "a1", worktreeId: "a" }),
      panel({ id: "b2", worktreeId: "b" }),
      panel({ id: "loose" }),
    ];
    const groups = buildDestructivePreview(input, titles, "Other terminals");
    expect(groups.map((g) => g.worktreeTitle)).toEqual(["wt:b", "wt:a", "Other terminals"]);
    const listed = groups.flatMap((g) => g.terminals.map((t) => t.terminalId)).sort();
    expect(listed).toEqual([...ids].sort());
  });

  it("lists working terminals ahead of the rest within each group", () => {
    const groups = buildDestructivePreview(
      [
        panel({ id: "idle-1", worktreeId: "a" }),
        panel({ id: "busy", worktreeId: "a", detectedAgentId: "claude", agentState: "working" }),
        panel({ id: "idle-2", worktreeId: "a" }),
      ],
      titles
    );
    const flags = groups[0]!.terminals.map((t) => t.hasRunningAgent);
    const firstIdle = flags.indexOf(false);
    expect(flags.slice(firstIdle).every((f) => !f)).toBe(true);
    expect(groups[0]!.terminals.map((t) => t.terminalId).filter((id) => id !== "busy")).toEqual([
      "idle-1",
      "idle-2",
    ]);
  });
});
