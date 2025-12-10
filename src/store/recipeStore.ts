import { create, type StateCreator } from "zustand";
import type { TerminalRecipe, RecipeTerminal } from "@/types";
import { useTerminalStore, type TerminalInstance } from "./terminalStore";
import { appClient } from "@/clients";

function terminalToRecipeTerminal(terminal: TerminalInstance): RecipeTerminal {
  return {
    type: terminal.type,
    title: terminal.title || undefined,
    command: terminal.command || undefined,
    env: {},
  };
}

interface RecipeState {
  recipes: TerminalRecipe[];
  isLoading: boolean;

  loadRecipes: () => Promise<void>;
  createRecipe: (
    name: string,
    worktreeId: string | undefined,
    terminals: RecipeTerminal[]
  ) => Promise<void>;
  updateRecipe: (
    id: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "createdAt">>
  ) => Promise<void>;
  deleteRecipe: (id: string) => Promise<void>;

  getRecipesForWorktree: (worktreeId: string | undefined) => TerminalRecipe[];
  getRecipeById: (id: string) => TerminalRecipe | undefined;

  runRecipe: (recipeId: string, worktreePath: string, worktreeId?: string) => Promise<void>;

  exportRecipe: (id: string) => string | null;
  importRecipe: (json: string) => Promise<void>;

  generateRecipeFromActiveTerminals: (worktreeId: string) => RecipeTerminal[];
}

const MAX_TERMINALS_PER_RECIPE = 10;

const createRecipeStore: StateCreator<RecipeState> = (set, get) => ({
  recipes: [],
  isLoading: false,

  loadRecipes: async () => {
    set({ isLoading: true });
    try {
      const appState = await appClient.getState();
      set({ recipes: appState.recipes || [], isLoading: false });
    } catch (error) {
      console.error("Failed to load recipes:", error);
      set({ isLoading: false });
    }
  },

  createRecipe: async (name, worktreeId, terminals) => {
    if (terminals.length === 0) {
      throw new Error("Recipe must contain at least one terminal");
    }
    if (terminals.length > MAX_TERMINALS_PER_RECIPE) {
      throw new Error(`Recipe cannot exceed ${MAX_TERMINALS_PER_RECIPE} terminals`);
    }

    const newRecipe: TerminalRecipe = {
      id: `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name,
      worktreeId,
      terminals,
      createdAt: Date.now(),
    };

    const newRecipes = [...get().recipes, newRecipe];
    set({ recipes: newRecipes });

    try {
      await appClient.setState({
        recipes: newRecipes.map((r) => ({
          id: r.id,
          name: r.name,
          worktreeId: r.worktreeId,
          terminals: r.terminals,
          createdAt: r.createdAt,
        })),
      });
    } catch (error) {
      console.error("Failed to persist recipe:", error);
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

    const updatedRecipe = { ...recipes[index], ...updates };
    const newRecipes = [...recipes];
    newRecipes[index] = updatedRecipe;

    set({ recipes: newRecipes });

    try {
      await appClient.setState({
        recipes: newRecipes.map((r) => ({
          id: r.id,
          name: r.name,
          worktreeId: r.worktreeId,
          terminals: r.terminals,
          createdAt: r.createdAt,
        })),
      });
    } catch (error) {
      console.error("Failed to persist recipe update:", error);
      throw error;
    }
  },

  deleteRecipe: async (id) => {
    const newRecipes = get().recipes.filter((r) => r.id !== id);
    set({ recipes: newRecipes });

    try {
      await appClient.setState({
        recipes: newRecipes.map((r) => ({
          id: r.id,
          name: r.name,
          worktreeId: r.worktreeId,
          terminals: r.terminals,
          createdAt: r.createdAt,
        })),
      });
    } catch (error) {
      console.error("Failed to persist recipe deletion:", error);
      throw error;
    }
  },

  getRecipesForWorktree: (worktreeId) => {
    const recipes = get().recipes;
    return recipes.filter((r) => r.worktreeId === worktreeId || r.worktreeId === undefined);
  },

  getRecipeById: (id) => {
    return get().recipes.find((r) => r.id === id);
  },

  runRecipe: async (recipeId, worktreePath, worktreeId) => {
    const recipe = get().getRecipeById(recipeId);
    if (!recipe) {
      throw new Error(`Recipe ${recipeId} not found`);
    }

    const terminalStore = useTerminalStore.getState();

    for (const terminal of recipe.terminals) {
      try {
        await terminalStore.addTerminal({
          type: terminal.type,
          title: terminal.title,
          cwd: worktreePath,
          command: terminal.command,
          worktreeId: worktreeId,
        });
      } catch (error) {
        console.error(`Failed to spawn terminal for recipe ${recipeId}:`, error);
      }
    }
  },

  exportRecipe: (id) => {
    const recipe = get().getRecipeById(id);
    if (!recipe) {
      return null;
    }
    return JSON.stringify(recipe, null, 2);
  },

  importRecipe: async (json) => {
    let recipe: TerminalRecipe;
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

    const ALLOWED_TYPES = ["terminal", "claude", "gemini", "codex"];
    const sanitizedTerminals = recipe.terminals
      .filter((terminal) => {
        if (!ALLOWED_TYPES.includes(terminal.type)) return false;
        if (terminal.command !== undefined) {
          if (typeof terminal.command !== "string") return false;
          // eslint-disable-next-line no-control-regex
          if (/[\r\n\x00-\x1F]/.test(terminal.command)) return false;
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
        return true;
      })
      .map((terminal) => ({
        type: terminal.type,
        title: typeof terminal.title === "string" ? terminal.title : undefined,
        command: typeof terminal.command === "string" ? terminal.command.trim() : undefined,
        env: terminal.env,
      }));

    if (sanitizedTerminals.length === 0) {
      throw new Error("No valid terminals found in recipe");
    }

    const importedRecipe: TerminalRecipe = {
      id: `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: String(recipe.name),
      worktreeId: typeof recipe.worktreeId === "string" ? recipe.worktreeId : undefined,
      terminals: sanitizedTerminals,
      createdAt: Date.now(),
    };

    const newRecipes = [...get().recipes, importedRecipe];
    set({ recipes: newRecipes });

    try {
      await appClient.setState({
        recipes: newRecipes.map((r) => ({
          id: r.id,
          name: r.name,
          worktreeId: r.worktreeId,
          terminals: r.terminals,
          createdAt: r.createdAt,
        })),
      });
    } catch (_error) {
      console.error("Failed to persist imported recipe:", _error);
      throw _error;
    }
  },

  generateRecipeFromActiveTerminals: (worktreeId) => {
    const terminalStore = useTerminalStore.getState();

    const activeTerminals = terminalStore.terminals.filter(
      (t) => t.location !== "trash" && t.worktreeId === worktreeId
    );

    const terminalsToCapture = activeTerminals.slice(0, MAX_TERMINALS_PER_RECIPE);

    return terminalsToCapture.map(terminalToRecipeTerminal);
  },
});

export const useRecipeStore = create<RecipeState>()(createRecipeStore);
