import { useEffect, useId, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Field, FieldError } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { FIELD_INPUT, FormGrid, FormRow } from "@/components/Worktree/views";
import { useRecipeStore } from "@/store/recipeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { cn } from "@/lib/utils";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface RecipeImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The project a "Project" import lands in; without one only Global can succeed. */
  projectId: string | undefined;
}

/**
 * Paste-to-import for a recipe's JSON. One dialog for every place that offers
 * it — the recipe manager and the project settings tab used to carry their own
 * copies, which had drifted apart in fields, validation and how an error looked.
 */
export function RecipeImportDialog({ isOpen, onClose, projectId }: RecipeImportDialogProps) {
  const importRecipe = useRecipeStore((s) => s.importRecipe);
  // With no project open only Global can succeed, so it is the starting choice
  // and Project is offered but unavailable rather than failing on submit.
  const defaultScope = projectId ? "project" : "global";
  const [scope, setScope] = useState<"global" | "project">(defaultScope);
  const [json, setJson] = useState("");
  // What is wrong with the pasted text belongs on the field; a store that
  // refused a well-formed recipe is a failed operation, reported as one.
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const scopeId = useId();
  const jsonLabelId = useId();

  useEffect(() => {
    if (isOpen) return;
    setScope(defaultScope);
    setJson("");
    setJsonError(null);
    setImportError(null);
  }, [isOpen, defaultScope]);

  const handleImport = async () => {
    setJsonError(null);
    setImportError(null);
    try {
      JSON.parse(json);
    } catch (err) {
      // The engine's own message carries the position ("at position 35 (line 1
      // column 36)"), which is what the user needs to find the mistake.
      const message = `That isn't valid JSON: ${formatErrorMessage(err, "parse failed")}`;
      // `FieldError` is not a live region; a rejected import is a discrete event
      // the user caused, so it is announced once here instead.
      useAnnouncerStore.getState().announce(message, "assertive");
      setJsonError(message);
      return;
    }
    setIsImporting(true);
    try {
      await importRecipe(scope === "global" ? undefined : projectId, json);
      onClose();
    } catch (err) {
      setImportError(formatErrorMessage(err, "The recipe couldn't be imported"));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" dismissible={!isImporting}>
      <AppDialog.Header>
        <AppDialog.Title>Import recipe</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <FormGrid>
          <FormRow label="Import as" htmlFor={scopeId}>
            <select
              id={scopeId}
              value={scope}
              onChange={(e) => {
                setScope(e.target.value === "global" ? "global" : "project");
                setImportError(null);
              }}
              className={cn(FIELD_INPUT, "pr-8")}
            >
              <option value="project" disabled={!projectId}>
                Project (current project only)
              </option>
              <option value="global">Global (all projects)</option>
            </select>
          </FormRow>
        </FormGrid>

        {/* Off the rail deliberately: pasted recipe JSON needs the dialog's
            full width more than it needs a label column. */}
        <Field className="mt-4">
          <p id={jsonLabelId} className="text-xs text-text-secondary">
            Paste the JSON configuration for the recipe you want to import
          </p>
          <Textarea
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              setJsonError(null);
              setImportError(null);
            }}
            data-testid="recipe-import-textarea"
            aria-labelledby={jsonLabelId}
            placeholder='{"name": "My Recipe", "terminals": [...]}'
            variant="code"
            density="compact"
            resize="none"
            className="h-48"
            spellCheck={false}
          />
          {jsonError && <FieldError>{jsonError}</FieldError>}
        </Field>

        {importError && (
          <InlineStatusBanner
            severity="error"
            title="Couldn't import the recipe"
            description={importError}
            className="mt-4 rounded-[var(--radius-md)]"
          />
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: isImporting }}
        primaryAction={{
          label: "Import recipe",
          onClick: () => void handleImport(),
          disabled: !json.trim(),
          loading: isImporting,
        }}
      />
    </AppDialog>
  );
}
