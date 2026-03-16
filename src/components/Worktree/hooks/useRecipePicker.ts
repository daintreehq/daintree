import { useState, useEffect, useRef, useMemo } from "react";
import type { TerminalRecipe } from "@/types";

export interface UseRecipePickerResult {
  selectedRecipeId: string | null;
  setSelectedRecipeId: React.Dispatch<React.SetStateAction<string | null>>;
  recipePickerOpen: boolean;
  setRecipePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  recipeSelectionTouchedRef: React.MutableRefObject<boolean>;
  selectedRecipe: TerminalRecipe | undefined;
}

export function useRecipePicker({
  isOpen,
  defaultRecipeId,
  globalRecipes,
  lastSelectedWorktreeRecipeId,
  projectId,
  initialRecipeId,
  setLastSelectedWorktreeRecipeIdByProject,
}: {
  isOpen: boolean;
  defaultRecipeId: string | undefined;
  globalRecipes: TerminalRecipe[];
  lastSelectedWorktreeRecipeId: string | null | undefined;
  projectId: string;
  initialRecipeId?: string | null;
  setLastSelectedWorktreeRecipeIdByProject: (projectId: string, recipeId: string | null | undefined) => void;
}): UseRecipePickerResult {
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [recipePickerOpen, setRecipePickerOpen] = useState(false);
  const recipeSelectionTouchedRef = useRef(false);

  // Reset on open
  useEffect(() => {
    if (!isOpen) return;
    recipeSelectionTouchedRef.current = false;
  }, [isOpen]);

  // Auto-select recipe: initialRecipeId > lastSelected > default > null
  useEffect(() => {
    if (!isOpen) return;
    if (!projectId) return;
    if (globalRecipes.length === 0) return;
    if (recipeSelectionTouchedRef.current) return;

    if (initialRecipeId && globalRecipes.some((r) => r.id === initialRecipeId)) {
      setSelectedRecipeId(initialRecipeId);
    } else if (lastSelectedWorktreeRecipeId !== undefined) {
      if (
        lastSelectedWorktreeRecipeId === null ||
        globalRecipes.some((r) => r.id === lastSelectedWorktreeRecipeId)
      ) {
        setSelectedRecipeId(lastSelectedWorktreeRecipeId);
      } else {
        if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, undefined);
        if (defaultRecipeId && globalRecipes.some((r) => r.id === defaultRecipeId)) {
          setSelectedRecipeId(defaultRecipeId);
        }
      }
    } else if (defaultRecipeId && globalRecipes.some((r) => r.id === defaultRecipeId)) {
      setSelectedRecipeId(defaultRecipeId);
    }
  }, [
    isOpen,
    globalRecipes,
    lastSelectedWorktreeRecipeId,
    defaultRecipeId,
    projectId,
    initialRecipeId,
    setLastSelectedWorktreeRecipeIdByProject,
  ]);

  // Invalidate stale recipe
  useEffect(() => {
    if (!selectedRecipeId) return;
    if (globalRecipes.some((recipe) => recipe.id === selectedRecipeId)) return;
    setSelectedRecipeId(null);
    if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, undefined);
  }, [globalRecipes, selectedRecipeId, projectId, setLastSelectedWorktreeRecipeIdByProject]);

  const selectedRecipe = useMemo(
    () => (selectedRecipeId ? globalRecipes.find((r) => r.id === selectedRecipeId) : undefined),
    [selectedRecipeId, globalRecipes]
  );

  return {
    selectedRecipeId,
    setSelectedRecipeId,
    recipePickerOpen,
    setRecipePickerOpen,
    recipeSelectionTouchedRef,
    selectedRecipe,
  };
}
