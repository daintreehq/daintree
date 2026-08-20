import { create, type StateCreator } from "zustand";
import type { TerminalRecipe, RecipeTerminal, RecipeTerminalType } from "@/types";
import { isPluginRecipe } from "@shared/types/project";
import type { PluginRecipeMetadataPatch } from "@shared/types/project";
import { usePanelStore } from "./panelStore";
import { preflightSpawnBatchLimit } from "./panelLimitStore";
import { countPanelsTowardLimit } from "./slices/panelRegistry/panelCount";
import { isMcpSpawnFocusSuppressed } from "./mcpSpawnFocusGuard";
import { isAssistantFocused } from "./macroFocusStore";
import {
  isDevPreviewPanel,
  isPtyPanel,
  type DevPreviewPanelData,
  type PtyPanelData,
} from "@shared/types/panel";
import {
  projectClient,
  agentSettingsClient,
  systemClient,
  globalRecipesClient,
  pluginRecipesClient,
} from "@/clients";
import { getAgentConfig, getMergedPreset } from "@/config/agents";
import {
  generateAgentCommand,
  buildAgentLaunchFlags,
  resolveEffectivePresetId,
} from "@shared/types";
import {
  applyPresetBehaviorOverrides,
  mergeAgentRuntimeEnv,
  resolveAgentRuntimeSettings,
} from "@/utils/agentRuntimeSettings";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { replaceRecipeVariables, type RecipeContext } from "@/utils/recipeVariables";
import { sanitizeTerminalName } from "@/utils/agentLaunchValidation";
import { sanitizeRecipeTerminals, MAX_TERMINALS_PER_RECIPE } from "@shared/utils/recipeSanitizer";
import type { ActionSource } from "@shared/types/actions";
import type { AgentCliDetail } from "@shared/types/ipc";
import type { TerminalSpawnSource, AddPanelFocusPolicy } from "@shared/types/panel";
import { isInRepoRecipeId, safeRecipeFilename } from "@shared/utils/recipeFilename";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isClientAppError } from "@/utils/clientAppError";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";

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
  /** Shared admission batch for one user-confirmed recipe operation spanning worktrees. */
  spawnBatch?: { id: string; size: number };
  /**
   * The action dispatch source that triggered this run. When `"agent"`, a
   * lower per-run terminal cap ({@link MAX_AGENT_RECIPE_TERMINALS}) is applied
   * to bound the blast radius of MCP-driven recipe runs. Forwarded from
   * `recipe.run`'s `ActionContext.dispatchSource`.
   */
  dispatchSource?: ActionSource;
}

function isAgentRecipeType(type: RecipeTerminalType): boolean {
  return type !== "terminal" && type !== "dev-preview";
}

// Recipes read from disk may still contain agentModelId/agentLaunchFlags/location
// if they were written by an older build before those fields were stripped on
// persist. Treat them as session-only state and drop them at load time.
//
// `origin` is dropped for a different reason: this runs over the three
// USER-OWNED tiers, whose files a user can hand-edit and whose schema is
// `.passthrough()`. An `origin` present there is a forgery — only the plugin
// registry stamps real provenance — and honouring it would route that recipe's
// writes into the plugin sidecar and make it undeletable (#11860).
function stripSessionOverridesFromRecipe(recipe: TerminalRecipe): TerminalRecipe {
  let changed = false;
  const terminals = recipe.terminals.map((terminal) => {
    if (
      terminal.agentModelId === undefined &&
      terminal.agentLaunchFlags === undefined &&
      terminal.location === undefined
    ) {
      return terminal;
    }
    changed = true;
    const { agentModelId: _m, agentLaunchFlags: _f, location: _l, ...rest } = terminal;
    return rest;
  });
  if (recipe.shadowedBy !== undefined || recipe.origin !== undefined) {
    const { shadowedBy: _s, origin: _o, ...rest } = recipe;
    return { ...rest, ...(changed ? { terminals } : {}) };
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
    location: undefined,
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
      location: terminal.location === "dock" ? "dock" : undefined,
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
    location: terminal.location === "dock" ? "dock" : undefined,
  };
}

interface RecipeState {
  recipes: TerminalRecipe[];
  globalRecipes: TerminalRecipe[];
  projectRecipes: TerminalRecipe[];
  inRepoRecipes: TerminalRecipe[];
  /**
   * Plugin-contributed recipes (#11860). Owned entirely by `usePluginRecipes`
   * (pull-on-mount plus an authoritative push), NOT by {@link loadRecipes}:
   * they are project-independent, so folding them into the per-project load
   * would race a broadcast for no benefit and clear them on every switch.
   */
  pluginRecipes: TerminalRecipe[];
  isLoading: boolean;
  currentProjectId: string | null;

  loadRecipes: (projectId: string) => Promise<void>;
  /** Replace the plugin tier wholesale from main's authoritative snapshot. */
  setPluginRecipes: (recipes: TerminalRecipe[]) => void;
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

// Re-exported from the shared module so existing renderer imports
// (`import { MAX_TERMINALS_PER_RECIPE } from "@/store/recipeStore"`) keep working
// while the in-repo load path (Electron main) shares the same constant.
export { MAX_TERMINALS_PER_RECIPE };

/**
 * Per-run terminal cap for agent-dispatched recipe runs. A single MCP-approved
 * `recipe.run` shouldn't authorize a full {@link MAX_TERMINALS_PER_RECIPE}-wide
 * spawn — an agent context needs at most a handful of panels. Bounds the blast
 * radius without blocking legitimate agent use.
 */
export const MAX_AGENT_RECIPE_TERMINALS = 3;

let loadRecipesRequestId = 0;

/**
 * Flatten the four recipe tiers into the list the UI renders.
 *
 * `pluginRecipes` is REQUIRED and deliberately has no default: a default would
 * let any one of the dozen mutation sites silently drop every plugin recipe
 * from the merged view by forgetting to pass it, whereas an omission is now a
 * compile error (#11860).
 */
function mergeRecipes(
  globalRecipes: TerminalRecipe[],
  projectRecipes: TerminalRecipe[],
  inRepoRecipes: TerminalRecipe[],
  pluginRecipes: TerminalRecipe[]
): TerminalRecipe[] {
  // Project-local recipes that share a name with an in-repo recipe are kept but
  // marked as shadowed so the UI can surface them dimmed instead of hiding them.
  // ProjectFileStore also carries a reconciled mirror of each in-repo recipe so
  // runtime metadata can survive. Do not render those mirrors as project-local
  // duplicates; use the mirror as the displayed in-repo recipe instead.
  const inRepoIds = new Set(inRepoRecipes.map((r) => r.id));
  const inRepoNames = new Set(inRepoRecipes.map((r) => r.name));
  const inRepoMirrors = new Map(
    projectRecipes
      .filter((r) => inRepoIds.has(r.id) && isInRepoRecipeId(r))
      .map((r) => [r.id, r] as const)
  );
  const projectLocalRecipes = projectRecipes.filter(
    (r) => !(inRepoIds.has(r.id) && isInRepoRecipeId(r))
  );
  const projectWithMarkers = projectLocalRecipes.map((r) =>
    inRepoNames.has(r.name) ? { ...r, shadowedBy: r.name } : r
  );
  const inRepoWithMirrors = inRepoRecipes.map((r) => {
    const mirror = inRepoMirrors.get(r.id);
    if (!mirror) return r;
    const { shadowedBy: _shadowedBy, ...displayRecipe } = mirror;
    return displayRecipe;
  });
  // Plugin recipes sit with the other always-available entries and take no part
  // in name shadowing: their ids are plugin-qualified, so identity is exact and
  // a user recipe that happens to share a display name is a different recipe,
  // not an override of one.
  return [...globalRecipes, ...pluginRecipes, ...projectWithMarkers, ...inRepoWithMirrors];
}

const createRecipeStore: StateCreator<RecipeState> = (set, get) => ({
  recipes: [],
  globalRecipes: [],
  projectRecipes: [],
  inRepoRecipes: [],
  pluginRecipes: [],
  isLoading: false,
  currentProjectId: null,

  setPluginRecipes: (pluginRecipes) => {
    set((state) => ({
      pluginRecipes,
      recipes: mergeRecipes(
        state.globalRecipes,
        state.projectRecipes,
        state.inRepoRecipes,
        pluginRecipes
      ),
    }));
  },

  loadRecipes: async (projectId: string) => {
    const requestId = ++loadRecipesRequestId;
    const previousProjectId = get().currentProjectId;
    const clearRecipes = previousProjectId && previousProjectId !== projectId;
    set({
      isLoading: true,
      currentProjectId: projectId,
      // The plugin tier is intentionally absent from this reset: it is global,
      // owned by the plugin hook, and re-fetching it per project switch would
      // make every switch flash plugin recipes out of the list (#11860).
      ...(clearRecipes
        ? {
            recipes: mergeRecipes([], [], [], get().pluginRecipes),
            globalRecipes: [],
            projectRecipes: [],
            inRepoRecipes: [],
          }
        : {}),
    });
    try {
      const [globalRecipesRaw, projectRecipesResult, inRepoRecipesRaw] = await Promise.all([
        // Degrade each source independently: a transient read failure in one
        // store (e.g. GlobalFileStore.getRecipes now rethrows non-ENOENT read
        // errors) must not clear the other two. The global read previously
        // swallowed errors itself; keep loadRecipes resilient now that it does
        // not.
        globalRecipesClient.getRecipes().catch(() => [] as TerminalRecipe[]),
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
      // The canonical .daintree/recipes/*.json files intentionally omit
      // machine-local frecency (lastUsedAt/usageHistory) — it lives only in the
      // ProjectFileStore mirror (#11354). RecipeManager renders inRepoRecipes
      // directly, so hydrate those fields from the mirror; otherwise team
      // recipes read "Never used" after every reload despite being persisted.
      const inRepoMirrorMeta = new Map(
        projectRecipes.filter((r) => isInRepoRecipeId(r)).map((r) => [r.id, r] as const)
      );
      const inRepoRecipes = inRepoRecipesRaw.map(stripSessionOverridesFromRecipe).map((r) => {
        const mirror = inRepoMirrorMeta.get(r.id);
        if (!mirror) return r;
        return { ...r, lastUsedAt: mirror.lastUsedAt, usageHistory: mirror.usageHistory };
      });
      set({
        globalRecipes,
        projectRecipes,
        inRepoRecipes,
        recipes: mergeRecipes(globalRecipes, projectRecipes, inRepoRecipes, get().pluginRecipes),
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
          context: { eventKind: "settings" },
        });
      }
    } catch (error) {
      if (requestId !== loadRecipesRequestId || get().currentProjectId !== projectId) {
        return;
      }
      logError("Failed to load recipes", error);
      set({
        recipes: mergeRecipes([], [], [], get().pluginRecipes),
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
      recipes: mergeRecipes(nextGlobal, prevProject, nextInRepo, get().pluginRecipes),
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
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo, get().pluginRecipes),
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

    // Provenance is resolved BEFORE the `projectId === undefined` inference
    // below. A plugin recipe also carries no projectId, so without this it
    // would read as global and its writes would land in GlobalFileStore's
    // recipes.json — creating a user-owned ghost of a recipe the plugin still
    // owns (#11860).
    if (isPluginRecipe(recipe)) {
      const patch: PluginRecipeMetadataPatch = {};
      for (const key of Object.keys(updates)) {
        // Frecency has its own atomic main-process path (`recordUse`), which
        // appends against the freshest on-disk history rather than accepting a
        // whole array a second window may already have superseded. Drop it here
        // rather than rejecting: `runRecipeWithResults` routes it directly.
        if (key === "lastUsedAt" || key === "usageHistory") continue;
        // A key present with an `undefined` value means "clear the override" —
        // `in`-style key presence, not value truthiness, is what separates that
        // from "not part of this patch".
        if (key === "showInEmptyState") {
          patch.showInEmptyState = updates.showInEmptyState ?? null;
          continue;
        }
        if (key === "autoAssign") {
          patch.autoAssign = updates.autoAssign ?? null;
          continue;
        }
        throw new Error(
          `"${recipe.name}" is provided by the ${recipe.origin.pluginId} plugin and can't be edited. Save it to the repo to make an editable copy.`
        );
      }
      if (Object.keys(patch).length === 0) return;

      const applyPatch = (target: TerminalRecipe): TerminalRecipe => {
        const next = { ...target };
        if (patch.showInEmptyState !== undefined) {
          if (patch.showInEmptyState === null) delete next.showInEmptyState;
          else next.showInEmptyState = patch.showInEmptyState;
        }
        if (patch.autoAssign !== undefined) {
          if (patch.autoAssign === null) delete next.autoAssign;
          else next.autoAssign = patch.autoAssign;
        }
        return next;
      };

      const prevPlugin = get().pluginRecipes;
      get().setPluginRecipes(prevPlugin.map((r) => (r.id === id ? applyPatch(r) : r)));
      try {
        const persisted = await pluginRecipesClient.updateMetadata(id, patch);
        get().setPluginRecipes(get().pluginRecipes.map((r) => (r.id === id ? persisted : r)));
      } catch (error) {
        // A preference edit is an explicit user action, so it rolls back and
        // surfaces — unlike a frecency stamp, which fails silently.
        get().setPluginRecipes(prevPlugin);
        logError("Failed to persist plugin recipe preference", error);
        throw error;
      }
      return;
    }

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
      recipes: mergeRecipes(nextGlobal, nextProject, nextInRepo, get().pluginRecipes),
    });

    try {
      if (isInRepo) {
        const metadataOnlyKeys = new Set(["lastUsedAt", "usageHistory"]);
        const updateKeys = Object.keys(updates);
        const isMetadataOnly = updateKeys.every((k) => metadataOnlyKeys.has(k));
        const projectId = get().currentProjectId;
        if (isMetadataOnly) {
          // Frecency-only edit (lastUsedAt / usageHistory). Persist it to the
          // ProjectFileStore mirror — never the canonical git-tracked
          // .daintree/recipes/*.json file (that's exactly what metadataOnlyKeys
          // keeps out) — so in-repo usage metadata survives a reload the same
          // way project and global recipes already do (#11354). Best-effort:
          // the mirror entry only exists once reconcileProjectRecipes has
          // backfilled it (after the first load), so a not-yet-reconciled
          // "recipe not found" degrades to losing this one stamp rather than
          // rolling back the optimistic update or surfacing a toast for a
          // low-stakes write. An empty patch stays a true no-op (updateKeys is
          // empty, so `every` is vacuously true — don't issue a mirror write).
          if (projectId && updateKeys.length > 0) {
            await projectClient.updateRecipe(projectId, id, sanitizedUpdates).catch((error) => {
              logError("Failed to persist in-repo recipe usage metadata", error);
            });
          }
        } else {
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
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo, get().pluginRecipes),
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
              recipes: mergeRecipes(
                get().globalRecipes,
                refreshedProject,
                refreshedInRepo,
                get().pluginRecipes
              ),
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
    if (isPluginRecipe(recipe)) {
      throw new Error(
        `"${recipe.name}" is provided by the ${recipe.origin.pluginId} plugin. Disable or uninstall the plugin to remove it.`
      );
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
      recipes: mergeRecipes(nextGlobal, nextProject, nextInRepo, get().pluginRecipes),
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
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo, get().pluginRecipes),
      });
      throw error;
    }
  },

  saveToRepo: async (recipeId, requestedDeleteOriginal = false) => {
    const recipe = get().recipes.find((r) => r.id === recipeId);
    if (!recipe) throw new Error(`Recipe ${recipeId} not found`);
    if (isInRepoRecipeId(recipe)) throw new Error("Recipe is already in-repo");

    const currentProjectId = get().currentProjectId;
    if (!currentProjectId) throw new Error("No current project");

    // Promoting a plugin recipe is the sanctioned way to customise one: it
    // duplicates the content into a user-owned tier. `origin` is dropped so the
    // copy is genuinely user-owned, and the original is never deleted — the
    // plugin still owns it (#11860).
    const fromPlugin = isPluginRecipe(recipe);
    const isGlobal = !fromPlugin && recipe.projectId === undefined;
    const {
      projectId: _,
      worktreeId: _w,
      shadowedBy: _s,
      origin: _o,
      lastUsedAt: priorLastUsedAt,
      usageHistory: priorUsageHistory,
      ...rest
    } = recipe;
    // Reuse the id of an existing in-repo recipe that maps to the same on-disk
    // filename so a repeat promotion is an idempotent update rather than a
    // duplicate or an on-disk stale conflict. Compare by filename slug, not the
    // raw name, since "My Recipe"/"my recipe" share my-recipe.json. Otherwise
    // mint a fresh opaque id.
    const targetFilename = safeRecipeFilename(recipe.name);
    const existingInRepoId = get().inRepoRecipes.find(
      (r) => safeRecipeFilename(r.name) === targetFilename
    )?.id;
    const promoted: TerminalRecipe = {
      ...rest,
      // Frecency carries over for a user recipe (same recipe, new home) but not
      // for a plugin one: the copy is a NEW recipe whose usage history belongs
      // to the plugin-owned original, which keeps its own in the sidecar.
      ...(fromPlugin ? {} : { lastUsedAt: priorLastUsedAt, usageHistory: priorUsageHistory }),
      id: existingInRepoId ?? `recipe-${crypto.randomUUID()}`,
      scope: "inrepo",
    };

    // A plugin recipe's "original" lives in the plugin's manifest — there is
    // nothing here to delete, and honouring the flag would throw from
    // deleteRecipe after the in-repo write already succeeded.
    const deleteOriginal = requestedDeleteOriginal && !fromPlugin;

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
      recipes: mergeRecipes(nextGlobal, nextProject, nextInRepo, get().pluginRecipes),
    });

    try {
      await projectClient.updateInRepoRecipe(currentProjectId, promoted);
    } catch (error) {
      logError("Failed to save recipe to repo", error);
      set({
        globalRecipes: prevGlobal,
        projectRecipes: prevProject,
        inRepoRecipes: prevInRepo,
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo, get().pluginRecipes),
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
          recipes: mergeRecipes(prevGlobal, prevProject, nextInRepo, get().pluginRecipes),
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
      // Resolve through the merged list, not `inRepoRecipes` directly: the
      // merged entry is the ProjectFileStore mirror, which keeps the local env
      // values the git-tracked canonical copy redacts. Going straight to
      // `inRepoRecipes` would launch a shadowed row with blank env while the
      // Team row it defers to runs hydrated.
      const winner = get().inRepoRecipes.find((r) => r.name === recipe.name);
      if (!winner) return recipe;
      return get().recipes.find((r) => r.id === winner.id) ?? winner;
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
        pluginRecipes: apply(state.pluginRecipes),
        recipes: apply(state.recipes),
      };
    });
    // Persist against the RESOLVED winner — `getRecipeById` can hand back a
    // different recipe than the id asked for — and route on its provenance.
    const persistSnapshot = get().recipes.find((r) => r.id === resolvedId);
    if (persistSnapshot && isPluginRecipe(persistSnapshot)) {
      // A plugin recipe has no writable user-tier file. Send only the timestamp
      // and let main append it atomically, so two windows running the same
      // recipe can't overwrite each other with their own stale history array.
      // Best-effort: a lost frecency stamp must never fail a spawn (#11860).
      void pluginRecipesClient.recordUse(resolvedId, now).catch((error: unknown) => {
        logError("Failed to record plugin recipe usage", error);
      });
    } else if (persistSnapshot) {
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

    // Defense-in-depth blast-radius cap for agent-dispatched runs. recipe.run's
    // danger:"confirm" gate already requires user approval for agent sources,
    // but one approval shouldn't authorize a full 10-terminal recipe. Apply the
    // cap BEFORE preflightSpawnBatchLimit so a capped agent run can never reach
    // the confirmation-dialog path (which would hang a headless MCP dispatch).
    if (options?.dispatchSource === "agent" && validIndices.length > MAX_AGENT_RECIPE_TERMINALS) {
      const dropped = validIndices.splice(MAX_AGENT_RECIPE_TERMINALS);
      for (const index of dropped) {
        results.failed.push({ index, error: "Agent recipe terminal cap reached" });
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
    const currentCount = countPanelsTowardLimit(terminalStore.panelsById, terminalStore.panelIds);
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
    const ptySpawnCount = spawnIndices.filter(
      (index) => recipe.terminals[index]?.type !== "dev-preview"
    ).length;
    const requestedSpawnBatch = options?.spawnBatch;
    const launchCliDetails = new Map<string, Promise<AgentCliDetail | undefined>>();
    const spawnBatch =
      requestedSpawnBatch &&
      requestedSpawnBatch.size >= ptySpawnCount &&
      requestedSpawnBatch.size > 1
        ? {
            spawnBatchId: requestedSpawnBatch.id,
            spawnBatchSize: requestedSpawnBatch.size,
          }
        : ptySpawnCount > 1
          ? { spawnBatchId: crypto.randomUUID(), spawnBatchSize: ptySpawnCount }
          : {};
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

          // A recipe that names its panes owns those names: pin them as
          // "custom" so agent detection can't rewrite them on promotion or
          // demote them on exit. Recipes are how a fleet gets launched and
          // role titles (TEAMLEAD, DEV1...) are how its panes are told apart,
          // so losing them defeats the point of naming (#11872). Mirrors the
          // caller-name pin `agent.launch` has had since #10439.
          //
          // Sanitizing drives the predicate only — `title:` still passes the
          // raw string so the pane matches what the recipe editor shows. The
          // recipe sanitizer keeps titles verbatim (unlike command/args), so
          // a whitespace- or control-only title would pass plain truthiness;
          // `sanitizeTerminalName` returns "" for those, leaving them
          // unpinned and eligible for the derived title as before. Derived
          // per terminal, never hoisted above the map: one pane's title must
          // not decide another's pin (#10794). Conditional spread, never
          // `titleMode: undefined`, which `addPanel` reads as an explicit
          // "default".
          const titlePin = sanitizeTerminalName(terminal.title ?? "")
            ? { titleMode: "custom" as const }
            : {};

          if (isAgentRecipeType(terminal.type)) {
            const agentId = terminal.type as string;
            const agentConfig = getAgentConfig(agentId);
            let launchCliDetail = launchCliDetails.get(agentId);
            if (!launchCliDetail) {
              launchCliDetail = getCurrentLaunchCliDetail(agentId, true);
              launchCliDetails.set(agentId, launchCliDetail);
            }
            const baseCommand = resolveAgentLaunchBaseCommand(
              agentConfig?.command ?? "",
              await launchCliDetail
            );
            const rawPrompt = terminal.initialPrompt?.trim();
            const resolvedContext: RecipeContext = { ...context, worktreePath };
            const initialPrompt = rawPrompt
              ? replaceRecipeVariables(rawPrompt, resolvedContext)
              : undefined;
            const entry = agentSettings?.agents?.[agentId] ?? {};
            const globalSkipPermissions = agentSettings?.globalSkipPermissions ?? false;
            const globalUseAltScreen = agentSettings?.globalUseAltScreen ?? false;

            // Resolve the selected preset to parity with manual launches
            // (useAgentLauncher): the worktree-scoped pick wins over the
            // agent-level default, and the preset's args/env/behavioral
            // overrides must fold into the spawn. Without this, recipe
            // launches silently ignored the chosen preset (#10722).
            const resolvedPresetId = resolveEffectivePresetId(entry, worktreeId);
            const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[agentId];
            const projectPresets = useProjectPresetsStore.getState().presetsByAgent[agentId];
            const resolution = resolveAgentRuntimeSettings({
              agentId,
              presetId: resolvedPresetId,
              entry,
              ccrPresets,
              projectPresets,
            });
            let preset = resolution.preset;
            let effectiveEntry = resolution.effectiveEntry;
            // Stale worktree-scoped preset: fall back to the agent-level
            // default if it still resolves. Unlike useAgentLauncher we never
            // clear the vanished slot here — recipe launches must not mutate
            // persisted agent settings (the recipe path deliberately avoids
            // useAgentSettingsStore).
            const scopedId =
              worktreeId && entry.worktreePresets ? entry.worktreePresets[worktreeId] : undefined;
            if (
              resolution.presetWasStale &&
              scopedId &&
              scopedId === resolvedPresetId &&
              entry.presetId &&
              entry.presetId !== scopedId
            ) {
              const fallbackPreset = getMergedPreset(
                agentId,
                entry.presetId,
                entry.customPresets,
                ccrPresets,
                projectPresets
              );
              if (fallbackPreset) {
                preset = fallbackPreset;
                effectiveEntry = applyPresetBehaviorOverrides(entry, fallbackPreset);
              }
            }

            // Layer env: global env (base) < preset env < recipe-defined env.
            // The recipe's own `terminal.env` is caller-supplied and must win.
            const baseEnv = mergeAgentRuntimeEnv(entry, preset);
            const finalEnv =
              baseEnv || terminal.env ? { ...baseEnv, ...terminal.env } : terminal.env;

            const command = generateAgentCommand(baseCommand, effectiveEntry, agentId, {
              initialPrompt,
              clipboardDirectory,
              modelId: terminal.agentModelId,
              recipeArgs: terminal.args?.trim() || undefined,
              presetArgs: preset?.args?.join(" "),
              globalSkipPermissions,
              globalUseAltScreen,
            });
            // Persist the process-level launch flags so restart/resume/continue
            // reproduce the same configuration. Without this the panel arrives
            // with `agentLaunchFlags: undefined` and the restart slice silently
            // regenerates the command from current settings, dropping
            // `--dangerously-skip-permissions` and the recipe's args (#9650).
            // Preserve flags an in-memory recipe already carries; for disk
            // recipes the field is stripped (undefined), so compute from live
            // settings (mirroring useAgentLauncher) and append recipe args as
            // raw tokens since the restart command builder applies its own
            // escaping.
            const agentLaunchFlags = terminal.agentLaunchFlags ?? [
              ...buildAgentLaunchFlags(effectiveEntry, agentId, {
                modelId: terminal.agentModelId,
                presetArgs: preset?.args,
                globalSkipPermissions,
                globalUseAltScreen,
              }),
              ...(terminal.args?.trim().split(/\s+/).filter(Boolean) ?? []),
            ];
            return terminalStore.addPanel({
              kind: "terminal",
              launchAgentId: agentId,
              command,
              title: terminal.title,
              ...titlePin,
              cwd: worktreePath,
              worktreeId: worktreeId,
              agentLaunchFlags,
              agentModelId: terminal.agentModelId,
              agentPresetId: preset?.id,
              agentPresetColor: preset?.color,
              env: finalEnv,
              exitBehavior: terminal.exitBehavior,
              spawnedBy,
              focusPolicy,
              bypassLimits: true,
              ...spawnBatch,
            });
          }

          return terminalStore.addPanel({
            kind: "terminal",
            title: terminal.title,
            ...titlePin,
            cwd: worktreePath,
            command: terminal.command?.trim() || "",
            worktreeId: worktreeId,
            env: terminal.env,
            exitBehavior: terminal.exitBehavior,
            spawnedBy,
            focusPolicy,
            bypassLimits: true,
            ...spawnBatch,
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
      const focusId = results.spawned[results.spawned.length - 1]!.terminalId;
      // The batch suppressed addPanel's maximize exit along with its focus set,
      // so apply it here too — the agents the user just launched have to be
      // visible, not stranded behind a fullscreen cell (#11060). Read the panel
      // back fresh (`terminalStore` is a pre-spawn snapshot) and require it to
      // still be a live grid panel: it can be removed during addPanel's async
      // tail, and a missing panel must not drop the user out of fullscreen.
      const committed = usePanelStore.getState().panelsById[focusId];
      if (committed !== undefined && committed.location !== "dock") {
        terminalStore.exitMaximize();
      }
      terminalStore.setFocused(focusId);
    }

    // Record this run in the durable history (#9949). Fire-and-forget AFTER the
    // spawn batch has flushed (above) so the IPC write can't interleave with the
    // deferred `panelIds` commit (#9345); a thrown IPC error must never fail the
    // run, so we `void` + `.catch`. Pane titles are snapshotted from the live
    // registry so the record stays legible after a terminal closes.
    const panelsForTitles = usePanelStore.getState().panelsById;
    safeFireAndForget(
      window.electron.runHistory.append({
        kind: "recipe",
        recipeId: resolvedId,
        recipeName: recipe.name,
        worktreeId,
        worktreeName: context?.branchName,
        totalTerminals: recipe.terminals.length,
        durationMs: Date.now() - now,
        spawned: results.spawned.map((s) => ({
          index: s.index,
          terminalId: s.terminalId,
          title: panelsForTitles[s.terminalId]?.title,
        })),
        failed: results.failed,
      }),
      { context: "Failed to record recipe run history" }
    );

    return results;
  },

  exportRecipe: (id) => {
    const recipe = get().getRecipeById(id);
    if (!recipe) {
      return null;
    }
    // Export without projectId, shadowedBy, or origin — the first two are
    // assigned/derived on import, and re-importing a plugin recipe must produce
    // a plain user-owned copy rather than a forged plugin recipe (#11860).
    const {
      projectId: _projectId,
      shadowedBy: _shadowedBy,
      origin: _origin,
      ...exportableRecipe
    } = recipe;
    return JSON.stringify(exportableRecipe, null, 2);
  },

  exportRecipeToFile: async (id) => {
    const recipe = get().getRecipeById(id);
    if (!recipe) return false;
    const { projectId: _p, shadowedBy: _s, origin: _o, ...exportable } = recipe;
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

    // Content-validate at the import trust boundary. Shared with the in-repo
    // load path (ProjectIdentityFiles.readInRepoRecipesWithHashes) so both
    // entry points apply the same type allowlist, control-char filtering, and
    // explicit field mapping before a terminal can reach the spawn path.
    const sanitizedTerminals = sanitizeRecipeTerminals(recipe.terminals);

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
      recipes: mergeRecipes(nextGlobal, prevProject, nextInRepo, get().pluginRecipes),
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
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo, get().pluginRecipes),
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
      pluginRecipes: [],
      isLoading: false,
      currentProjectId: null,
    }),
});

export const useRecipeStore = create<RecipeState>()(createRecipeStore);
