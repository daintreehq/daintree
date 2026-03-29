import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, Edit3, Download, FileDown, Check, Globe } from "lucide-react";
import { TerminalRecipeIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useRecipeStore } from "@/store/recipeStore";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { RecipeEditor } from "@/components/TerminalRecipe/RecipeEditor";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import type { TerminalRecipe, Worktree } from "@/types";

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
    deleteRecipe,
    exportRecipe,
    importRecipe,
    isLoading: recipesLoading,
  } = useRecipeStore();

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
        console.error("Failed to load recipes:", err);
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
    try {
      await deleteRecipe(recipeId);
      if (recipeId === defaultWorktreeRecipeId) {
        onDefaultWorktreeRecipeIdChange(undefined);
      }
      setRecipeToDelete(null);
    } catch (err) {
      console.error("Failed to delete recipe:", err);
      setDeleteError(err instanceof Error ? err.message : "Failed to delete recipe");
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
        console.error("Failed to copy to clipboard:", err);
        setExportError(err instanceof Error ? err.message : "Failed to copy to clipboard");
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
      setImportError(err instanceof Error ? err.message : "Failed to import recipe");
    }
  };

  const getRecipeScope = (recipe: TerminalRecipe): { label: string; isGlobal: boolean } => {
    if (recipe.projectId === undefined) return { label: "Global", isGlobal: true };
    if (!recipe.worktreeId) return { label: "Project-wide", isGlobal: false };
    const worktree = worktreeMap.get(recipe.worktreeId);
    if (worktree) {
      return {
        label: `Worktree: ${worktree.isMainWorktree ? worktree.name : worktree.branch || worktree.name}`,
        isGlobal: false,
      };
    }
    return { label: `Worktree: ${recipe.worktreeId}`, isGlobal: false };
  };

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={300}>
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
          <TerminalRecipeIcon className="h-4 w-4" />
          Terminal Recipes
        </h3>
        <p className="text-xs text-canopy-text/60 mb-4">
          Manage saved terminal configurations. Recipes can spawn multiple terminals with predefined
          commands and settings.
        </p>

        <div className="space-y-2">
          {recipesLoading ? (
            <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
              Loading recipes...
            </div>
          ) : recipes.length === 0 ? (
            <div className="text-sm text-canopy-text/60 text-center py-8 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
              No recipes configured yet
            </div>
          ) : (
            <div className="border border-canopy-border rounded-[var(--radius-md)] divide-y divide-canopy-border">
              {recipes.map((recipe) => {
                const exported = exportFeedback === recipe.id;
                return (
                  <div
                    key={recipe.id}
                    className="p-3 hover:bg-muted/50 transition-colors group cursor-default"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-sm font-medium text-foreground truncate">
                                {recipe.name}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">{recipe.name}</TooltipContent>
                          </Tooltip>
                          {(() => {
                            const scopeInfo = getRecipeScope(recipe);
                            return (
                              <span
                                className={`text-[11px] px-1.5 py-0.5 rounded font-medium shrink-0 flex items-center gap-1 ${
                                  scopeInfo.isGlobal
                                    ? "text-status-info bg-status-info/10"
                                    : "text-muted-foreground bg-muted"
                                }`}
                              >
                                {scopeInfo.isGlobal && <Globe className="h-3 w-3" />}
                                {scopeInfo.label}
                              </span>
                            );
                          })()}
                          <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-medium shrink-0">
                            {recipe.terminals.length} terminal
                            {recipe.terminals.length !== 1 ? "s" : ""}
                          </span>
                          {recipe.showInEmptyState && (
                            <span className="text-[11px] text-status-info bg-status-info/10 px-1.5 py-0.5 rounded font-medium shrink-0">
                              Empty State
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {recipe.lastUsedAt ? (
                            <span>
                              Last used <LiveTimeAgo timestamp={recipe.lastUsedAt} />
                            </span>
                          ) : (
                            <span>Never used</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
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
                              {exported ? <Check className="text-status-success" /> : <Download />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            {exported ? "Exported" : "Export recipe to clipboard"}
                          </TooltipContent>
                        </Tooltip>
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
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {exportError && (
            <div
              className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3"
              role="alert"
            >
              {exportError}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleAddRecipe} className="flex-1">
              <Plus />
              Add Recipe
            </Button>
            <Button variant="outline" onClick={() => setShowImportDialog(true)}>
              <FileDown />
              Import Recipe
            </Button>
          </div>
        </div>
      </div>

      <RecipeEditor
        recipe={editingRecipe}
        worktreeId={undefined}
        isOpen={isRecipeEditorOpen}
        onClose={handleRecipeEditorClose}
      />

      <ConfirmDialog
        isOpen={recipeToDelete !== null}
        title="Delete Recipe"
        description={
          deleteError
            ? `Error: ${deleteError}`
            : "Are you sure you want to delete this recipe? This action cannot be undone."
        }
        confirmLabel={deleteError ? "Retry" : "Delete"}
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
          <AppDialog.Title>Import Recipe</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>

        <AppDialog.Body>
          <p className="text-sm text-canopy-text/60 mb-4">
            Paste the JSON configuration for the recipe you want to import.
          </p>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{"name": "My Recipe", "terminals": [...]}'
            className="w-full h-64 px-3 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-sm text-canopy-text font-mono focus:outline-none focus:ring-2 focus:ring-canopy-accent resize-none"
            spellCheck={false}
          />
          {importError && (
            <div className="mt-3 text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded p-3">
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
          <Button onClick={handleImportRecipe} disabled={!importJson.trim()}>
            Import
          </Button>
        </AppDialog.Footer>
      </AppDialog>
    </TooltipProvider>
  );
}
