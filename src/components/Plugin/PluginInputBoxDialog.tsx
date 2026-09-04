import { useCallback, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import type { PluginInputBoxOptions } from "@shared/types/plugin";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";

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
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function InputBoxForm({ options, pluginId, onSubmit, onCancel }: InputBoxFormProps) {
  const [value, setValue] = useState(options.value ?? "");
  const [showError, setShowError] = useState(false);
  const pattern = compilePattern(options.validationPattern);
  const isValid = pattern ? pattern.test(value) : true;
  // Provenance copy names the plugin, and `pluginId` is the host's instance key
  // — raw, a project-owned plugin would attribute the prompt to
  // `project__{projectId}__{manifestId}`. Fallback is the manifest id (#12211).
  const pluginName = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
  );

  const handleSubmit = () => {
    if (!isValid) {
      setShowError(true);
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
        <input
          type={options.password ? "password" : "text"}
          value={value}
          autoFocus
          placeholder={options.placeholder}
          aria-label={options.prompt || options.title || "Value"}
          aria-invalid={showError && !isValid}
          onChange={(e) => {
            setValue(e.target.value);
            if (showError) setShowError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
          className="w-full rounded-md bg-overlay-subtle px-3 py-2 text-sm text-text-primary placeholder:text-daintree-text/40"
        />
        {showError && !isValid && (
          <p className="text-xs text-status-error">
            {options.validationMessage || "The value doesn't match the required format"}
          </p>
        )}
        <p className="text-xs text-text-secondary">Requested by the '{pluginName}' plugin</p>
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{ label: "Cancel", onClick: onCancel }}
        primaryAction={{ label: "Submit", onClick: handleSubmit, disabled: showError && !isValid }}
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
      ? { promptId: current.promptId, pluginId: current.pluginId, options: current.params.options }
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
        initialFocus="first"
      >
        {inputBox && (
          <InputBoxForm
            key={inputBox.promptId}
            options={inputBox.options}
            pluginId={inputBox.pluginId}
            onSubmit={(value) => resolveOnce(inputBox.promptId, value)}
            onCancel={() => resolveOnce(inputBox.promptId, undefined)}
          />
        )}
      </AppDialog>
    </ErrorBoundary>
  );
}
