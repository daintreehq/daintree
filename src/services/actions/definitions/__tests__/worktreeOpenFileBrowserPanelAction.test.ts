// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { PanelInstance } from "@shared/types/panel";
import type { WorktreeState } from "@/types";

const addPanelMock = vi.hoisted(() => vi.fn<(o: AddPanelOptions) => Promise<string | null>>());
const activateTerminalMock = vi.hoisted(() => vi.fn<(id: string) => void>());
const setFileBrowserViewMock = vi.hoisted(() =>
  vi.fn<(id: string, patch: Record<string, unknown>) => void>()
);
const panelsMock = vi.hoisted(() => ({ current: [] as PanelInstance[] }));
const worktreesMock = vi.hoisted(() => ({ current: new Map<string, Partial<WorktreeState>>() }));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelIds: panelsMock.current.map((panel) => panel.id),
      panelsById: Object.fromEntries(panelsMock.current.map((panel) => [panel.id, panel])),
      addPanel: addPanelMock,
      activateTerminal: activateTerminalMock,
      setFileBrowserView: setFileBrowserViewMock,
    }),
  },
}));

// The dialog sibling shares this module's registration call, so its lazy import
// must resolve even though nothing here exercises it.
vi.mock("@/store/panelDialogStore", () => ({
  usePanelDialogStore: { getState: () => ({ openPanelDialog: vi.fn() }) },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: worktreesMock.current }),
  }),
  getCurrentViewStoreOrNull: () => ({
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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial callbacks: only onInject is reachable here
  const callbacks = { onInject: vi.fn() } as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  const factory = actions.get("worktree.openFileBrowserPanel");
  if (!factory) throw new Error("worktree.openFileBrowserPanel is not registered");
  return factory();
}

function seedWorktree(id: string, overrides: Partial<WorktreeState> = {}) {
  worktreesMock.current.set(id, { id, path: `/repo/${id}`, name: id, ...overrides });
}

/** A file-browser panel record as the registry would hold it. */
function browserPanel(id: string, fields: Partial<PanelInstance> = {}): PanelInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: only the fields the dedup scan reads
  return { id, kind: "file-browser", title: id, location: "grid", ...fields } as PanelInstance;
}

/** The options the action passed to `addPanel` on its only call. */
function addPanelOptions() {
  expect(addPanelMock).toHaveBeenCalledTimes(1);
  return addPanelMock.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  worktreesMock.current = new Map();
  panelsMock.current = [];
  addPanelMock.mockResolvedValue("fb-panel-1");
});

describe("worktree.openFileBrowserPanel", () => {
  describe("target resolution", () => {
    it("opens a grid panel for an explicit worktreeId", async () => {
      seedWorktree("wt-1", { branch: "feature/x" });
      const result = await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelOptions()).toMatchObject({
        kind: "file-browser",
        worktreeId: "wt-1",
        title: "Files — feature/x",
        location: "grid",
      });
      expect(result).toEqual({ panelId: "fb-panel-1" });
    });

    it("prefers the focused worktree over the active one", async () => {
      seedWorktree("wt-focus");
      seedWorktree("wt-active");
      await getAction().run(undefined, {
        focusedWorktreeId: "wt-focus",
        activeWorktreeId: "wt-active",
      } as ActionContext);

      expect(addPanelOptions()).toMatchObject({ worktreeId: "wt-focus" });
    });

    it("opens the workspace root when no worktree is in context", async () => {
      await getAction().run(undefined, {
        projectName: "Notes",
        projectPath: "/folders/notes",
      } as ActionContext);

      const options = addPanelOptions();
      expect(options).toMatchObject({ title: "Files — Notes", location: "grid" });
      // Both absences are the contract: no `worktreeId` is what tells the
      // create path to resolve this view's own workspace folder, and
      // `browserWorkspaceRooted` is derived from that absence rather than
      // passed — an opener that stamped it would be deciding placement
      // metadata it has no business deciding (#11489).
      expect(options).not.toHaveProperty("worktreeId");
      expect(options).not.toHaveProperty("browserWorkspaceRooted");
    });

    it("throws rather than silently no-opping with nothing to browse", async () => {
      await expect(getAction().run(undefined, {} as ActionContext)).rejects.toThrow(
        /No folder to browse/
      );
      expect(addPanelMock).not.toHaveBeenCalled();
    });

    it("throws on an explicit worktreeId that does not resolve", async () => {
      await expect(
        getAction().run({ worktreeId: "ghost" }, { projectPath: "/folders/notes" } as ActionContext)
      ).rejects.toThrow(/Worktree not found/);
      // Never the folder *above* the one named — the wrong folder, not a
      // degraded one.
      expect(addPanelMock).not.toHaveBeenCalled();
    });

    it("throws for a stale focused worktree instead of widening to the project root", async () => {
      await expect(
        getAction().run(undefined, {
          focusedWorktreeId: "wt-deleted",
          projectPath: "/folders/notes",
        } as ActionContext)
      ).rejects.toThrow(/Worktree not found/);
      expect(addPanelMock).not.toHaveBeenCalled();
    });
  });

  describe("focus policy", () => {
    it("takes focus on a foreground dispatch", async () => {
      seedWorktree("wt-1");
      await getAction().run({ worktreeId: "wt-1" }, {
        dispatchSource: "user",
      } as ActionContext);

      expect(addPanelOptions()).toMatchObject({ focusPolicy: "take" });
    });

    it("leaves focus to the store for an agent dispatch", async () => {
      seedWorktree("wt-1");
      await getAction().run({ worktreeId: "wt-1" }, {
        dispatchSource: "agent",
      } as ActionContext);

      // Omitted entirely rather than set to a passive value: the store's own
      // "auto" vs "preserve" resolution is what keeps a background open from
      // stealing focus from a typing user.
      expect(addPanelOptions()).not.toHaveProperty("focusPolicy");
    });
  });

  describe("reuse", () => {
    it("focuses the existing browser for the same worktree instead of opening a second", async () => {
      seedWorktree("wt-1");
      panelsMock.current = [browserPanel("fb-existing", { worktreeId: "wt-1" })];

      const result = await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelMock).not.toHaveBeenCalled();
      expect(activateTerminalMock).toHaveBeenCalledWith("fb-existing");
      expect(result).toEqual({ panelId: "fb-existing" });
    });

    it("reuses a workspace-rooted browser for a workspace-rooted request", async () => {
      panelsMock.current = [browserPanel("fb-workspace", { browserWorkspaceRooted: true })];

      const result = await getAction().run(undefined, {
        projectPath: "/folders/notes",
      } as ActionContext);

      expect(addPanelMock).not.toHaveBeenCalled();
      expect(result).toEqual({ panelId: "fb-workspace" });
    });

    it("keeps a workspace-rooted browser distinct from a worktree request that shares its placement id", async () => {
      // Placement stamps the active worktree onto a workspace-rooted panel so
      // it lands in a rendered index bucket (#11489). Matching on that id would
      // hand a worktree request the workspace browser — a different folder.
      seedWorktree("wt-1");
      panelsMock.current = [
        browserPanel("fb-workspace", { worktreeId: "wt-1", browserWorkspaceRooted: true }),
      ];

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelOptions()).toMatchObject({ worktreeId: "wt-1" });
      expect(activateTerminalMock).not.toHaveBeenCalled();
    });

    it("does not reuse a browser for a different worktree", async () => {
      seedWorktree("wt-1");
      seedWorktree("wt-2");
      panelsMock.current = [browserPanel("fb-other", { worktreeId: "wt-2" })];

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelOptions()).toMatchObject({ worktreeId: "wt-1" });
    });

    it.each(["dialog", "trash", "background", "dock", "overlay"] as const)(
      "does not reuse a %s browser",
      async (location) => {
        // None of these surface anything when activated, and reusing a dialog
        // record in particular would hand the grid an uncounted, unpersisted
        // panel instead of opening a real one.
        seedWorktree("wt-1");
        panelsMock.current = [browserPanel("fb-hidden", { worktreeId: "wt-1", location })];

        await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

        expect(addPanelOptions()).toMatchObject({ worktreeId: "wt-1" });
        expect(activateTerminalMock).not.toHaveBeenCalled();
      }
    );

    it("does not reuse a panel of another kind", async () => {
      seedWorktree("wt-1");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture
      panelsMock.current = [
        { id: "file-1", kind: "file", location: "grid", worktreeId: "wt-1" } as PanelInstance,
      ];

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("reveal", () => {
    it("expands ancestors of a reveal path on a fresh panel", async () => {
      seedWorktree("wt-1");
      await getAction().run(
        { worktreeId: "wt-1", revealPath: "src/lib/app.ts" },
        {} as ActionContext
      );

      expect(addPanelOptions()).toMatchObject({
        browserSelectedPath: "src/lib/app.ts",
        browserExpandedPaths: ["src", "src/lib"],
      });
    });

    it("normalizes a Windows-shaped reveal path", async () => {
      // Row keys and `ancestorDirectories` both speak forward slashes, so a
      // backslash path would select nothing at all.
      seedWorktree("wt-1");
      await getAction().run(
        { worktreeId: "wt-1", revealPath: "src\\lib\\app.ts" },
        {} as ActionContext
      );

      expect(addPanelOptions()).toMatchObject({ browserSelectedPath: "src/lib/app.ts" });
    });

    it("applies a reveal to a reused panel rather than dropping it", async () => {
      seedWorktree("wt-1");
      panelsMock.current = [
        browserPanel("fb-existing", {
          worktreeId: "wt-1",
          browserExpandedPaths: ["docs"],
          browserRootPath: "packages/app",
        }),
      ];

      await getAction().run(
        { worktreeId: "wt-1", revealPath: "src/lib/app.ts" },
        {} as ActionContext
      );

      expect(setFileBrowserViewMock).toHaveBeenCalledWith("fb-existing", {
        browserSelectedPath: "src/lib/app.ts",
        // The user's own expansion survives — a reveal adds to what is open.
        browserExpandedPaths: ["docs", "src", "src/lib"],
        // A reveal path is resolved from the worktree root, so a re-rooted tree
        // would select a row that is not in it.
        browserRootPath: "",
      });
      expect(activateTerminalMock).toHaveBeenCalledWith("fb-existing");
    });

    it("leaves a reused panel's view untouched when nothing is revealed", async () => {
      seedWorktree("wt-1");
      panelsMock.current = [
        browserPanel("fb-existing", { worktreeId: "wt-1", browserRootPath: "packages/app" }),
      ];

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(setFileBrowserViewMock).not.toHaveBeenCalled();
      expect(activateTerminalMock).toHaveBeenCalledWith("fb-existing");
    });

    it("treats a reveal of the root as no reveal at all", async () => {
      // Revealing the root passes no path while still carrying a revealKind —
      // which is exactly why presence of a reveal cannot pick the surface.
      seedWorktree("wt-1");
      await getAction().run(
        { worktreeId: "wt-1", revealPath: "", revealKind: "directory" },
        {} as ActionContext
      );

      expect(addPanelOptions()).not.toHaveProperty("browserSelectedPath");
    });

    it("expands a revealed directory itself, not just its ancestors", async () => {
      seedWorktree("wt-1");
      await getAction().run(
        { worktreeId: "wt-1", revealPath: "src/lib", revealKind: "directory" },
        {} as ActionContext
      );

      expect(addPanelOptions()).toMatchObject({ browserExpandedPaths: ["src", "src/lib"] });
    });
  });

  describe("panel ceiling", () => {
    it("throws when the grid refuses the panel", async () => {
      // A bare return would report ok from dispatch with nothing on screen.
      seedWorktree("wt-1");
      addPanelMock.mockResolvedValue(null);

      await expect(getAction().run({ worktreeId: "wt-1" }, {} as ActionContext)).rejects.toThrow(
        /panel limit reached/
      );
    });

    it("throws a message the callers can recognise as the already-reported refusal", async () => {
      seedWorktree("wt-1");
      addPanelMock.mockResolvedValue(null);
      const { isPanelLimitError } = await import("../panelLimitError");

      const error = await getAction()
        .run({ worktreeId: "wt-1" }, {} as ActionContext)
        .catch((e: unknown) => e);

      expect(isPanelLimitError(error instanceof Error ? error.message : undefined)).toBe(true);
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
      seedWorktree("wt-1");
      expect(isReady({} as ActionContext)).toBe(false);

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);
      expect(addPanelOptions()).toMatchObject({ worktreeId: "wt-1" });
    });

    it("is not ready for a focused worktree that no longer exists", () => {
      // A stale id now makes `run` throw, so a readiness check that only tested
      // for a non-empty string would enable a row that cannot open anything.
      expect(isReady({ focusedWorktreeId: "wt-gone" } as ActionContext)).toBe(false);
    });

    it("rejects an empty worktreeId rather than treating it as absent", () => {
      // `""` is falsy, so a truthiness-based presence check would skip the
      // unknown-worktree guard and open the workspace root instead.
      expect(() => getAction().argsSchema!.parse({ worktreeId: "" })).toThrow();
    });
  });
});
