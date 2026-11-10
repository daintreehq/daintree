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
import { recipeTerminalLabel } from "@/components/Terminal/utils/recipeUtils";
import { describeTerminal } from "./recipeConfirmPreview";
import { GLOBAL_SCOPE_LABEL, PROJECT_SCOPE_LABEL, newRecipeScopeDetail } from "./recipeScopeCopy";
import { useRecipeStore } from "@/store/recipeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { pluralize, pluralNoun } from "@/lib/pluralize";
import type { TerminalRecipe } from "@/types";
import {
  describeRejectedTerminal,
  isRecipeImportDropsTerminalsError,
  isRecipeImportInvalidError,
  previewRecipeImport,
  type RecipeFileImport,
  type RecipeImportDropsTerminalsError,
  type RecipeImportInvalidError,
  type RecipeImportPreview,
} from "@/utils/recipeImport";

const IMPORT_FAILED = "The recipe couldn't be imported";

interface RecipeImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The project a "Team" import lands in; without one only Global can succeed. */
  projectId: string | undefined;
  /**
   * A picked file: one to confirm before anything is saved, or one the import
   * refused, opened with its JSON and what went wrong so it can be fixed here.
   */
  fileImport?: RecipeFileImport | null;
  /** The saved recipe, reported before the dialog closes. */
  onImported?: (recipe: TerminalRecipe) => void;
  /** Where focus goes on close when the control that opened the dialog is gone. */
  restoreFocusTo?: RestoreFocusTarget;
  /** Try {@link restoreFocusTo} before the control that opened the dialog. */
  preferRestoreFocusTo?: boolean;
}

/** The parser's own message carries the position, which is what finds the mistake. */
function jsonParseError(json: string): string | null {
  try {
    JSON.parse(json);
    return null;
  } catch (err) {
    return `That isn't valid JSON: ${formatErrorMessage(err, "parse failed")}`;
  }
}

/**
 * Import for a recipe's JSON, pasted or from a file. One dialog for every place
 * that offers it — the recipe manager and the project settings tab used to carry
 * their own copies, which had drifted apart in fields, validation and how an
 * error looked.
 */
export function RecipeImportDialog({
  isOpen,
  onClose,
  projectId,
  fileImport,
  onImported,
  restoreFocusTo,
  preferRestoreFocusTo,
}: RecipeImportDialogProps) {
  const importRecipe = useRecipeStore((s) => s.importRecipe);
  // With no project open only Global can succeed, so it is the starting choice
  // and Team is offered but unavailable rather than failing on submit.
  const defaultScope = projectId ? "project" : "global";
  const [scope, setScope] = useState<"global" | "project">(defaultScope);
  const [json, setJson] = useState("");
  // What is wrong with the text belongs on the field; a store that refused a
  // well-formed recipe is a failed operation, reported as one.
  const [jsonError, setJsonError] = useState<string | null>(null);
  // JSON that can't become a recipe in either scope. It stands until the JSON
  // changes, and so does the import it blocks.
  const [invalid, setInvalid] = useState<RecipeImportInvalidError | null>(null);
  // A save that failed. Trying again, or in the other scope, may work.
  const [importError, setImportError] = useState<string | null>(null);
  // Terminals the last attempt would have dropped. Nothing is saved while this
  // stands; any edit clears it, so a confirmed import always matches what the
  // user reviewed (#15044).
  const [review, setReview] = useState<RecipeImportDropsTerminalsError | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const scopeId = useId();
  const scopeHelpId = useId();
  const jsonLabelId = useId();
  const statusId = useId();

  useEffect(() => {
    if (isOpen) return;
    setScope(defaultScope);
    setJson("");
    setJsonError(null);
    setInvalid(null);
    setImportError(null);
    setReview(null);
  }, [isOpen, defaultScope]);

  useEffect(() => {
    if (!isOpen || !fileImport) return;
    setJson(fileImport.json);
    if (fileImport.status !== "refused") return;
    const { error } = fileImport;
    if (isRecipeImportDropsTerminalsError(error)) {
      setReview(error);
    } else if (isRecipeImportInvalidError(error)) {
      // A file that isn't JSON at all is marked on the field with where it
      // broke, the same as a paste.
      const parseError = fileImport.json.trim() ? jsonParseError(fileImport.json) : null;
      if (parseError) setJsonError(parseError);
      else setInvalid(error);
    } else {
      setImportError(formatErrorMessage(error, IMPORT_FAILED));
    }
  }, [isOpen, fileImport]);

  const canImportRest = review !== null && review.acceptedCount > 0;
  // Content the import has already refused can't succeed until it changes, so
  // the import waits for an edit rather than repeating the refusal.
  const contentRefused =
    jsonError !== null || invalid !== null || (review !== null && review.acceptedCount === 0);
  // A clean file is shown as what it would save; the JSON only matters once
  // there is something in it to fix.
  const preview =
    fileImport?.status === "ready" && review === null && invalid === null
      ? fileImport.recipe
      : null;
  // While the JSON is open, what the import would save from it as it stands:
  // the surviving terminals while a review offers to import the rest, the whole
  // recipe once the JSON is one. It follows every edit, so a repaired file is
  // confirmed the way a clean one is, and sits under the field so the field
  // never moves while it is typed in.
  const draftPreview =
    preview || !json.trim() || jsonError !== null
      ? null
      : previewRecipeImport(json, canImportRest ? { allowDroppedTerminals: true } : undefined);
  const draftTotal =
    draftPreview && canImportRest
      ? draftPreview.terminals.length + review.rejected.length
      : undefined;
  const hasContentStatus = invalid !== null || review !== null;

  const handleImport = async () => {
    const allowDroppedTerminals = canImportRest;
    setJsonError(null);
    setImportError(null);
    const parseError = jsonParseError(json);
    if (parseError) {
      // `FieldError` is not a live region; a rejected import is a discrete event
      // the user caused, so it is announced once here instead.
      useAnnouncerStore.getState().announce(parseError, "assertive");
      setJsonError(parseError);
      return;
    }
    setIsImporting(true);
    try {
      const saved = await importRecipe(
        scope === "global" ? undefined : projectId,
        json,
        allowDroppedTerminals ? { allowDroppedTerminals } : undefined
      );
      onImported?.(saved);
      onClose();
    } catch (err) {
      if (isRecipeImportDropsTerminalsError(err)) {
        setReview(err);
      } else if (isRecipeImportInvalidError(err)) {
        setInvalid(err);
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
      preferRestoreFocusTo={preferRestoreFocusTo}
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
                // What the JSON can't do is the same in either scope, so a
                // refusal and its review stay; only a failed save might go
                // differently.
                setImportError(null);
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
          {fileImport && (
            <FormRow label="File">
              <p className="break-all text-sm text-text-primary select-text">
                {fileImport.fileName}
              </p>
            </FormRow>
          )}
          {preview && (
            <FormRow label="Recipe" labelClassName="self-start pt-0.5">
              <RecipeImportSummary recipe={preview} />
            </FormRow>
          )}
        </FormGrid>

        {/* Ahead of the JSON it explains: it is why the JSON is showing. */}
        {hasContentStatus && (
          <div id={statusId}>
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
            {invalid && (
              <InlineStatusBanner
                severity="error"
                title={invalid.title}
                description={invalid.detail}
                className="mt-4 rounded-[var(--radius-md)]"
              />
            )}
          </div>
        )}

        {importError && (
          <InlineStatusBanner
            severity="error"
            title="Couldn't import the recipe"
            description={importError}
            className="mt-4 rounded-[var(--radius-md)]"
          />
        )}

        {!preview && (
          // Off the rail deliberately: recipe JSON needs the dialog's full
          // width more than it needs a label column.
          <Field className="mt-4">
            <p id={jsonLabelId} className="text-xs text-text-secondary">
              {fileImport
                ? "JSON from the selected file"
                : "Paste the JSON configuration for the recipe you want to import"}
            </p>
            <Textarea
              value={json}
              onChange={(e) => {
                setJson(e.target.value);
                setJsonError(null);
                setInvalid(null);
                setImportError(null);
                setReview(null);
              }}
              data-testid="recipe-import-textarea"
              readOnly={isImporting}
              aria-labelledby={jsonLabelId}
              aria-describedby={hasContentStatus ? statusId : undefined}
              placeholder='{"name": "My Recipe", "terminals": [...]}'
              variant="code"
              density="compact"
              resize="none"
              className="h-48"
              spellCheck={false}
            />
            {jsonError && <FieldError>{jsonError}</FieldError>}
          </Field>
        )}

        {draftPreview && (
          <div className="mt-4">
            <FormGrid>
              <FormRow label="Recipe" labelClassName="self-start pt-0.5">
                <RecipeImportSummary recipe={draftPreview} totalTerminals={draftTotal} />
              </FormRow>
            </FormGrid>
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{ label: "Cancel", onClick: onClose, disabled: isImporting }}
        primaryAction={{
          // A failed save is retried from here, worded the way the manager's own
          // confirms word theirs ("Retry delete", "Retry save").
          label: importError
            ? "Retry import"
            : canImportRest
              ? `Import ${pluralize(review.acceptedCount, "terminal")}`
              : "Import recipe",
          onClick: () => void handleImport(),
          disabled: !json.trim() || contentRefused,
          loading: isImporting,
        }}
      />
    </AppDialog>
  );
}

/**
 * What an import would save, terminal by terminal, in the words the recipe
 * manager and the run confirmation use, so nothing in it is a surprise later.
 * Commands and prompts are shown whole: this is the one look at them before
 * they can run. Env values stay hidden, as everywhere a recipe is previewed.
 */
function RecipeImportSummary({
  recipe,
  totalTerminals,
}: {
  recipe: RecipeImportPreview;
  /** The file's own count, when some of its terminals are being left out. */
  totalTerminals?: number;
}) {
  const kept = recipe.terminals.length;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-medium text-text-primary select-text">
          {recipe.name}
        </p>
        <span className="shrink-0 text-xs text-text-secondary">
          {totalTerminals !== undefined && totalTerminals !== kept
            ? `${kept} of ${pluralize(totalTerminals, "terminal")}`
            : pluralize(kept, "terminal")}
        </span>
      </div>
      <ol className="mt-2 divide-y divide-border-default rounded-[var(--radius-md)] border border-border-default">
        {recipe.terminals.map((terminal, index) => (
          <li key={index} className="flex min-w-0 items-baseline gap-3 px-3 py-2 text-xs">
            <span className="w-1/3 min-w-0 shrink-0 break-words text-text-primary">
              {recipeTerminalLabel(terminal)}
            </span>
            <span className="min-w-0 flex-1 space-y-0.5 font-mono text-text-secondary select-text">
              {describeTerminal(terminal, { full: true }).map((line, lineIndex) => (
                <span key={lineIndex} className="block whitespace-pre-wrap break-words">
                  {line}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function reviewDescription(review: RecipeImportDropsTerminalsError): string {
  const them = pluralNoun(review.rejected.length, "it", "them");
  if (review.acceptedCount === 0) return `Fix ${them} in the JSON, then import again.`;
  return `Nothing has been saved. Fix ${them} in the JSON, or import the other ${pluralize(review.acceptedCount, "terminal")} without ${them}.`;
}
