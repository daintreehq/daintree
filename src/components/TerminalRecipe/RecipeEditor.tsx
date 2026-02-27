import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { TerminalRecipe, RecipeTerminal, RecipeTerminalType } from "@/types";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";

function cloneTerminal(t: RecipeTerminal): RecipeTerminal {
  return { ...t, env: t.env ? { ...t.env } : {} };
}

function normalizeExitBehavior(t: RecipeTerminal): "" | "keep" | "trash" | "remove" {
  const value = t.exitBehavior ?? "";
  // "restart" is QuickRun-only and not exposed in recipe UI — treat as default
  if (!value || value === "restart") return "";
  const defaultBehavior = t.type === "terminal" || t.type === "dev-preview" ? "trash" : "keep";
  return value === defaultBehavior ? "" : value;
}

function serializeEditorState(
  name: string,
  terminals: RecipeTerminal[],
  showInEmptyState: boolean
): string {
  return JSON.stringify({
    name,
    showInEmptyState,
    terminals: terminals.map((t) => ({
      type: t.type,
      title: t.title ?? "",
      command: t.command ?? "",
      initialPrompt: t.initialPrompt ?? "",
      devCommand: t.devCommand ?? "",
      exitBehavior: normalizeExitBehavior(t),
      env: Object.fromEntries(Object.entries(t.env ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    })),
  });
}

interface RecipeEditorProps {
  recipe?: TerminalRecipe;
  initialTerminals?: RecipeTerminal[];
  worktreeId?: string;
  isOpen: boolean;
  onClose: () => void;
  onSave?: (recipe: TerminalRecipe) => void;
}

const TERMINAL_TYPES: RecipeTerminalType[] = [
  "terminal",
  "claude",
  "gemini",
  "codex",
  "opencode",
  "dev-preview",
];

const TYPE_LABELS: Record<RecipeTerminalType, string> = {
  terminal: "Terminal",
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  opencode: "OpenCode",
  "dev-preview": "Dev Server",
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
  const currentProject = useProjectStore((state) => state.currentProject);

  const [recipeName, setRecipeName] = useState("");
  const [terminals, setTerminals] = useState<RecipeTerminal[]>([
    { type: "terminal", title: "", command: "", env: {} },
  ]);
  const [showInEmptyState, setShowInEmptyState] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recipeNameInputRef = useRef<HTMLInputElement>(null);
  const initialStateRef = useRef<string>("");

  useEffect(() => {
    if (!isOpen) return;
    if (recipe) {
      const nextTerminals = recipe.terminals.map(cloneTerminal);
      const nextShowInEmptyState = recipe.showInEmptyState ?? false;
      setRecipeName(recipe.name);
      setTerminals(nextTerminals);
      setShowInEmptyState(nextShowInEmptyState);
      initialStateRef.current = serializeEditorState(
        recipe.name,
        nextTerminals,
        nextShowInEmptyState
      );
    } else if (initialTerminals && initialTerminals.length > 0) {
      const nextTerminals = initialTerminals.map(cloneTerminal);
      setRecipeName("");
      setTerminals(nextTerminals);
      setShowInEmptyState(false);
      initialStateRef.current = serializeEditorState("", nextTerminals, false);
    } else {
      const nextTerminals: RecipeTerminal[] = [
        { type: "terminal", title: "", command: "", env: {} },
      ];
      setRecipeName("");
      setTerminals(nextTerminals);
      setShowInEmptyState(false);
      initialStateRef.current = serializeEditorState("", nextTerminals, false);
    }
    setError(null);
  }, [recipe, initialTerminals, isOpen]);

  const isDirty = useMemo(
    () => serializeEditorState(recipeName, terminals, showInEmptyState) !== initialStateRef.current,
    [recipeName, terminals, showInEmptyState]
  );

  const { onBeforeClose } = useUnsavedChanges({ isDirty });

  const handleCancel = useCallback(async () => {
    const canClose = await onBeforeClose();
    if (canClose) onClose();
  }, [onBeforeClose, onClose]);

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
          showInEmptyState,
        });
      } else {
        if (!currentProject?.id) {
          throw new Error("No project selected");
        }
        await createRecipe(currentProject.id, recipeName, worktreeId, terminals, showInEmptyState);
      }

      if (onSave) {
        const savedRecipe: TerminalRecipe = recipe
          ? { ...recipe, name: recipeName, terminals }
          : {
              id: `recipe-${Date.now()}`,
              name: recipeName,
              projectId: currentProject!.id,
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
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      onBeforeClose={onBeforeClose}
      size="lg"
      dismissible={!isSaving}
    >
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
            className="w-full px-3 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
          />
        </div>

        <div className="mb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              id="show-in-empty-state"
              type="checkbox"
              checked={showInEmptyState}
              onChange={(e) => setShowInEmptyState(e.target.checked)}
              aria-describedby="show-in-empty-state-help"
              className="w-4 h-4 rounded border-canopy-border bg-canopy-bg checked:bg-canopy-accent checked:border-canopy-accent focus:ring-2 focus:ring-canopy-accent"
            />
            <span className="text-sm font-medium text-canopy-text">Show in Empty State</span>
          </label>
          <p id="show-in-empty-state-help" className="text-xs text-canopy-muted mt-1 ml-6">
            Display this recipe as a primary launcher when the worktree has no active terminals
          </p>
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
                className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] p-3"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <label
                      htmlFor={`terminal-type-${index}`}
                      className="block text-xs font-medium text-canopy-text mb-1"
                    >
                      Type
                    </label>
                    <select
                      id={`terminal-type-${index}`}
                      value={terminal.type}
                      onChange={(e) => {
                        const newType = e.target.value as RecipeTerminalType;
                        setTerminals((prev) => {
                          const updated = [...prev];
                          const prevType = updated[index].type;
                          updated[index] = {
                            ...updated[index],
                            type: newType,
                            // Clear command when switching between types so the new type uses its default
                            command: newType === prevType ? updated[index].command : "",
                            // Clear initialPrompt when switching to terminal or dev-preview
                            initialPrompt:
                              newType === "terminal" || newType === "dev-preview"
                                ? ""
                                : updated[index].initialPrompt,
                            // Clear devCommand when switching away from dev-preview
                            devCommand: newType !== "dev-preview" ? "" : updated[index].devCommand,
                          };
                          return updated;
                        });
                      }}
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
                    <label
                      htmlFor={`terminal-title-${index}`}
                      className="block text-xs font-medium text-canopy-text mb-1"
                    >
                      Title (optional)
                    </label>
                    <input
                      id={`terminal-title-${index}`}
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
                  <>
                    <div className="mt-2">
                      <label
                        htmlFor={`terminal-command-${index}`}
                        className="block text-xs font-medium text-canopy-text mb-1"
                      >
                        Command (optional)
                      </label>
                      <input
                        id={`terminal-command-${index}`}
                        type="text"
                        value={terminal.command || ""}
                        onChange={(e) => handleTerminalChange(index, "command", e.target.value)}
                        placeholder="e.g., npm run dev"
                        className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text"
                      />
                    </div>
                    <div className="mt-2">
                      <label
                        htmlFor={`terminal-exit-behavior-${index}`}
                        className="block text-xs font-medium text-canopy-text mb-1"
                      >
                        After Exit
                      </label>
                      <select
                        id={`terminal-exit-behavior-${index}`}
                        value={terminal.exitBehavior || "trash"}
                        onChange={(e) =>
                          handleTerminalChange(
                            index,
                            "exitBehavior",
                            e.target.value === "trash" ? "" : e.target.value
                          )
                        }
                        aria-describedby={`terminal-exit-behavior-help-${index}`}
                        className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text"
                      >
                        <option value="trash">Send to Trash (default)</option>
                        <option value="keep">Keep for Review</option>
                        <option value="remove">Remove Completely</option>
                      </select>
                      <p
                        id={`terminal-exit-behavior-help-${index}`}
                        className="text-xs text-canopy-muted mt-1"
                      >
                        Failures always preserve terminal for debugging
                      </p>
                    </div>
                  </>
                )}

                {terminal.type !== "terminal" && terminal.type !== "dev-preview" && (
                  <>
                    <div className="mt-2">
                      <label
                        htmlFor={`terminal-initial-prompt-${index}`}
                        className="block text-xs font-medium text-canopy-text mb-1"
                      >
                        Initial Prompt (optional)
                      </label>
                      <textarea
                        id={`terminal-initial-prompt-${index}`}
                        value={terminal.initialPrompt || ""}
                        onChange={(e) =>
                          handleTerminalChange(index, "initialPrompt", e.target.value)
                        }
                        placeholder="e.g., Review the latest changes and suggest improvements"
                        rows={2}
                        aria-describedby={`terminal-initial-prompt-help-${index}`}
                        className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text resize-y min-h-[60px]"
                      />
                      <p
                        id={`terminal-initial-prompt-help-${index}`}
                        className="text-xs text-canopy-muted mt-1"
                      >
                        This prompt will be sent to the agent when it starts
                      </p>
                    </div>
                    <div className="mt-2">
                      <label
                        htmlFor={`terminal-agent-exit-behavior-${index}`}
                        className="block text-xs font-medium text-canopy-text mb-1"
                      >
                        After Exit
                      </label>
                      <select
                        id={`terminal-agent-exit-behavior-${index}`}
                        value={terminal.exitBehavior || "keep"}
                        onChange={(e) =>
                          handleTerminalChange(
                            index,
                            "exitBehavior",
                            e.target.value === "keep" ? "" : e.target.value
                          )
                        }
                        aria-describedby={`terminal-agent-exit-behavior-help-${index}`}
                        className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text"
                      >
                        <option value="keep">Keep for Review (default)</option>
                        <option value="trash">Send to Trash</option>
                        <option value="remove">Remove Completely</option>
                      </select>
                      <p
                        id={`terminal-agent-exit-behavior-help-${index}`}
                        className="text-xs text-canopy-muted mt-1"
                      >
                        Failures always preserve terminal for debugging
                      </p>
                    </div>
                  </>
                )}

                {terminal.type === "dev-preview" && (
                  <>
                    <div className="mt-2">
                      <label
                        htmlFor={`terminal-dev-command-${index}`}
                        className="block text-xs font-medium text-canopy-text mb-1"
                      >
                        Dev Command (optional)
                      </label>
                      <input
                        id={`terminal-dev-command-${index}`}
                        type="text"
                        value={terminal.devCommand || ""}
                        onChange={(e) => handleTerminalChange(index, "devCommand", e.target.value)}
                        placeholder="e.g., npm run dev"
                        aria-describedby={`terminal-dev-command-help-${index}`}
                        className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text"
                      />
                      <p
                        id={`terminal-dev-command-help-${index}`}
                        className="text-xs text-canopy-muted mt-1"
                      >
                        Leave empty to use project default or auto-detect from package.json
                      </p>
                    </div>
                    <div className="mt-2">
                      <label
                        htmlFor={`terminal-dev-exit-behavior-${index}`}
                        className="block text-xs font-medium text-canopy-text mb-1"
                      >
                        After Exit
                      </label>
                      <select
                        id={`terminal-dev-exit-behavior-${index}`}
                        value={terminal.exitBehavior || "trash"}
                        onChange={(e) =>
                          handleTerminalChange(
                            index,
                            "exitBehavior",
                            e.target.value === "trash" ? "" : e.target.value
                          )
                        }
                        aria-describedby={`terminal-dev-exit-behavior-help-${index}`}
                        className="w-full px-2 py-1.5 bg-canopy-sidebar border border-canopy-border rounded text-sm text-canopy-text"
                      >
                        <option value="trash">Send to Trash (default)</option>
                        <option value="keep">Keep for Review</option>
                        <option value="remove">Remove Completely</option>
                      </select>
                      <p
                        id={`terminal-dev-exit-behavior-help-${index}`}
                        className="text-xs text-canopy-muted mt-1"
                      >
                        Failures always preserve terminal for debugging
                      </p>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-[var(--radius-md)] text-[var(--color-status-error)] text-sm">
            {error}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="outline" onClick={() => void handleCancel()} disabled={isSaving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : recipe ? "Update Recipe" : "Create Recipe"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
