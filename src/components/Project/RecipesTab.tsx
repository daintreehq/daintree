import { useState, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, FileDown, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsEmptyRow,
  SettingsGroup,
  SettingsInlineError,
} from "@/components/Settings/SettingsGroup";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useRecipeStore } from "@/store/recipeStore";
import { actionService } from "@/services/ActionService";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { RecipeEditor } from "@/components/TerminalRecipe/RecipeEditor";
import { RecipeImportDialog } from "@/components/TerminalRecipe/RecipeImportDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TerminalRecipe, Worktree } from "@/types";
import { logError } from "@/utils/logger";
import { getRecipeScope, worktreeDisplayName } from "@/utils/recipeScope";
import { isPluginRecipe } from "@shared/types/project";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { pluralize } from "@/lib/pluralize";

interface RecipesTabProps {
  projectId: string;
  defaultWorktreeRecipeId: string | undefined;
  onDefaultWorktreeRecipeIdChange: (value: string | undefined) => void;
  worktreeMap: Map<string, Worktree>;
  isOpen: boolean;
}

export function RecipesTab({
  projectId,
  defaultWorktreeRecipeId,
  onDefaultWorktreeRecipeIdChange,
  worktreeMap,
  isOpen,
}: RecipesTabProps) {
  const {
    recipes,
    loadRecipes,
    exportRecipe,
    isLoading: recipesLoading,
  } = useRecipeStore(
    useShallow((s) => ({
      recipes: s.recipes,
      loadRecipes: s.loadRecipes,
      exportRecipe: s.exportRecipe,
      isLoading: s.isLoading,
    }))
  );

  const [isRecipeEditorOpen, setIsRecipeEditorOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<TerminalRecipe | undefined>(undefined);
  const [recipeToDelete, setRecipeToDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // "Clear default" removes the warning it sits in, so focus goes to the next
  // thing a user would do: add or pin another recipe.
  const addRecipeRef = useRef<HTMLButtonElement>(null);
  const hasLoadedRecipes = useRef(false);

  useEffect(() => {
    if (isOpen && !hasLoadedRecipes.current && !recipesLoading && projectId) {
      hasLoadedRecipes.current = true;
      loadRecipes(projectId).catch((err) => {
        logError("Failed to load recipes", err);
      });
    }
  }, [isOpen, recipesLoading, loadRecipes, projectId]);

  useEffect(() => {
    if (!isOpen) {
      setIsRecipeEditorOpen(false);
      setEditingRecipe(undefined);
      setRecipeToDelete(null);
      setDeleteError(null);
      setShowImportDialog(false);
      setExportError(null);
      hasLoadedRecipes.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      hasLoadedRecipes.current = false;
    }
  }, [projectId, isOpen]);

  const handleEditRecipe = (recipe: TerminalRecipe) => {
    setEditingRecipe(recipe);
    setIsRecipeEditorOpen(true);
  };

  const handleAddRecipe = () => {
    setEditingRecipe(undefined);
    setIsRecipeEditorOpen(true);
  };

  const handleRecipeEditorClose = () => {
    setIsRecipeEditorOpen(false);
    setEditingRecipe(undefined);
  };

  const handleDeleteRecipe = async (recipeId: string) => {
    setDeleteError(null);
    const result = await actionService.dispatch(
      "recipe.delete",
      { recipeId },
      { source: "user", confirmed: true }
    );
    if (result.ok) {
      if (recipeId === defaultWorktreeRecipeId) {
        onDefaultWorktreeRecipeIdChange(undefined);
      }
      setRecipeToDelete(null);
    } else {
      logError("Failed to delete recipe", result.error);
      setDeleteError(formatErrorMessage(result.error, "Failed to delete recipe"));
    }
  };

  const readRecipeJson = (recipeId: string) => {
    const json = exportRecipe(recipeId);
    if (json === null) throw new Error("The recipe couldn't be serialised");
    return json;
  };

  // Falls back to the raw id so an orphaned worktree's recipe stays
  // identifiable here, where the row has the width for it.
  const resolveWorktreeName = (worktreeId: string): string =>
    worktreeDisplayName(worktreeMap.get(worktreeId)) ?? worktreeId;

  return (
    <>
      <SettingsSection
        id="project-default-recipe"
        title="Terminal recipes"
        description="Manage saved terminal configurations. Recipes can spawn multiple terminals with predefined commands and settings."
        action={
          <>
            <Button variant="outline" size="sm" onClick={() => setShowImportDialog(true)}>
              <FileDown />
              Import recipe
            </Button>
            {!recipesLoading && recipes.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleAddRecipe} ref={addRecipeRef}>
                <Plus />
                Add recipe
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3">
          {!recipesLoading &&
            defaultWorktreeRecipeId &&
            !recipes.find(
              (r) => r.id === defaultWorktreeRecipeId && !r.worktreeId && !r.shadowedBy
            ) && (
              <div
                className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20"
                role="alert"
              >
                <AlertTriangle className="h-4 w-4 text-status-warning mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-status-warning">Default recipe unavailable</p>
                  <p className="text-xs text-text-secondary mt-1">
                    The pinned recipe was deleted or is no longer eligible. Pin another recipe with
                    its pin button, or clear the default.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onDefaultWorktreeRecipeIdChange(undefined);
                      addRecipeRef.current?.focus();
                    }}
                    className="mt-2"
                  >
                    Clear default
                  </Button>
                </div>
              </div>
            )}
          {recipesLoading ? (
            <SettingsGroup>
              <Skeleton label="Loading recipes" className="space-y-2 p-3">
                <SkeletonBone className="h-12 w-full" />
                <SkeletonBone className="h-12 w-full" />
                <SkeletonBone className="h-12 w-full" />
              </Skeleton>
            </SettingsGroup>
          ) : recipes.length === 0 ? (
            <SettingsGroup>
              <SettingsEmptyRow
                action={
                  <Button variant="outline" size="sm" onClick={handleAddRecipe} ref={addRecipeRef}>
                    <Plus />
                    Add recipe
                  </Button>
                }
              >
                Add a recipe to open a set of terminals in one step
              </SettingsEmptyRow>
            </SettingsGroup>
          ) : (
            <SettingsGroup>
              {recipes.map((recipe) => {
                const isEligibleForDefault = !recipe.worktreeId && !recipe.shadowedBy;
                const isDefault = recipe.id === defaultWorktreeRecipeId;
                const isShadowed = !!recipe.shadowedBy;
                // A plugin owns its recipes' content — editing or deleting one
                // here would be undone on the plugin's next load, and the store
                // rejects both. Hide the controls rather than surface an error
                // toast for an action that was never possible (#11860).
                const fromPlugin = isPluginRecipe(recipe);
                return (
                  <div key={recipe.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-sm font-medium text-text-primary truncate">
                                {recipe.name}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">{recipe.name}</TooltipContent>
                          </Tooltip>
                          {(() => {
                            const scopeInfo = getRecipeScope(recipe, resolveWorktreeName);
                            return <Badge size="xs">{scopeInfo.label}</Badge>;
                          })()}
                          <Badge size="xs">{pluralize(recipe.terminals.length, "terminal")}</Badge>
                          {isShadowed && <Badge size="xs">Overridden by team recipe</Badge>}
                          {isDefault && <Badge size="xs">Default</Badge>}
                          {recipe.showInEmptyState && <Badge size="xs">On empty grid</Badge>}
                        </div>
                        <div className="text-xs text-text-secondary mt-1">
                          {recipe.lastUsedAt ? (
                            <span>
                              Last used <LiveTimeAgo timestamp={recipe.lastUsedAt} />
                            </span>
                          ) : (
                            <span>Never used</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {isEligibleForDefault && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() =>
                                  onDefaultWorktreeRecipeIdChange(isDefault ? undefined : recipe.id)
                                }
                                pressed={isDefault}
                                // A toggle's name stays put; `pressed` announces the state.
                                aria-label={`Pin ${recipe.name} as the default worktree recipe`}
                              >
                                <Pin className={isDefault ? "fill-current" : undefined} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">Pin as default recipe</TooltipContent>
                          </Tooltip>
                        )}
                        <div className="flex items-center gap-1">
                          {!fromPlugin && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => handleEditRecipe(recipe)}
                                  aria-label={`Edit recipe ${recipe.name}`}
                                >
                                  <Pencil />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">Edit recipe</TooltipContent>
                            </Tooltip>
                          )}
                          <CopyButton
                            size="icon-sm"
                            text={() => readRecipeJson(recipe.id)}
                            aria-label={`Copy recipe ${recipe.name} as JSON`}
                            tooltip="Copy as JSON"
                            tooltipSide="bottom"
                            announcement="Recipe copied"
                            onClick={() => setExportError(null)}
                            onCopyError={(err) => {
                              logError("Failed to copy recipe", err);
                              setExportError(formatErrorMessage(err, "Couldn't copy the recipe"));
                            }}
                          />
                          {!fromPlugin && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost-danger"
                                  size="icon-sm"
                                  onClick={() => setRecipeToDelete(recipe.id)}
                                  aria-label={`Delete recipe ${recipe.name}`}
                                >
                                  <Trash2 />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">Delete recipe</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </SettingsGroup>
          )}
          {exportError && <SettingsInlineError role="alert">{exportError}</SettingsInlineError>}
        </div>
      </SettingsSection>

      <RecipeEditor
        recipe={editingRecipe}
        worktreeId={undefined}
        isOpen={isRecipeEditorOpen}
        onClose={handleRecipeEditorClose}
      />

      <ConfirmDialog
        isOpen={recipeToDelete !== null}
        title={`Delete '${recipes.find((r) => r.id === recipeToDelete)?.name ?? "recipe"}'?`}
        description={
          deleteError
            ? `Error: ${deleteError}`
            : "Deletes this recipe — the terminals it launches and their settings. Committed in-repo recipes in .daintree/recipes/ can be restored from git; recipes stored only on this machine can't be recovered."
        }
        confirmLabel={deleteError ? "Retry delete" : "Delete recipe"}
        variant="destructive"
        onConfirm={() => {
          if (recipeToDelete) {
            void handleDeleteRecipe(recipeToDelete);
          }
        }}
        onClose={() => {
          setRecipeToDelete(null);
          setDeleteError(null);
        }}
      />

      <RecipeImportDialog
        isOpen={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        projectId={projectId}
      />
    </>
  );
}
