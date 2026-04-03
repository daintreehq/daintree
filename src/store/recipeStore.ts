import { create, type StateCreator } from "zustand";
import type { TerminalRecipe, RecipeTerminal, RecipeTerminalType } from "@/types";
import { useTerminalStore, type TerminalInstance } from "./terminalStore";
import { projectClient, agentSettingsClient, systemClient, globalRecipesClient } from "@/clients";
import { getAgentConfig } from "@/config/agents";
import { generateAgentCommand } from "@shared/types";
import { replaceRecipeVariables, type RecipeContext } from "@/utils/recipeVariables";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { stableInRepoId, isInRepoRecipeId } from "@shared/utils/recipeFilename";

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

function isAgentRecipeType(type: RecipeTerminalType): boolean {
  return type !== "terminal" && type !== "dev-preview";
}

function sanitizeRecipeTerminal(terminal: RecipeTerminal): RecipeTerminal {
  const isAgent = isAgentRecipeType(terminal.type);
  const command = terminal.command?.trim() || undefined;
  const devCommand = terminal.devCommand?.trim() || undefined;
  const initialPrompt =
    typeof terminal.initialPrompt === "string"
      ? terminal.initialPrompt.replace(/\r\n/g, "\n").trimEnd() || undefined
      : undefined;

  return {
    ...terminal,
    command: isAgent ? undefined : command,
    initialPrompt: isAgent ? initialPrompt : undefined,
    devCommand: terminal.type === "dev-preview" ? devCommand : undefined,
  };
}

function terminalToRecipeTerminal(terminal: TerminalInstance): RecipeTerminal {
  // Map kind to RecipeTerminalType
  const type: RecipeTerminalType =
    terminal.kind === "dev-preview"
      ? "dev-preview"
      : (terminal.agentId ?? terminal.type ?? "terminal");

  return {
    type,
    title: terminal.title || undefined,
    command: terminal.command || undefined,
    devCommand: terminal.kind === "dev-preview" ? terminal.devCommand : undefined,
    env: {},
    exitBehavior: terminal.exitBehavior,
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
    context?: RecipeContext
  ) => Promise<void>;

  runRecipeWithResults: (
    recipeId: string,
    worktreePath: string,
    worktreeId?: string,
    context?: RecipeContext,
    terminalIndices?: number[]
  ) => Promise<RecipeSpawnResults>;

  saveToRepo: (recipeId: string, deleteOriginal?: boolean) => Promise<void>;

  exportRecipe: (id: string) => string | null;
  importRecipe: (projectId: string | undefined, json: string) => Promise<void>;

  generateRecipeFromActiveTerminals: (worktreeId: string) => RecipeTerminal[];

  reset: () => void;
}

const MAX_TERMINALS_PER_RECIPE = 10;

let loadRecipesRequestId = 0;

function mergeRecipes(
  globalRecipes: TerminalRecipe[],
  projectRecipes: TerminalRecipe[],
  inRepoRecipes: TerminalRecipe[] = []
): TerminalRecipe[] {
  // Project-local recipes that share a name with an in-repo recipe are shadowed
  const inRepoNames = new Set(inRepoRecipes.map((r) => r.name));
  const visibleProject = projectRecipes.filter((r) => !inRepoNames.has(r.name));
  return [...globalRecipes, ...visibleProject, ...inRepoRecipes];
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
      const [globalRecipes, projectRecipes, inRepoRecipes] = await Promise.all([
        globalRecipesClient.getRecipes(),
        projectClient.getRecipes(projectId),
        projectClient.getInRepoRecipes(projectId).catch(() => [] as TerminalRecipe[]),
      ]);
      if (requestId !== loadRecipesRequestId || get().currentProjectId !== projectId) {
        return;
      }
      set({
        globalRecipes,
        projectRecipes,
        inRepoRecipes,
        recipes: mergeRecipes(globalRecipes, projectRecipes, inRepoRecipes),
        isLoading: false,
      });
    } catch (error) {
      if (requestId !== loadRecipesRequestId || get().currentProjectId !== projectId) {
        return;
      }
      console.error("Failed to load recipes:", error);
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
      id: isGlobal
        ? `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        : stableInRepoId(name),
      name,
      projectId: isGlobal ? undefined : projectId,
      worktreeId: isGlobal ? undefined : worktreeId,
      terminals: terminals.map(sanitizeRecipeTerminal),
      createdAt: Date.now(),
      showInEmptyState,
      autoAssign,
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
      console.error("Failed to persist recipe:", error);
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

    const recipe = recipes[index];
    const isInRepo = isInRepoRecipeId(id);
    const isGlobal = !isInRepo && recipe.projectId === undefined;
    const sanitizedTerminals = updates.terminals?.map(sanitizeRecipeTerminal);
    const sanitizedUpdates = sanitizedTerminals
      ? { ...updates, terminals: sanitizedTerminals }
      : updates;

    // For in-repo recipes with a name change, compute the new stable ID
    const nameChanged = isInRepo && updates.name && stableInRepoId(updates.name) !== id;
    const newId = nameChanged ? stableInRepoId(updates.name!) : id;

    const updatedRecipe = {
      ...recipe,
      ...sanitizedUpdates,
      id: newId,
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
    const nextProject = !isGlobal && !isInRepo ? applyUpdate(prevProject) : prevProject;
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
      console.error("Failed to persist recipe update:", error);
      set({
        globalRecipes: prevGlobal,
        projectRecipes: prevProject,
        inRepoRecipes: prevInRepo,
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo),
      });
      throw error;
    }
  },

  deleteRecipe: async (id) => {
    const recipes = get().recipes;
    const recipe = recipes.find((r) => r.id === id);
    if (!recipe) {
      throw new Error(`Recipe ${id} not found`);
    }

    const isInRepo = isInRepoRecipeId(id);
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
      console.error("Failed to persist recipe deletion:", error);
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
    if (isInRepoRecipeId(recipeId)) throw new Error("Recipe is already in-repo");

    const currentProjectId = get().currentProjectId;
    if (!currentProjectId) throw new Error("No current project");

    const isGlobal = recipe.projectId === undefined;
    const { projectId: _, worktreeId: _w, ...rest } = recipe;
    const promoted: TerminalRecipe = { ...rest, id: stableInRepoId(recipe.name) };

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
      if (deleteOriginal) {
        if (isGlobal) {
          await globalRecipesClient.deleteRecipe(recipeId);
        } else {
          await projectClient.deleteRecipe(recipe.projectId!, recipeId);
        }
      }
    } catch (error) {
      console.error("Failed to save recipe to repo:", error);
      set({
        globalRecipes: prevGlobal,
        projectRecipes: prevProject,
        inRepoRecipes: prevInRepo,
        recipes: mergeRecipes(prevGlobal, prevProject, prevInRepo),
      });
      throw error;
    }
  },

  getRecipesForWorktree: (worktreeId) => {
    const recipes = get().recipes;
    // Only return recipes for the specific worktree or project-wide recipes (undefined worktreeId)
    // No longer falling back to global recipes - all recipes now belong to a project
    return recipes.filter((r) => r.worktreeId === worktreeId || r.worktreeId === undefined);
  },

  getRecipeById: (id) => {
    return get().recipes.find((r) => r.id === id);
  },

  runRecipe: async (recipeId, worktreePath, worktreeId, context) => {
    await get().runRecipeWithResults(recipeId, worktreePath, worktreeId, context);
  },

  runRecipeWithResults: async (recipeId, worktreePath, worktreeId, context, terminalIndices) => {
    const recipe = get().getRecipeById(recipeId);
    if (!recipe) {
      throw new Error(`Recipe ${recipeId} not found`);
    }

    const now = Date.now();
    const prevHistory = recipe.usageHistory ?? [];
    const usageHistory = [...prevHistory, now].slice(-20);
    get()
      .updateRecipe(recipeId, { lastUsedAt: now, usageHistory })
      .catch((error) => {
        console.warn("Failed to update lastUsedAt for recipe:", error);
      });

    const terminalStore = useTerminalStore.getState();

    const indicesToSpawn = terminalIndices ?? recipe.terminals.map((_, i) => i);

    // Pre-fetch agent settings once for all agent terminals
    let agentSettings: Awaited<ReturnType<typeof agentSettingsClient.get>> | null = null;
    let clipboardDirectory: string | undefined;
    const terminalsToSpawn = indicesToSpawn.map((i) => recipe.terminals[i]!);
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
        clipboardDirectory = tmpDir ? `${tmpDir}/canopy-clipboard` : undefined;
      } catch (error) {
        console.warn("Failed to fetch agent settings for recipe:", error);
      }
    }

    const results: RecipeSpawnResults = { spawned: [], failed: [] };

    for (const index of indicesToSpawn) {
      const terminal = recipe.terminals[index];
      if (!terminal) {
        results.failed.push({ index, error: `Terminal index ${index} out of bounds` });
        continue;
      }
      try {
        // Handle dev-preview terminals
        if (terminal.type === "dev-preview") {
          const terminalId = await terminalStore.addTerminal({
            kind: "dev-preview",
            title: terminal.title || "Dev Server",
            cwd: worktreePath,
            worktreeId: worktreeId,
            devCommand: terminal.devCommand?.trim() || undefined,
            env: terminal.env,
            exitBehavior: terminal.exitBehavior,
          });
          if (terminalId) {
            results.spawned.push({ index, terminalId });
          } else {
            results.failed.push({ index, error: "Panel limit reached" });
          }
          continue;
        }

        const isAgent = isAgentRecipeType(terminal.type);
        let command = terminal.command?.trim() || "";

        // For agent terminals, build command with settings/flags and optional initial prompt
        if (isAgent) {
          const agentConfig = getAgentConfig(terminal.type);
          const baseCommand = agentConfig?.command || terminal.type;
          const rawPrompt = terminal.initialPrompt?.trim();
          const resolvedContext: RecipeContext = {
            ...context,
            worktreePath,
          };
          const initialPrompt = rawPrompt
            ? replaceRecipeVariables(rawPrompt, resolvedContext)
            : undefined;
          const entry = agentSettings?.agents?.[terminal.type] ?? {};
          command = generateAgentCommand(baseCommand, entry, terminal.type, {
            initialPrompt,
            clipboardDirectory,
          });
        }

        const terminalId = await terminalStore.addTerminal({
          kind: isAgent ? "agent" : "terminal",
          agentId: isAgent ? terminal.type : undefined,
          title: terminal.title,
          cwd: worktreePath,
          command,
          worktreeId: worktreeId,
          env: terminal.env,
          exitBehavior: terminal.exitBehavior,
        });
        if (terminalId) {
          results.spawned.push({ index, terminalId });
        } else {
          results.failed.push({ index, error: "Panel limit reached" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to spawn terminal for recipe ${recipeId}:`, error);
        results.failed.push({ index, error: message });
      }
    }

    return results;
  },

  exportRecipe: (id) => {
    const recipe = get().getRecipeById(id);
    if (!recipe) {
      return null;
    }
    // Export without projectId - it will be assigned on import
    const { projectId: _projectId, ...exportableRecipe } = recipe;
    return JSON.stringify(exportableRecipe, null, 2);
  },

  exportRecipeToFile: async (id) => {
    const recipe = get().getRecipeById(id);
    if (!recipe) return false;
    const { projectId: _p, ...exportable } = recipe;
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
      id: isGlobal
        ? `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        : stableInRepoId(recipeName),
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
      console.error("Failed to persist imported recipe:", _error);
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
    const terminalStore = useTerminalStore.getState();

    const activeTerminals = terminalStore.terminalIds
      .map((id) => terminalStore.terminalsById[id])
      .filter((t) => t && t.location !== "trash" && t.worktreeId === worktreeId);

    const terminalsToCapture = activeTerminals.slice(0, MAX_TERMINALS_PER_RECIPE);

    return terminalsToCapture.map(terminalToRecipeTerminal);
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
