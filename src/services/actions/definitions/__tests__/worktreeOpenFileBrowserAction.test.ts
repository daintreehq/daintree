// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { WorktreeState } from "@/types";

const openPanelDialogMock = vi.hoisted(() =>
  vi.fn<(o: AddPanelOptions) => Promise<string | null>>()
);
const worktreesMock = vi.hoisted(() => ({ current: new Map<string, Partial<WorktreeState>>() }));

vi.mock("@/store/panelDialogStore", () => ({
  usePanelDialogStore: { getState: () => ({ openPanelDialog: openPanelDialogMock }) },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: worktreesMock.current }),
  }),
}));

vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: { openPath: vi.fn() },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../../actionTypes";
import { registerWorktreeContextActions } from "../worktreeContextActions";

function getAction() {
  const actions: ActionRegistry = new Map();
  const callbacks = { onInject: vi.fn() } as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  const factory = actions.get("worktree.openFileBrowser");
  if (!factory) throw new Error("worktree.openFileBrowser is not registered");
  return factory();
}

function seedWorktree(id: string, overrides: Partial<WorktreeState> = {}) {
  worktreesMock.current.set(id, { id, path: `/repo/${id}`, name: id, ...overrides });
}

/** The options the action passed to `openPanelDialog` on its only call. */
function dialogOptions() {
  expect(openPanelDialogMock).toHaveBeenCalledTimes(1);
  return openPanelDialogMock.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  worktreesMock.current = new Map();
  openPanelDialogMock.mockResolvedValue("fb-1");
});

describe("worktree.openFileBrowser", () => {
  it("opens a worktree browser for an explicit worktreeId", async () => {
    seedWorktree("wt-1", { branch: "feature/x" });
    await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

    expect(dialogOptions()).toMatchObject({
      kind: "file-browser",
      worktreeId: "wt-1",
      title: "Files — feature/x",
    });
  });

  it("prefers the focused worktree over the active one", async () => {
    seedWorktree("wt-focus");
    seedWorktree("wt-active");
    await getAction().run(undefined, {
      focusedWorktreeId: "wt-focus",
      activeWorktreeId: "wt-active",
    } as ActionContext);

    expect(dialogOptions()).toMatchObject({ worktreeId: "wt-focus" });
  });

  describe("workspace roots (#11482)", () => {
    it("opens the scratch folder when no worktree is in context", async () => {
      await getAction().run(undefined, {
        scratchId: "s-1",
        scratchName: "Scratch one",
        scratchPath: "/scratches/one",
      } as ActionContext);

      const options = dialogOptions();
      expect(options).toMatchObject({ kind: "file-browser", title: "Files — Scratch one" });
      // The absent worktreeId is the contract: it is what tells the pane and
      // main to resolve this view's own workspace folder.
      expect(options).not.toHaveProperty("worktreeId");
    });

    it("opens a worktree-less project's folder", async () => {
      await getAction().run(undefined, {
        projectId: "p-1",
        projectName: "Notes",
        projectPath: "/folders/notes",
      } as ActionContext);

      expect(dialogOptions()).toMatchObject({ title: "Files — Notes" });
      expect(dialogOptions()).not.toHaveProperty("worktreeId");
    });

    it("prefers a worktree over the workspace root when both resolve", async () => {
      seedWorktree("wt-1", { branch: "main" });
      await getAction().run(undefined, {
        activeWorktreeId: "wt-1",
        projectPath: "/folders/notes",
      } as ActionContext);

      expect(dialogOptions()).toMatchObject({ worktreeId: "wt-1" });
    });

    it("prefers the project path over a scratch path", async () => {
      // Both pointers are briefly set while a cached view catches up on a
      // switch broadcast; project-first mirrors `resolveWorkspaceCwd` (#11076).
      await getAction().run(undefined, {
        projectName: "Notes",
        projectPath: "/folders/notes",
        scratchName: "Scratch one",
        scratchPath: "/scratches/one",
      } as ActionContext);

      expect(dialogOptions()).toMatchObject({ title: "Files — Notes" });
    });

    it("names the folder from its basename when the workspace has no name", async () => {
      await getAction().run(undefined, { scratchPath: "/scratches/one" } as ActionContext);
      expect(dialogOptions()).toMatchObject({ title: "Files — one" });
    });
  });

  describe("fail-loud resolution", () => {
    it("throws rather than silently no-opping with nothing to browse", async () => {
      // A bare return still reports ok from dispatch, so the palette and the
      // launcher chip would both look like they worked.
      await expect(getAction().run(undefined, {} as ActionContext)).rejects.toThrow(
        /No folder to browse/
      );
      expect(openPanelDialogMock).not.toHaveBeenCalled();
    });

    it("throws on an explicit worktreeId that does not resolve", async () => {
      await expect(
        getAction().run({ worktreeId: "ghost" }, { projectPath: "/folders/notes" } as ActionContext)
      ).rejects.toThrow(/Worktree not found/);
    });

    it("never falls back to the workspace root for an unknown explicit worktree", async () => {
      // Opening the folder *above* the one asked for would be the wrong
      // folder, not a degraded one.
      await expect(
        getAction().run({ worktreeId: "ghost" }, { projectPath: "/folders/notes" } as ActionContext)
      ).rejects.toThrow();
      expect(openPanelDialogMock).not.toHaveBeenCalled();
    });

    it("throws for a stale focused worktree instead of widening to the project root", async () => {
      // A deleted worktree can stay focused after its row is gone; falling
      // through would silently browse the folder above it.
      await expect(
        getAction().run(undefined, {
          focusedWorktreeId: "wt-deleted",
          projectPath: "/folders/notes",
        } as ActionContext)
      ).rejects.toThrow(/Worktree not found/);
      expect(openPanelDialogMock).not.toHaveBeenCalled();
    });

    it("rejects an empty worktreeId rather than treating it as absent", () => {
      // `""` is falsy, so a truthiness-based presence check would skip the
      // unknown-worktree guard and open the workspace root instead.
      expect(() => getAction().argsSchema!.parse({ worktreeId: "" })).toThrow();
    });
  });

  describe("palette gate", () => {
    // `PaletteBehavior` is a union; only the requireContext arm carries
    // `isReady`, so narrow on the mode rather than casting.
    const isReady = (ctx: ActionContext) => {
      const palette = getAction().palette;
      return palette?.mode === "requireContext" ? palette.isReady(ctx) : false;
    };

    it("is ready for a worktree, a project or a scratch", () => {
      seedWorktree("wt-1");
      expect(isReady({ focusedWorktreeId: "wt-1" } as ActionContext)).toBe(true);
      expect(isReady({ activeWorktreeId: "wt-1" } as ActionContext)).toBe(true);
      expect(isReady({ projectPath: "/folders/notes" } as ActionContext)).toBe(true);
      expect(isReady({ scratchPath: "/scratches/one" } as ActionContext)).toBe(true);
    });

    it("is not ready with no workspace at all", () => {
      expect(isReady({} as ActionContext)).toBe(false);
    });

    it("gates the palette row rather than dispatch, so an explicit arg still runs", async () => {
      // `isEnabled` would gate dispatch from ActionContext alone and never see
      // args, refusing an explicit worktree while an empty context held focus.
      // Asserted behaviorally: empty context is not palette-ready, yet the same
      // empty context still dispatches an explicit worktree successfully.
      seedWorktree("wt-1");
      expect(isReady({} as ActionContext)).toBe(false);

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);
      expect(dialogOptions()).toMatchObject({ worktreeId: "wt-1" });
    });

    it("is not ready for a focused worktree that no longer exists", () => {
      // A stale id now makes `run` throw, so a readiness check that only tested
      // for a non-empty string would enable a row that cannot open anything.
      expect(isReady({ focusedWorktreeId: "wt-gone" } as ActionContext)).toBe(false);
    });
  });

  it("still expands ancestors for a reveal path", async () => {
    seedWorktree("wt-1");
    await getAction().run(
      { worktreeId: "wt-1", revealPath: "src/lib/app.ts" },
      {} as ActionContext
    );

    expect(dialogOptions()).toMatchObject({
      browserSelectedPath: "src/lib/app.ts",
      browserExpandedPaths: ["src", "src/lib"],
    });
  });
});
