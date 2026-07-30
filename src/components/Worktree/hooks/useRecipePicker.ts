import { useState, useEffect, useRef, useMemo } from "react";
import type { TerminalRecipe } from "@/types";

export const CLONE_LAYOUT_ID = "__clone_layout__";

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
  startingLayoutRecipes,
  lastSelectedWorktreeRecipeId,
  projectId,
  initialRecipeId,
  setLastSelectedWorktreeRecipeIdByProject,
}: {
  isOpen: boolean;
  defaultRecipeId: string | undefined;
  startingLayoutRecipes: TerminalRecipe[];
  lastSelectedWorktreeRecipeId: string | null | undefined;
  projectId: string;
  initialRecipeId?: string | null;
  setLastSelectedWorktreeRecipeIdByProject: (
    projectId: string,
    recipeId: string | null | undefined
  ) => void;
}): UseRecipePickerResult {
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [recipePickerOpen, setRecipePickerOpen] = useState(false);
  const recipeSelectionTouchedRef = useRef(false);

  // Reset on open
  useEffect(() => {
    if (!isOpen) return;
    recipeSelectionTouchedRef.current = false;
  }, [isOpen]);

  // Auto-select recipe: initialRecipeId > lastSelected > default > clone layout
  useEffect(() => {
    if (!isOpen) return;
    if (!projectId) return;
    if (recipeSelectionTouchedRef.current) return;

    if (initialRecipeId && startingLayoutRecipes.some((r) => r.id === initialRecipeId)) {
      setSelectedRecipeId(initialRecipeId);
    } else if (lastSelectedWorktreeRecipeId !== undefined) {
      if (lastSelectedWorktreeRecipeId === null) {
        setSelectedRecipeId(null);
      } else if (lastSelectedWorktreeRecipeId === CLONE_LAYOUT_ID) {
        setSelectedRecipeId(CLONE_LAYOUT_ID);
      } else if (startingLayoutRecipes.some((r) => r.id === lastSelectedWorktreeRecipeId)) {
        setSelectedRecipeId(lastSelectedWorktreeRecipeId);
      } else {
        if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, undefined);
        if (defaultRecipeId && startingLayoutRecipes.some((r) => r.id === defaultRecipeId)) {
          setSelectedRecipeId(defaultRecipeId);
        } else {
          setSelectedRecipeId(CLONE_LAYOUT_ID);
        }
      }
    } else if (defaultRecipeId && startingLayoutRecipes.some((r) => r.id === defaultRecipeId)) {
      setSelectedRecipeId(defaultRecipeId);
    } else {
      setSelectedRecipeId(CLONE_LAYOUT_ID);
    }
  }, [
    isOpen,
    startingLayoutRecipes,
    lastSelectedWorktreeRecipeId,
    defaultRecipeId,
    projectId,
    initialRecipeId,
    setLastSelectedWorktreeRecipeIdByProject,
  ]);

  // Invalidate stale recipe (skip sentinel IDs)
  useEffect(() => {
    if (!selectedRecipeId) return;
    if (selectedRecipeId === CLONE_LAYOUT_ID) return;
    if (startingLayoutRecipes.some((recipe) => recipe.id === selectedRecipeId)) return;
    setSelectedRecipeId(null);
    if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, undefined);
  }, [
    startingLayoutRecipes,
    selectedRecipeId,
    projectId,
    setLastSelectedWorktreeRecipeIdByProject,
  ]);

  const selectedRecipe = useMemo(
    () =>
      selectedRecipeId ? startingLayoutRecipes.find((r) => r.id === selectedRecipeId) : undefined,
    [selectedRecipeId, startingLayoutRecipes]
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
