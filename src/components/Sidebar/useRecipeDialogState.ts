import { useCallback, useEffect, useState } from "react";
import { useRecipeStore } from "@/store/recipeStore";
import type { RecipeTerminal } from "@/types";
import type { TerminalRecipe } from "@/types";

interface UseRecipeDialogStateReturn {
  isRecipeEditorOpen: boolean;
  recipeEditorWorktreeId: string | undefined;
  recipeEditorInitialTerminals: RecipeTerminal[] | undefined;
  recipeEditorDefaultScope: "global" | "project" | undefined;
  recipeManagerEdit: TerminalRecipe | undefined;
  isRecipeManagerOpen: boolean;
  handleOpenRecipeEditor: (worktreeId: string, initialTerminals?: RecipeTerminal[]) => void;
  handleCloseRecipeEditor: () => void;
  handleCloseRecipeManager: () => void;
  handleRecipeManagerEdit: (recipe: TerminalRecipe) => void;
  handleRecipeManagerCreate: (scope: "global" | "project") => void;
}

function useRecipeDialogState(): UseRecipeDialogStateReturn {
  const [isRecipeEditorOpen, setIsRecipeEditorOpen] = useState(false);
  const [recipeEditorWorktreeId, setRecipeEditorWorktreeId] = useState<string | undefined>(
    undefined
  );
  const [recipeEditorInitialTerminals, setRecipeEditorInitialTerminals] = useState<
    RecipeTerminal[] | undefined
  >(undefined);
  const [recipeEditorDefaultScope, setRecipeEditorDefaultScope] = useState<
    "global" | "project" | undefined
  >(undefined);
  const [isRecipeManagerOpen, setIsRecipeManagerOpen] = useState(false);
  const [recipeManagerEdit, setRecipeManagerEdit] = useState<TerminalRecipe | undefined>(undefined);

  const handleOpenRecipeEditor = useCallback(
    (worktreeId: string, initialTerminals?: RecipeTerminal[]) => {
      setRecipeEditorWorktreeId(worktreeId);
      setRecipeEditorInitialTerminals(initialTerminals);
      setIsRecipeEditorOpen(true);
    },
    []
  );

  useEffect(() => {
    const handleOpenRecipeEditorEvent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as unknown;
      if (!detail) return;
      const d = detail as { worktreeId?: unknown; recipeId?: unknown; initialTerminals?: unknown };

      if (typeof d.recipeId === "string") {
        const recipe = useRecipeStore.getState().getRecipeById(d.recipeId);
        if (recipe) {
          setIsRecipeManagerOpen(false);
          setRecipeEditorWorktreeId(recipe.worktreeId);
          setRecipeEditorDefaultScope(recipe.projectId === undefined ? "global" : "project");
          setRecipeEditorInitialTerminals(undefined);
          setRecipeManagerEdit(recipe);
          setIsRecipeEditorOpen(true);
          return;
        }
      }

      if (typeof d.worktreeId !== "string") return;
      const worktreeId = d.worktreeId;
      const initialTerminals = Array.isArray(d.initialTerminals)
        ? (d.initialTerminals as RecipeTerminal[])
        : undefined;
      handleOpenRecipeEditor(worktreeId, initialTerminals);
    };

    const controller = new AbortController();
    window.addEventListener("daintree:open-recipe-editor", handleOpenRecipeEditorEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [handleOpenRecipeEditor]);

  useEffect(() => {
    const handleOpenRecipeManagerEvent = () => {
      setIsRecipeManagerOpen(true);
    };
    const controller = new AbortController();
    window.addEventListener("daintree:open-recipe-manager", handleOpenRecipeManagerEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, []);

  const handleCloseRecipeManager = useCallback(() => {
    setIsRecipeManagerOpen(false);
  }, []);

  const handleRecipeManagerEdit = useCallback((recipe: TerminalRecipe) => {
    setIsRecipeManagerOpen(false);
    setRecipeEditorWorktreeId(recipe.worktreeId);
    setRecipeEditorDefaultScope(recipe.projectId === undefined ? "global" : "project");
    setRecipeEditorInitialTerminals(undefined);
    setTimeout(() => {
      setIsRecipeEditorOpen(true);
    }, 100);
    setRecipeManagerEdit(recipe);
  }, []);

  const handleRecipeManagerCreate = useCallback((scope: "global" | "project") => {
    setIsRecipeManagerOpen(false);
    setRecipeEditorDefaultScope(scope);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
    setRecipeManagerEdit(undefined);
    setTimeout(() => {
      setIsRecipeEditorOpen(true);
    }, 100);
  }, []);

  const handleCloseRecipeEditor = useCallback(() => {
    setIsRecipeEditorOpen(false);
    setRecipeEditorWorktreeId(undefined);
    setRecipeEditorInitialTerminals(undefined);
    setRecipeEditorDefaultScope(undefined);
    setRecipeManagerEdit(undefined);
  }, []);

  return {
    isRecipeEditorOpen,
    recipeEditorWorktreeId,
    recipeEditorInitialTerminals,
    recipeEditorDefaultScope,
    recipeManagerEdit,
    isRecipeManagerOpen,
    handleOpenRecipeEditor,
    handleCloseRecipeEditor,
    handleCloseRecipeManager,
    handleRecipeManagerEdit,
    handleRecipeManagerCreate,
  };
}

export { useRecipeDialogState };
