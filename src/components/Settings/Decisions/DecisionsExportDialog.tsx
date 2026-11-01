import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH } from "@shared/types/decisions";

interface DecisionsExportDialogProps {
  isOpen: boolean;
  exporting: boolean;
  error: string | null;
  onCancel: () => void;
  /** Hands the passphrase on; the dialog clears its fields at once, whatever follows. */
  onExport: (passphrase: string) => void;
}

/**
 * Asks for the passphrase the decision history archive is encrypted with
 * (#16025), twice, since an archive whose passphrase was mistyped can never
 * be opened. Main then asks where to save it.
 */
export function DecisionsExportDialog({
  isOpen,
  exporting,
  error,
  onCancel,
  onExport,
}: DecisionsExportDialogProps) {
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const tooShort = passphrase.length < DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH;
  const mismatch = repeat !== "" && repeat !== passphrase;
  const ready = !tooShort && repeat === passphrase;

  const clear = () => {
    setPassphrase("");
    setRepeat("");
  };

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={() => {
        clear();
        onCancel();
      }}
      variant="default"
      title="Export decision history"
      description="Every question and answer stored on this computer, with the audit log, goes into one archive encrypted with this passphrase. Without it the archive can't be opened, and Daintree doesn't keep it. Paired devices' public keys and attachments aren't included."
      confirmLabel="Export history…"
      confirmDisabled={!ready}
      isConfirmLoading={exporting}
      onConfirm={() => {
        if (!ready) return;
        const chosen = passphrase;
        clear();
        onExport(chosen);
      }}
      hint={
        ready
          ? undefined
          : tooShort
            ? `Use at least ${DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH} characters`
            : "Enter the same passphrase twice"
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <Field>
          <FieldLabel>Passphrase</FieldLabel>
          <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={1024}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            disabled={exporting}
          />
        </Field>
        <Field invalid={mismatch}>
          <FieldLabel>Passphrase again</FieldLabel>
          <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={1024}
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            disabled={exporting}
          />
          {mismatch && <FieldError>The passphrases don't match</FieldError>}
        </Field>
      </form>
      {error && (
        <p role="alert" className="text-xs text-status-error select-text">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
