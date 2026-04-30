import { useMemo, useState, useCallback, useEffect } from "react";
import { useRecipeStore } from "@/store/recipeStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { actionService } from "@/services/ActionService";
import {
  buildRecipeSections,
  rankSearchResults,
  type RecipeSections,
  type RankedRecipe,
} from "./recipeRunnerUtils";
import type { TerminalRecipe, RunCommand } from "@/types";

export interface UseRecipeRunnerOptions {
  activeWorktreeId: string | null | undefined;
  defaultCwd: string | undefined;
}

export interface UseRecipeRunnerResult {
  recipes: TerminalRecipe[];
  sections: RecipeSections;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchResults: RankedRecipe[];
  focusedIndex: number;
  setFocusedIndex: (i: number) => void;
  showSearch: boolean;
  totalItems: number;
  focusedItemId: string | undefined;
  suggestions: RunCommand[];
  handleRun: (recipeId: string) => void;
  handleEdit: (recipeId: string) => void;
  handleDuplicate: (recipeId: string) => void;
  handlePin: (recipeId: string) => void;
  handleUnpin: (recipeId: string) => void;
  handleDelete: (recipeId: string) => void;
  handleCreate: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  getFlatRecipes: () => TerminalRecipe[];
}

export function useRecipeRunner({
  activeWorktreeId,
  defaultCwd,
}: UseRecipeRunnerOptions): UseRecipeRunnerResult {
  const allRecipes = useRecipeStore((s) => s.recipes);
  const runRecipe = useRecipeStore((s) => s.runRecipe);
  const updateRecipe = useRecipeStore((s) => s.updateRecipe);
  const deleteRecipe = useRecipeStore((s) => s.deleteRecipe);
  const createRecipe = useRecipeStore((s) => s.createRecipe);
  const getRecipeById = useRecipeStore((s) => s.getRecipeById);

  const allDetectedRunners = useProjectSettingsStore((s) => s.allDetectedRunners);

  const [searchQuery, setSearchQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Stable filtered recipe array for Fuse cache
  const recipes = useMemo(() => {
    return allRecipes.filter(
      (r) => r.worktreeId === activeWorktreeId || r.worktreeId === undefined
    );
  }, [allRecipes, activeWorktreeId]);

  const showSearch = recipes.length > 6;

  const sections = useMemo(() => buildRecipeSections(recipes), [recipes]);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return rankSearchResults(recipes, searchQuery.trim(), Date.now());
  }, [recipes, searchQuery]);

  // Build flat list for keyboard navigation
  const getFlatRecipes = useCallback((): TerminalRecipe[] => {
    if (searchQuery.trim()) {
      return searchResults.map((r) => r.recipe);
    }
    return [...sections.pinned, ...sections.recent, ...sections.all];
  }, [searchQuery, searchResults, sections]);

  // +1 for "Create new recipe" button
  const totalItems = getFlatRecipes().length + 1;

  // Reset focused index on worktree/query change
  useEffect(() => {
    setFocusedIndex(0);
  }, [activeWorktreeId, searchQuery]);

  const focusedItemId = useMemo(() => {
    const flat = getFlatRecipes();
    if (focusedIndex < flat.length) {
      return `recipe-option-${flat[focusedIndex]!.id}`;
    }
    if (focusedIndex === flat.length) {
      return "recipe-option-create";
    }
    return undefined;
  }, [focusedIndex, getFlatRecipes]);

  // Suggestions from package.json
  const suggestions = useMemo(() => {
    const keywords = ["dev", "start", "serve", "test", "build"];
    return allDetectedRunners.filter((r) =>
      keywords.some(
        (kw) => r.command.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw)
      )
    );
  }, [allDetectedRunners]);

  const handleRun = useCallback(
    (recipeId: string) => {
      if (!defaultCwd) return;
      const worktreeData = activeWorktreeId
        ? getCurrentViewStore().getState().worktrees.get(activeWorktreeId)
        : null;
      void runRecipe(recipeId, defaultCwd, activeWorktreeId ?? undefined, {
        issueNumber: worktreeData?.issueNumber,
        prNumber: worktreeData?.prNumber,
        worktreePath: defaultCwd,
        branchName: worktreeData?.branch,
      });
    },
    [defaultCwd, activeWorktreeId, runRecipe]
  );

  const handleEdit = useCallback(
    (recipeId: string) => {
      window.dispatchEvent(
        new CustomEvent("daintree:open-recipe-editor", {
          detail: { recipeId, worktreeId: activeWorktreeId },
        })
      );
    },
    [activeWorktreeId]
  );

  const handleDuplicate = useCallback(
    (recipeId: string) => {
      const recipe = getRecipeById(recipeId);
      if (!recipe) return;
      void createRecipe(
        recipe.projectId,
        `${recipe.name} (Copy)`,
        recipe.worktreeId,
        recipe.terminals,
        false,
        recipe.autoAssign
      );
    },
    [getRecipeById, createRecipe]
  );

  const handlePin = useCallback(
    (recipeId: string) => {
      void updateRecipe(recipeId, { showInEmptyState: true });
    },
    [updateRecipe]
  );

  const handleUnpin = useCallback(
    (recipeId: string) => {
      void updateRecipe(recipeId, { showInEmptyState: false });
    },
    [updateRecipe]
  );

  const handleDelete = useCallback(
    (recipeId: string) => {
      void deleteRecipe(recipeId);
    },
    [deleteRecipe]
  );

  const handleCreate = useCallback(() => {
    void actionService.dispatch(
      "recipe.editor.open",
      { worktreeId: activeWorktreeId },
      { source: "user" }
    );
  }, [activeWorktreeId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => (prev + 1) % totalItems);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => (prev - 1 + totalItems) % totalItems);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const flat = getFlatRecipes();
        if (focusedIndex < flat.length) {
          handleRun(flat[focusedIndex]!.id);
        } else {
          handleCreate();
        }
      } else if (e.key === "Escape") {
        if (searchQuery) {
          e.preventDefault();
          setSearchQuery("");
        }
      } else if (e.key === "e" && e.metaKey) {
        e.preventDefault();
        const flat = getFlatRecipes();
        if (focusedIndex < flat.length) {
          handleEdit(flat[focusedIndex]!.id);
        }
      } else if (e.key === "n" && e.metaKey) {
        e.preventDefault();
        handleCreate();
      }
    },
    [totalItems, focusedIndex, getFlatRecipes, handleRun, handleCreate, handleEdit, searchQuery]
  );

  return {
    recipes,
    sections,
    searchQuery,
    setSearchQuery,
    searchResults,
    focusedIndex,
    setFocusedIndex,
    showSearch,
    totalItems,
    focusedItemId,
    suggestions,
    handleRun,
    handleEdit,
    handleDuplicate,
    handlePin,
    handleUnpin,
    handleDelete,
    handleCreate,
    handleKeyDown,
    getFlatRecipes,
  };
}
