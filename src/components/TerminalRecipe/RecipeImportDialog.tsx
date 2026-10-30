import { useEffect, useId, useState } from "react";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Field, FieldError } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { FIELD_CONTROL_SIZE, FormGrid, FormRow } from "@/components/Worktree/views";
import { GLOBAL_SCOPE_LABEL, PROJECT_SCOPE_LABEL, newRecipeScopeDetail } from "./recipeScopeCopy";
import { useRecipeStore } from "@/store/recipeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { pluralize, pluralNoun } from "@/lib/pluralize";
import {
  describeRejectedTerminal,
  isRecipeImportDropsTerminalsError,
  type RecipeImportDropsTerminalsError,
} from "@/utils/recipeImport";

const IMPORT_FAILED = "The recipe couldn't be imported";

interface RecipeImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The project a "Project" import lands in; without one only Global can succeed. */
  projectId: string | undefined;
  /**
   * A file import that was refused, opened here with its JSON and what went
   * wrong, so the user can fix it in place or import what can be.
   */
  refusedImport?: { json: string; error: unknown } | null;
  /** Where focus goes on close when the control that opened the dialog is gone. */
  restoreFocusTo?: RestoreFocusTarget;
}

/**
 * Paste-to-import for a recipe's JSON. One dialog for every place that offers
 * it — the recipe manager and the project settings tab used to carry their own
 * copies, which had drifted apart in fields, validation and how an error looked.
 */
export function RecipeImportDialog({
  isOpen,
  onClose,
  projectId,
  refusedImport,
  restoreFocusTo,
}: RecipeImportDialogProps) {
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
  // Terminals the last attempt would have dropped. Nothing is saved while this
  // stands; any edit clears it, so a confirmed import always matches what the
  // user reviewed (#15044).
  const [review, setReview] = useState<RecipeImportDropsTerminalsError | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const scopeId = useId();
  const scopeHelpId = useId();
  const jsonLabelId = useId();

  useEffect(() => {
    if (isOpen) return;
    setScope(defaultScope);
    setJson("");
    setJsonError(null);
    setImportError(null);
    setReview(null);
  }, [isOpen, defaultScope]);

  useEffect(() => {
    if (!isOpen || !refusedImport) return;
    setJson(refusedImport.json);
    if (isRecipeImportDropsTerminalsError(refusedImport.error)) {
      setReview(refusedImport.error);
    } else {
      setImportError(formatErrorMessage(refusedImport.error, IMPORT_FAILED));
    }
  }, [isOpen, refusedImport]);

  const canImportRest = review !== null && review.acceptedCount > 0;

  const handleImport = async () => {
    const allowDroppedTerminals = canImportRest;
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
      await importRecipe(
        scope === "global" ? undefined : projectId,
        json,
        allowDroppedTerminals ? { allowDroppedTerminals } : undefined
      );
      onClose();
    } catch (err) {
      if (isRecipeImportDropsTerminalsError(err)) {
        setReview(err);
      } else {
        setImportError(formatErrorMessage(err, IMPORT_FAILED));
      }
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      dismissible={!isImporting}
      restoreFocusTo={restoreFocusTo}
    >
      <AppDialog.Header>
        <AppDialog.Title>Import recipe</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <FormGrid>
          <FormRow
            label="Import as"
            htmlFor={scopeId}
            hint={
              <p id={scopeHelpId} className="text-xs text-text-secondary select-text">
                {newRecipeScopeDetail(scope)}
              </p>
            }
          >
            <Select
              value={scope}
              onValueChange={(value) => {
                setScope(value === "global" ? "global" : "project");
                setImportError(null);
                setReview(null);
              }}
              disabled={isImporting}
            >
              <SelectTrigger
                id={scopeId}
                className={FIELD_CONTROL_SIZE}
                aria-describedby={scopeHelpId}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project" disabled={!projectId}>
                  {PROJECT_SCOPE_LABEL}
                </SelectItem>
                <SelectItem value="global">{GLOBAL_SCOPE_LABEL}</SelectItem>
              </SelectContent>
            </Select>
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
              setReview(null);
            }}
            data-testid="recipe-import-textarea"
            readOnly={isImporting}
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

        {review && (
          <InlineStatusBanner
            severity={canImportRest ? "warning" : "error"}
            title={review.message}
            description={reviewDescription(review)}
            descriptionExtras={
              <ul className="mt-1.5 space-y-1 text-xs">
                {review.rejected.map((terminal) => {
                  const { label, reason } = describeRejectedTerminal(terminal);
                  return (
                    <li key={terminal.index} className="break-words">
                      <span className="font-medium text-text-primary">{label}</span>
                      <span className="text-text-secondary"> — {reason}</span>
                    </li>
                  );
                })}
              </ul>
            }
            className="mt-4 rounded-[var(--radius-md)]"
          />
        )}

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
          label: canImportRest
            ? `Import ${pluralize(review.acceptedCount, "terminal")}`
            : "Import recipe",
          onClick: () => void handleImport(),
          disabled: !json.trim(),
          loading: isImporting,
        }}
      />
    </AppDialog>
  );
}

function reviewDescription(review: RecipeImportDropsTerminalsError): string {
  const them = pluralNoun(review.rejected.length, "it", "them");
  if (review.acceptedCount === 0) return `Fix ${them} in the JSON, then import again.`;
  return `Nothing has been saved. Fix ${them} in the JSON, or import the other ${pluralize(review.acceptedCount, "terminal")} without ${them}.`;
}
