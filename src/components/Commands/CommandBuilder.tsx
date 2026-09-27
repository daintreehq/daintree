import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import type {
  CommandManifestEntry,
  CommandContext,
  CommandResult,
  BuilderStep,
  BuilderField,
} from "@shared/types/commands";
import { Check, ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import {
  FIELD_FOCUS,
  FIELD_INPUT,
  FIELD_SURFACE,
  FormGrid,
  FormRow,
} from "@/components/Worktree/views/WorktreeFormLayout";

interface CommandBuilderProps {
  command: CommandManifestEntry;
  steps: BuilderStep[];
  context: CommandContext;
  isExecuting: boolean;
  executionError: string | null;
  onExecute: (args: Record<string, unknown>) => Promise<CommandResult>;
  onCancel: () => void;
}

interface FieldErrors {
  [fieldName: string]: string;
}

function validateField(field: BuilderField, value: unknown): string | null {
  // Fields are optional unless the manifest says its handler rejects a blank.
  // Treat whitespace-only input as empty
  const stringValue = typeof value === "string" ? value.trim() : value;
  if (stringValue === undefined || stringValue === null || stringValue === "") {
    return field.required ? "Required to run this command" : null;
  }

  const validation = field.validation;
  if (!validation) return null;

  if (field.type === "text" || field.type === "textarea") {
    const strValue = String(stringValue);
    // Only validate min/max if value is provided
    if (validation.min !== undefined && strValue.length < validation.min) {
      return validation.message ?? `Minimum ${validation.min} characters required`;
    }
    if (validation.max !== undefined && strValue.length > validation.max) {
      return validation.message ?? `Maximum ${validation.max} characters allowed`;
    }
    if (validation.pattern) {
      try {
        const regex = new RegExp(validation.pattern);
        if (!regex.test(strValue)) {
          return validation.message ?? "Invalid format";
        }
      } catch {
        return "Invalid format";
      }
    }
  }

  if (field.type === "number") {
    const numValue = Number(stringValue);
    if (isNaN(numValue)) {
      return "Must be a valid number";
    }
    if (validation.integer && !Number.isInteger(numValue)) {
      return validation.message ?? "Must be a whole number";
    }
    if (validation.min !== undefined && numValue < validation.min) {
      return validation.message ?? `Minimum value is ${validation.min}`;
    }
    if (validation.max !== undefined && numValue > validation.max) {
      return validation.message ?? `Maximum value is ${validation.max}`;
    }
  }

  return null;
}

// Command labels come from a manifest we don't author, so the rail can't rely on
// them staying short: cap the cell rather than let one field's label set the
// column width for the whole step.
const BUILDER_LABEL = "max-w-48 break-words";

// A plain function, not a component: `FormRow` skips its hint row on a falsy
// hint, and an element is truthy even when it renders nothing.
function builderFieldHint({
  error,
  helpText,
  errorId,
  helpId,
}: {
  error?: string;
  helpText?: string;
  errorId: string;
  helpId: string;
}): React.ReactNode {
  if (error) {
    return (
      <p id={errorId} className="text-xs text-status-error flex items-center gap-1" role="alert">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        {error}
      </p>
    );
  }
  if (helpText) {
    return (
      <p id={helpId} className="text-xs text-text-secondary">
        {helpText}
      </p>
    );
  }
  return null;
}

function BuilderTextField({
  field,
  value,
  error,
  onChange,
}: {
  field: BuilderField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `field-${field.name}`;
  const errorId = `${inputId}-error`;
  const helpId = `${inputId}-help`;

  return (
    <FormRow
      label={field.label}
      htmlFor={inputId}
      labelClassName={BUILDER_LABEL}
      hint={builderFieldHint({ error, helpText: field.helpText, errorId, helpId })}
    >
      <input
        ref={inputRef}
        id={inputId}
        type={field.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        aria-describedby={error ? errorId : field.helpText ? helpId : undefined}
        aria-invalid={error ? "true" : undefined}
        className={cn(FIELD_INPUT, error && "border-status-error")}
      />
    </FormRow>
  );
}

function BuilderTextareaField({
  field,
  value,
  error,
  onChange,
}: {
  field: BuilderField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputId = `field-${field.name}`;
  const errorId = `${inputId}-error`;
  const helpId = `${inputId}-help`;

  return (
    <FormRow
      label={field.label}
      htmlFor={inputId}
      // The grid centres every cell; a four-row textarea would leave its label
      // floating halfway down the box.
      labelClassName={cn(BUILDER_LABEL, "self-start pt-2")}
      hint={builderFieldHint({ error, helpText: field.helpText, errorId, helpId })}
    >
      <textarea
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        rows={4}
        aria-describedby={error ? errorId : field.helpText ? helpId : undefined}
        aria-invalid={error ? "true" : undefined}
        className={cn(
          FIELD_SURFACE,
          FIELD_FOCUS,
          // `block`: an inline textarea sits on the text baseline and leaves a
          // descender gap beneath it, pushing its hint further off than an input's.
          "block w-full px-2.5 py-2 text-sm resize-y min-h-[100px]",
          "text-text-primary placeholder:text-text-placeholder",
          error && "border-status-error"
        )}
      />
    </FormRow>
  );
}

function BuilderSelectField({
  field,
  value,
  error,
  onChange,
}: {
  field: BuilderField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputId = `field-${field.name}`;
  const errorId = `${inputId}-error`;
  const helpId = `${inputId}-help`;

  return (
    <FormRow
      label={field.label}
      htmlFor={inputId}
      labelClassName={BUILDER_LABEL}
      hint={builderFieldHint({ error, helpText: field.helpText, errorId, helpId })}
    >
      <select
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={error ? errorId : field.helpText ? helpId : undefined}
        aria-invalid={error ? "true" : undefined}
        className={cn(
          FIELD_INPUT,
          "pr-8",
          // The empty option is a prompt, not a choice: it reads as placeholder
          // ink until something is picked.
          value === "" && "text-text-placeholder",
          error && "border-status-error"
        )}
      >
        <option value="">{field.placeholder ?? "Choose an option"}</option>
        {field.options?.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </FormRow>
  );
}

function BuilderCheckboxField({
  field,
  value,
  onChange,
}: {
  field: BuilderField;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const inputId = `field-${field.name}`;
  const helpId = `${inputId}-help`;

  return (
    <FormRow
      label={field.label}
      htmlFor={inputId}
      labelClassName={BUILDER_LABEL}
      hint={builderFieldHint({ helpText: field.helpText, errorId: "", helpId })}
    >
      {/* The row is the box's height, not a 32px control's, so the box sits on
          the label's line rather than floating in a taller cell. */}
      <div className="flex h-8 items-center">
        <Checkbox
          id={inputId}
          checked={value}
          onCheckedChange={(checked) => onChange(checked === true)}
          aria-describedby={field.helpText ? helpId : undefined}
        />
      </div>
    </FormRow>
  );
}

function BuilderFieldRenderer({
  field,
  value,
  error,
  onChange,
}: {
  field: BuilderField;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  switch (field.type) {
    case "text":
    case "number":
      return (
        <BuilderTextField
          field={field}
          value={String(value ?? "")}
          error={error}
          onChange={onChange}
        />
      );
    case "textarea":
      return (
        <BuilderTextareaField
          field={field}
          value={String(value ?? "")}
          error={error}
          onChange={onChange}
        />
      );
    case "select":
      return (
        <BuilderSelectField
          field={field}
          value={String(value ?? "")}
          error={error}
          onChange={onChange}
        />
      );
    case "checkbox":
      return <BuilderCheckboxField field={field} value={Boolean(value)} onChange={onChange} />;
    default:
      return null;
  }
}

const DEFAULT_SUBMIT_LABEL = "Run";

export function CommandBuilder({
  command,
  steps,
  context: _context,
  isExecuting,
  executionError,
  onExecute,
  onCancel,
}: CommandBuilderProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [executionResult, setExecutionResult] = useState<CommandResult | null>(null);
  // Bumped on every failed validation, so the effect that moves focus to the
  // first invalid field runs again even when the same field fails twice.
  const [validationAttempt, setValidationAttempt] = useState(0);
  const formRef = useRef<HTMLFieldSetElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const lastFocusedStepRef = useRef(0);

  const currentStep = steps[currentStepIndex];
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === steps.length - 1;
  const hasMultipleSteps = steps.length > 1;
  const hasEmptySteps = steps.length === 0;
  const submitLabel = steps[steps.length - 1]?.submitLabel ?? DEFAULT_SUBMIT_LABEL;
  // Past the still-working threshold the dialog stops holding the user: the
  // run carries on without it, and saying so is better than a lock with no end.
  const isSlowRun = useDeferredLoading(isExecuting, UI_STILL_WORKING_MS);
  const canDismiss = !isExecuting || isSlowRun;

  useEffect(() => {
    setCurrentStepIndex(0);
    lastFocusedStepRef.current = 0;
    // Initialize checkbox fields to false to ensure explicit boolean values
    const initialData: Record<string, unknown> = {};
    for (const step of steps) {
      for (const field of step.fields) {
        if (field.type === "checkbox") {
          initialData[field.name] = false;
        }
      }
    }
    setFormData(initialData);
    setFieldErrors({});
    setExecutionResult(null);
  }, [command.id, steps]);

  // Back and Next swap the fields out from under the button that was pressed,
  // and on the last step swap the button itself. Land on the new step's first
  // field so the keyboard continues from the top of what just appeared. The
  // dialog places focus for the first step on open.
  useEffect(() => {
    if (lastFocusedStepRef.current === currentStepIndex) return;
    lastFocusedStepRef.current = currentStepIndex;
    // A step with no fields falls back to the forward action, which is where
    // the keyboard goes next anyway.
    const target =
      formRef.current?.querySelector<HTMLElement>(
        "input, textarea, select, button:not([disabled])"
      ) ?? primaryRef.current;
    target?.focus();
  }, [currentStepIndex]);

  useEffect(() => {
    if (validationAttempt === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [validationAttempt]);

  const showSuccessState = executionResult?.success === true;

  // The form, and the button that ran it, are gone once the result shows.
  // Layout, not passive: focus has to land before the frame that removed its
  // old home is painted, or it sits on <body> for that frame.
  useLayoutEffect(() => {
    if (showSuccessState) closeRef.current?.focus();
  }, [showSuccessState]);

  const validateCurrentStep = useCallback((): boolean => {
    if (!currentStep) return true;

    const errors: FieldErrors = {};
    for (const field of currentStep.fields) {
      const error = validateField(field, formData[field.name]);
      if (error) {
        errors[field.name] = error;
      }
    }

    setFieldErrors(errors);
    const valid = Object.keys(errors).length === 0;
    if (!valid) setValidationAttempt((n) => n + 1);
    return valid;
  }, [currentStep, formData]);

  const handleFieldChange = useCallback(
    (fieldName: string, value: unknown, field?: BuilderField) => {
      // Number fields keep the typed string while editing: coercing each
      // keystroke turns a half-typed "-" or "1e" into NaN and writes it back.
      const coercedValue = value;
      setFormData((prev) => ({ ...prev, [fieldName]: coercedValue }));
      // A field already marked wrong is re-checked as it's edited, so the error
      // clears when the value is fixed and not merely when it's touched.
      setFieldErrors((prev) => {
        if (!(fieldName in prev)) return prev;
        const next = { ...prev };
        const error = field ? validateField(field, coercedValue) : null;
        if (error) next[fieldName] = error;
        else delete next[fieldName];
        return next;
      });
    },
    []
  );

  const handleBack = useCallback(() => {
    if (!isFirstStep) {
      setCurrentStepIndex((prev) => prev - 1);
      setFieldErrors({});
    }
  }, [isFirstStep]);

  const handleNext = useCallback(() => {
    if (!validateCurrentStep()) return;

    if (isLastStep) {
      return;
    }

    setCurrentStepIndex((prev) => prev + 1);
    setFieldErrors({});
  }, [isLastStep, validateCurrentStep]);

  const handleExecute = useCallback(async () => {
    if (isExecuting || !validateCurrentStep()) return;

    // Normalize empty strings to undefined so agents see "unset" rather than "provided empty"
    const numberFields = new Set(
      steps
        .flatMap((step) => step.fields)
        .filter((f) => f.type === "number")
        .map((f) => f.name)
    );
    const normalizedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(formData)) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed !== "") {
          normalizedData[key] = numberFields.has(key) ? Number(trimmed) : trimmed;
        }
      } else if (value !== undefined && value !== null && value !== "") {
        normalizedData[key] = value;
      }
    }

    const result = await onExecute(normalizedData);
    setExecutionResult(result);
  }, [formData, isExecuting, onExecute, steps, validateCurrentStep]);

  const handleClose = useCallback(() => {
    if (executionResult?.success || canDismiss) {
      onCancel();
    }
  }, [executionResult, canDismiss, onCancel]);

  // Retry's button leaves with the banner the moment the run restarts; hand
  // focus to the run action, which stays put through the pending state.
  const handleRetry = useCallback(() => {
    primaryRef.current?.focus();
    void handleExecute();
  }, [handleExecute]);

  return (
    <AppDialog isOpen={true} onClose={handleClose} size="md" dismissible={canDismiss}>
      <AppDialog.Header>
        <AppDialog.Title>{command.label}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {showSuccessState ? (
          <div
            className="flex flex-col items-center gap-4 py-6 text-center"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-success/15">
              <Check className="h-6 w-6 text-status-success" aria-hidden="true" />
            </div>
            <div className="max-w-full space-y-1">
              <h3 className="text-base font-semibold text-text-primary break-words">
                {executionResult.message ?? "Done"}
              </h3>
              {executionResult.detail && (
                <p className="text-sm text-text-secondary break-words">{executionResult.detail}</p>
              )}
            </div>
          </div>
        ) : hasEmptySteps ? (
          <InlineStatusBanner
            severity="error"
            title="This command isn't set up"
            description="Its builder has no steps, so there's nothing to fill in. The command's author needs to add them."
            animated={false}
            className="rounded-[var(--radius-md)]"
          />
        ) : (
          <div className="space-y-5">
            {currentStep && (
              <>
                {(hasMultipleSteps || currentStep.title || currentStep.description) && (
                  <div className="space-y-1">
                    {hasMultipleSteps && (
                      <p className="text-xs tabular-nums text-text-secondary">
                        Step {currentStepIndex + 1} of {steps.length}
                      </p>
                    )}
                    {currentStep.title && (
                      <h3 className="text-base font-semibold text-text-primary">
                        {currentStep.title}
                      </h3>
                    )}
                    {currentStep.description && (
                      <p className="text-sm text-text-secondary">{currentStep.description}</p>
                    )}
                  </div>
                )}
                {/* Step changes are announced here rather than by re-titling the
                    dialog, which would read as a new dialog opening. */}
                {hasMultipleSteps && (
                  <span className="sr-only" aria-live="polite">
                    {`Step ${currentStepIndex + 1} of ${steps.length}${currentStep.title ? `: ${currentStep.title}` : ""}`}
                  </span>
                )}

                {/* Locked while the command runs: what was sent is already fixed, and
                    an edit then would look like it counted. Kept at full ink,
                    though — dimmed, a typed value reads as an empty placeholder. */}
                <fieldset
                  ref={formRef}
                  disabled={isExecuting}
                  className="m-0 min-w-0 border-0 p-0 [&_:disabled]:opacity-100!"
                >
                  <FormGrid>
                    {currentStep.fields.map((field) => (
                      <BuilderFieldRenderer
                        key={field.name}
                        field={field}
                        value={formData[field.name]}
                        error={fieldErrors[field.name]}
                        onChange={(value) => handleFieldChange(field.name, value, field)}
                      />
                    ))}
                  </FormGrid>
                </fieldset>
              </>
            )}

            {executionError && !isExecuting && (
              <InlineStatusBanner
                severity="error"
                title="Command failed"
                description={executionError}
                action={{ id: "retry", label: "Retry", onClick: handleRetry }}
                className="rounded-[var(--radius-md)]"
              />
            )}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        hint={
          isExecuting ? (
            // Says what the dimmed action and the locked form are waiting on,
            // and, once it's slow, that closing is safe.
            <span role="status">
              {isSlowRun
                ? `Still running ${command.label}… Closing this won't stop it.`
                : `Running ${command.label}…`}
            </span>
          ) : undefined
        }
      >
        {showSuccessState || hasEmptySteps ? (
          <Button ref={closeRef} variant="contrast" onClick={onCancel}>
            Close
          </Button>
        ) : (
          <div className="ml-auto flex items-center gap-3">
            <Button
              variant="ghost"
              onClick={onCancel}
              disabled={!canDismiss}
              className="text-text-secondary"
            >
              {/* Once a slow run can be left, this no longer cancels anything. */}
              {isSlowRun ? "Close" : "Cancel"}
            </Button>
            {!isFirstStep && (
              <Button
                variant="ghost"
                onClick={handleBack}
                disabled={isExecuting}
                className="text-text-secondary"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
            )}
            {isLastStep ? (
              <Button
                ref={primaryRef}
                variant="contrast"
                onClick={() => void handleExecute()}
                loading={isExecuting}
              >
                {submitLabel}
              </Button>
            ) : (
              <Button ref={primaryRef} variant="contrast" onClick={handleNext}>
                Next
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
