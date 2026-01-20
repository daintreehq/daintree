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
import { ChevronLeft, ChevronRight, Loader2, AlertCircle, CheckCircle } from "lucide-react";

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
  if (field.type === "checkbox") {
    if (field.required && !value) {
      return `${field.label} must be checked`;
    }
    return null;
  }

  if (field.required && (value === undefined || value === null || value === "")) {
    return `${field.label} is required`;
  }

  if (value === undefined || value === null || value === "") {
    return null;
  }

  const validation = field.validation;
  if (!validation) return null;

  if (field.type === "text" || field.type === "textarea") {
    const strValue = String(value);
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
    const numValue = Number(value);
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

  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-canopy-text">
        {field.label}
        {field.required && <span className="text-[var(--color-status-error)] ml-1">*</span>}
      </label>
      <input
        ref={inputRef}
        type={field.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className={cn(
          "w-full px-3 py-2 text-sm rounded-[var(--radius-md)]",
          "bg-canopy-bg border text-canopy-text placeholder:text-canopy-text/40",
          "focus:outline-none focus:ring-1",
          error
            ? "border-[var(--color-status-error)] focus:border-[var(--color-status-error)] focus:ring-[var(--color-status-error)]"
            : "border-canopy-border focus:border-canopy-accent focus:ring-canopy-accent"
        )}
      />
      {field.helpText && !error && (
        <p className="text-xs text-canopy-text/50">{field.helpText}</p>
      )}
      {error && (
        <p className="text-xs text-[var(--color-status-error)] flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
    </div>
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
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-canopy-text">
        {field.label}
        {field.required && <span className="text-[var(--color-status-error)] ml-1">*</span>}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        rows={4}
        className={cn(
          "w-full px-3 py-2 text-sm rounded-[var(--radius-md)] resize-y min-h-[100px]",
          "bg-canopy-bg border text-canopy-text placeholder:text-canopy-text/40",
          "focus:outline-none focus:ring-1",
          error
            ? "border-[var(--color-status-error)] focus:border-[var(--color-status-error)] focus:ring-[var(--color-status-error)]"
            : "border-canopy-border focus:border-canopy-accent focus:ring-canopy-accent"
        )}
      />
      {field.helpText && !error && (
        <p className="text-xs text-canopy-text/50">{field.helpText}</p>
      )}
      {error && (
        <p className="text-xs text-[var(--color-status-error)] flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
    </div>
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
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-canopy-text">
        {field.label}
        {field.required && <span className="text-[var(--color-status-error)] ml-1">*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full px-3 py-2 text-sm rounded-[var(--radius-md)]",
          "bg-canopy-bg border text-canopy-text",
          "focus:outline-none focus:ring-1",
          error
            ? "border-[var(--color-status-error)] focus:border-[var(--color-status-error)] focus:ring-[var(--color-status-error)]"
            : "border-canopy-border focus:border-canopy-accent focus:ring-canopy-accent"
        )}
      >
        <option value="">{field.placeholder ?? "Select an option..."}</option>
        {field.options?.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {field.helpText && !error && (
        <p className="text-xs text-canopy-text/50">{field.helpText}</p>
      )}
      {error && (
        <p className="text-xs text-[var(--color-status-error)] flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
    </div>
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
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className={cn(
            "h-4 w-4 rounded border-canopy-border bg-canopy-bg",
            "text-canopy-accent focus:ring-canopy-accent focus:ring-offset-0",
            "cursor-pointer"
          )}
        />
        <span className="text-sm font-medium text-canopy-text group-hover:text-canopy-text/90">
          {field.label}
        </span>
      </label>
      {field.helpText && <p className="text-xs text-canopy-text/50 ml-7">{field.helpText}</p>}
    </div>
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
      return (
        <BuilderCheckboxField
          field={field}
          value={Boolean(value)}
          onChange={onChange}
        />
      );
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
    setFormData({});
    setFieldErrors({});
    setExecutionResult(null);
  }, [command.id]);

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

  const handleFieldChange = useCallback((fieldName: string, value: unknown, field?: BuilderField) => {
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
  }, []);

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

    const result = await onExecute(formData);
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
            <span className="text-sm text-canopy-text/50">
              Step {currentStepIndex + 1} of {steps.length}
            </span>
          )}
        </div>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {showSuccessState ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <CheckCircle className="h-12 w-12 text-[var(--color-status-success)]" />
            <div className="text-center">
              <h3 className="text-lg font-medium text-canopy-text">Command Executed</h3>
              <p className="text-sm text-canopy-text/70 mt-1">
                {executionResult.message ?? "The command completed successfully."}
              </p>
            </div>
          </div>
        ) : hasEmptySteps ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <AlertCircle className="h-12 w-12 text-[var(--color-status-error)]" />
            <div className="text-center">
              <h3 className="text-lg font-medium text-canopy-text">Configuration Error</h3>
              <p className="text-sm text-canopy-text/70 mt-1">
                This command has no builder steps configured.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {currentStep && (
              <>
                {currentStep.description && (
                  <p className="text-sm text-canopy-text/70">{currentStep.description}</p>
                )}

                <div className="space-y-4">
                  {currentStep.fields.map((field) => (
                    <BuilderFieldRenderer
                      key={field.name}
                      field={field}
                      value={formData[field.name]}
                      error={fieldErrors[field.name]}
                      onChange={(value) => handleFieldChange(field.name, value, field)}
                    />
                  ))}
                </div>
              </>
            )}

            {executionError && (
              <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-[var(--color-status-error)]/10 border border-[var(--color-status-error)]/30">
                <AlertCircle className="h-4 w-4 text-[var(--color-status-error)] shrink-0 mt-0.5" />
                <div className="text-sm text-[var(--color-status-error)]">{executionError}</div>
              </div>
            )}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        {showSuccessState ? (
          <Button onClick={onCancel}>Close</Button>
        ) : (
          <>
            <div className="flex-1 flex items-center gap-2">
              {!isFirstStep && (
                <Button
                  variant="ghost"
                  onClick={handleBack}
                  disabled={isExecuting}
                  className="text-canopy-text/70"
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
                className="text-canopy-text/70"
              >
                Cancel
              </Button>
              {isLastStep ? (
                <Button onClick={handleExecute} disabled={isExecuting}>
                  {isExecuting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Executing...
                    </>
                  ) : (
                    "Execute"
                  )}
                </Button>
              ) : (
                <Button onClick={handleNext} disabled={isExecuting}>
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
