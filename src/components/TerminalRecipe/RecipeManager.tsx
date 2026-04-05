import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Globe,
  FolderOpen,
  FolderGit2,
  Plus,
  Trash2,
  Edit3,
  Download,
  FileDown,
  FileUp,
  Check,
  Lock,
  GitBranch,
} from "lucide-react";
import { TerminalRecipeIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import type { TerminalRecipe } from "@/types";
import { useRef } from "react";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";

interface RecipeManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onEditRecipe: (recipe: TerminalRecipe) => void;
  onCreateRecipe: (scope: "global" | "project") => void;
}

export function RecipeManager({
  isOpen,
  onClose,
  onEditRecipe,
  onCreateRecipe,
}: RecipeManagerProps) {
  const globalRecipes = useRecipeStore((s) => s.globalRecipes);
  const rawProjectRecipes = useRecipeStore((s) => s.projectRecipes);
  const inRepoRecipes = useRecipeStore((s) => s.inRepoRecipes);

  // Filter out project recipes shadowed by in-repo recipes with the same name
  const inRepoNames = useMemo(() => new Set(inRepoRecipes.map((r) => r.name)), [inRepoRecipes]);
  const projectRecipes = useMemo(
    () => rawProjectRecipes.filter((r) => !inRepoNames.has(r.name)),
    [rawProjectRecipes, inRepoNames]
  );
  const deleteRecipe = useRecipeStore((s) => s.deleteRecipe);
  const saveToRepo = useRecipeStore((s) => s.saveToRepo);
  const exportRecipe = useRecipeStore((s) => s.exportRecipe);
  const exportRecipeToFile = useRecipeStore((s) => s.exportRecipeToFile);
  const importRecipe = useRecipeStore((s) => s.importRecipe);
  const importRecipeFromFile = useRecipeStore((s) => s.importRecipeFromFile);
  const currentProject = useProjectStore((s) => s.currentProject);

  const [recipeToDelete, setRecipeToDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [recipeToSave, setRecipeToSave] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recipeToDeleteAfterSave, setRecipeToDeleteAfterSave] = useState<string | null>(null);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importScope, setImportScope] = useState<"global" | "project">("project");
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const exportTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (exportTimeoutRef.current) {
        clearTimeout(exportTimeoutRef.current);
      }
    };
  }, []);

  const handleDeleteRecipe = async (recipeId: string) => {
    setDeleteError(null);
    try {
      await deleteRecipe(recipeId);
      setRecipeToDelete(null);
    } catch (err) {
      console.error("Failed to delete recipe:", err);
      setDeleteError(err instanceof Error ? err.message : "Failed to delete recipe");
    }
  };

  const handleExportRecipe = useCallback(
    async (recipeId: string) => {
      const json = exportRecipe(recipeId);
      if (json) {
        try {
          await navigator.clipboard.writeText(json);
          setExportFeedback(recipeId);
          if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
          exportTimeoutRef.current = setTimeout(() => {
            setExportFeedback(null);
            exportTimeoutRef.current = null;
          }, 2000);
        } catch (err) {
          console.error("Failed to copy to clipboard:", err);
        }
      }
    },
    [exportRecipe]
  );

  const handleSaveToRepo = async () => {
    if (!recipeToSave) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await saveToRepo(recipeToSave, false);
      const savedId = recipeToSave;
      setRecipeToSave(null);
      setRecipeToDeleteAfterSave(savedId);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save recipe to repo");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAfterSave = async () => {
    if (!recipeToDeleteAfterSave) return;
    try {
      await deleteRecipe(recipeToDeleteAfterSave);
    } catch (err) {
      console.error("Failed to delete original recipe:", err);
    }
    setRecipeToDeleteAfterSave(null);
  };

  const handleImportRecipe = async () => {
    setImportError(null);
    const targetProjectId = importScope === "global" ? undefined : currentProject?.id;
    if (importScope === "project" && !targetProjectId) {
      setImportError("No project selected");
      return;
    }
    try {
      await importRecipe(targetProjectId, importJson);
      setShowImportDialog(false);
      setImportJson("");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import recipe");
    }
  };

  const renderRecipeRow = (recipe: TerminalRecipe, readOnly = false) => {
    const exported = exportFeedback === recipe.id;
    const isGlobal = !isInRepoRecipeId(recipe.id) && recipe.projectId === undefined;
    return (
      <div key={recipe.id} className="p-3 hover:bg-muted/50 transition-colors group cursor-default">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground truncate">{recipe.name}</span>
              {readOnly && (
                <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-medium shrink-0 flex items-center gap-1">
                  <Lock className="h-3 w-3" />
                  Read-only
                </span>
              )}
              {isGlobal && (
                <span className="text-[11px] text-status-info bg-status-info/10 px-1.5 py-0.5 rounded font-medium shrink-0 flex items-center gap-1">
                  <Globe className="h-3 w-3" />
                  Global
                </span>
              )}
              <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-medium shrink-0">
                {recipe.terminals.length} terminal{recipe.terminals.length !== 1 ? "s" : ""}
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
            {!readOnly && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEditRecipe(recipe)}
                    className="h-7 px-2"
                    aria-label={`Edit recipe ${recipe.name}`}
                  >
                    <Edit3 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Edit recipe</TooltipContent>
              </Tooltip>
            )}
            {!isInRepoRecipeId(recipe.id) && currentProject && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRecipeToSave(recipe.id)}
                    className="h-7 px-2"
                    aria-label={`Save recipe ${recipe.name} to repository`}
                  >
                    <FolderGit2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Save to repo</TooltipContent>
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
                  {exported ? <Check className="text-status-success" /> : <Download />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {exported ? "Exported" : "Export to clipboard"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void exportRecipeToFile(recipe.id)}
                  className="h-7 px-2"
                  aria-label={`Export recipe ${recipe.name} to file`}
                >
                  <FileUp />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Export to file</TooltipContent>
            </Tooltip>
            {!readOnly && (
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
    );
  };

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={300}>
      <AppDialog isOpen={isOpen} onClose={onClose} size="lg">
        <AppDialog.Header>
          <AppDialog.Title>
            <span className="flex items-center gap-2">
              <TerminalRecipeIcon className="h-5 w-5" />
              Recipe Manager
            </span>
          </AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>

        <AppDialog.Body>
          {/* Global Recipes Section */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Global Recipes
            </h3>
            <p className="text-xs text-canopy-text/60 mb-3">Available across all projects</p>
            {globalRecipes.length === 0 ? (
              <div className="text-sm text-canopy-text/60 text-center py-4 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                No global recipes
              </div>
            ) : (
              <div className="border border-canopy-border rounded-[var(--radius-md)] divide-y divide-canopy-border">
                {globalRecipes.map((r) => renderRecipeRow(r))}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <Button variant="outline" size="sm" onClick={() => onCreateRecipe("global")}>
                <Plus className="h-3 w-3" />
                New Global Recipe
              </Button>
            </div>
          </div>

          {/* Team Recipes Section (in-repo) */}
          {inRepoRecipes.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
                <GitBranch className="h-4 w-4" />
                Team Recipes
              </h3>
              <p className="text-xs text-canopy-text/60 mb-3">
                Shared via .canopy/recipes/ in the repository
              </p>
              <div className="border border-canopy-border rounded-[var(--radius-md)] divide-y divide-canopy-border">
                {inRepoRecipes.map((r) => renderRecipeRow(r))}
              </div>
            </div>
          )}

          {/* Project Recipes Section */}
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-canopy-text/80 mb-2 flex items-center gap-2">
              <FolderOpen className="h-4 w-4" />
              Project Recipes
              {currentProject && (
                <span className="text-xs font-normal text-canopy-text/50">
                  {currentProject.emoji} {currentProject.name}
                </span>
              )}
            </h3>
            <p className="text-xs text-canopy-text/60 mb-3">Specific to the current project</p>
            {projectRecipes.length === 0 ? (
              <div className="text-sm text-canopy-text/60 text-center py-4 border border-dashed border-canopy-border rounded-[var(--radius-md)]">
                No project recipes
              </div>
            ) : (
              <div className="border border-canopy-border rounded-[var(--radius-md)] divide-y divide-canopy-border">
                {projectRecipes.map((r) => renderRecipeRow(r))}
              </div>
            )}
            <div className="flex gap-2 mt-2">
              <Button variant="outline" size="sm" onClick={() => onCreateRecipe("project")}>
                <Plus className="h-3 w-3" />
                New Project Recipe
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowImportDialog(true)}>
                <FileDown className="h-3 w-3" />
                Import from Clipboard
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void importRecipeFromFile(currentProject?.id)}
              >
                <FileUp className="h-3 w-3" />
                Import from File
              </Button>
            </div>
          </div>
        </AppDialog.Body>
      </AppDialog>

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
          if (recipeToDelete) void handleDeleteRecipe(recipeToDelete);
        }}
        onClose={() => {
          setRecipeToDelete(null);
          setDeleteError(null);
        }}
      />

      <ConfirmDialog
        isOpen={recipeToSave !== null}
        title="Save to Team Recipes?"
        description={
          saveError
            ? `Error: ${saveError}`
            : "This recipe will be written to .canopy/recipes/ in the repository where it can be committed and shared with the team."
        }
        confirmLabel={saveError ? "Retry" : "Save to Repo"}
        isConfirmLoading={isSaving}
        onConfirm={() => void handleSaveToRepo()}
        onClose={() => {
          setRecipeToSave(null);
          setSaveError(null);
        }}
      />

      <ConfirmDialog
        isOpen={recipeToDeleteAfterSave !== null}
        title="Delete original?"
        description="The recipe has been saved to the repository. Do you want to remove the original copy from this machine?"
        confirmLabel="Delete Original"
        cancelLabel="Keep Both"
        variant="destructive"
        onConfirm={() => void handleDeleteAfterSave()}
        onClose={() => setRecipeToDeleteAfterSave(null)}
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
          <div className="mb-4">
            <label className="block text-sm font-medium text-canopy-text mb-1">Import as</label>
            <select
              value={importScope}
              onChange={(e) => setImportScope(e.target.value as "global" | "project")}
              className="w-full px-3 pr-8 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text text-sm"
            >
              <option value="project">Project Recipe</option>
              <option value="global">Global Recipe</option>
            </select>
          </div>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{"name": "My Recipe", "terminals": [...]}'
            className="w-full h-48 px-3 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-sm text-canopy-text font-mono focus:outline-none focus:ring-2 focus:ring-canopy-accent resize-none"
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
