import { useState, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus, Trash2, Edit3, Download, FileDown, Check, Pin, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup } from "@/components/Settings/SettingsGroup";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { useRecipeStore } from "@/store/recipeStore";
import { actionService } from "@/services/ActionService";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { RecipeEditor } from "@/components/TerminalRecipe/RecipeEditor";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TerminalRecipe, Worktree } from "@/types";
import { logError } from "@/utils/logger";
import { getRecipeScope, worktreeDisplayName } from "@/utils/recipeScope";
import { isPluginRecipe } from "@shared/types/project";
import { formatErrorMessage } from "@shared/utils/errorMessage";

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
    importRecipe,
    isLoading: recipesLoading,
  } = useRecipeStore(
    useShallow((s) => ({
      recipes: s.recipes,
      loadRecipes: s.loadRecipes,
      exportRecipe: s.exportRecipe,
      importRecipe: s.importRecipe,
      isLoading: s.isLoading,
    }))
  );

  const [isRecipeEditorOpen, setIsRecipeEditorOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<TerminalRecipe | undefined>(undefined);
  const [recipeToDelete, setRecipeToDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const exportTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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
      setImportJson("");
      setImportError(null);
      setExportError(null);
      setExportFeedback(null);
      if (exportTimeoutRef.current) {
        clearTimeout(exportTimeoutRef.current);
        exportTimeoutRef.current = null;
      }
      hasLoadedRecipes.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      hasLoadedRecipes.current = false;
    }
  }, [projectId, isOpen]);

  useEffect(() => {
    return () => {
      if (exportTimeoutRef.current) {
        clearTimeout(exportTimeoutRef.current);
      }
    };
  }, []);

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

  const handleExportRecipe = async (recipeId: string) => {
    setExportError(null);
    const json = exportRecipe(recipeId);
    if (json) {
      try {
        await navigator.clipboard.writeText(json);
        setExportFeedback(recipeId);
        setExportError(null);
        if (exportTimeoutRef.current) {
          clearTimeout(exportTimeoutRef.current);
        }
        exportTimeoutRef.current = setTimeout(() => {
          setExportFeedback(null);
          exportTimeoutRef.current = null;
        }, 2000);
      } catch (err) {
        logError("Failed to copy to clipboard", err);
        setExportError(formatErrorMessage(err, "Failed to copy to clipboard"));
      }
    }
  };

  const handleImportRecipe = async () => {
    setImportError(null);
    if (!projectId) {
      setImportError("No project selected");
      return;
    }
    try {
      await importRecipe(projectId, importJson);
      setShowImportDialog(false);
      setImportJson("");
    } catch (err) {
      setImportError(formatErrorMessage(err, "Failed to import recipe"));
    }
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
              <Button variant="outline" size="sm" onClick={handleAddRecipe}>
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
                    The previously pinned recipe was deleted or is no longer eligible. Pin another
                    recipe or clear the default below.
                  </p>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onDefaultWorktreeRecipeIdChange(undefined)}
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
                  <Button variant="outline" size="sm" onClick={handleAddRecipe}>
                    <Plus />
                    Add recipe
                  </Button>
                }
              >
                No recipes yet — a recipe opens a set of terminals with their commands in one step
              </SettingsEmptyRow>
            </SettingsGroup>
          ) : (
            <SettingsGroup>
              {recipes.map((recipe) => {
                const exported = exportFeedback === recipe.id;
                const isEligibleForDefault = !recipe.worktreeId && !recipe.shadowedBy;
                const isDefault = recipe.id === defaultWorktreeRecipeId;
                const isShadowed = !!recipe.shadowedBy;
                // A plugin owns its recipes' content — editing or deleting one
                // here would be undone on the plugin's next load, and the store
                // rejects both. Hide the controls rather than surface an error
                // toast for an action that was never possible (#11860).
                const fromPlugin = isPluginRecipe(recipe);
                return (
                  <div
                    key={recipe.id}
                    className={cn(
                      "px-4 py-3 hover:bg-overlay-subtle transition-colors group cursor-default",
                      isShadowed && "opacity-60"
                    )}
                  >
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
                          <Badge size="xs">
                            {recipe.terminals.length} terminal
                            {recipe.terminals.length !== 1 ? "s" : ""}
                          </Badge>
                          {isShadowed && <Badge size="xs">Overridden</Badge>}
                          {isDefault && <Badge size="xs">Default</Badge>}
                          {recipe.showInEmptyState && <Badge size="xs">Empty state</Badge>}
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
                                size="sm"
                                onClick={() =>
                                  onDefaultWorktreeRecipeIdChange(isDefault ? undefined : recipe.id)
                                }
                                aria-pressed={isDefault}
                                aria-label={
                                  isDefault
                                    ? `Unset ${recipe.name} as default worktree recipe`
                                    : `Set ${recipe.name} as default worktree recipe`
                                }
                                className={`h-7 px-2 transition-opacity ${
                                  isDefault
                                    ? "opacity-100"
                                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                                }`}
                              >
                                <Pin className={isDefault ? "fill-current" : undefined} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                              {isDefault ? "Unset default recipe" : "Set as default recipe"}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                          {!fromPlugin && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleEditRecipe(recipe)}
                                  className="h-7 px-2"
                                  aria-label={`Edit recipe ${recipe.name}`}
                                >
                                  <Edit3 />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">Edit recipe</TooltipContent>
                            </Tooltip>
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleExportRecipe(recipe.id)}
                                className="h-7 px-2"
                                aria-label={
                                  exported
                                    ? `Recipe ${recipe.name} exported to clipboard`
                                    : `Export recipe ${recipe.name} to clipboard`
                                }
                              >
                                {exported ? (
                                  <Check className="text-status-success" />
                                ) : (
                                  <Download />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                              {exported ? "Exported" : "Export recipe to clipboard"}
                            </TooltipContent>
                          </Tooltip>
                          {!fromPlugin && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setRecipeToDelete(recipe.id)}
                                  className="h-7 px-2"
                                  aria-label={`Delete recipe ${recipe.name}`}
                                >
                                  <Trash2 className="text-status-error" />
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
          {exportError && (
            <p className="text-xs text-status-error" role="alert">
              {exportError}
            </p>
          )}
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

      <AppDialog
        isOpen={showImportDialog}
        onClose={() => {
          setShowImportDialog(false);
          setImportJson("");
          setImportError(null);
        }}
        size="md"
      >
        <AppDialog.Header>
          <AppDialog.Title>Import recipe</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>

        <AppDialog.Body>
          <p className="text-sm text-text-secondary mb-4">
            Paste the JSON configuration for the recipe you want to import.
          </p>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{"name": "My Recipe", "terminals": [...]}'
            className="w-full h-64 px-3 py-2 bg-surface-canvas border border-border-default rounded-[var(--radius-md)] text-sm text-text-primary font-mono focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/30 resize-none"
            spellCheck={false}
          />
          {importError && (
            <div className="mt-3 text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)] p-3">
              {importError}
            </div>
          )}
        </AppDialog.Body>

        <AppDialog.Footer>
          <Button
            variant="ghost"
            onClick={() => {
              setShowImportDialog(false);
              setImportJson("");
              setImportError(null);
            }}
          >
            Cancel
          </Button>
          <Button variant="contrast" onClick={handleImportRecipe} disabled={!importJson.trim()}>
            Import
          </Button>
        </AppDialog.Footer>
      </AppDialog>
    </>
  );
}
