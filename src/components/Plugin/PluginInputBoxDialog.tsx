import { useCallback, useId, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PluginProvenance } from "./PluginProvenance";
import type { PluginUiPromptWaited } from "@shared/types/pluginUiPrompt";
import { usePluginAttribution } from "@/hooks/usePluginAttribution";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import type { PluginInputBoxOptions } from "@shared/types/plugin";

/**
 * Compile a plugin-supplied validation pattern. A malformed pattern is ignored
 * (returns `null`) rather than throwing — a buggy plugin regex must not wedge
 * the dialog so the user can never submit.
 */
function compilePattern(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

interface InputBoxFormProps {
  options: PluginInputBoxOptions;
  pluginId: string;
  waited?: PluginUiPromptWaited;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function InputBoxForm({ options, pluginId, waited, onSubmit, onCancel }: InputBoxFormProps) {
  const [value, setValue] = useState(options.value ?? "");
  // Set by the first rejected submit and never cleared: from then on the field
  // is judged live, so the error stays while the value is still wrong and goes
  // the moment it is right — not on the first keystroke of an edit that may not
  // have fixed anything.
  const [attempted, setAttempted] = useState(false);
  const pattern = compilePattern(options.validationPattern);
  const isValid = pattern ? pattern.test(value) : true;
  const showError = attempted && !isValid;
  const errorMessage = options.validationMessage || "The value doesn't match the required format";
  const provenanceId = useId();
  const attribution = usePluginAttribution(pluginId);

  const handleSubmit = () => {
    if (!isValid) {
      // `FieldError` is deliberately not a live region (it renders per
      // keystroke in settings). A rejected submit is a discrete event the user
      // caused, so each one is announced — never the keystrokes in between.
      useAnnouncerStore.getState().announce(errorMessage, "assertive");
      setAttempted(true);
      return;
    }
    onSubmit(value);
  };

  return (
    <>
      <AppDialog.Header>
        <AppDialog.Title>{options.title || "Enter a value"}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-3">
        {options.prompt && <AppDialog.Description>{options.prompt}</AppDialog.Description>}
        <Field>
          <Input
            type={options.password ? "password" : "text"}
            value={value}
            // The dialog opens with `initialFocus="none"` and leaves focus to
            // this: its default lands on the header's close button, and a
            // promoted prompt remounts the form without reopening the dialog.
            autoFocus
            placeholder={options.placeholder}
            aria-label={options.prompt || options.title || "Value"}
            aria-describedby={provenanceId}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // Enter that commits an IME composition is not a submit.
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          {showError && <FieldError>{errorMessage}</FieldError>}
        </Field>
      </AppDialog.Body>

      <AppDialog.Footer
        // The one line in this dialog the plugin did not write, so it sits in
        // the host's footer band rather than beside the plugin's own copy.
        hint={<PluginProvenance id={provenanceId} attribution={attribution} waited={waited} />}
        secondaryAction={{ label: "Cancel", onClick: onCancel }}
        primaryAction={{ label: "Submit", onClick: handleSubmit, disabled: showError }}
      />
    </>
  );
}

/**
 * Singleton dialog for `host.showInputBox` (#10522). Mounted once in `App.tsx`.
 * Renders the front prompt of `pluginPromptStore` when it is an `inputBox`.
 * Validation (an optional regex) is enforced client-side at submit time — there
 * is no per-keystroke IPC round-trip back to the plugin worker.
 */
export function PluginInputBoxDialog() {
  const current = usePluginPromptStore((state) => state.current);
  const resolveCurrent = usePluginPromptStore((state) => state.resolveCurrent);

  // Capture the narrowed inputBox `params` into a fresh object: `PendingUiPrompt`
  // is a struct whose `.params` is the union, so narrowing the discriminant on
  // the access expression doesn't carry through a stored reference to the whole
  // item — the object literal pins the narrowed `options` type.
  const inputBox =
    current && current.params.kind === "inputBox"
      ? {
          promptId: current.promptId,
          pluginId: current.pluginId,
          options: current.params.options,
          waited: current.params.waited,
        }
      : null;
  const isInputBox = inputBox !== null;

  // resolveCurrent advances synchronously; gate to resolve each prompt once.
  const handledPromptIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (promptId: string, value: string | undefined) => {
      if (handledPromptIdRef.current === promptId) return;
      handledPromptIdRef.current = promptId;
      resolveCurrent(value);
    },
    [resolveCurrent]
  );

  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginInputBoxDialog"
      resetKeys={[inputBox ? inputBox.promptId : "null"]}
    >
      <AppDialog
        isOpen={isInputBox}
        onClose={() => {
          if (inputBox) resolveOnce(inputBox.promptId, undefined);
        }}
        size="sm"
        initialFocus="none"
      >
        {inputBox && (
          <InputBoxForm
            key={inputBox.promptId}
            options={inputBox.options}
            pluginId={inputBox.pluginId}
            waited={inputBox.waited}
            onSubmit={(value) => resolveOnce(inputBox.promptId, value)}
            onCancel={() => resolveOnce(inputBox.promptId, undefined)}
          />
        )}
      </AppDialog>
    </ErrorBoundary>
  );
}
