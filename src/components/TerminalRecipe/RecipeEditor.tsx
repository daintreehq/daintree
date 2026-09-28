import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { TerminalRecipe, RecipeTerminal, RecipeTerminalType } from "@/types";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { isEnterToSubmit } from "@/lib/enterToSubmit";
import { useRecipeStore, MAX_TERMINALS_PER_RECIPE } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { isInRepoRecipeId } from "@shared/utils/recipeFilename";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  FIELD_INPUT,
  FIELD_SURFACE,
  FormGrid,
  FormRow,
  FormSection,
} from "@/components/Worktree/views";
import { RecipeVariablePreview } from "@/components/TerminalRecipe/RecipeVariablePreview";
import { cn } from "@/lib/utils";

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
  showInEmptyState: boolean,
  autoAssign: "always" | "never" | "prompt"
): string {
  return JSON.stringify({
    name,
    showInEmptyState,
    autoAssign,
    terminals: terminals.map((t) => ({
      type: t.type,
      title: t.title ?? "",
      command: t.command ?? "",
      initialPrompt: t.initialPrompt ?? "",
      args: t.args ?? "",
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
  defaultScope?: "global" | "project";
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

const FAILURE_PRESERVE_CAPTION = "Failures always preserve terminal for debugging";

export function RecipeEditor({
  recipe,
  initialTerminals,
  worktreeId,
  defaultScope,
  isOpen,
  onClose,
  onSave,
}: RecipeEditorProps) {
  const createRecipe = useRecipeStore((state) => state.createRecipe);
  const updateRecipe = useRecipeStore((state) => state.updateRecipe);
  const currentProject = useProjectStore((state) => state.currentProject);
  // With no project open only Global can be saved, so a new recipe starts there
  // and Project is shown but unavailable — the same rule as the import dialog.
  const hasProject = !!currentProject?.id;
  const newRecipeScope = hasProject ? (defaultScope ?? "project") : "global";

  const [recipeName, setRecipeName] = useState("");
  const [terminals, setTerminals] = useState<RecipeTerminal[]>([
    { type: "terminal", title: "", command: "", env: {} },
  ]);
  const [showInEmptyState, setShowInEmptyState] = useState(false);
  const [autoAssign, setAutoAssign] = useState<"always" | "never" | "prompt">("always");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by a save attempted with no name; from then the name field is judged
  // live, so its error clears the moment a name is typed.
  const [nameAttempted, setNameAttempted] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // Cards are keyed by identity, not position: with index keys, removing a card
  // hands the next card's DOM — and the focus inside it — to a different terminal.
  const nextCardKeyRef = useRef(0);
  const freshCardKeys = (count: number) =>
    Array.from({ length: count }, () => nextCardKeyRef.current++);
  const [cardKeys, setCardKeys] = useState<number[]>(() => freshCardKeys(1));
  // Where focus goes once an add or remove has rendered.
  const pendingFocusIdRef = useRef<string | null>(null);
  const initialStateRef = useRef<string>("");
  const nameMissing = nameAttempted && !recipeName.trim();

  useEffect(() => {
    const id = pendingFocusIdRef.current;
    if (!id) return;
    pendingFocusIdRef.current = null;
    const target = document.getElementById(id);
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }, [terminals.length]);

  // The banner sits below every card, and the body may be scrolled anywhere
  // when Save is pressed from the footer.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  useEffect(() => {
    if (!isOpen) return;
    if (recipe) {
      const nextTerminals = recipe.terminals.map(cloneTerminal);
      const nextShowInEmptyState = recipe.showInEmptyState ?? false;
      const nextAutoAssign = recipe.autoAssign ?? "always";
      setRecipeName(recipe.name);
      setTerminals(nextTerminals);
      setCardKeys(freshCardKeys(nextTerminals.length));
      setShowInEmptyState(nextShowInEmptyState);
      setAutoAssign(nextAutoAssign);
      setScope(isInRepoRecipeId(recipe) || recipe.projectId !== undefined ? "project" : "global");
      initialStateRef.current = serializeEditorState(
        recipe.name,
        nextTerminals,
        nextShowInEmptyState,
        nextAutoAssign
      );
    } else if (initialTerminals && initialTerminals.length > 0) {
      const nextTerminals = initialTerminals.map(cloneTerminal);
      setRecipeName("");
      setTerminals(nextTerminals);
      setCardKeys(freshCardKeys(nextTerminals.length));
      setShowInEmptyState(false);
      setAutoAssign("always");
      setScope(newRecipeScope);
      initialStateRef.current = serializeEditorState("", nextTerminals, false, "always");
    } else {
      const nextTerminals: RecipeTerminal[] = [
        { type: "terminal", title: "", command: "", env: {} },
      ];
      setRecipeName("");
      setTerminals(nextTerminals);
      setCardKeys(freshCardKeys(nextTerminals.length));
      setShowInEmptyState(false);
      setAutoAssign("always");
      setScope(newRecipeScope);
      initialStateRef.current = serializeEditorState("", nextTerminals, false, "always");
    }
    setError(null);
    setNameAttempted(false);
  }, [recipe, initialTerminals, newRecipeScope, isOpen]);

  const isDirty = useMemo(
    () =>
      serializeEditorState(recipeName, terminals, showInEmptyState, autoAssign) !==
      initialStateRef.current,
    [recipeName, terminals, showInEmptyState, autoAssign]
  );

  const { onBeforeClose, isConfirmOpen, closeConfirm } = useUnsavedChanges({ isDirty });

  const handleCancel = useCallback(() => {
    if (onBeforeClose()) onClose();
  }, [onBeforeClose, onClose]);

  const handleDiscard = useCallback(() => {
    closeConfirm();
    onClose();
  }, [closeConfirm, onClose]);

  const handleAddTerminal = () => {
    if (terminals.length >= MAX_TERMINALS_PER_RECIPE) {
      setError(`Maximum of ${MAX_TERMINALS_PER_RECIPE} terminals per recipe`);
      return;
    }
    setTerminals([...terminals, { type: "terminal", title: "", command: "", env: {} }]);
    setCardKeys([...cardKeys, ...freshCardKeys(1)]);
    pendingFocusIdRef.current = `terminal-type-${terminals.length}`;
  };

  const handleRemoveTerminal = (index: number) => {
    if (terminals.length === 1) {
      setError("Recipe must contain at least one terminal");
      return;
    }
    setTerminals(terminals.filter((_, i) => i !== index));
    setCardKeys(cardKeys.filter((_, i) => i !== index));
    // The card that slid into this slot, or the new last one.
    pendingFocusIdRef.current = `terminal-type-${Math.min(index, terminals.length - 2)}`;
  };

  const handleTerminalChange = (
    index: number,
    field: keyof RecipeTerminal,
    value: string | Record<string, string>
  ) => {
    const newTerminals = [...terminals];
    const current = newTerminals[index];
    if (!current) return;
    newTerminals[index] = { ...current, [field]: value };
    setTerminals(newTerminals);
  };

  const handleTypeChange = (index: number, newType: RecipeTerminalType) => {
    setTerminals((prev) => {
      const updated = [...prev];
      const current = updated[index];
      if (!current) return prev;
      const prevType = current.type;
      updated[index] = {
        ...current,
        type: newType,
        // Clear command when switching between types so the new type uses its default
        command: newType === prevType ? current.command : "",
        // Clear initialPrompt and args when switching to terminal or dev-preview
        initialPrompt:
          newType === "terminal" || newType === "dev-preview" ? "" : current.initialPrompt,
        args: newType === "terminal" || newType === "dev-preview" ? "" : current.args,
        // Clear devCommand when switching away from dev-preview
        devCommand: newType !== "dev-preview" ? "" : current.devCommand,
      };
      return updated;
    });
  };

  const handleSave = async () => {
    setError(null);

    if (!recipeName.trim()) {
      // `FieldError` is not a live region; a rejected save is a discrete event
      // the user caused, so it is announced once here instead.
      useAnnouncerStore.getState().announce("Name the recipe to save it", "assertive");
      setNameAttempted(true);
      nameInputRef.current?.focus();
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
          autoAssign,
        });
      } else {
        const isGlobal = scope === "global";
        if (!isGlobal && !currentProject?.id) {
          throw new Error("No project selected");
        }
        const targetProjectId = isGlobal ? undefined : currentProject!.id;
        await createRecipe(
          targetProjectId,
          recipeName,
          isGlobal ? undefined : worktreeId,
          terminals,
          showInEmptyState,
          autoAssign
        );
      }

      if (onSave) {
        const savedRecipe: TerminalRecipe = recipe
          ? { ...recipe, name: recipeName, terminals }
          : {
              id: `recipe-${crypto.randomUUID()}`,
              name: recipeName,
              projectId: scope === "global" ? undefined : currentProject!.id,
              worktreeId: scope === "global" ? undefined : worktreeId,
              terminals,
              createdAt: Date.now(),
            };
        onSave(savedRecipe);
      }

      onClose();
    } catch (error) {
      setError(formatErrorMessage(error, "Failed to save recipe"));
    } finally {
      setIsSaving(false);
    }
  };

  const recipeDisplayName = (recipe?.name ?? recipeName).trim();

  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (!isEnterToSubmit(event)) return;
    event.preventDefault();
    if (!isSaving) void handleSave();
  };

  const hint = (id: string, children: React.ReactNode) => (
    <p id={id} className="text-xs text-text-secondary select-text">
      {children}
    </p>
  );

  const exitBehaviorRow = (
    index: number,
    terminal: RecipeTerminal,
    idPrefix: string,
    defaultValue: "trash" | "keep"
  ) => {
    const id = `${idPrefix}-${index}`;
    const helpId = `${idPrefix}-help-${index}`;
    const options: Array<["trash" | "keep" | "remove", string]> = [
      ["trash", "Send to trash"],
      ["keep", "Keep for review"],
      ["remove", "Remove completely"],
    ];
    const ordered = [
      ...options.filter(([value]) => value === defaultValue),
      ...options.filter(([value]) => value !== defaultValue),
    ];
    return (
      <FormRow label="After exit" htmlFor={id} hint={hint(helpId, FAILURE_PRESERVE_CAPTION)}>
        <select
          id={id}
          value={terminal.exitBehavior || defaultValue}
          onChange={(e) =>
            handleTerminalChange(
              index,
              "exitBehavior",
              e.target.value === defaultValue ? "" : e.target.value
            )
          }
          aria-describedby={helpId}
          className={cn(FIELD_INPUT, "pr-8")}
        >
          {ordered.map(([value, label]) => (
            <option key={value} value={value}>
              {value === defaultValue ? `${label} (default)` : label}
            </option>
          ))}
        </select>
      </FormRow>
    );
  };

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={onClose}
        onBeforeClose={onBeforeClose}
        size="lg"
        dismissible={!isSaving}
      >
        <AppDialog.Header>
          <AppDialog.Title>{recipe ? "Edit recipe" : "Create recipe"}</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>

        <AppDialog.Body>
          <FormGrid>
            {/* Top-aligned so the label stays on the field's line when the
                error below it appears, instead of re-centring on both. */}
            <FormRow label="Recipe name" htmlFor="recipe-name" labelClassName="self-start pt-2">
              <Field controlId="recipe-name">
                <Input
                  ref={nameInputRef}
                  type="text"
                  value={recipeName}
                  onChange={(e) => setRecipeName(e.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder="e.g., Full Stack Dev"
                  className="h-8 px-2.5 py-0"
                />
                {nameMissing && <FieldError>Name the recipe to save it</FieldError>}
              </Field>
            </FormRow>

            {/* No `for` when editing: scope is then a read-only display with no
                control to name, and `output` — the one labelable element that
                fits — is a live region, which would announce static text. */}
            <FormRow label="Scope" htmlFor={recipe ? undefined : "recipe-scope"}>
              {recipe ? (
                <div
                  className={cn(
                    FIELD_SURFACE,
                    "flex h-8 items-center px-2.5 text-sm text-text-primary opacity-75"
                  )}
                >
                  {isInRepoRecipeId(recipe) || recipe.projectId !== undefined
                    ? "Project"
                    : "Global (all projects)"}
                </div>
              ) : (
                <select
                  id="recipe-scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as "global" | "project")}
                  className={cn(FIELD_INPUT, "pr-8")}
                >
                  <option value="project" disabled={!hasProject}>
                    Project (current project only)
                  </option>
                  <option value="global">Global (all projects)</option>
                </select>
              )}
            </FormRow>

            <FormRow
              label="Pin to canvas"
              htmlFor="show-in-empty-state"
              hint={hint(
                "show-in-empty-state-help",
                "List this recipe first on the canvas when a worktree has no open terminals"
              )}
            >
              <Checkbox
                id="show-in-empty-state"
                checked={showInEmptyState}
                onCheckedChange={(checked) => setShowInEmptyState(checked === true)}
                aria-describedby="show-in-empty-state-help"
              />
            </FormRow>

            <FormRow
              label="Auto-assign issue"
              htmlFor="auto-assign"
              hint={hint(
                "auto-assign-help",
                "Controls whether the linked GitHub issue is automatically assigned to you during quick worktree creation"
              )}
            >
              <select
                id="auto-assign"
                value={autoAssign}
                onChange={(e) => setAutoAssign(e.target.value as "always" | "never" | "prompt")}
                aria-describedby="auto-assign-help"
                className={cn(FIELD_INPUT, "pr-8")}
              >
                <option value="always">Always assign to me</option>
                <option value="prompt">Ask before assigning</option>
                <option value="never">Never assign</option>
              </select>
            </FormRow>

            <FormSection
              title={`Terminals (${terminals.length}/${MAX_TERMINALS_PER_RECIPE})`}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddTerminal}
                  disabled={terminals.length >= MAX_TERMINALS_PER_RECIPE}
                >
                  <Plus />
                  Add terminal
                </Button>
              }
            >
              {/* Each card is a subgrid of the form, so its fields sit on the
                  same label rail as the recipe's own rows rather than a second
                  layout of stacked labels. */}
              <div className="col-span-2 grid grid-cols-subgrid gap-y-3">
                {terminals.map((terminal, index) => {
                  const headingId = `terminal-heading-${index}`;
                  const isAgent = terminal.type !== "terminal" && terminal.type !== "dev-preview";
                  return (
                    <div
                      key={cardKeys[index] ?? `index-${index}`}
                      role="group"
                      aria-labelledby={headingId}
                      className="col-span-2 grid grid-cols-subgrid items-center gap-y-3 rounded-[var(--radius-md)] border border-border-default bg-surface-canvas p-3"
                    >
                      <div className="col-span-2 -my-0.5 flex items-center justify-between gap-3">
                        <h4 id={headingId} className="text-xs font-medium text-text-primary">
                          Terminal {index + 1}
                        </h4>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost-danger"
                              size="icon-sm"
                              onClick={() => handleRemoveTerminal(index)}
                              disabled={terminals.length === 1}
                              aria-label={`Remove terminal ${index + 1}`}
                            >
                              <Trash2 />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Remove terminal</TooltipContent>
                        </Tooltip>
                      </div>

                      <FormRow label="Type" htmlFor={`terminal-type-${index}`}>
                        <select
                          id={`terminal-type-${index}`}
                          value={terminal.type}
                          onChange={(e) =>
                            handleTypeChange(index, e.target.value as RecipeTerminalType)
                          }
                          className={cn(FIELD_INPUT, "pr-8")}
                        >
                          {TERMINAL_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {TYPE_LABELS[type]}
                            </option>
                          ))}
                        </select>
                      </FormRow>

                      <FormRow label="Title" htmlFor={`terminal-title-${index}`}>
                        <input
                          id={`terminal-title-${index}`}
                          type="text"
                          value={terminal.title || ""}
                          onChange={(e) => handleTerminalChange(index, "title", e.target.value)}
                          onKeyDown={submitOnEnter}
                          placeholder="Default"
                          className={FIELD_INPUT}
                        />
                      </FormRow>

                      {terminal.type === "terminal" && (
                        <>
                          <FormRow label="Command" htmlFor={`terminal-command-${index}`}>
                            <input
                              id={`terminal-command-${index}`}
                              type="text"
                              value={terminal.command || ""}
                              onChange={(e) =>
                                handleTerminalChange(index, "command", e.target.value)
                              }
                              onKeyDown={submitOnEnter}
                              placeholder="e.g., npm run dev"
                              className={FIELD_INPUT}
                            />
                          </FormRow>
                          {exitBehaviorRow(index, terminal, "terminal-exit-behavior", "trash")}
                        </>
                      )}

                      {isAgent && (
                        <>
                          <FormRow
                            label="Arguments"
                            htmlFor={`terminal-args-${index}`}
                            hint={hint(
                              `terminal-args-help-${index}`,
                              "Additional CLI arguments passed to the agent at launch"
                            )}
                          >
                            <input
                              id={`terminal-args-${index}`}
                              type="text"
                              value={terminal.args || ""}
                              onChange={(e) => handleTerminalChange(index, "args", e.target.value)}
                              onKeyDown={submitOnEnter}
                              placeholder="e.g., --model claude-opus-4-5"
                              aria-describedby={`terminal-args-help-${index}`}
                              className={FIELD_INPUT}
                            />
                          </FormRow>
                          <FormRow
                            label="Initial prompt"
                            htmlFor={`terminal-initial-prompt-${index}`}
                            labelClassName="self-start pt-2"
                            hint={hint(
                              `terminal-initial-prompt-help-${index}`,
                              <>
                                Variables: <code>{"{{issue_number}}"}</code>,{" "}
                                <code>{"{{pr_number}}"}</code>, <code>{"{{number}}"}</code>,{" "}
                                <code>{"{{worktree_path}}"}</code>, <code>{"{{branch_name}}"}</code>
                              </>
                            )}
                          >
                            <Textarea
                              id={`terminal-initial-prompt-${index}`}
                              value={terminal.initialPrompt || ""}
                              onChange={(e) =>
                                handleTerminalChange(index, "initialPrompt", e.target.value)
                              }
                              placeholder="e.g., Review the latest changes and suggest improvements"
                              rows={2}
                              density="compact"
                              aria-describedby={`terminal-initial-prompt-help-${index}`}
                              className="min-h-[60px] max-h-60 field-sizing-content"
                            />
                            <RecipeVariablePreview
                              initialPrompt={terminal.initialPrompt || ""}
                              worktreeId={worktreeId ?? recipe?.worktreeId}
                            />
                          </FormRow>
                          {exitBehaviorRow(index, terminal, "terminal-agent-exit-behavior", "keep")}
                        </>
                      )}

                      {terminal.type === "dev-preview" && (
                        <>
                          <FormRow
                            label="Dev command"
                            htmlFor={`terminal-dev-command-${index}`}
                            hint={hint(
                              `terminal-dev-command-help-${index}`,
                              "Leave empty to use project default or auto-detect from package.json"
                            )}
                          >
                            <input
                              id={`terminal-dev-command-${index}`}
                              type="text"
                              value={terminal.devCommand || ""}
                              onChange={(e) =>
                                handleTerminalChange(index, "devCommand", e.target.value)
                              }
                              onKeyDown={submitOnEnter}
                              placeholder="e.g., npm run dev"
                              aria-describedby={`terminal-dev-command-help-${index}`}
                              className={FIELD_INPUT}
                            />
                          </FormRow>
                          {exitBehaviorRow(index, terminal, "terminal-dev-exit-behavior", "trash")}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </FormSection>
          </FormGrid>

          {error && (
            // The scroll margin clears the body's bottom padding and edge fade, so
            // scrolling the banner into view leaves it readable.
            <div ref={errorRef} className="mt-6 scroll-mb-6">
              <InlineStatusBanner
                severity="error"
                title={recipe ? "Couldn't update the recipe" : "Couldn't create the recipe"}
                description={error}
                className="rounded-[var(--radius-md)]"
              />
            </div>
          )}
        </AppDialog.Body>

        <AppDialog.Footer
          secondaryAction={{ label: "Cancel", onClick: handleCancel, disabled: isSaving }}
          primaryAction={{
            label: recipe ? "Update recipe" : "Create recipe",
            onClick: () => void handleSave(),
            loading: isSaving,
          }}
        />
      </AppDialog>

      <ConfirmDialog
        isOpen={isConfirmOpen}
        onClose={closeConfirm}
        variant="destructive"
        zIndex="nested"
        title={
          recipeDisplayName ? `Discard changes to '${recipeDisplayName}'?` : "Discard changes?"
        }
        description="Your edits to this recipe won't be saved"
        confirmLabel="Discard changes"
        onConfirm={handleDiscard}
      />
    </>
  );
}
