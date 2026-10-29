// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import type { TerminalRecipe } from "@/types";

interface MockProject {
  id: string;
  path: string;
}

const {
  refreshMock,
  forgeState,
  BOTH_FORGES,
  projectState,
  MANAGER_RECIPE,
  surfaceState,
  switchedState,
} = vi.hoisted(() => {
  const MANAGER_RECIPE: TerminalRecipe = {
    id: "recipe-managed",
    name: "Managed",
    projectId: "project-1",
    worktreeId: "wt-3",
    terminals: [],
    createdAt: 0,
  };
  const BOTH_FORGES = {
    entry: { contribution: { slots: { bulkCreateWorktreeDialog: "code-forge.bulk" } } },
    issues: {
      entry: { contribution: { slots: { bulkCreateWorktreeDialog: "issue-forge.bulk" } } },
    },
  };
  return {
    refreshMock: vi.fn(() => Promise.resolve()),
    forgeState: { current: BOTH_FORGES as unknown },
    BOTH_FORGES,
    projectState: { current: null as MockProject | null },
    MANAGER_RECIPE,
    surfaceState: { current: null as { config: { id: string } } | null },
    switchedState: { current: null as { config: { id: string } } | null },
  };
});

// Seeded before each render; nothing here changes the project mid-test.
vi.mock("@/store/projectStore", () => ({
  useProjectStore: <T,>(selector: (state: { currentProject: MockProject | null }) => T) =>
    selector({ currentProject: projectState.current }),
}));

vi.mock("@/components/Plugin/ProjectSurfaceView", () => ({
  useProjectSurface: () => surfaceState.current,
  useSurfaceSwitchedToStock: () => switchedState.current,
}));

// `onUseStock` stands for the dialog's `onCloseComplete`: the real dialog calls
// it once its exit has finished and focus is back on the opener.
vi.mock("../ProjectWorktreeCreateDialog", () => ({
  ProjectWorktreeCreateDialog: ({
    config,
    leavingForStock,
    onClose,
    onUseStock,
  }: {
    config: { id: string };
    leavingForStock?: boolean;
    onClose: () => void;
    onUseStock: () => void;
  }) => (
    <div
      data-testid="plugin-create-dialog"
      data-kind={config.id}
      data-leaving={String(leavingForStock === true)}
    >
      <button onClick={onUseStock}>standard dialog</button>
      <button onClick={onClose}>close plugin</button>
    </div>
  ),
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ refresh: refreshMock }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => forgeState.current,
}));

vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: (slotId: string) =>
    slotId
      ? ({ mode, onClose }: { mode: string; onClose: () => void }) => (
          <div data-testid="bulk-create-dialog" data-slot={slotId} data-mode={mode}>
            <button onClick={onClose}>close bulk</button>
          </div>
        )
      : null,
}));

vi.mock("@/components/Worktree/NewWorktreeDialog", () => ({
  NewWorktreeDialog: ({
    isOpen,
    rootPath,
    onClose,
    onWorktreeCreated,
  }: {
    isOpen: boolean;
    rootPath: string;
    onClose: () => void;
    onWorktreeCreated: (id: string) => void;
  }) => (
    <div data-testid="new-worktree-dialog" data-open={String(isOpen)} data-root={rootPath}>
      <button onClick={() => onWorktreeCreated("wt-new")}>create</button>
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

vi.mock("@/components/Fleet/FleetPickerPalette", () => ({
  FleetPickerPalette: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => (
    <div data-testid="fleet-picker" data-open={String(isOpen)}>
      <button onClick={onClose}>close fleet</button>
    </div>
  ),
}));

vi.mock("@/components/TerminalRecipe/RecipeEditor", () => ({
  RecipeEditor: ({
    isOpen,
    recipe,
    worktreeId,
    initialTerminals,
    layoutOmissions,
    defaultScope,
    onClose,
  }: {
    isOpen: boolean;
    recipe?: { id: string };
    worktreeId?: string;
    initialTerminals?: unknown[];
    layoutOmissions?: unknown;
    defaultScope?: string;
    onClose: () => void;
  }) => (
    <div
      data-testid="recipe-editor"
      data-open={String(isOpen)}
      data-recipe={recipe?.id ?? ""}
      data-worktree={worktreeId ?? ""}
      data-terminals={String(initialTerminals?.length ?? 0)}
      data-omissions={layoutOmissions ? JSON.stringify(layoutOmissions) : ""}
      data-scope={defaultScope ?? ""}
    >
      <button onClick={onClose}>close recipe editor</button>
    </div>
  ),
}));

vi.mock("@/components/TerminalRecipe/RecipeManager", () => ({
  RecipeManager: ({
    isOpen,
    onEditRecipe,
    onCreateRecipe,
  }: {
    isOpen: boolean;
    onEditRecipe: (recipe: TerminalRecipe) => void;
    onCreateRecipe: (scope: "global" | "project") => void;
  }) => (
    <div data-testid="recipe-manager" data-open={String(isOpen)}>
      <button onClick={() => onEditRecipe(MANAGER_RECIPE)}>edit recipe</button>
      <button onClick={() => onCreateRecipe("project")}>new project recipe</button>
    </div>
  ),
}));

import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetPickerPaletteStore } from "@/store/fleetPickerPaletteStore";
import { useRecipeEditorActivityStore } from "@/store/recipeEditorActivityStore";
import { useRecipeStore } from "@/store/recipeStore";
import { ProjectDialogHost } from "../ProjectDialogHost";

const initialSelectionState = useWorktreeSelectionStore.getState();
const initialGetRecipeById = useRecipeStore.getState().getRecipeById;

function setProject(project: MockProject | null) {
  projectState.current = project;
}

describe("ProjectDialogHost", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    forgeState.current = BOTH_FORGES;
    setProject({ id: "project-1", path: "/repo" });
    surfaceState.current = null;
    switchedState.current = null;
    useWorktreeSelectionStore.setState(initialSelectionState, true);
    useFleetPickerPaletteStore.setState({ isOpen: false });
    useRecipeEditorActivityStore.setState({ openCount: 0 });
  });

  afterEach(() => {
    cleanup();
    useRecipeStore.setState({ getRecipeById: initialGetRecipeById });
  });

  describe("New worktree dialog", () => {
    it("mounts on worktree.createDialog.open's store write, rooted at the project", async () => {
      render(<ProjectDialogHost />);
      expect(screen.queryByTestId("new-worktree-dialog")).toBeNull();

      act(() => useWorktreeSelectionStore.getState().openCreateDialog());

      const dialog = await screen.findByTestId("new-worktree-dialog");
      expect(dialog.dataset.open).toBe("true");
      expect(dialog.dataset.root).toBe("/repo");
    });

    it("keeps the same dialog mounted, closed, after it closes so its exit can play", async () => {
      render(<ProjectDialogHost />);
      act(() => useWorktreeSelectionStore.getState().openCreateDialog());
      const dialog = await screen.findByTestId("new-worktree-dialog");

      fireEvent.click(screen.getByText("close"));

      expect(useWorktreeSelectionStore.getState().createDialog.isOpen).toBe(false);
      expect(screen.getByTestId("new-worktree-dialog")).toBe(dialog);
      expect(dialog.dataset.open).toBe("false");
    });

    it("refreshes the worktree list and hands the new id to the opener", async () => {
      const onCreated = vi.fn();
      render(<ProjectDialogHost />);
      act(() => useWorktreeSelectionStore.getState().openCreateDialog(null, { onCreated }));
      fireEvent.click(await screen.findByText("create"));

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith("wt-new");
    });

    it("does not mount without a project path, while the other dialogs still open", async () => {
      // A scratch workspace has a root but no project path to create a
      // worktree under; the guard is the New worktree dialog's alone.
      setProject(null);
      render(<ProjectDialogHost />);
      act(() => useWorktreeSelectionStore.getState().openCreateDialog());
      act(() => useFleetPickerPaletteStore.getState().open());
      act(() => {
        window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"));
      });

      expect((await screen.findByTestId("fleet-picker")).dataset.open).toBe("true");
      expect((await screen.findByTestId("recipe-manager")).dataset.open).toBe("true");
      expect(screen.queryByTestId("new-worktree-dialog")).toBeNull();
    });
  });

  describe("plugin-owned New worktree dialog", () => {
    const PLUGIN_KIND = "plugin.acme.create";

    it("shows the plugin's dialog in place of the stock one while its claim renders", async () => {
      surfaceState.current = { config: { id: PLUGIN_KIND } };
      render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );

      const dialog = await screen.findByTestId("plugin-create-dialog");
      expect(dialog.dataset.kind).toBe(PLUGIN_KIND);
      expect(screen.queryByTestId("new-worktree-dialog")).toBeNull();
    });

    it("keeps an opening that wasn't handed to the plugin on the stock dialog", async () => {
      surfaceState.current = { config: { id: PLUGIN_KIND } };
      render(<ProjectDialogHost />);
      act(() => useWorktreeSelectionStore.getState().openCreateDialog());

      expect((await screen.findByTestId("new-worktree-dialog")).dataset.open).toBe("true");
      expect(screen.queryByTestId("plugin-create-dialog")).toBeNull();
    });

    it("falls back to the stock dialog when the claim no longer renders", async () => {
      surfaceState.current = null;
      render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );

      expect((await screen.findByTestId("new-worktree-dialog")).dataset.open).toBe("true");
      expect(screen.queryByTestId("plugin-create-dialog")).toBeNull();
    });

    it("moves one opening to the stock dialog from the Standard dialog link, keeping its callback", async () => {
      surfaceState.current = { config: { id: PLUGIN_KIND } };
      const onCreated = vi.fn();
      render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
          initialBranchInput: "feature/x",
          onCreated,
        })
      );

      fireEvent.click(await screen.findByText("standard dialog"));

      expect(screen.queryByTestId("plugin-create-dialog")).toBeNull();
      expect((await screen.findByTestId("new-worktree-dialog")).dataset.open).toBe("true");
      const { createDialog } = useWorktreeSelectionStore.getState();
      expect(createDialog.initialBranchInput).toBe("feature/x");
      expect(createDialog.onCreated).toBe(onCreated);

      act(() => useWorktreeSelectionStore.getState().closeCreateDialog());
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );
      expect(await screen.findByTestId("plugin-create-dialog")).toBeDefined();
    });

    it("keeps an opening on stock once its claim is lost, even if the claim comes back", async () => {
      surfaceState.current = { config: { id: PLUGIN_KIND } };
      const { rerender } = render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );
      await screen.findByTestId("plugin-create-dialog");

      surfaceState.current = null;
      rerender(<ProjectDialogHost />);
      expect((await screen.findByTestId("new-worktree-dialog")).dataset.open).toBe("true");

      surfaceState.current = { config: { id: PLUGIN_KIND } };
      rerender(<ProjectDialogHost />);
      expect(screen.queryByTestId("plugin-create-dialog")).toBeNull();
      expect(screen.getByTestId("new-worktree-dialog").dataset.open).toBe("true");
    });

    it("lets the plugin dialog close before stock opens when stock is chosen inside it (#15236)", async () => {
      surfaceState.current = { config: { id: PLUGIN_KIND } };
      const onCreated = vi.fn();
      const { rerender } = render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
          initialBranchInput: "feature/x",
          onCreated,
        })
      );
      expect((await screen.findByTestId("plugin-create-dialog")).dataset.leaving).toBe("false");

      // The strip's switch or the consent notice saved "stock": the claim
      // still renders, but the resolver now draws stock.
      surfaceState.current = null;
      switchedState.current = { config: { id: PLUGIN_KIND } };
      rerender(<ProjectDialogHost />);

      // Still mounted, closing, and stock waits for it rather than opening in
      // the same render with the unmounting control as its opener.
      expect(screen.getByTestId("plugin-create-dialog").dataset.leaving).toBe("true");
      expect(screen.queryByTestId("new-worktree-dialog")).toBeNull();
      expect(useWorktreeSelectionStore.getState().createDialog.surfacePanelKindId).toBe(
        PLUGIN_KIND
      );

      fireEvent.click(screen.getByText("standard dialog"));

      expect(screen.queryByTestId("plugin-create-dialog")).toBeNull();
      expect((await screen.findByTestId("new-worktree-dialog")).dataset.open).toBe("true");
      const { createDialog } = useWorktreeSelectionStore.getState();
      expect(createDialog.initialBranchInput).toBe("feature/x");
      expect(createDialog.onCreated).toBe(onCreated);
    });

    it("goes straight to stock when stock was chosen before the plugin dialog ever showed", async () => {
      switchedState.current = { config: { id: PLUGIN_KIND } };
      render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );

      expect((await screen.findByTestId("new-worktree-dialog")).dataset.open).toBe("true");
      expect(screen.queryByTestId("plugin-create-dialog")).toBeNull();
    });

    it("starts the next opening on the plugin dialog after one was handed to stock", async () => {
      surfaceState.current = { config: { id: PLUGIN_KIND } };
      const { rerender } = render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );
      await screen.findByTestId("plugin-create-dialog");
      surfaceState.current = null;
      switchedState.current = { config: { id: PLUGIN_KIND } };
      rerender(<ProjectDialogHost />);
      // Cancelled mid-exit: nothing is handed over, and the plugin dialog goes.
      act(() => useWorktreeSelectionStore.getState().closeCreateDialog());
      expect(screen.queryByTestId("plugin-create-dialog")).toBeNull();

      surfaceState.current = { config: { id: PLUGIN_KIND } };
      switchedState.current = null;
      rerender(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );

      expect((await screen.findByTestId("plugin-create-dialog")).dataset.leaving).toBe("false");
    });

    it("ignores a close from a plugin view whose opening has ended", async () => {
      surfaceState.current = { config: { id: PLUGIN_KIND } };
      render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );
      const staleClose = await screen.findByText("close plugin");
      const firstOpening = useWorktreeSelectionStore.getState().createDialog.openingId;
      act(() => useWorktreeSelectionStore.getState().closeCreateDialog());
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );
      expect(useWorktreeSelectionStore.getState().createDialog.openingId).not.toBe(firstOpening);

      act(() => useWorktreeSelectionStore.getState().closeSurfaceCreateDialog(firstOpening));

      expect(useWorktreeSelectionStore.getState().createDialog.isOpen).toBe(true);
      expect(staleClose).toBeDefined();
    });

    it("closes the opening when the plugin's view closes", async () => {
      surfaceState.current = { config: { id: PLUGIN_KIND } };
      render(<ProjectDialogHost />);
      act(() =>
        useWorktreeSelectionStore.getState().openCreateDialog(null, {
          surfacePanelKindId: PLUGIN_KIND,
        })
      );

      fireEvent.click(await screen.findByText("close plugin"));

      expect(useWorktreeSelectionStore.getState().createDialog.isOpen).toBe(false);
      expect(screen.queryByTestId("plugin-create-dialog")).toBeNull();
    });
  });

  describe("forge bulk-create dialog", () => {
    it("takes issue mode from the issues provider's slot", async () => {
      render(<ProjectDialogHost />);
      act(() => useWorktreeSelectionStore.getState().openBulkCreateDialog([]));

      const dialog = await screen.findByTestId("bulk-create-dialog");
      expect(dialog.dataset.mode).toBe("issue");
      expect(dialog.dataset.slot).toBe("issue-forge.bulk");
    });

    it("takes PR mode from the code forge's slot and unmounts on close", async () => {
      render(<ProjectDialogHost />);
      act(() => useWorktreeSelectionStore.getState().openBulkCreateDialogForPRs([]));

      const dialog = await screen.findByTestId("bulk-create-dialog");
      expect(dialog.dataset.mode).toBe("pr");
      expect(dialog.dataset.slot).toBe("code-forge.bulk");

      fireEvent.click(screen.getByText("close bulk"));
      expect(screen.queryByTestId("bulk-create-dialog")).toBeNull();
    });

    it("renders nothing when the active provider contributes no dialog", async () => {
      forgeState.current = { entry: null, issues: { entry: null } };
      render(<ProjectDialogHost />);
      act(() => useWorktreeSelectionStore.getState().openBulkCreateDialog([]));
      await act(async () => {});

      expect(useWorktreeSelectionStore.getState().bulkCreateDialog.isOpen).toBe(true);
      expect(screen.queryByTestId("bulk-create-dialog")).toBeNull();
    });
  });

  describe("recipe editor and manager", () => {
    it("acknowledges a request it accepts and opens the editor", async () => {
      render(<ProjectDialogHost />);
      const acknowledge = vi.fn();

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: {
              worktreeId: "wt-1",
              initialTerminals: [{ type: "terminal" }, { type: "claude" }],
              acknowledge,
            },
          })
        );
      });

      expect(acknowledge).toHaveBeenCalledTimes(1);
      const editor = await screen.findByTestId("recipe-editor");
      expect(editor.dataset.open).toBe("true");
      expect(editor.dataset.worktree).toBe("wt-1");
      expect(editor.dataset.terminals).toBe("2");
      expect(useRecipeEditorActivityStore.getState().openCount).toBe(1);
    });

    it("hands a captured draft's omissions to the editor and drops them on close (#14968)", async () => {
      render(<ProjectDialogHost />);
      const omitted = { panelKinds: { browser: 2 }, cappedTerminalCount: 1 };
      const open = (detail: Record<string, unknown>) =>
        act(() => {
          window.dispatchEvent(new CustomEvent("daintree:open-recipe-editor", { detail }));
        });

      open({
        worktreeId: "wt-1",
        initialTerminals: [{ type: "terminal" }],
        layoutOmissions: omitted,
      });
      const editor = await screen.findByTestId("recipe-editor");
      expect(JSON.parse(editor.dataset.omissions ?? "")).toEqual(omitted);

      fireEvent.click(screen.getByText("close recipe editor"));
      expect(editor.dataset.open).toBe("false");
      expect(editor.dataset.omissions).toBe("");

      open({
        worktreeId: "wt-1",
        initialTerminals: [{ type: "terminal" }],
        layoutOmissions: omitted,
      });
      open({ worktreeId: "wt-1", initialTerminals: [{ type: "terminal" }] });
      expect(editor.dataset.omissions).toBe("");
    });

    it.each([
      ["a negative kind count", { panelKinds: { browser: -1 }, cappedTerminalCount: 0 }],
      ["a fractional cap count", { panelKinds: {}, cappedTerminalCount: 1.5 }],
      ["a string count", { panelKinds: { browser: "2" }, cappedTerminalCount: 0 }],
      ["no cap count", { panelKinds: { browser: 1 } }],
      ["null kinds", { panelKinds: null, cappedTerminalCount: 0 }],
      ["array kinds", { panelKinds: [1], cappedTerminalCount: 0 }],
      ["a null report", null],
    ])("drops a report with %s rather than show it", async (_label, layoutOmissions) => {
      render(<ProjectDialogHost />);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: {
              worktreeId: "wt-1",
              initialTerminals: [{ type: "terminal" }],
              layoutOmissions,
            },
          })
        );
      });

      const editor = await screen.findByTestId("recipe-editor");
      expect(editor.dataset.open).toBe("true");
      expect(editor.dataset.terminals).toBe("1");
      expect(editor.dataset.omissions).toBe("");
    });

    it("ignores a report that arrives without a captured draft", async () => {
      render(<ProjectDialogHost />);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: {
              worktreeId: "wt-1",
              layoutOmissions: { panelKinds: { browser: 1 }, cappedTerminalCount: 0 },
            },
          })
        );
      });

      const editor = await screen.findByTestId("recipe-editor");
      expect(editor.dataset.open).toBe("true");
      expect(editor.dataset.omissions).toBe("");
    });

    it.each(["edit recipe", "new project recipe"])(
      "drops a captured draft's report when the manager's %s takes over",
      async (button) => {
        render(<ProjectDialogHost />);
        act(() => {
          window.dispatchEvent(
            new CustomEvent("daintree:open-recipe-editor", {
              detail: {
                worktreeId: "wt-1",
                initialTerminals: [{ type: "terminal" }],
                layoutOmissions: { panelKinds: { browser: 1 }, cappedTerminalCount: 0 },
              },
            })
          );
          window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"));
        });
        const editor = await screen.findByTestId("recipe-editor");
        expect(editor.dataset.omissions).not.toBe("");

        fireEvent.click(await screen.findByText(button));

        expect(editor.dataset.omissions).toBe("");
      }
    );

    it("swaps an open recipe and a captured draft without carrying either over", async () => {
      const recipe: TerminalRecipe = {
        id: "recipe-1",
        name: "Dev",
        projectId: "proj",
        worktreeId: "wt-2",
        terminals: [],
        createdAt: 0,
      };
      useRecipeStore.setState({
        getRecipeById: (id: string) => (id === recipe.id ? recipe : undefined),
      });
      render(<ProjectDialogHost />);
      const open = (detail: Record<string, unknown>) =>
        act(() => {
          window.dispatchEvent(new CustomEvent("daintree:open-recipe-editor", { detail }));
        });
      const captured = {
        worktreeId: "wt-1",
        initialTerminals: [{ type: "terminal" }],
        layoutOmissions: { panelKinds: {}, cappedTerminalCount: 1 },
      };

      open(captured);
      open({ recipeId: "recipe-1" });
      const editor = await screen.findByTestId("recipe-editor");
      expect(editor.dataset.recipe).toBe("recipe-1");
      expect(editor.dataset.omissions).toBe("");

      // An existing recipe left in place would win over the capture and take its save.
      open(captured);
      expect(editor.dataset.recipe).toBe("");
      expect(editor.dataset.scope).toBe("");
      expect(editor.dataset.terminals).toBe("1");
      expect(editor.dataset.omissions).not.toBe("");
    });

    it("opens an existing recipe by id in its own scope", async () => {
      const recipe: TerminalRecipe = {
        id: "recipe-1",
        name: "Dev",
        worktreeId: "wt-2",
        terminals: [],
        createdAt: 0,
      };
      useRecipeStore.setState({
        getRecipeById: (id: string) => (id === recipe.id ? recipe : undefined),
      });
      render(<ProjectDialogHost />);
      const acknowledge = vi.fn();

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: { recipeId: "recipe-1", worktreeId: "wt-1", acknowledge },
          })
        );
      });

      expect(acknowledge).toHaveBeenCalledTimes(1);
      const editor = await screen.findByTestId("recipe-editor");
      expect(editor.dataset.recipe).toBe("recipe-1");
      expect(editor.dataset.worktree).toBe("wt-2");
      expect(editor.dataset.scope).toBe("global");
    });

    it("leaves a request it cannot act on unacknowledged", () => {
      render(<ProjectDialogHost />);
      const acknowledge = vi.fn();

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", { detail: { acknowledge } })
        );
      });

      expect(acknowledge).not.toHaveBeenCalled();
      expect(screen.queryByTestId("recipe-editor")).toBeNull();
    });

    it("opens the manager on its event", async () => {
      render(<ProjectDialogHost />);
      act(() => {
        window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"));
      });

      expect((await screen.findByTestId("recipe-manager")).dataset.open).toBe("true");
    });

    it("hands an edit from the manager to the editor in the recipe's own scope", async () => {
      render(<ProjectDialogHost />);
      act(() => {
        window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"));
      });
      fireEvent.click(await screen.findByText("edit recipe"));

      expect(screen.getByTestId("recipe-manager").dataset.open).toBe("false");
      const editor = await screen.findByTestId("recipe-editor");
      expect(editor.dataset.open).toBe("true");
      expect(editor.dataset.recipe).toBe("recipe-managed");
      expect(editor.dataset.worktree).toBe("wt-3");
      expect(editor.dataset.scope).toBe("project");
      expect(useRecipeEditorActivityStore.getState().openCount).toBe(1);
    });

    it("hands a new recipe from the manager to a blank editor in the chosen scope", async () => {
      render(<ProjectDialogHost />);
      act(() => {
        window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"));
      });
      fireEvent.click(await screen.findByText("new project recipe"));

      expect(screen.getByTestId("recipe-manager").dataset.open).toBe("false");
      const editor = await screen.findByTestId("recipe-editor");
      expect(editor.dataset.open).toBe("true");
      expect(editor.dataset.recipe).toBe("");
      expect(editor.dataset.worktree).toBe("");
      expect(editor.dataset.scope).toBe("project");
    });

    it("answers each request once under StrictMode's effect replay", async () => {
      render(
        <StrictMode>
          <ProjectDialogHost />
        </StrictMode>
      );
      const acknowledge = vi.fn();

      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: { worktreeId: "wt-1", acknowledge },
          })
        );
      });

      expect(acknowledge).toHaveBeenCalledTimes(1);
      await screen.findByTestId("recipe-editor");
    });

    it("stops listening once the host unmounts", () => {
      const { unmount } = render(<ProjectDialogHost />);
      unmount();
      const acknowledge = vi.fn();

      window.dispatchEvent(
        new CustomEvent("daintree:open-recipe-editor", {
          detail: { worktreeId: "wt-1", acknowledge },
        })
      );

      expect(acknowledge).not.toHaveBeenCalled();
    });
  });

  describe("fleet picker palette", () => {
    it("opens from the shared store and writes its close back", async () => {
      render(<ProjectDialogHost />);
      act(() => useFleetPickerPaletteStore.getState().open());

      const palette = await screen.findByTestId("fleet-picker");
      expect(palette.dataset.open).toBe("true");

      fireEvent.click(screen.getByText("close fleet"));
      expect(useFleetPickerPaletteStore.getState().isOpen).toBe(false);
      expect(screen.getByTestId("fleet-picker").dataset.open).toBe("false");
    });

    it("closes with the host so the next workspace doesn't inherit it open", async () => {
      const { unmount } = render(<ProjectDialogHost />);
      act(() => useFleetPickerPaletteStore.getState().open());
      await screen.findByTestId("fleet-picker");

      unmount();

      expect(useFleetPickerPaletteStore.getState().isOpen).toBe(false);
    });
  });
});
