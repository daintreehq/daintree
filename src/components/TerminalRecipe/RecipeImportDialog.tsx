import { useEffect, useId, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Field, FieldError } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
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
  const [scope, setScope] = useState<"global" | "project">("project");
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const scopeId = useId();
  const jsonLabelId = useId();

  useEffect(() => {
    if (isOpen) return;
    setScope("project");
    setJson("");
    setError(null);
  }, [isOpen]);

  const fail = (message: string) => {
    // `FieldError` is not a live region; a rejected import is a discrete event
    // the user caused, so it is announced once here instead.
    useAnnouncerStore.getState().announce(message, "assertive");
    setError(message);
  };

  const handleImport = async () => {
    setError(null);
    const targetProjectId = scope === "global" ? undefined : projectId;
    if (scope === "project" && !targetProjectId) {
      fail("No project is open. Import it as a global recipe instead.");
      return;
    }
    try {
      JSON.parse(json);
    } catch (err) {
      // The engine's own message carries the position ("at position 35 (line 1
      // column 36)"), which is what the user needs to find the mistake.
      fail(`That isn't valid JSON: ${formatErrorMessage(err, "parse failed")}`);
      return;
    }
    setIsImporting(true);
    try {
      await importRecipe(targetProjectId, json);
      onClose();
    } catch (err) {
      fail(formatErrorMessage(err, "Couldn't import the recipe"));
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
                setScope(e.target.value as "global" | "project");
                setError(null);
              }}
              className={cn(FIELD_INPUT, "pr-8")}
            >
              <option value="project">Project (current project only)</option>
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
              setError(null);
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
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: isImporting }}
        primaryAction={{
          label: "Import",
          onClick: () => void handleImport(),
          disabled: !json.trim(),
          loading: isImporting,
        }}
      />
    </AppDialog>
  );
}
