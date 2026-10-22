import { useCallback, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { isEnterToSubmit } from "@/lib/enterToSubmit";
import { FIELD_INPUT, FormGrid, FormRow } from "@/components/Worktree/views/WorktreeFormLayout";
import type { PromptTemplateArgument } from "@shared/types/plugin";

interface PromptTemplateFormProps {
  title: string;
  /** The plugin the template comes from, named under the title. */
  pluginName: string;
  args: readonly PromptTemplateArgument[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  restoreFocusTo?: () => HTMLElement | null;
}

/** The arguments a prompt template asks for before it fills the composer. */
export function PromptTemplateForm({
  title,
  pluginName,
  args,
  onSubmit,
  onCancel,
  restoreFocusTo,
}: PromptTemplateFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const primaryRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFieldSetElement>(null);

  const handleChange = useCallback((arg: PromptTemplateArgument, value: string) => {
    setValues((prev) => ({ ...prev, [arg.name]: value }));
    setErrors((prev) => {
      if (!(arg.name in prev)) return prev;
      const next = { ...prev };
      if (arg.required && value.trim() === "") next[arg.name] = "Required";
      else delete next[arg.name];
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    const nextErrors: Record<string, string> = {};
    for (const arg of args) {
      if (arg.required && (values[arg.name] ?? "").trim() === "") nextErrors[arg.name] = "Required";
    }
    setErrors(nextErrors);
    const firstInvalid = args.find((arg) => arg.name in nextErrors);
    if (firstInvalid) {
      formRef.current?.querySelector<HTMLElement>(`#prompt-template-${firstInvalid.name}`)?.focus();
      return;
    }
    onSubmit(values);
  }, [args, values, onSubmit]);

  return (
    <AppDialog
      isOpen={true}
      onClose={onCancel}
      size="md"
      restoreFocusTo={restoreFocusTo}
      preferRestoreFocusTo={restoreFocusTo !== undefined}
    >
      <AppDialog.Header>
        <AppDialog.Title>{title}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <p className="mb-4 text-xs text-text-secondary">From {pluginName}</p>
        <fieldset
          ref={formRef}
          onKeyDown={(event) => {
            if (!isEnterToSubmit(event)) return;
            event.preventDefault();
            primaryRef.current?.click();
          }}
          className="mx-0 min-w-0 border-0 p-0"
        >
          <FormGrid>
            {args.map((arg) => {
              const inputId = `prompt-template-${arg.name}`;
              const errorId = `${inputId}-error`;
              const error = errors[arg.name];
              return (
                <FormRow
                  key={arg.name}
                  label={arg.label}
                  htmlFor={inputId}
                  labelClassName="max-w-48 break-words"
                  hint={error ? <InlineError id={errorId}>{error}</InlineError> : null}
                >
                  <input
                    id={inputId}
                    type="text"
                    value={values[arg.name] ?? ""}
                    onChange={(e) => handleChange(arg, e.target.value)}
                    aria-describedby={error ? errorId : undefined}
                    aria-invalid={error ? "true" : undefined}
                    aria-required={arg.required || undefined}
                    className={cn(FIELD_INPUT, error && "border-status-error")}
                  />
                </FormRow>
              );
            })}
          </FormGrid>
        </fieldset>
      </AppDialog.Body>
      <AppDialog.Footer>
        <div className="ml-auto flex items-center gap-3">
          <Button variant="ghost" onClick={onCancel} className="text-text-secondary">
            Cancel
          </Button>
          <Button ref={primaryRef} variant="contrast" onClick={handleSubmit}>
            Fill draft
          </Button>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
