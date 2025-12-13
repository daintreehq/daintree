import { useState } from "react";
import type { TerminalRecipe } from "@/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useRecipeStore } from "@/store/recipeStore";
import { RecipeEditor } from "./RecipeEditor";

interface RecipeListProps {
  worktreeId?: string;
  worktreePath?: string;
  showGlobal?: boolean;
}

export function RecipeList({ worktreeId, worktreePath, showGlobal = true }: RecipeListProps) {
  const recipes = useRecipeStore((state) => state.recipes);
  const deleteRecipe = useRecipeStore((state) => state.deleteRecipe);
  const exportRecipe = useRecipeStore((state) => state.exportRecipe);
  const runRecipe = useRecipeStore((state) => state.runRecipe);
  const importRecipe = useRecipeStore((state) => state.importRecipe);

  const [editingRecipe, setEditingRecipe] = useState<TerminalRecipe | undefined>(undefined);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [runningRecipeId, setRunningRecipeId] = useState<string | null>(null);

  const filteredRecipes = recipes.filter((recipe) => {
    if (worktreeId) {
      return recipe.worktreeId === worktreeId || (showGlobal && !recipe.worktreeId);
    }
    return true;
  });

  const handleRun = async (recipe: TerminalRecipe) => {
    if (!worktreePath) {
      console.error("Cannot run recipe: worktree path not provided");
      return;
    }

    if (runningRecipeId !== null) {
      return;
    }

    setRunningRecipeId(recipe.id);
    try {
      await runRecipe(recipe.id, worktreePath, worktreeId);
    } catch (error) {
      console.error("Failed to run recipe:", error);
    } finally {
      setRunningRecipeId(null);
    }
  };

  const handleEdit = (recipe: TerminalRecipe) => {
    setEditingRecipe(recipe);
    setIsEditorOpen(true);
  };

  const handleDelete = async (recipe: TerminalRecipe) => {
    if (confirm(`Delete recipe "${recipe.name}"?`)) {
      try {
        await deleteRecipe(recipe.id);
      } catch (error) {
        console.error("Failed to delete recipe:", error);
      }
    }
  };

  const handleExport = (recipe: TerminalRecipe) => {
    const json = exportRecipe(recipe.id);
    if (!json) {
      console.error("Failed to export recipe");
      return;
    }

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = recipe.name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        await importRecipe(text);
      } catch (error) {
        alert(error instanceof Error ? error.message : "Failed to import recipe");
      }
    };
    input.click();
  };

  const handleCloseEditor = () => {
    setIsEditorOpen(false);
    setEditingRecipe(undefined);
  };

  if (filteredRecipes.length === 0) {
    return (
      <div className="text-center py-8 text-canopy-text-dim">
        <p className="mb-4">No recipes found</p>
        <Button size="sm" onClick={handleImport}>
          Import Recipe
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filteredRecipes.map((recipe) => (
        <div
          key={recipe.id}
          className="bg-canopy-background border border-canopy-border rounded-[var(--radius-md)] p-3 hover:border-canopy-accent transition-colors"
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h3 className="text-sm font-medium text-canopy-text">{recipe.name}</h3>
              <p className="text-xs text-canopy-text-dim mt-1">
                {recipe.terminals.length} terminal{recipe.terminals.length !== 1 ? "s" : ""} •{" "}
                {recipe.worktreeId ? "Worktree" : "Global"}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {worktreePath && (
                <Button
                  size="sm"
                  onClick={() => handleRun(recipe)}
                  disabled={runningRecipeId === recipe.id}
                >
                  {runningRecipeId === recipe.id ? "Running..." : "Run"}
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" aria-label="Recipe actions">
                    ⋮
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleEdit(recipe)}>Edit</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport(recipe)}>
                    Export as JSON
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => handleDelete(recipe)}
                    className="text-[var(--color-status-error)]"
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      ))}

      <div className="pt-2">
        <Button size="sm" variant="outline" onClick={handleImport} className="w-full">
          Import Recipe
        </Button>
      </div>

      <RecipeEditor
        recipe={editingRecipe}
        worktreeId={worktreeId}
        isOpen={isEditorOpen}
        onClose={handleCloseEditor}
      />
    </div>
  );
}
