// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { PanelInstance, TabGroup } from "@shared/types/panel";
import type { WorktreeState } from "@/types";

const addPanelMock = vi.hoisted(() => vi.fn<(o: AddPanelOptions) => Promise<string | null>>());
const activateTerminalMock = vi.hoisted(() => vi.fn<(id: string) => void>());
const setActiveTabMock = vi.hoisted(() => vi.fn<(groupId: string, panelId: string) => void>());
const getPanelGroupMock = vi.hoisted(() => vi.fn<(id: string) => TabGroup | undefined>());
const setFileBrowserViewMock = vi.hoisted(() =>
  vi.fn<(id: string, patch: Record<string, unknown>) => void>()
);
const openPanelDialogMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
const selectWorktreeMock = vi.hoisted(() =>
  vi.fn<(id: string, options?: { source?: string }) => void>()
);
const activeWorktreeIdMock = vi.hoisted(() => ({ current: null as string | null }));
// `panelIds` and `panelsById` are seeded independently, not derived from one
// list: a spawn or hydration batch commits the map first and defers the id
// append, and a fixture that ties them together cannot express that state.
const panelsMock = vi.hoisted(() => ({
  byId: [] as PanelInstance[],
  /** `null` = mirror `byId` (the committed, non-batched case). */
  ids: null as string[] | null,
}));
const worktreesMock = vi.hoisted(() => ({ current: new Map<string, Partial<WorktreeState>>() }));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelIds: panelsMock.ids ?? panelsMock.byId.map((panel) => panel.id),
      panelsById: Object.fromEntries(panelsMock.byId.map((panel) => [panel.id, panel])),
      addPanel: addPanelMock,
      activateTerminal: activateTerminalMock,
      setActiveTab: setActiveTabMock,
      getPanelGroup: getPanelGroupMock,
      setFileBrowserView: setFileBrowserViewMock,
    }),
  },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: activeWorktreeIdMock.current,
      selectWorktree: selectWorktreeMock,
    }),
  },
}));

// Reachable, not a black hole: the panel action must never present a dialog,
// and an inaccessible `vi.fn()` here would let it do so silently — `await
// undefined` is harmless, so every assertion would still pass.
vi.mock("@/store/panelDialogStore", () => ({
  usePanelDialogStore: { getState: () => ({ openPanelDialog: openPanelDialogMock }) },
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
  panelsMock.byId = [];
  panelsMock.ids = null;
  activeWorktreeIdMock.current = null;
  getPanelGroupMock.mockReturnValue(undefined);
  addPanelMock.mockResolvedValue("fb-panel-1");
});

afterEach(() => {
  // A suite-wide invariant rather than one test: this action opens a grid
  // panel, and the whole point of the split is that it never presents the
  // ephemeral dialog its sibling owns — on any path, including the failures.
  expect(openPanelDialogMock).not.toHaveBeenCalled();
});

describe("worktree.openFileBrowserPanel", () => {
  describe("target resolution", () => {
    it("opens a grid panel for an explicit worktreeId", async () => {
      seedWorktree("wt-1", { branch: "feature/x" });
      const result = await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      const options = addPanelOptions();
      expect(options).toMatchObject({
        kind: "file-browser",
        worktreeId: "wt-1",
        title: "Files — feature/x",
        location: "grid",
      });
      // The marker's absence is what makes this a WORKTREE browser: the
      // defaults factory treats either the marker or a missing worktreeId as
      // workspace-rooted, and the pane then ignores the worktreeId entirely —
      // so stamping it here would browse the workspace root while every other
      // assertion above still passed (#11489).
      expect(options).not.toHaveProperty("browserWorkspaceRooted");
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
      panelsMock.byId = [browserPanel("fb-existing", { worktreeId: "wt-1" })];

      const result = await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelMock).not.toHaveBeenCalled();
      expect(activateTerminalMock).toHaveBeenCalledWith("fb-existing");
      expect(result).toEqual({ panelId: "fb-existing" });
    });

    it("reuses a workspace-rooted browser for a workspace-rooted request", async () => {
      panelsMock.byId = [browserPanel("fb-workspace", { browserWorkspaceRooted: true })];

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
      panelsMock.byId = [
        browserPanel("fb-workspace", { worktreeId: "wt-1", browserWorkspaceRooted: true }),
      ];

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelOptions()).toMatchObject({ worktreeId: "wt-1" });
      expect(activateTerminalMock).not.toHaveBeenCalled();
    });

    it("reuses a workspace-rooted browser that carries a placement worktreeId", async () => {
      // The mirror of the case above: once promotion stamps a worktreeId on it,
      // the marker is the only thing still identifying it as the workspace
      // browser, so a workspace request must follow the marker, not the id.
      panelsMock.byId = [
        browserPanel("fb-workspace", { worktreeId: "wt-1", browserWorkspaceRooted: true }),
      ];

      const result = await getAction().run(undefined, {
        projectPath: "/folders/notes",
      } as ActionContext);

      expect(addPanelMock).not.toHaveBeenCalled();
      expect(result).toEqual({ panelId: "fb-workspace" });
    });

    it("does not hand a workspace request a worktree browser", async () => {
      panelsMock.byId = [browserPanel("fb-worktree", { worktreeId: "wt-1" })];

      await getAction().run(undefined, { projectPath: "/folders/notes" } as ActionContext);

      expect(addPanelOptions()).not.toHaveProperty("worktreeId");
      expect(activateTerminalMock).not.toHaveBeenCalled();
    });

    it("does not reuse a browser for a different worktree", async () => {
      seedWorktree("wt-1");
      seedWorktree("wt-2");
      panelsMock.byId = [browserPanel("fb-other", { worktreeId: "wt-2" })];

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelOptions()).toMatchObject({ worktreeId: "wt-1" });
    });

    it("finds a browser still pending a spawn batch's id append", async () => {
      // A spawn or hydration batch commits `panelsById` immediately and defers
      // the `panelIds` append to its flush. Scanning the committed list alone
      // would miss a browser opened moments earlier and duplicate it.
      seedWorktree("wt-1");
      panelsMock.byId = [browserPanel("fb-pending", { worktreeId: "wt-1" })];
      panelsMock.ids = [];

      const result = await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(addPanelMock).not.toHaveBeenCalled();
      expect(result).toEqual({ panelId: "fb-pending" });
    });

    it("surfaces a reused browser that sits behind a sibling tab", async () => {
      // Activation moves `focusedId`, but a group renders its own stored active
      // tab in preference to it — so without this the browser stays hidden
      // behind whatever tab the group was showing.
      seedWorktree("wt-1");
      panelsMock.byId = [browserPanel("fb-tabbed", { worktreeId: "wt-1" })];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture: only the id is read
      getPanelGroupMock.mockReturnValue({ id: "group-1", activeTabId: "other" } as TabGroup);

      await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

      expect(setActiveTabMock).toHaveBeenCalledWith("group-1", "fb-tabbed");
    });

    it.each(["dialog", "trash", "background", "dock", "overlay"] as const)(
      "does not reuse a %s browser",
      async (location) => {
        // None of these surface anything when activated, and reusing a dialog
        // record in particular would hand the grid an uncounted, unpersisted
        // panel instead of opening a real one.
        seedWorktree("wt-1");
        panelsMock.byId = [browserPanel("fb-hidden", { worktreeId: "wt-1", location })];

        await getAction().run({ worktreeId: "wt-1" }, {} as ActionContext);

        expect(addPanelOptions()).toMatchObject({ worktreeId: "wt-1" });
        expect(activateTerminalMock).not.toHaveBeenCalled();
      }
    );

    it("does not reuse a panel of another kind", async () => {
      seedWorktree("wt-1");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixture
      panelsMock.byId = [
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
      panelsMock.byId = [
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
        // The target is outside the scoped root, so the scope has to go or the
        // selection would name a row the tree does not contain.
        browserRootPath: "",
      });
      expect(activateTerminalMock).toHaveBeenCalledWith("fb-existing");
    });

    it("keeps a scoped root when the revealed path is already inside it", async () => {
      // Dropping a scope the user chose is not part of revealing something they
      // can already see.
      seedWorktree("wt-1");
      panelsMock.byId = [
        browserPanel("fb-existing", { worktreeId: "wt-1", browserRootPath: "packages/app" }),
      ];

      await getAction().run(
        { worktreeId: "wt-1", revealPath: "packages/app/src/main.ts" },
        {} as ActionContext
      );

      expect(setFileBrowserViewMock.mock.calls[0]![1]).not.toHaveProperty("browserRootPath");
    });

    it("does not mistake a sibling directory for a child of the scoped root", async () => {
      // A prefix comparison would call `packages/apply/x.ts` a child of
      // `packages/app` and leave the tree scoped where the row cannot appear.
      seedWorktree("wt-1");
      panelsMock.byId = [
        browserPanel("fb-existing", { worktreeId: "wt-1", browserRootPath: "packages/app" }),
      ];

      await getAction().run(
        { worktreeId: "wt-1", revealPath: "packages/apply/x.ts" },
        {} as ActionContext
      );

      expect(setFileBrowserViewMock.mock.calls[0]![1]).toMatchObject({ browserRootPath: "" });
    });

    it("leaves a reused panel's view untouched when nothing is revealed", async () => {
      seedWorktree("wt-1");
      panelsMock.byId = [
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

  describe("visibility of the target worktree", () => {
    it("follows a person to the worktree they asked to browse", async () => {
      // The grid renders only the active worktree's bucket, so a panel created
      // for any other worktree is backgrounded on arrival — dispatch would
      // report ok with nothing on screen.
      seedWorktree("wt-other");
      activeWorktreeIdMock.current = "wt-active";

      await getAction().run({ worktreeId: "wt-other" }, {
        dispatchSource: "context-menu",
      } as ActionContext);

      expect(selectWorktreeMock).toHaveBeenCalledWith("wt-other", { source: "user" });
    });

    it("does not move the user for an agent dispatch", async () => {
      seedWorktree("wt-other");
      activeWorktreeIdMock.current = "wt-active";

      await getAction().run({ worktreeId: "wt-other" }, {
        dispatchSource: "agent",
      } as ActionContext);

      expect(selectWorktreeMock).not.toHaveBeenCalled();
    });

    it("does not re-select the worktree already showing", async () => {
      // Selecting re-persists the restore target and touches the MRU; browsing
      // the worktree you are already in is not a navigation worth recording.
      seedWorktree("wt-1");
      activeWorktreeIdMock.current = "wt-1";

      await getAction().run({ worktreeId: "wt-1" }, { dispatchSource: "user" } as ActionContext);

      expect(selectWorktreeMock).not.toHaveBeenCalled();
    });

    it("has no worktree to select for a workspace-rooted open", async () => {
      await getAction().run(undefined, {
        dispatchSource: "user",
        projectPath: "/folders/notes",
      } as ActionContext);

      expect(selectWorktreeMock).not.toHaveBeenCalled();
    });
  });

  describe("panel ceiling", () => {
    it("throws a refusal the callers can recognise as already reported", async () => {
      // Thrown, not a bare return: a silent refusal reports ok from dispatch
      // with nothing on screen. Asserted through the classifier the callers
      // actually use, so the two cannot drift apart into a message that is
      // raised but no longer suppresses the misleading follow-up toast.
      seedWorktree("wt-1");
      addPanelMock.mockResolvedValue(null);
      const { isPanelLimitError } = await import("../panelLimitError");

      const error = await getAction()
        .run({ worktreeId: "wt-1" }, {} as ActionContext)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
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
