import { useState, useCallback, useEffect, useRef } from "react";
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
import { ChevronLeft, ChevronRight, AlertCircle, CheckCircle } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import {
  FIELD_FOCUS,
  FIELD_INPUT,
  FIELD_SURFACE,
  FormGrid,
  FormRow,
} from "@/components/Worktree/views";

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
  // No required field validation - all fields are optional
  // The agent will interpret user intent from whatever is provided

  // Treat whitespace-only input as empty
  const stringValue = typeof value === "string" ? value.trim() : value;
  if (stringValue === undefined || stringValue === null || stringValue === "") {
    return null;
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
      <p id={helpId} className="text-xs text-text-muted">
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
          "w-full px-2.5 py-2 text-sm resize-y min-h-[100px]",
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
        className={cn(FIELD_INPUT, "pr-8", error && "border-status-error")}
      >
        <option value="">{field.placeholder ?? "Select an option..."}</option>
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
      hint={
        field.helpText && (
          <p id={helpId} className="text-xs text-text-muted">
            {field.helpText}
          </p>
        )
      }
    >
      <input
        id={inputId}
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={field.helpText ? helpId : undefined}
        className={cn(
          "h-4 w-4 rounded border-border-default bg-surface-canvas",
          "text-accent-primary focus:ring-daintree-accent/30 focus:ring-offset-0",
          "cursor-pointer"
        )}
      />
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

  const currentStep = steps[currentStepIndex];
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === steps.length - 1;
  const hasMultipleSteps = steps.length > 1;
  const hasEmptySteps = steps.length === 0;

  useEffect(() => {
    setCurrentStepIndex(0);
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
    return Object.keys(errors).length === 0;
  }, [currentStep, formData]);

  const handleFieldChange = useCallback(
    (fieldName: string, value: unknown, field?: BuilderField) => {
      let coercedValue = value;
      if (field?.type === "number" && typeof value === "string" && value !== "") {
        coercedValue = Number(value);
      }
      setFormData((prev) => ({ ...prev, [fieldName]: coercedValue }));
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[fieldName];
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
    if (!validateCurrentStep()) return;

    // Normalize empty strings to undefined so agents see "unset" rather than "provided empty"
    const normalizedData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(formData)) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed !== "") {
          normalizedData[key] = trimmed;
        }
      } else if (value !== undefined && value !== null && value !== "") {
        normalizedData[key] = value;
      }
    }

    const result = await onExecute(normalizedData);
    setExecutionResult(result);
  }, [formData, onExecute, validateCurrentStep]);

  const handleClose = useCallback(() => {
    if (executionResult?.success) {
      onCancel();
    } else if (!isExecuting) {
      onCancel();
    }
  }, [executionResult, isExecuting, onCancel]);

  const showSuccessState = executionResult?.success;

  return (
    <AppDialog isOpen={true} onClose={handleClose} size="md" dismissible={!isExecuting}>
      <AppDialog.Header>
        <div className="flex items-center gap-3">
          <AppDialog.Title>{command.label}</AppDialog.Title>
          {hasMultipleSteps && (
            <span className="text-sm tabular-nums text-text-secondary">
              Step {currentStepIndex + 1} of {steps.length}
            </span>
          )}
        </div>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {showSuccessState ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <CheckCircle className="h-12 w-12 text-status-success" />
            <div className="text-center">
              <h3 className="text-lg font-medium text-text-primary">Command Executed</h3>
              <p className="text-sm text-text-secondary mt-1">
                {executionResult.message ?? "Command completed."}
              </p>
            </div>
          </div>
        ) : hasEmptySteps ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <AlertCircle className="h-12 w-12 text-status-error" />
            <div className="text-center">
              <h3 className="text-lg font-medium text-text-primary">Configuration Error</h3>
              <p className="text-sm text-text-secondary mt-1">
                This command has no builder steps configured.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {currentStep && (
              <>
                {currentStep.title && (
                  <h3 className="text-base font-semibold text-text-primary">{currentStep.title}</h3>
                )}
                {currentStep.description && (
                  <p className="text-sm text-text-secondary">{currentStep.description}</p>
                )}

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
              </>
            )}

            {executionError && (
              <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/30">
                <AlertCircle className="h-4 w-4 text-status-error shrink-0 mt-0.5" />
                <div className="text-sm text-status-error">{executionError}</div>
              </div>
            )}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        {showSuccessState ? (
          <Button variant="contrast" onClick={onCancel}>
            Close
          </Button>
        ) : hasEmptySteps ? (
          <Button variant="contrast" onClick={onCancel}>
            Close
          </Button>
        ) : (
          <>
            <div className="flex-1 flex items-center gap-2">
              {!isFirstStep && (
                <Button
                  variant="ghost"
                  onClick={handleBack}
                  disabled={isExecuting}
                  className="text-text-secondary"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                onClick={onCancel}
                disabled={isExecuting}
                className="text-text-secondary"
              >
                Cancel
              </Button>
              {isLastStep ? (
                <Button variant="contrast" onClick={handleExecute} disabled={isExecuting}>
                  {isExecuting ? (
                    <>
                      <Spinner size="md" />
                      Executing...
                    </>
                  ) : (
                    "Execute"
                  )}
                </Button>
              ) : (
                <Button variant="contrast" onClick={handleNext} disabled={isExecuting}>
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
