import { beforeEach, describe, expect, it, vi } from "vitest";

const panelState = vi.hoisted(() => ({
  panelsById: {} as Record<string, unknown>,
  addPanel: vi.fn<(options: unknown) => Promise<string | null>>(),
}));
const assistantSlot = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => panelState },
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: { getState: () => ({}) },
  selectSlotForTerminal: () => assistantSlot.value,
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  __testing,
  isSuggestedCommandSource,
  runSuggestedCommand,
} from "../suggestedCommandRunner";

function seed(panel?: Record<string, unknown>): void {
  panelState.panelsById = panel ? { agent: { id: "agent", kind: "terminal", ...panel } } : {};
}

describe("suggestedCommandRunner", () => {
  beforeEach(() => {
    __testing.reset();
    assistantSlot.value = null;
    panelState.addPanel.mockReset();
    panelState.addPanel.mockResolvedValue("new-terminal");
    seed({ cwd: "/repo/wt", worktreeId: "wt" });
  });

  it("is live only while the pane runs Claude Code", () => {
    expect(isSuggestedCommandSource("agent", "claude")).toBe(true);
    expect(isSuggestedCommandSource("agent", "codex")).toBe(false);
    expect(isSuggestedCommandSource("agent", undefined)).toBe(false);
  });

  it("is not live in an assistant lane", () => {
    assistantSlot.value = "primary";
    expect(isSuggestedCommandSource("agent", "claude")).toBe(false);
  });

  it("is not live without a panel cwd to run in", () => {
    seed({ cwd: "" });
    expect(isSuggestedCommandSource("agent", "claude")).toBe(false);
    seed();
    expect(isSuggestedCommandSource("agent", "claude")).toBe(false);
  });

  it("opens a terminal in the agent's worktree running the command", () => {
    runSuggestedCommand("agent", "npm test -- foo");
    expect(panelState.addPanel).toHaveBeenCalledExactlyOnceWith({
      kind: "terminal",
      cwd: "/repo/wt",
      worktreeId: "wt",
      location: "grid",
      command: "npm test -- foo",
      spawnedBy: "quickrun",
    });
  });

  it("opens nothing when the source panel is gone", () => {
    seed();
    runSuggestedCommand("agent", "npm test");
    expect(panelState.addPanel).not.toHaveBeenCalled();
  });

  it("opens one terminal for a double click, and another once it settles", async () => {
    let settle: (id: string) => void = () => {};
    panelState.addPanel.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));
    runSuggestedCommand("agent", "npm test");
    runSuggestedCommand("agent", "npm test");
    expect(panelState.addPanel).toHaveBeenCalledTimes(1);

    settle("new-terminal");
    await vi.waitFor(() => {
      runSuggestedCommand("agent", "npm test");
      expect(panelState.addPanel).toHaveBeenCalledTimes(2);
    });
  });

  it("releases the guard when the spawn fails", async () => {
    panelState.addPanel.mockRejectedValueOnce(new Error("spawn failed"));
    runSuggestedCommand("agent", "npm test");
    await vi.waitFor(() => {
      runSuggestedCommand("agent", "npm test");
      expect(panelState.addPanel).toHaveBeenCalledTimes(2);
    });
  });
});
