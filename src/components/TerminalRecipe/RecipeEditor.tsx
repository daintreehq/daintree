import { useState, useEffect, useRef } from "react";
import type { TerminalRecipe, RecipeTerminal, RecipeTerminalType } from "@/types";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { useRecipeStore } from "@/store/recipeStore";

interface RecipeEditorProps {
  recipe?: TerminalRecipe;
  initialTerminals?: RecipeTerminal[];
  worktreeId?: string;
  isOpen: boolean;
  onClose: () => void;
  onSave?: (recipe: TerminalRecipe) => void;
}

const TERMINAL_TYPES: RecipeTerminalType[] = ["terminal", "claude", "gemini", "codex"];

const TYPE_LABELS: Record<RecipeTerminalType, string> = {
  terminal: "Terminal",
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
};

export function RecipeEditor({
  recipe,
  initialTerminals,
  worktreeId,
  isOpen,
  onClose,
  onSave,
}: RecipeEditorProps) {
  const createRecipe = useRecipeStore((state) => state.createRecipe);
  const updateRecipe = useRecipeStore((state) => state.updateRecipe);

  const [recipeName, setRecipeName] = useState("");
  const [terminals, setTerminals] = useState<RecipeTerminal[]>([
    { type: "terminal", title: "", command: "", env: {} },
  ]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recipeNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (recipe) {
      setRecipeName(recipe.name);
      setTerminals(recipe.terminals.map((t) => ({ ...t })));
    } else if (initialTerminals && initialTerminals.length > 0) {
      setRecipeName("");
      setTerminals(initialTerminals.map((t) => ({ ...t })));
    } else {
      setRecipeName("");
      setTerminals([{ type: "terminal", title: "", command: "", env: {} }]);
    }
    setError(null);
  }, [recipe, initialTerminals, isOpen]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => recipeNameInputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const handleAddTerminal = () => {
    if (terminals.length >= 10) {
      setError("Maximum of 10 terminals per recipe");
      return;
    }
    setTerminals([...terminals, { type: "terminal", title: "", command: "", env: {} }]);
  };

  const handleRemoveTerminal = (index: number) => {
    if (terminals.length === 1) {
      setError("Recipe must contain at least one terminal");
      return;
    }
    setTerminals(terminals.filter((_, i) => i !== index));
  };

  const handleTerminalChange = (
    index: number,
    field: keyof RecipeTerminal,
    value: string | Record<string, string>
  ) => {
    const newTerminals = [...terminals];
    newTerminals[index] = { ...newTerminals[index], [field]: value };
    setTerminals(newTerminals);
  };

  const handleSave = async () => {
    setError(null);

    if (!recipeName.trim()) {
      setError("Recipe name is required");
      return;
    }

    if (terminals.length === 0) {
      setError("Recipe must contain at least one terminal");
      return;
    }

    setIsSaving(true);

    try {
      if (recipe) {
        await updateRecipe(recipe.id, {
          name: recipeName,
          terminals,
        });
      } else {
        await createRecipe(recipeName, worktreeId, terminals);
      }

      if (onSave) {
        const savedRecipe: TerminalRecipe = recipe
          ? { ...recipe, name: recipeName, terminals }
          : {
              id: `recipe-${Date.now()}`,
              name: recipeName,
              worktreeId,
              terminals,
              createdAt: Date.now(),
            };
        onSave(savedRecipe);
      }

      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to save recipe");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg" dismissible={!isSaving}>
      <AppDialog.Header>
        <AppDialog.Title>{recipe ? "Edit Recipe" : "Create Recipe"}</AppDialog.Title>
      </AppDialog.Header>

      <AppDialog.Body>
        <div className="mb-4">
          <label htmlFor="recipe-name" className="block text-sm font-medium text-canopy-text mb-1">
            Recipe Name
          </label>
          <input
            ref={recipeNameInputRef}
            id="recipe-name"
            type="text"
            value={recipeName}
            onChange={(e) => setRecipeName(e.target.value)}
            placeholder="e.g., Full Stack Dev"
            className="w-full px-3 py-2 bg-canopy-background border border-canopy-border rounded-md text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
          />
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-canopy-text">
              Terminals ({terminals.length}/10)
            </label>
            <Button size="sm" onClick={handleAddTerminal} disabled={terminals.length >= 10}>
              + Add Terminal
            </Button>
          </div>

          <div className="space-y-3">
            {terminals.map((terminal, index) => (
              <div
                key={index}
                className="bg-canopy-background border border-canopy-border rounded-md p-3"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <label className="block text-xs font-medium text-canopy-text mb-1">Type</label>
                    <select
                      value={terminal.type}
                      onChange={(e) =>
                        handleTerminalChange(index, "type", e.target.value as RecipeTerminalType)
                      }
                      className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text"
                    >
                      {TERMINAL_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex-1">
                    <label className="block text-xs font-medium text-canopy-text mb-1">
                      Title (optional)
                    </label>
                    <input
                      type="text"
                      value={terminal.title || ""}
                      onChange={(e) => handleTerminalChange(index, "title", e.target.value)}
                      placeholder="Default"
                      className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text"
                    />
                  </div>

                  <div className="pt-5">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleRemoveTerminal(index)}
                      disabled={terminals.length === 1}
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                {terminal.type === "terminal" && (
                  <div className="mt-2">
                    <label className="block text-xs font-medium text-canopy-text mb-1">
                      Command (optional)
                    </label>
                    <input
                      type="text"
                      value={terminal.command || ""}
                      onChange={(e) => handleTerminalChange(index, "command", e.target.value)}
                      placeholder="e.g., npm run dev"
                      className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-md text-[var(--color-status-error)] text-sm">
            {error}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="outline" onClick={onClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : recipe ? "Update Recipe" : "Create Recipe"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
