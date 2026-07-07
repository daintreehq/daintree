import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: projectStoreMock }));

import { registerMarkdownActions } from "../markdownActions";

const addPanelSpy = vi.fn<(options: unknown) => Promise<string | null>>();
const activateTerminalSpy = vi.fn<(id: string) => void>();
const setMarkdownViewModeSpy = vi.fn<(id: string, mode: string) => void>();

function setPanelState(
  panelsById: Record<string, Record<string, unknown>>,
  panelIds = Object.keys(panelsById)
) {
  panelStoreMock.getState.mockReturnValue({
    panelsById,
    panelIds,
    addPanel: addPanelSpy,
    activateTerminal: activateTerminalSpy,
    setMarkdownViewMode: setMarkdownViewModeSpy,
  });
}

function setProjectPath(path: string | undefined) {
  projectStoreMock.getState.mockReturnValue({
    currentProject: path ? { id: "proj", path } : undefined,
  });
}

function setupActions(activeWorktreeId?: string) {
  const actions: ActionRegistry = new Map();
  const callbacks = { getActiveWorktreeId: () => activeWorktreeId } as ActionCallbacks;
  registerMarkdownActions(actions, callbacks);
  return async (id: string, args?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, {} as never);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  addPanelSpy.mockResolvedValue("new-panel-id");
  setPanelState({});
  setProjectPath("/repo");
});

describe("markdown.openPanel", () => {
  it("creates a new markdown panel with an absolute path", async () => {
    const run = setupActions("wt-1");
    const result = await run("markdown.openPanel", { path: "/repo/docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalledWith({
      kind: "markdown",
      markdownFilePath: "/repo/docs/spec.md",
      markdownViewMode: undefined,
      worktreeId: "wt-1",
      location: "grid",
    });
    expect(result).toEqual({ panelId: "new-panel-id" });
  });

  it("resolves a repo-relative path against the current project root", async () => {
    const run = setupActions();
    await run("markdown.openPanel", { path: "docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ markdownFilePath: "/repo/docs/spec.md" })
    );
  });

  it("prefers an explicit rootPath for relative resolution", async () => {
    const run = setupActions();
    await run("markdown.openPanel", { path: "notes.md", rootPath: "/elsewhere" });

    expect(addPanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ markdownFilePath: "/elsewhere/notes.md" })
    );
  });

  it("reuses a panel already showing the same file instead of duplicating", async () => {
    setPanelState({
      "md-1": {
        id: "md-1",
        kind: "markdown",
        location: "grid",
        markdownFilePath: "/repo/docs/spec.md",
      },
    });
    const run = setupActions();
    const result = await run("markdown.openPanel", {
      path: "/repo/docs/spec.md",
      viewMode: "source",
    });

    expect(addPanelSpy).not.toHaveBeenCalled();
    expect(activateTerminalSpy).toHaveBeenCalledWith("md-1");
    expect(setMarkdownViewModeSpy).toHaveBeenCalledWith("md-1", "source");
    expect(result).toEqual({ panelId: "md-1" });
  });

  it("does not reuse a trashed panel", async () => {
    setPanelState({
      "md-1": {
        id: "md-1",
        kind: "markdown",
        location: "trash",
        markdownFilePath: "/repo/docs/spec.md",
      },
    });
    const run = setupActions();
    await run("markdown.openPanel", { path: "/repo/docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalled();
    expect(activateTerminalSpy).not.toHaveBeenCalled();
  });

  it("throws for a relative path with no project open and no rootPath", async () => {
    setProjectPath(undefined);
    const run = setupActions();
    await expect(run("markdown.openPanel", { path: "docs/spec.md" })).rejects.toThrow(
      /No project open/
    );
  });

  it("throws when the panel limit blocks creation", async () => {
    addPanelSpy.mockResolvedValue(null);
    const run = setupActions();
    await expect(run("markdown.openPanel", { path: "/repo/docs/spec.md" })).rejects.toThrow(
      /panel limit/
    );
  });
});
