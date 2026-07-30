import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionSource } from "@shared/types/actions";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const projectStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@/store", () => ({ useProjectStore: projectStoreMock }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/clients", () => ({ systemClient: {} }));
vi.mock("@/clients/filesClient", () => ({ filesClient: {} }));

import { registerFileActions } from "../fileActions";

const addPanelSpy = vi.fn<(options: unknown) => Promise<string | null>>();
const activateTerminalSpy = vi.fn<(id: string) => void>();
const setFileViewModeSpy = vi.fn<(id: string, mode: string) => void>();

function setPanelState(
  panelsById: Record<string, Record<string, unknown>>,
  panelIds = Object.keys(panelsById)
) {
  panelStoreMock.getState.mockReturnValue({
    panelsById,
    panelIds,
    addPanel: addPanelSpy,
    activateTerminal: activateTerminalSpy,
    setFileViewMode: setFileViewModeSpy,
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
  registerFileActions(actions, callbacks);
  return async (id: string, args?: unknown, dispatchSource?: ActionSource): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, (dispatchSource ? { dispatchSource } : {}) as never);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  addPanelSpy.mockResolvedValue("new-panel-id");
  setPanelState({});
  setProjectPath("/repo");
});

describe("file.openPanel", () => {
  it("creates a new file panel with an absolute path", async () => {
    const run = setupActions("wt-1");
    const result = await run("file.openPanel", { path: "/repo/docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalledWith({
      kind: "file",
      filePath: "/repo/docs/spec.md",
      fileViewMode: undefined,
      worktreeId: "wt-1",
      location: "grid",
    });
    expect(result).toEqual({ panelId: "new-panel-id" });
  });

  it("resolves a repo-relative path against the current project root", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/repo/docs/spec.md" })
    );
  });

  it("prefers an explicit rootPath for relative resolution", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "notes.md", rootPath: "/elsewhere" });

    expect(addPanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/elsewhere/notes.md" })
    );
  });

  it("opens non-markdown files as panels", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "src/index.css" });

    expect(addPanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file", filePath: "/repo/src/index.css" })
    );
  });

  it("clamps a rendered request on a non-markdown file to source", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "src/index.css", viewMode: "rendered" });

    expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ fileViewMode: "source" }));
  });

  it("passes rendered through for markdown files", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "docs/spec.md", viewMode: "rendered" });

    expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ fileViewMode: "rendered" }));
  });

  it("passes rendered through for html files", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "dist/report.html", viewMode: "rendered" });

    expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ fileViewMode: "rendered" }));
  });

  it("passes rendered through for .htm files", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "dist/page.htm", viewMode: "rendered" });

    expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ fileViewMode: "rendered" }));
  });

  it("clamps a rendered request on a non-renderable file (.xhtml) to source", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "dist/page.xhtml", viewMode: "rendered" });

    expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ fileViewMode: "source" }));
  });

  it("reuses a panel already showing the same file instead of duplicating", async () => {
    setPanelState({
      "file-1": {
        id: "file-1",
        kind: "file",
        location: "grid",
        filePath: "/repo/docs/spec.md",
      },
    });
    const run = setupActions();
    const result = await run("file.openPanel", {
      path: "/repo/docs/spec.md",
      viewMode: "rendered",
    });

    expect(addPanelSpy).not.toHaveBeenCalled();
    expect(activateTerminalSpy).toHaveBeenCalledWith("file-1");
    expect(setFileViewModeSpy).toHaveBeenCalledWith("file-1", "rendered");
    expect(result).toEqual({ panelId: "file-1" });
  });

  it("does not reuse a trashed panel", async () => {
    setPanelState({
      "file-1": {
        id: "file-1",
        kind: "file",
        location: "trash",
        filePath: "/repo/docs/spec.md",
      },
    });
    const run = setupActions();
    await run("file.openPanel", { path: "/repo/docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalled();
    expect(activateTerminalSpy).not.toHaveBeenCalled();
  });

  it("does not reuse a backgrounded panel (hibernated, activation shows nothing)", async () => {
    setPanelState({
      "file-1": {
        id: "file-1",
        kind: "file",
        location: "background",
        filePath: "/repo/docs/spec.md",
      },
    });
    const run = setupActions();
    await run("file.openPanel", { path: "/repo/docs/spec.md" });

    expect(addPanelSpy).toHaveBeenCalled();
    expect(activateTerminalSpy).not.toHaveBeenCalled();
  });

  // #11506 — the store forces `preserve` (skipping both focus AND the exit from
  // fullscreen) whenever an MCP suppression lease is live or the assistant owns
  // focus. Those guards are about background spawns; a person asking for a file
  // has to see it, so a foreground dispatch overrides them with `take`.
  it.each<ActionSource>(["user", "keybinding", "menu", "context-menu"])(
    "takes focus for a %s dispatch so the panel can't land behind fullscreen",
    async (source) => {
      const run = setupActions();
      await run("file.openPanel", { path: "/repo/docs/spec.md" }, source);

      expect(addPanelSpy).toHaveBeenCalledWith(expect.objectContaining({ focusPolicy: "take" }));
    }
  );

  it.each<ActionSource>(["agent", "plugin"])(
    "leaves focus policy to the store for a %s dispatch",
    async (source) => {
      const run = setupActions();
      await run("file.openPanel", { path: "/repo/docs/spec.md" }, source);

      const options = addPanelSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      // Absent, not `undefined` — an explicit undefined would still short-circuit
      // the store's `options.focusPolicy ?? ...` resolution the same way, but it
      // reads as a decision the action never made.
      expect(Object.hasOwn(options, "focusPolicy")).toBe(false);
    }
  );

  it("leaves focus policy to the store when there is no dispatch context", async () => {
    const run = setupActions();
    await run("file.openPanel", { path: "/repo/docs/spec.md" });

    const options = addPanelSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(options, "focusPolicy")).toBe(false);
  });

  it("throws for a relative path with no project open and no rootPath", async () => {
    setProjectPath(undefined);
    const run = setupActions();
    await expect(run("file.openPanel", { path: "docs/spec.md" })).rejects.toThrow(
      /No project open/
    );
  });

  it("throws when the panel limit blocks creation", async () => {
    addPanelSpy.mockResolvedValue(null);
    const run = setupActions();
    await expect(run("file.openPanel", { path: "/repo/docs/spec.md" })).rejects.toThrow(
      /panel limit/
    );
  });
});
