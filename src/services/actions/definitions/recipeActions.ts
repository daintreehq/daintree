import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { TerminalRecipe } from "@shared/types";
import { isPluginRecipe } from "@shared/types/project";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import {
  TerminalSpawnSourceSchema,
  RecipeSummarySchema,
  AddPanelFocusPolicySchema,
} from "./schemas";

/**
 * Deliberately just the two selectors.
 *
 * The pre-#11908 schema also took `initialTerminals: z.any()`, which no caller
 * ever passed. Typing it properly for the tool surface meant advertising the
 * whole `RecipeTerminal` shape — 1.8 KB of nested schema on a tool whose job is
 * to open a window, well past the per-tool parameter budget. Prefilling a draft
 * from real panes is what `recipe.editor.openFromLayout` is for, and it reads
 * them from the live layout instead of asking a model to compose them, so the
 * argument bought nothing it does not already cover.
 */
const RecipeEditorOpenArgsSchema = z.object({
  worktreeId: z
    .string()
    .min(1)
    .optional()
    .describe("Worktree the draft belongs to. Defaults to the one this call came from."),
  recipeId: z
    .string()
    .min(1)
    .optional()
    .describe("Load an existing recipe. An unknown id opens a blank draft instead."),
});

const RecipeEditorFromLayoutArgsSchema = z.object({
  worktreeId: z
    .string()
    .min(1)
    .describe("Worktree whose live terminals become the draft. Must have at least one open."),
});

/**
 * Shared by both editor handoffs so a caller reads one shape either way.
 *
 * `opened` is the explicit "the user-facing editor is on screen" signal these
 * actions owe their caller — both throw rather than resolving false, so a
 * success is never a silent no-op. Nothing here reports a save, because neither
 * action performs one (#11908).
 */
const RecipeEditorHandoffResultSchema = z.object({
  opened: z.boolean(),
  mode: z.enum(["blankDraft", "existingRecipe", "fromLayout"]),
  worktreeId: z.string().nullable(),
  recipeId: z.string().nullable(),
  terminalCount: z.number(),
});

export function registerRecipeActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  /**
   * Normalize a recipe's tier for `recipe.list` (#11860). Plugin provenance is
   * checked first because a plugin recipe also carries no `projectId` and would
   * otherwise report as "global" — the same inference bug the persistence
   * routing has to avoid.
   */
  const describeRecipeOrigin = (
    recipe: TerminalRecipe
  ): { kind: "global" | "project" | "team" | "plugin"; pluginId: string | null } => {
    if (isPluginRecipe(recipe)) return { kind: "plugin", pluginId: recipe.origin.pluginId };
    if (isInRepoRecipeId(recipe)) return { kind: "team", pluginId: null };
    return { kind: recipe.projectId === undefined ? "global" : "project", pluginId: null };
  };

  actions.set("recipe.list", () =>
    defineAction({
      id: "recipe.list",
      title: "List Recipes",
      description:
        "List the saved recipes for the current project — named multi-terminal setups the user has configured, plus any a plugin contributes. Use this to discover recipe ids before running one; each entry reports its origin. It never fails, and it reports whether recipes are still loading: an empty list while loading means not read yet, not that the project has none.",
      category: "recipes",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          worktreeId: z
            .string()
            .optional()
            .describe(
              "Restricts the listing to recipes available in one worktree, using an id from the worktree-listing capability. Omit it to list every recipe in the project rather than the active worktree's."
            ),
        })
        .optional(),
      resultSchema: z.object({
        recipes: z.array(RecipeSummarySchema),
        isLoading: z.boolean(),
      }),
      run: async (args) => {
        const worktreeId = args?.worktreeId;
        const recipeState = useRecipeStore.getState();
        const recipes = recipeState.recipes;

        // Filter by worktree if specified, otherwise return all recipes
        const filtered = worktreeId
          ? recipes.filter((r) => r.worktreeId === worktreeId || r.worktreeId === undefined)
          : recipes;

        return {
          recipes: filtered.map((r) => ({
            id: r.id,
            name: r.name,
            worktreeId: r.worktreeId ?? null,
            terminalCount: r.terminals.length,
            showInEmptyState: r.showInEmptyState ?? false,
            origin: describeRecipeOrigin(r),
          })),
          isLoading: recipeState.isLoading,
        };
      },
    })
  );

  actions.set("recipe.run", () =>
    defineAction({
      id: "recipe.run",
      title: "Run Recipe",
      description:
        "Launch the terminals a saved recipe defines, in one worktree, as a repeatable multi-pane setup. Launch a single agent or a plain terminal instead when only one pane is wanted. This creates several panels at once and starts their configured commands or agents. An automated caller gets at most the first three of them; the rest come back as failures, so check what actually started.",
      category: "recipes",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      dangerRationale:
        "Spawns the recipe's terminals, each running shell commands or launching agents. " +
        "Agent-initiated runs are confirmation-gated so a single dispatch can't open many terminals unprompted.",
      argsSchema: z.object({
        recipeId: z
          .string()
          .describe(
            "Identifies which saved recipe to run, using an id from the recipe-listing capability. An unknown id fails before any terminal is created."
          ),
        worktreeId: z
          .string()
          .optional()
          .describe(
            "Identifies the worktree to launch the recipe terminals in, using an id from the worktree-listing capability. Defaults to the active worktree."
          ),
        spawnedBy: TerminalSpawnSourceSchema.optional(),
        focusPolicy: AddPanelFocusPolicySchema.optional(),
      }),
      resultSchema: z.object({
        spawnedCount: z.number().int().nonnegative(),
        failedCount: z.number().int().nonnegative(),
        failedTerminals: z.array(
          z.object({ index: z.number().int().nonnegative(), reason: z.string() })
        ),
      }),
      mcpOutputSchema: true,
      run: async ({ recipeId, worktreeId, spawnedBy, focusPolicy }, ctx: ActionContext) => {
        const targetWorktreeId = worktreeId ?? ctx.activeWorktreeId ?? undefined;
        const worktree = targetWorktreeId
          ? getCurrentViewStore().getState().worktrees.get(targetWorktreeId)
          : null;
        const worktreePath = worktree?.path ?? ctx.projectPath;

        if (!worktreePath) {
          throw new Error("No worktree or project path available to run recipe");
        }

        const recipeContext = {
          issueNumber: worktree?.issueNumber,
          prNumber: worktree?.linked?.pr?.ref.number,
          worktreePath,
          branchName: worktree?.branch,
        };
        // Always forward dispatchSource so runRecipeWithResults can apply the
        // agent-source terminal cap. ActionService sets ctx.dispatchSource on
        // every dispatch, so this is the live path for all real invocations.
        const recipeName = useRecipeStore.getState().getRecipeById(recipeId)?.name;
        const results = await useRecipeStore
          .getState()
          .runRecipeWithResults(recipeId, worktreePath, targetWorktreeId, recipeContext, {
            spawnedBy,
            focusPolicy,
            dispatchSource: ctx.dispatchSource,
          });

        // Toast/inbox first so palette users see the failure even though the
        // dispatch below also rejects (the rejection only reaches MCP callers).
        notifyRecipeSpawnFailures(results, {
          recipeName,
          projectId: ctx.projectId,
        });

        if (results.spawned.length === 0 && results.failed.length > 0) {
          const reasons = Array.from(new Set(results.failed.map((f) => f.error))).join("; ");
          throw new Error(`Recipe launch failed: ${reasons}`);
        }

        return {
          spawnedCount: results.spawned.length,
          failedCount: results.failed.length,
          failedTerminals: results.failed.map((f) => ({ index: f.index, reason: f.error })),
        };
      },
    })
  );

  actions.set("recipe.editor.open", () =>
    defineAction({
      id: "recipe.editor.open",
      title: "Open Recipe Editor",
      description:
        "Put a recipe draft in front of the user in the editor, either blank for a worktree or loaded from an existing recipe. This is a handoff, not a write: nothing is saved or deleted until the person reviews the draft and saves it, so a success here means the editor is open, never that the recipe exists. An unknown recipe opens a blank draft rather than failing.",
      category: "recipes",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: RecipeEditorOpenArgsSchema,
      resultSchema: RecipeEditorHandoffResultSchema,
      mcpOutputSchema: true,
      examples: [
        {
          args: { worktreeId: "wt-1" },
          description: "Open a blank recipe draft scoped to one worktree",
        },
      ],
      run: async (args, ctx: ActionContext) => {
        const { worktreeId, recipeId } = args;
        // The editor's event listener hard-requires a string worktreeId and
        // silently returns without one (unless an existing recipe matched, which
        // carries its own). Resolving and checking here is what keeps the
        // returned `opened` honest: without it this action reports a handoff
        // that never reached the screen.
        const resolvedWorktreeId = worktreeId ?? ctx.activeWorktreeId;
        const existing = recipeId ? useRecipeStore.getState().getRecipeById(recipeId) : undefined;
        if (!existing && !resolvedWorktreeId) {
          throw new Error(
            "No worktree to scope the recipe draft to — name one, or open the editor from a worktree."
          );
        }
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: { worktreeId: resolvedWorktreeId, recipeId },
          })
        );
        return {
          opened: true,
          mode: existing ? ("existingRecipe" as const) : ("blankDraft" as const),
          worktreeId: existing ? (existing.worktreeId ?? null) : (resolvedWorktreeId ?? null),
          recipeId: existing ? existing.id : null,
          terminalCount: existing ? existing.terminals.length : 0,
        };
      },
    })
  );

  actions.set("recipe.manager.open", () => ({
    id: "recipe.manager.open",
    title: "Manage Recipes",
    description: "Open the recipe manager to view and manage global and project recipes",
    category: "recipes",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"));
    },
  }));

  actions.set("recipe.saveToRepo", () =>
    defineAction({
      id: "recipe.saveToRepo",
      title: "Save Recipe to Repository",
      description:
        "Promote a recipe to in-repo storage (.daintree/recipes/) for git tracking and team sharing",
      category: "recipes",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        recipeId: z.string(),
        deleteOriginal: z.boolean().default(false),
      }),
      run: async ({ recipeId, deleteOriginal }) => {
        const store = useRecipeStore.getState();
        if (!store.currentProjectId) throw new Error("No project open");
        await store.saveToRepo(recipeId, deleteOriginal);
      },
    })
  );

  actions.set("recipe.delete", () =>
    defineAction({
      id: "recipe.delete",
      title: "Delete Recipe",
      description: "Delete a recipe permanently",
      category: "recipes",
      kind: "command",
      danger: "confirm",
      scope: "renderer",
      dangerRationale:
        "Permanently deletes a recipe. The recipe configuration cannot be recovered.",
      argsSchema: z.object({ recipeId: z.string() }),
      run: async ({ recipeId }) => {
        await useRecipeStore.getState().deleteRecipe(recipeId);
      },
    })
  );

  actions.set("recipe.editor.openFromLayout", () =>
    defineAction({
      id: "recipe.editor.openFromLayout",
      title: "Open Recipe Editor From Layout",
      description:
        "Turn a worktree's live terminals into a recipe draft and put it in front of the user in the editor. Use this to capture a layout someone already has open; the plain editor capability starts from nothing. It only hands off — the draft is not a recipe until the person saves it. A worktree with no live terminals is rejected.",
      category: "recipes",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: RecipeEditorFromLayoutArgsSchema,
      resultSchema: RecipeEditorHandoffResultSchema,
      mcpOutputSchema: true,
      examples: [
        {
          args: { worktreeId: "wt-1" },
          description: "Capture one worktree's open terminals as a draft recipe",
        },
      ],
      run: async ({ worktreeId }) => {
        const terminals = useRecipeStore.getState().generateRecipeFromActiveTerminals(worktreeId);
        if (terminals.length === 0) {
          throw new Error("No active terminals in this worktree to save");
        }
        window.dispatchEvent(
          new CustomEvent("daintree:open-recipe-editor", {
            detail: { worktreeId, initialTerminals: terminals },
          })
        );
        return {
          opened: true,
          mode: "fromLayout" as const,
          worktreeId,
          recipeId: null,
          terminalCount: terminals.length,
        };
      },
    })
  );
}
