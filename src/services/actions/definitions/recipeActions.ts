import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { TerminalRecipe } from "@shared/types";
import { isPluginRecipe } from "@shared/types/project";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
import { MAX_TERMINALS_PER_RECIPE } from "@shared/utils/recipeSanitizer";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { getWorktreePathIndex } from "@/store/storeAccessors";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import {
  TerminalSpawnSourceSchema,
  RecipeSummarySchema,
  AddPanelFocusPolicySchema,
} from "./schemas";

/**
 * `initialTerminals` is validated at the element's edge, not through its whole
 * shape.
 *
 * It was `z.any()` before #11908, and no in-tree caller passes it — but a
 * plugin can dispatch built-in actions, so dropping the key outright would
 * silently strip an argument the manifest used to accept. Typing it fully
 * instead meant advertising the whole nested `RecipeTerminal` shape: 1.8 KB of
 * schema on a tool whose job is to open a window, past the per-tool parameter
 * budget in `mcpWireBudget.test.ts`.
 *
 * The middle ground: require the one field the editor actually reads (`type`)
 * and let the rest through, capped at the same terminal count a recipe can hold
 * anyway. That keeps a plugin's existing well-formed payload working, costs
 * ~150 bytes of schema, and stops the two things an unbounded `unknown[]` would
 * have handed a model now that this is agent-reachable — a pane list longer
 * than any recipe can be, and elements the editor's `RecipeTerminal[]` cast
 * would misrepresent. The description points at the from-layout capability,
 * which reads real panes rather than asking a model to compose them, and
 * nothing here is saved until a person reviews the draft.
 */
/**
 * Fire the editor-open event and report whether anything took it.
 *
 * These actions hand off through a DOM event, which tells the dispatcher
 * nothing — `dispatchEvent` returns true whether one listener ran or none
 * exist. Both actions promise their caller `opened: true`, so that promise has
 * to be earned: the listener calls `acknowledge` on the paths that really open
 * the editor, and an unacknowledged dispatch throws instead of reporting a
 * handoff that never reached the screen.
 */
function dispatchRecipeEditorOpen(detail: Record<string, unknown>): void {
  let acknowledged = false;
  window.dispatchEvent(
    new CustomEvent("daintree:open-recipe-editor", {
      detail: {
        ...detail,
        acknowledge: () => {
          acknowledged = true;
        },
      },
    })
  );
  if (!acknowledged) {
    throw new Error(
      "The recipe editor didn't open — no editor surface is mounted to receive it right now."
    );
  }
}

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
  initialTerminals: z
    .array(z.looseObject({ type: z.string().min(1) }))
    .max(MAX_TERMINALS_PER_RECIPE)
    .optional()
    .describe(
      `Prefilled panes, for callers that already hold them (max ${MAX_TERMINALS_PER_RECIPE}). Capture a live layout instead.`
    ),
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
        // The ids of the panels that actually started, in spawn order. A count
        // cannot be acted on: an automated caller needs these to poll the
        // terminals it just created, and the MCP server needs them to attribute
        // each one to the session that asked for the run (#11909).
        spawnedTerminalIds: z
          .array(z.string())
          .describe(
            "The panels this run actually started, in spawn order. Use these ids to read output from or close the terminals; the count alone identifies nothing."
          ),
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
          spawnedTerminalIds: results.spawned.map((s) => s.terminalId),
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
      // An agent dispatch carrying a recipeId is elevated to "confirm" by
      // `resolveEffectiveActionDanger`, which keys on the argument rather than
      // on the action. Its generic rationale says the call spawns the recipe's
      // terminals — true of the composites it was written for, false here, and a
      // confirmation dialog that misstates what it is gating is worse than none.
      // A definition's own rationale wins over the elevation's, so state what
      // this call actually does.
      dangerRationale:
        "Opens the recipe editor on an existing recipe for the user to review. It starts no terminals and saves nothing on its own.",
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
        const { worktreeId, recipeId, initialTerminals } = args;
        // The editor's event listener hard-requires a string worktreeId and
        // silently returns without one (unless an existing recipe matched, which
        // carries its own). Resolving and checking here is what keeps the
        // returned `opened` honest: without it this action reports a handoff
        // that never reached the screen.
        const resolvedWorktreeId = worktreeId ?? ctx.activeWorktreeId;
        const existing = recipeId ? useRecipeStore.getState().getRecipeById(recipeId) : undefined;
        if (!existing) {
          if (!resolvedWorktreeId) {
            throw new Error(
              "No worktree to scope the recipe draft to — name one, or open the editor from a worktree."
            );
          }
          // A blank draft carries no scope of its own, so an unknown worktree id
          // would open an editor pinned to a worktree that isn't there — and the
          // person would only find out when they tried to save. An existing
          // recipe is exempt: it brings its own stored worktree.
          const index = getWorktreePathIndex();
          if (index && !index.has(resolvedWorktreeId)) {
            throw new Error("Unknown worktree — no worktree with that id is open in this project.");
          }
        }
        dispatchRecipeEditorOpen({
          worktreeId: resolvedWorktreeId,
          recipeId,
          initialTerminals,
        });
        return {
          opened: true,
          mode: existing ? ("existingRecipe" as const) : ("blankDraft" as const),
          worktreeId: existing ? (existing.worktreeId ?? null) : (resolvedWorktreeId ?? null),
          recipeId: existing ? existing.id : null,
          terminalCount: existing ? existing.terminals.length : (initialTerminals?.length ?? 0),
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
          throw new Error("No active terminals in this worktree to capture");
        }
        dispatchRecipeEditorOpen({ worktreeId, initialTerminals: terminals });
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
