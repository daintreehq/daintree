import { create, type StateCreator } from "zustand";
import type { TerminalRecipe, RecipeTerminal, RecipeTerminalType } from "@/types";
import { usePanelStore } from "./panelStore";
import { preflightSpawnBatchLimit } from "./panelLimitStore";
import { isMcpSpawnFocusSuppressed } from "./mcpSpawnFocusGuard";
import { isAssistantFocused } from "./macroFocusStore";
import {
  isDevPreviewPanel,
  isPtyPanel,
  type DevPreviewPanelData,
  type PtyPanelData,
} from "@shared/types/panel";
import { projectClient, agentSettingsClient, systemClient, globalRecipesClient } from "@/clients";
import { getAgentConfig } from "@/config/agents";
import { generateAgentCommand } from "@shared/types";
import { replaceRecipeVariables, type RecipeContext } from "@/utils/recipeVariables";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import type { TerminalSpawnSource, AddPanelFocusPolicy } from "@shared/types/panel";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { isClientAppError } from "@/utils/clientAppError";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";

export interface RecipeSpawnResult {
  index: number;
  terminalId: string;
}

export interface RecipeSpawnFailure {
  index: number;
  error: string;
}

export interface RecipeSpawnResults {
  spawned: RecipeSpawnResult[];
  failed: RecipeSpawnFailure[];
}

export interface RecipeRunOptions {
  spawnedBy?: TerminalSpawnSource;
  focusPolicy?: AddPanelFocusPolicy;
  terminalIndices?: number[];
}

function isAgentRecipeType(type: RecipeTerminalType): boolean {
  return type !== "terminal" && type !== "dev-preview";
}

// Recipes read from disk may still contain agentModelId/agentLaunchFlags if
// they were written by an older build before those fields were stripped on
// persist. Treat them as session-only state and drop them at load time.
function stripSessionOverridesFromRecipe(recipe: TerminalRecipe): TerminalRecipe {
  let changed = false;
  const terminals = recipe.terminals.map((terminal) => {
    if (terminal.agentModelId === undefined && terminal.agentLaunchFlags === undefined) {
      return terminal;
    }
    changed = true;
    const { agentModelId: _m, agentLaunchFlags: _f, ...rest } = terminal;
    return rest;
  });
  if (recipe.shadowedBy !== undefined) {
    const { shadowedBy: _s, ...rest } = recipe;
    return changed ? { ...rest, terminals } : rest;
  }
  return changed ? { ...recipe, terminals } : recipe;
}

function sanitizeRecipeTerminal(terminal: RecipeTerminal): RecipeTerminal {
  const isAgent = isAgentRecipeType(terminal.type);
  const command = terminal.command?.trim() || undefined;
  const devCommand = terminal.devCommand?.trim() || undefined;
  const initialPrompt =
    typeof terminal.initialPrompt === "string"
      ? terminal.initialPrompt.replace(/\r\n/g, "\n").trimEnd() || undefined
      : undefined;
  const args = isAgent ? terminal.args?.trim() || undefined : undefined;

  return {
    ...terminal,
    command: isAgent ? undefined : command,
    initialPrompt: isAgent ? initialPrompt : undefined,
    devCommand: terminal.type === "dev-preview" ? devCommand : undefined,
    args,
    // Session-scoped overrides must never leak into disk-saved recipes.
    agentModelId: undefined,
    agentLaunchFlags: undefined,
  };
}

function terminalToRecipeTerminal(terminal: PtyPanelData | DevPreviewPanelData): RecipeTerminal {
  // Map kind to RecipeTerminalType.
  // Launch-intent only: recipes encode what the terminal was launched as, not
  // what runtime detection observed. Persisting `detectedAgentId` would corrupt
  // a recipe by baking ephemeral session state into a reusable template.
  if (isDevPreviewPanel(terminal)) {
    return {
      type: "dev-preview",
      title: terminal.title || undefined,
      command: undefined,
      devCommand: terminal.devCommand,
      env: {},
      exitBehavior: terminal.exitBehavior,
      agentModelId: undefined,
      agentLaunchFlags: undefined,
    };
  }

  const type: RecipeTerminalType = terminal.launchAgentId ?? "terminal";
  const isAgent = isAgentRecipeType(type);

  return {
    type,
    title: terminal.title || undefined,
    command: terminal.command || undefined,
    devCommand: undefined,
    env: {},
    exitBehavior: terminal.exitBehavior,
    agentModelId: isAgent ? terminal.agentModelId : undefined,
    agentLaunchFlags: isAgent ? terminal.agentLaunchFlags : undefined,
  };
}

interface RecipeState {
  recipes: TerminalRecipe[];
  globalRecipes: TerminalRecipe[];
  projectRecipes: TerminalRecipe[];
  inRepoRecipes: TerminalRecipe[];
  isLoading: boolean;
  currentProjectId: string | null;

  loadRecipes: (projectId: string) => Promise<void>;
  exportRecipeToFile: (id: string) => Promise<boolean>;
  importRecipeFromFile: (projectId: string | undefined) => Promise<boolean>;
  createRecipe: (
    projectId: string | undefined,
    name: string,
    worktreeId: string | undefined,
    terminals: RecipeTerminal[],
    showInEmptyState?: boolean,
    autoAssign?: "always" | "never" | "prompt"
  ) => Promise<void>;
  updateRecipe: (
    id: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ) => Promise<void>;
  deleteRecipe: (id: string) => Promise<void>;

  getRecipesForWorktree: (worktreeId: string | undefined) => TerminalRecipe[];
  getRecipeById: (id: string) => TerminalRecipe | undefined;

  runRecipe: (
    recipeId: string,
    worktreePath: string,
    worktreeId?: string,
    context?: RecipeContext,
    options?: RecipeRunOptions
  ) => Promise<void>;

  runRecipeWithResults: (
    recipeId: string,
    worktreePath: string,
    worktreeId?: string,
    context?: RecipeContext,
    options?: RecipeRunOptions
  ) => Promise<RecipeSpawnResults>;

  saveToRepo: (recipeId: string, deleteOriginal?: boolean) => Promise<void>;

  exportRecipe: (id: string) => string | null;
  importRecipe: (projectId: string | undefined, json: string) => Promise<void>;

  generateRecipeFromActiveTerminals: (worktreeId: string) => RecipeTerminal[];

  reset: () => void;
}

export const MAX_TERMINALS_PER_RECIPE = 10;

let loadRecipesRequestId = 0;

function mergeRecipes(
  globalRecipes: TerminalRecipe[],
  projectRecipes: TerminalRecipe[],
  inRepoRecipes: TerminalRecipe[] = []
): TerminalRecipe[] {
  // Project-local recipes that share a name with an in-repo recipe are kept but
  // marked as shadowed so the UI can surface them dimmed instead of hiding them.
  const inRepoNames = new Set(inRepoRecipes.map((r) => r.name));
  const projectWithMarkers = projectRecipes.map((r) =>
    inRepoNames.has(r.name) ? { ...r, shadowedBy: r.name } : r
  );
  return [...globalRecipes, ...projectWithMarkers, ...inRepoRecipes];
}

const createRecipeStore: StateCreator<RecipeState> = (set, get) => ({
  recipes: [],
  globalRecipes: [],
  projectRecipes: [],
  inRepoRecipes: [],
  isLoading: false,
  currentProjectId: null,

  loadRecipes: async (projectId: string) => {
    const requestId = ++loadRecipesRequestId;
    const previousProjectId = get().currentProjectId;
    const clearRecipes = previousProjectId && previousProjectId !== projectId;
    set({
      isLoading: true,
      currentProjectId: projectId,
      ...(clearRecipes
        ? { recipes: [], globalRecipes: [], projectRecipes: [], inRepoRecipes: [] }
        : {}),
    });
    try {
      const [globalRecipesRaw, projectRecipesResult, inRepoRecipesRaw] = await Promise.all([
        globalRecipesClient.getRecipes(),
        projectClient
          .getRecipes(projectId)
          .catch(() => ({ recipes: [] as TerminalRecipe[], collisions: [] })),
        projectClient.getInRepoRecipes(projectId).catch(() => [] as TerminalRecipe[]),
      ]);
      if (requestId !== loadRecipesRequestId || get().currentProjectId !== projectId) {
        return;
      }
      const globalRecipes = globalRecipesRaw.map(stripSessionOverridesFromRecipe);
      const projectRecipes = projectRecipesResult.recipes.map(stripSessionOverridesFromRecipe);
      const inRepoRecipes = inRepoRecipesRaw.map(stripSessionOverridesFromRecipe);
      set({
        globalRecipes,
        projectRecipes,
        inRepoRecipes,
        recipes: mergeRecipes(globalRecipes, projectRecipes, inRepoRecipes),
        isLoading: false,
      });
      // A recipe couldn't be promoted to the shared repo because a different
      // recipe already owns its filename slug. Route to the inbox (low
      // priority, project-scoped supersede) instead of a console-only log:
      // it's a non-urgent, ignorable conflict whose fix (rename) lives in the
      // recipe manager, so the least-restricted surface is correct.
      const collisions = projectRecipesResult.collisions;
      if (collisions.length > 0) {
        const first = collisions[0]!;
        notify({
          type: "warning",
          priority: "low",
          supersedeKey: `recipe-name-collision:${projectId}`,
          title: "Recipe name conflict",
          message:
            collisions.length > 1
              ? `${collisions.length} recipes share a filename with another recipe and couldn't be saved to the repo. Rename them to keep each one.`
              : `"${first.droppedName}" shares the filename "${first.filename}" with another recipe and couldn't be saved to the repo. Rename one to keep both.`,
        });
      }
    } catch (error) {
      if (requestId !== loadRecipesRequestId || get().currentProjectId !== projectId) {
        return;
      }
      logError("Failed to load recipes", error);
      set({
        recipes: [],
        globalRecipes: [],
        projectRecipes: [],
        inRepoRecipes: [],
        isLoading: false,
      });
    }
  },

  createRecipe: async (
    projectId,
    name,
    worktreeId,
    terminals,
    showInEmptyState = false,
    autoAssign
  ) => {
    if (terminals.length === 0) {
      throw new Error("Recipe must contain at least one terminal");
    }
    if (terminals.length > MAX_TERMINALS_PER_RECIPE) {
      throw new Error(`Recipe cannot exceed ${MAX_TERMINALS_PER_RECIPE} terminals`);
    }

    const isGlobal = projectId === undefined;
    const newRecipe: TerminalRecipe = {
      id: `recipe-${crypto.randomUUID()}`,
      name,
      projectId: isGlobal ? undefined : projectId,
      worktreeId: isGlobal ? undefined : worktreeId,
      terminals: terminals.map(sanitizeRecipeTerminal),
      createdAt: Date.now(),
      showInEmptyState,
      autoAssign,
      ...(isGlobal ? {} : { scope: "inrepo" as const }),
    };

    const prevGlobal = get().globalRecipes;
    const prevProject = get().projectRecipes;
    const prevInRepo = get().inRepoRecipes;
    const nextGlobal = isGlobal ? [...prevGlobal, newRecipe] : prevGlobal;
    const nextInRepo = isGlobal ? prevInRepo : [...prevInRepo, newRecipe];
    set({
      globalRecipes: nextGlobal,
      projectRecipes: prevProject,
      inRepoRecipes: nextInRepo,
      recipes: mergeRecipes(nextGlobal, prevProject, nextInRepo),
    });

    try {
      if (isGlobal) {
        await globalRecipesClient.addRecipe(newRecipe);
      } else {
        await projectClient.updateInRepoRecipe(projectId, newRecipe);
      }
    } catch (error) {
      logError("Failed to persist recipe", error);
      set({
        globalRecipes: prevGlobal,
        projectRecipes: prevProject,
        inRepoRecipes: prevInRepo,
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo),
      });
      throw error;
    }
  },

  updateRecipe: async (id, updates) => {
    const recipes = get().recipes;
    const index = recipes.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new Error(`Recipe ${id} not found`);
    }

    if (updates.terminals) {
      if (updates.terminals.length === 0) {
        throw new Error("Recipe must contain at least one terminal");
      }
      if (updates.terminals.length > MAX_TERMINALS_PER_RECIPE) {
        throw new Error(`Recipe cannot exceed ${MAX_TERMINALS_PER_RECIPE} terminals`);
      }
    }

    const recipe = recipes[index]!;
    const isInRepo = isInRepoRecipeId(recipe);
    const isGlobal = !isInRepo && recipe.projectId === undefined;
    const sanitizedTerminals = updates.terminals?.map(sanitizeRecipeTerminal);
    const sanitizedUpdates = sanitizedTerminals
      ? { ...updates, terminals: sanitizedTerminals }
      : updates;

    // The id is opaque and stable — a rename no longer recomputes it, so usage
    // history and the on-disk file association survive renames (#9195).
    const updatedRecipe: TerminalRecipe = {
      ...recipe,
      shadowedBy: undefined,
      ...sanitizedUpdates,
      id,
      name: sanitizedUpdates.name ?? recipe.name,
      terminals: sanitizedTerminals ?? recipe.terminals,
    };

    const prevGlobal = get().globalRecipes;
    const prevProject = get().projectRecipes;
    const prevInRepo = get().inRepoRecipes;
    const applyUpdate = (list: TerminalRecipe[]) => {
      const idx = list.findIndex((r) => r.id === id);
      if (idx === -1) return list;
      const next = [...list];
      next[idx] = updatedRecipe;
      return next;
    };
    const nextGlobal = isGlobal ? applyUpdate(prevGlobal) : prevGlobal;
    // For in-repo recipes, the file store carries a reconciled mirror that we
    // must keep in sync — otherwise a name change leaves the old id behind in
    // projectRecipes, and `mergeRecipes` surfaces it as a duplicate row.
    const nextProject =
      isInRepo || (!isGlobal && !isInRepo) ? applyUpdate(prevProject) : prevProject;
    const nextInRepo = isInRepo ? applyUpdate(prevInRepo) : prevInRepo;
    set({
      globalRecipes: nextGlobal,
      projectRecipes: nextProject,
      inRepoRecipes: nextInRepo,
      recipes: mergeRecipes(nextGlobal, nextProject, nextInRepo),
    });

    try {
      if (isInRepo) {
        const metadataOnlyKeys = new Set(["lastUsedAt", "usageHistory"]);
        const updateKeys = Object.keys(updates);
        const isMetadataOnly = updateKeys.every((k) => metadataOnlyKeys.has(k));
        if (!isMetadataOnly) {
          const projectId = get().currentProjectId;
          if (!projectId) throw new Error("No current project");
          const previousName =
            updates.name && updates.name !== recipe.name ? recipe.name : undefined;
          await projectClient.updateInRepoRecipe(projectId, updatedRecipe, previousName);
        }
      } else if (isGlobal) {
        await globalRecipesClient.updateRecipe(id, sanitizedUpdates);
      } else {
        await projectClient.updateRecipe(recipe.projectId!, id, sanitizedUpdates);
      }
    } catch (error) {
      // Always roll back the optimistic state first so the in-memory recipes
      // match the rejected write. The conflict path then surfaces a dialog;
      // all other errors propagate so callers can show a toast.
      set({
        globalRecipes: prevGlobal,
        projectRecipes: prevProject,
        inRepoRecipes: prevInRepo,
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo),
      });
      if (isInRepo && isClientAppError(error) && error.code === "RECIPE_STALE_CONFLICT") {
        const projectId = get().currentProjectId;
        const previousName = updates.name && updates.name !== recipe.name ? recipe.name : undefined;
        const resolution = await useRecipeConflictStore.getState().requestConflict({
          recipeId: id,
          recipeName: updatedRecipe.name,
          updates: sanitizedUpdates,
          previousName,
        });
        if (resolution === "reload" && projectId) {
          void get().loadRecipes(projectId);
          return;
        }
        if (resolution === "overwrite" && projectId) {
          try {
            await projectClient.updateInRepoRecipe(projectId, updatedRecipe, previousName, {
              force: true,
            });
            // Re-apply the optimistic state since the rollback above wiped it
            // and the forced write succeeded.
            const refreshedInRepo = applyUpdate(get().inRepoRecipes);
            const refreshedProject = isInRepo
              ? applyUpdate(get().projectRecipes)
              : get().projectRecipes;
            set({
              inRepoRecipes: refreshedInRepo,
              projectRecipes: refreshedProject,
              recipes: mergeRecipes(get().globalRecipes, refreshedProject, refreshedInRepo),
            });
            return;
          } catch (retryError) {
            logError("Failed to overwrite recipe after conflict", retryError);
            throw retryError;
          }
        }
        // Cancel / dismissed: leave the rolled-back state in place. The user
        // can re-attempt the edit; the focus-reload hook (or a manual reload)
        // brings the in-memory state back in sync with disk.
        return;
      }
      logError("Failed to persist recipe update", error);
      throw error;
    }
  },

  deleteRecipe: async (id) => {
    // Search merged list first, then source lists as fallback (handles shadowed recipes)
    const recipe =
      get().recipes.find((r) => r.id === id) ??
      get().projectRecipes.find((r) => r.id === id) ??
      get().globalRecipes.find((r) => r.id === id);
    if (!recipe) {
      throw new Error(`Recipe ${id} not found`);
    }

    const isInRepo = isInRepoRecipeId(recipe);
    const isGlobal = !isInRepo && recipe.projectId === undefined;
    const prevGlobal = get().globalRecipes;
    const prevProject = get().projectRecipes;
    const prevInRepo = get().inRepoRecipes;
    const nextGlobal = isGlobal ? prevGlobal.filter((r) => r.id !== id) : prevGlobal;
    const nextProject =
      !isGlobal && !isInRepo ? prevProject.filter((r) => r.id !== id) : prevProject;
    const nextInRepo = isInRepo ? prevInRepo.filter((r) => r.id !== id) : prevInRepo;
    set({
      globalRecipes: nextGlobal,
      projectRecipes: nextProject,
      inRepoRecipes: nextInRepo,
      recipes: mergeRecipes(nextGlobal, nextProject, nextInRepo),
    });

    try {
      if (isInRepo) {
        const projectId = get().currentProjectId;
        if (!projectId) throw new Error("No current project");
        await projectClient.deleteInRepoRecipe(projectId, recipe.name);
      } else if (isGlobal) {
        await globalRecipesClient.deleteRecipe(id);
      } else {
        await projectClient.deleteRecipe(recipe.projectId!, id);
      }
    } catch (error) {
      logError("Failed to persist recipe deletion", error);
      set({
        globalRecipes: prevGlobal,
        projectRecipes: prevProject,
        inRepoRecipes: prevInRepo,
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo),
      });
      throw error;
    }
  },

  saveToRepo: async (recipeId, deleteOriginal = false) => {
    const recipe = get().recipes.find((r) => r.id === recipeId);
    if (!recipe) throw new Error(`Recipe ${recipeId} not found`);
    if (isInRepoRecipeId(recipe)) throw new Error("Recipe is already in-repo");

    const currentProjectId = get().currentProjectId;
    if (!currentProjectId) throw new Error("No current project");

    const isGlobal = recipe.projectId === undefined;
    const { projectId: _, worktreeId: _w, shadowedBy: _s, ...rest } = recipe;
    // Reuse the id of an existing in-repo recipe with the same name so a repeat
    // promotion is an idempotent update (same on-disk filename) rather than a
    // duplicate or an on-disk stale conflict. Otherwise mint a fresh opaque id.
    const existingInRepoId = get().inRepoRecipes.find((r) => r.name === recipe.name)?.id;
    const promoted: TerminalRecipe = {
      ...rest,
      id: existingInRepoId ?? `recipe-${crypto.randomUUID()}`,
      scope: "inrepo",
    };

    const prevGlobal = get().globalRecipes;
    const prevProject = get().projectRecipes;
    const prevInRepo = get().inRepoRecipes;

    const nextInRepo = [...prevInRepo.filter((r) => r.id !== promoted.id), promoted];
    const nextGlobal =
      deleteOriginal && isGlobal ? prevGlobal.filter((r) => r.id !== recipeId) : prevGlobal;
    const nextProject =
      deleteOriginal && !isGlobal ? prevProject.filter((r) => r.id !== recipeId) : prevProject;

    set({
      globalRecipes: nextGlobal,
      projectRecipes: nextProject,
      inRepoRecipes: nextInRepo,
      recipes: mergeRecipes(nextGlobal, nextProject, nextInRepo),
    });

    try {
      await projectClient.updateInRepoRecipe(currentProjectId, promoted);
    } catch (error) {
      logError("Failed to save recipe to repo", error);
      set({
        globalRecipes: prevGlobal,
        projectRecipes: prevProject,
        inRepoRecipes: prevInRepo,
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo),
      });
      throw error;
    }

    if (deleteOriginal) {
      try {
        if (isGlobal) {
          await globalRecipesClient.deleteRecipe(recipeId);
        } else {
          await projectClient.deleteRecipe(recipe.projectId!, recipeId);
        }
      } catch (error) {
        // In-repo write succeeded; roll back only the delete portion
        logError("Failed to delete original recipe", error);
        set({
          globalRecipes: prevGlobal,
          projectRecipes: prevProject,
          inRepoRecipes: nextInRepo,
          recipes: mergeRecipes(prevGlobal, prevProject, nextInRepo),
        });
        throw error;
      }
    }
  },

  getRecipesForWorktree: (worktreeId) => {
    const recipes = get().recipes;
    // Only return recipes for the specific worktree or project-wide recipes (undefined worktreeId)
    // No longer falling back to global recipes - all recipes now belong to a project
    return recipes.filter((r) => r.worktreeId === worktreeId || r.worktreeId === undefined);
  },

  getRecipeById: (id) => {
    const recipe = get().recipes.find((r) => r.id === id);
    if (recipe?.shadowedBy) {
      return get().inRepoRecipes.find((r) => r.name === recipe.name) ?? recipe;
    }
    return recipe;
  },

  runRecipe: async (recipeId, worktreePath, worktreeId, context, options) => {
    await get().runRecipeWithResults(recipeId, worktreePath, worktreeId, context, options);
  },

  runRecipeWithResults: async (recipeId, worktreePath, worktreeId, context, options) => {
    const recipe = get().getRecipeById(recipeId);
    if (!recipe) {
      throw new Error(`Recipe ${recipeId} not found`);
    }

    // getRecipeById resolves shadowed recipes to the winner, so use the resolved id
    const resolvedId = recipe.id;

    const now = Date.now();
    // Atomic in-memory append — folding the read+write into a `set` callback
    // closes over the freshest state, so two near-simultaneous runs don't both
    // read the same pre-update snapshot and drop one timestamp.
    set((state) => {
      const apply = (list: TerminalRecipe[]) =>
        list.map((r) => {
          if (r.id !== resolvedId) return r;
          return {
            ...r,
            lastUsedAt: now,
            usageHistory: [...(r.usageHistory ?? []), now].slice(-20),
          };
        });
      return {
        globalRecipes: apply(state.globalRecipes),
        projectRecipes: apply(state.projectRecipes),
        inRepoRecipes: apply(state.inRepoRecipes),
        recipes: apply(state.recipes),
      };
    });
    // Persist using the freshest snapshot so any racing run's contribution is
    // preserved in the persisted history rather than clobbered.
    const persistSnapshot = get().recipes.find((r) => r.id === resolvedId);
    if (persistSnapshot) {
      get()
        .updateRecipe(resolvedId, {
          lastUsedAt: persistSnapshot.lastUsedAt,
          usageHistory: persistSnapshot.usageHistory,
        })
        .catch((error) => {
          logError("Failed to update lastUsedAt for recipe", error);
        });
    }

    const terminalStore = usePanelStore.getState();

    const indicesToSpawn = options?.terminalIndices ?? recipe.terminals.map((_, i) => i);
    const spawnedBy = options?.spawnedBy;
    // Pass focusPolicy through as-is (potentially undefined). panelStore.addPanel
    // resolves undefined to "auto" — which suppresses focus only when the assistant
    // owns input — or to "preserve" when an MCP dispatch is on the stack
    // (isMcpSpawnFocusSuppressed). Defaulting to "preserve" here would silently
    // strip focus from user-initiated recipe runs (dock menu, NewWorktreeDialog,
    // WorktreeCard); MCP-initiated runs already get "preserve" via panelStore.
    const focusPolicy = options?.focusPolicy;

    const results: RecipeSpawnResults = { spawned: [], failed: [] };

    // Split out-of-bounds indices before anything else so they're reported
    // regardless of how the limit gate or batch resolves. Must run before
    // building `terminalsToSpawn`: `recipe.terminals[i]!` would otherwise
    // pass `undefined` into the `hasAgent` check for any bad index and throw
    // on `.type`, masking the structured failure path entirely.
    const validIndices: number[] = [];
    for (const index of indicesToSpawn) {
      if (recipe.terminals[index]) {
        validIndices.push(index);
      } else {
        results.failed.push({ index, error: `Terminal index ${index} out of bounds` });
      }
    }

    // Pre-fetch agent settings once for all agent terminals
    let agentSettings: Awaited<ReturnType<typeof agentSettingsClient.get>> | null = null;
    let clipboardDirectory: string | undefined;
    const terminalsToSpawn = validIndices.map((i) => recipe.terminals[i]!);
    const hasAgent = terminalsToSpawn.some(
      (t) => t.type !== "terminal" && t.type !== "dev-preview"
    );
    if (hasAgent) {
      try {
        const [settings, tmpDir] = await Promise.all([
          agentSettingsClient.get(),
          systemClient.getTmpDir().catch(() => ""),
        ]);
        agentSettings = settings;
        clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
      } catch (error) {
        logError("Failed to fetch agent settings for recipe", error);
      }
    }

    // Aggregate panel-limit gate BEFORE opening the batch. The batched path
    // defers the `panelIds` append, so per-call limit checks would all read the
    // same stale count and under-enforce the ceiling; gate the whole burst once
    // here and pass `bypassLimits` on each individual call. (#9165)
    const currentCount = terminalStore.panelIds.reduce(
      (n, id) => (terminalStore.panelsById[id]?.location !== "trash" ? n + 1 : n),
      0
    );
    const { allowed } = await preflightSpawnBatchLimit(currentCount, validIndices.length);
    const spawnIndices = validIndices.slice(0, allowed);
    for (const index of validIndices.slice(allowed)) {
      results.failed.push({ index, error: "Panel limit reached" });
    }

    // Capture focus intent synchronously before the batch. The batched
    // `addPanel` path suppresses the per-panel focus mutation (it would defeat
    // the single commit), so focus is restored once after flush. Mirror
    // panelStore.addPanel's gates so a recipe run can't steal focus from the
    // assistant or an in-flight MCP dispatch.
    const suppressFocus =
      focusPolicy === "preserve" || isMcpSpawnFocusSuppressed() || isAssistantFocused();

    // Open one batch for the whole burst: each `addPanel` commits its
    // `panelsById` entry immediately but defers the `panelIds` append, so N
    // panels trigger a single grid reflow at flush instead of N. Skip opening
    // the batch when nothing will spawn (hard limit hit or all indices invalid)
    // so `isHydrationBatchActive()` never briefly flips for unrelated work. (#9165)
    const batchToken = spawnIndices.length > 0 ? terminalStore.beginSpawnBatch() : null;
    try {
      const settled = await Promise.allSettled(
        spawnIndices.map(async (index) => {
          const terminal = recipe.terminals[index]!;

          if (terminal.type === "dev-preview") {
            return terminalStore.addPanel({
              kind: "dev-preview",
              title: terminal.title || "Dev Server",
              cwd: worktreePath,
              worktreeId: worktreeId,
              devCommand: terminal.devCommand?.trim() || undefined,
              env: terminal.env,
              exitBehavior: terminal.exitBehavior,
              spawnedBy,
              focusPolicy,
              bypassLimits: true,
            });
          }

          if (isAgentRecipeType(terminal.type)) {
            const agentId = terminal.type as string;
            const agentConfig = getAgentConfig(agentId);
            const baseCommand = agentConfig?.command ?? "";
            const rawPrompt = terminal.initialPrompt?.trim();
            const resolvedContext: RecipeContext = { ...context, worktreePath };
            const initialPrompt = rawPrompt
              ? replaceRecipeVariables(rawPrompt, resolvedContext)
              : undefined;
            const entry = agentSettings?.agents?.[agentId] ?? {};
            const command = generateAgentCommand(baseCommand, entry, agentId, {
              initialPrompt,
              clipboardDirectory,
              recipeArgs: terminal.args?.trim() || undefined,
            });
            return terminalStore.addPanel({
              kind: "terminal",
              launchAgentId: agentId,
              command,
              title: terminal.title,
              cwd: worktreePath,
              worktreeId: worktreeId,
              env: terminal.env,
              exitBehavior: terminal.exitBehavior,
              spawnedBy,
              focusPolicy,
              bypassLimits: true,
            });
          }

          return terminalStore.addPanel({
            kind: "terminal",
            title: terminal.title,
            cwd: worktreePath,
            command: terminal.command?.trim() || "",
            worktreeId: worktreeId,
            env: terminal.env,
            exitBehavior: terminal.exitBehavior,
            spawnedBy,
            focusPolicy,
            bypassLimits: true,
          });
        })
      );

      settled.forEach((outcome, i) => {
        const index = spawnIndices[i]!;
        if (outcome.status === "fulfilled") {
          if (outcome.value) {
            results.spawned.push({ index, terminalId: outcome.value });
          } else {
            results.failed.push({ index, error: "Panel limit reached" });
          }
        } else {
          const message = formatErrorMessage(outcome.reason, "Failed to spawn terminal");
          logError(`Failed to spawn terminal for recipe ${recipeId}`, outcome.reason);
          results.failed.push({ index, error: message });
        }
      });
    } finally {
      // Always flush so the batch can never be left open (a no-op for a `null`
      // token when a concurrent run already owns the active batch).
      terminalStore.flushSpawnBatch(batchToken);
    }

    // Keep the index-ordered contract callers rely on; parallel settle order
    // and the limit/out-of-bounds prepends would otherwise scramble it.
    results.spawned.sort((a, b) => a.index - b.index);
    results.failed.sort((a, b) => a.index - b.index);

    // Restore the per-panel focus the batch suppressed: focus the last spawned
    // grid panel, matching the prior serial behaviour (last `addPanel` won).
    if (!suppressFocus && results.spawned.length > 0) {
      terminalStore.setFocused(results.spawned[results.spawned.length - 1]!.terminalId);
    }

    return results;
  },

  exportRecipe: (id) => {
    const recipe = get().getRecipeById(id);
    if (!recipe) {
      return null;
    }
    // Export without projectId and shadowedBy - they are assigned/derived on import
    const { projectId: _projectId, shadowedBy: _shadowedBy, ...exportableRecipe } = recipe;
    return JSON.stringify(exportableRecipe, null, 2);
  },

  exportRecipeToFile: async (id) => {
    const recipe = get().getRecipeById(id);
    if (!recipe) return false;
    const { projectId: _p, shadowedBy: _s, ...exportable } = recipe;
    const json = JSON.stringify(exportable, null, 2);
    return projectClient.exportRecipeToFile(recipe.name, json);
  },

  importRecipeFromFile: async (projectId) => {
    const json = await projectClient.importRecipeFromFile();
    if (!json) return false;
    await get().importRecipe(projectId, json);
    return true;
  },

  importRecipe: async (projectId, json) => {
    let recipe: Partial<TerminalRecipe>;
    try {
      recipe = JSON.parse(json);
    } catch (_error) {
      throw new Error("Invalid JSON format");
    }

    if (!recipe.name || !recipe.terminals || !Array.isArray(recipe.terminals)) {
      throw new Error("Invalid recipe format: missing required fields");
    }

    if (recipe.terminals.length === 0) {
      throw new Error("Recipe must contain at least one terminal");
    }
    if (recipe.terminals.length > MAX_TERMINALS_PER_RECIPE) {
      throw new Error(`Recipe cannot exceed ${MAX_TERMINALS_PER_RECIPE} terminals`);
    }

    const ALLOWED_TYPES = ["terminal", ...BUILT_IN_AGENT_IDS, "dev-preview"];
    const ALLOWED_EXIT_BEHAVIORS = ["keep", "trash", "remove"];
    const sanitizedTerminals = recipe.terminals
      .filter((terminal) => {
        if (!ALLOWED_TYPES.includes(terminal.type)) return false;
        if (terminal.command !== undefined) {
          if (typeof terminal.command !== "string") return false;
          // eslint-disable-next-line no-control-regex
          if (/[\r\n\x00-\x1F]/.test(terminal.command)) return false;
        }
        if (terminal.initialPrompt !== undefined) {
          if (typeof terminal.initialPrompt !== "string") return false;
          // Allow newlines (\r\n) but reject other control chars
          // eslint-disable-next-line no-control-regex
          if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(terminal.initialPrompt)) return false;
        }
        if (terminal.args !== undefined) {
          if (typeof terminal.args !== "string") return false;
          // eslint-disable-next-line no-control-regex
          if (/[\r\n\x00-\x1F]/.test(terminal.args)) return false;
        }
        if (terminal.devCommand !== undefined) {
          if (typeof terminal.devCommand !== "string") return false;
          // eslint-disable-next-line no-control-regex
          if (/[\r\n\x00-\x1F]/.test(terminal.devCommand)) return false;
        }
        if (terminal.env !== undefined) {
          if (
            typeof terminal.env !== "object" ||
            terminal.env === null ||
            Array.isArray(terminal.env)
          )
            return false;
          for (const value of Object.values(terminal.env)) {
            if (typeof value !== "string") return false;
          }
        }
        // Validate exitBehavior if present (allow undefined/empty string from UI)
        if (terminal.exitBehavior !== undefined && typeof terminal.exitBehavior === "string") {
          const behavior = terminal.exitBehavior as string;
          // Empty string from UI means "use default" - allow it
          if (behavior !== "" && !ALLOWED_EXIT_BEHAVIORS.includes(behavior)) {
            return false;
          }
        }
        return true;
      })
      .map((terminal) => ({
        type: terminal.type,
        title: typeof terminal.title === "string" ? terminal.title : undefined,
        command:
          terminal.type === "terminal" && typeof terminal.command === "string"
            ? terminal.command.trim() || undefined
            : undefined,
        env: terminal.env,
        initialPrompt:
          terminal.type !== "terminal" &&
          terminal.type !== "dev-preview" &&
          typeof terminal.initialPrompt === "string"
            ? terminal.initialPrompt.replace(/\r\n/g, "\n").trimEnd()
            : undefined,
        devCommand:
          terminal.type === "dev-preview" && typeof terminal.devCommand === "string"
            ? terminal.devCommand.trim() || undefined
            : undefined,
        args:
          terminal.type !== "terminal" &&
          terminal.type !== "dev-preview" &&
          typeof terminal.args === "string"
            ? terminal.args.trim() || undefined
            : undefined,
        exitBehavior:
          terminal.exitBehavior && ALLOWED_EXIT_BEHAVIORS.includes(terminal.exitBehavior as string)
            ? (terminal.exitBehavior as "keep" | "trash" | "remove")
            : undefined,
      }));

    if (sanitizedTerminals.length === 0) {
      throw new Error("No valid terminals found in recipe");
    }

    const isGlobal = projectId === undefined;
    const recipeName = String(recipe.name);
    const importedRecipe: TerminalRecipe = {
      id: `recipe-${crypto.randomUUID()}`,
      name: recipeName,
      projectId: isGlobal ? undefined : projectId,
      worktreeId: isGlobal
        ? undefined
        : typeof recipe.worktreeId === "string"
          ? recipe.worktreeId
          : undefined,
      terminals: sanitizedTerminals,
      createdAt: Date.now(),
      showInEmptyState:
        typeof recipe.showInEmptyState === "boolean" ? recipe.showInEmptyState : false,
      ...(isGlobal ? {} : { scope: "inrepo" as const }),
    };

    const prevGlobal = get().globalRecipes;
    const prevProject = get().projectRecipes;
    const prevInRepo = get().inRepoRecipes;
    const nextGlobal = isGlobal ? [...prevGlobal, importedRecipe] : prevGlobal;
    const nextInRepo = isGlobal ? prevInRepo : [...prevInRepo, importedRecipe];
    set({
      globalRecipes: nextGlobal,
      projectRecipes: prevProject,
      inRepoRecipes: nextInRepo,
      recipes: mergeRecipes(nextGlobal, prevProject, nextInRepo),
    });

    try {
      if (isGlobal) {
        await globalRecipesClient.addRecipe(importedRecipe);
      } else {
        await projectClient.updateInRepoRecipe(projectId, importedRecipe);
      }
    } catch (_error) {
      logError("Failed to persist imported recipe", _error);
      set({
        globalRecipes: prevGlobal,
        projectRecipes: prevProject,
        inRepoRecipes: prevInRepo,
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo),
      });
      throw _error;
    }
  },

  generateRecipeFromActiveTerminals: (worktreeId) => {
    const terminalStore = usePanelStore.getState();

    const activeTerminals = terminalStore.panelIds
      .map((id) => terminalStore.panelsById[id])
      .filter(
        (t): t is NonNullable<typeof t> =>
          Boolean(t) && t!.location !== "trash" && t!.worktreeId === worktreeId
      );

    const terminalsToCapture = activeTerminals.slice(0, MAX_TERMINALS_PER_RECIPE);

    return terminalsToCapture
      .filter((t): t is PtyPanelData | DevPreviewPanelData => isPtyPanel(t) || isDevPreviewPanel(t))
      .map(terminalToRecipeTerminal);
  },

  reset: () =>
    set({
      recipes: [],
      globalRecipes: [],
      projectRecipes: [],
      inRepoRecipes: [],
      isLoading: false,
      currentProjectId: null,
    }),
});

export const useRecipeStore = create<RecipeState>()(createRecipeStore);
