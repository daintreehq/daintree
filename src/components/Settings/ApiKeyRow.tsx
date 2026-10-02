import { useId, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle2, ExternalLink, Eye, EyeOff, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsRow } from "./SettingsGroup";

type KeyStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "saved"; verified: boolean }
  | { kind: "invalid"; message: string }
  | { kind: "save-failed" }
  | { kind: "removing" }
  | { kind: "removed" }
  | { kind: "remove-failed" };

export interface ApiKeyRowProps {
  id?: string;
  label: string;
  description?: ReactNode;
  /** How the stored key is shown — masked to its kind and last four — or null when none is. */
  savedLabel: string | null;
  placeholder: string;
  /** What stops working once the key is removed, for the confirm dialog's body. */
  removeConsequence: string;
  /** Resolves once the key has persisted — `false` means it did not. */
  onSave: (key: string) => Promise<boolean>;
  /**
   * Remote key validation. When omitted (e.g. providers without a validation
   * endpoint), the key is saved without a remote check.
   */
  onValidate?: (key: string) => Promise<{ valid: boolean; error?: string } | undefined> | undefined;
  helpUrl: string;
}

/**
 * A secret the user brings. The row always says whether one is stored — masked to its
 * kind and last four characters — so a configured page and an empty one never look the
 * same. Save is the explicit exception to instant apply: the key is checked remotely
 * before it is kept, and the outcome stays on screen until the field is edited again.
 */
export function ApiKeyRow({
  id,
  label,
  description,
  savedLabel,
  placeholder,
  removeConsequence,
  onSave,
  onValidate,
  helpUrl,
}: ApiKeyRowProps) {
  const [showKey, setShowKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [status, setStatus] = useState<KeyStatus>({ kind: "idle" });
  const statusId = useId();
  const testing = status.kind === "testing";
  const removing = status.kind === "removing";
  const busy = testing || removing;
  const savedId = useId();

  const handleSave = async () => {
    const key = keyInput.trim();
    // One credential operation at a time, so a result always describes the one the user ran.
    if (!key || busy) return;
    setStatus({ kind: "testing" });
    let verified = false;
    if (onValidate) {
      try {
        const result = await onValidate(key);
        if (!result?.valid) {
          setStatus({
            kind: "invalid",
            message: result?.error || "The provider rejected this key.",
          });
          return;
        }
        verified = true;
      } catch {
        setStatus({ kind: "invalid", message: "Couldn't reach the provider to check this key." });
        return;
      }
    }
    // Keep the draft until it has actually persisted, so a failed write can be retried.
    if (await onSave(key)) {
      setKeyInput("");
      setStatus({ kind: "saved", verified });
    } else {
      setStatus({ kind: "save-failed" });
    }
  };

  // Confirmed like every other stored credential (forge tokens, plugin secrets):
  // the key isn't recoverable from Daintree once its copy is gone.
  const [isRemoveConfirmOpen, setIsRemoveConfirmOpen] = useState(false);

  const handleRemove = async () => {
    if (busy) return;
    setStatus({ kind: "removing" });
    setStatus((await onSave("")) ? { kind: "removed" } : { kind: "remove-failed" });
    setIsRemoveConfirmOpen(false);
  };

  const statusLine =
    status.kind === "saved" ? (
      <>
        <CheckCircle2
          className={cn(
            "w-3.5 h-3.5 shrink-0",
            // Green only for a key the provider actually accepted.
            status.verified ? "text-status-success" : "text-text-secondary"
          )}
          aria-hidden="true"
        />
        {status.verified
          ? "Key checked and saved"
          : "Key saved. It's checked the first time you dictate."}
      </>
    ) : status.kind === "invalid" ? (
      <>
        <XCircle className="w-3.5 h-3.5 shrink-0 text-status-error" aria-hidden="true" />
        {status.message}
      </>
    ) : status.kind === "removed" ? (
      <>
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        Key removed
      </>
    ) : status.kind === "remove-failed" ? (
      <>
        <XCircle className="w-3.5 h-3.5 shrink-0 text-status-error" aria-hidden="true" />
        Couldn't remove the key. It's still saved, so you can try again.
      </>
    ) : status.kind === "save-failed" ? (
      <>
        <XCircle className="w-3.5 h-3.5 shrink-0 text-status-error" aria-hidden="true" />
        Couldn't save the key. It's still in the field, so you can try Save again.
      </>
    ) : null;

  return (
    <>
      <ConfirmDialog
        isOpen={isRemoveConfirmOpen}
        variant="destructive"
        onConfirm={() => void handleRemove()}
        onClose={() => setIsRemoveConfirmOpen(false)}
        isConfirmLoading={removing}
        title={`Remove the ${label}?`}
        description={removeConsequence}
        confirmLabel="Remove key"
        zIndex="nested"
      />
      <SettingsRow
        id={id}
        label={label}
        description={description}
        layout="stacked"
        accessory={
          savedLabel !== null ? (
            <span
              id={savedId}
              className="rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas px-1.5 py-0.5 font-mono text-2xs text-text-secondary"
            >
              Saved · {savedLabel}
            </span>
          ) : (
            <span id={savedId} className="text-xs text-text-secondary">
              Not set
            </span>
          )
        }
        control={({ labelId, descriptionId, disabled }) => (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-64">
                <Input
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  aria-labelledby={labelId}
                  aria-describedby={[savedId, descriptionId, statusId].filter(Boolean).join(" ")}
                  aria-invalid={status.kind === "invalid" ? true : undefined}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    if (status.kind !== "idle" && !busy) {
                      setStatus({ kind: "idle" });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSave();
                    }
                  }}
                  placeholder={
                    savedLabel !== null ? "Paste a new key to replace the saved one" : placeholder
                  }
                  className="pr-9 font-mono placeholder:font-sans"
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={disabled || busy}
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 [&_svg]:size-3.5"
                  aria-label="Show API key"
                  pressed={showKey}
                >
                  {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
              </div>
              <Button
                onClick={() => void handleSave()}
                disabled={disabled || busy || !keyInput.trim()}
                loading={testing}
                size="sm"
                variant="contrast"
              >
                {onValidate ? "Check and save" : "Save"}
              </Button>
              {savedLabel !== null ? (
                <Button
                  onClick={() => setIsRemoveConfirmOpen(true)}
                  variant="ghost-danger"
                  size="sm"
                  disabled={disabled || testing}
                  loading={removing}
                >
                  Remove key
                </Button>
              ) : (
                <Button
                  onClick={() => window.electron?.system?.openExternal(helpUrl)}
                  variant="ghost"
                  size="sm"
                >
                  Get a key
                  <ExternalLink aria-hidden="true" />
                </Button>
              )}
            </div>

            <p
              id={statusId}
              role="status"
              aria-live="polite"
              className={cn(
                "flex items-start gap-1.5 text-xs text-text-primary",
                !statusLine && "sr-only"
              )}
            >
              {statusLine}
            </p>
          </div>
        )}
      />
    </>
  );
}
