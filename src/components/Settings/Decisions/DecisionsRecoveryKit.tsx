import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DecisionsStatus } from "@shared/types/decisions";
import { useRecoveryKit } from "./useRecoveryKit";
import {
  MIN_KIT_PASSPHRASE_LENGTH,
  describeExportResult,
  describeVerifyResult,
  formatVerifiedAt,
} from "./recoveryKitCopy";

/** A kit is one identity, a few KiB; main refuses anything bigger. */
const MAX_KIT_BYTES = 256 * 1024;

interface ChosenKit {
  name: string;
  text: string;
}

interface DecisionsRecoveryKitProps {
  status: DecisionsStatus;
  disabled: boolean;
  /** A kit verified: main's status, now recording it. */
  onVerified: (status: DecisionsStatus) => void;
  /** Above zero, and bumped, to bring the passphrase field into view and focus it. */
  focusRequest: number;
  /** The field took focus for the request. */
  onFocused?: () => void;
}

/**
 * The recovery kit (#16007): saving one, locked with a passphrase, through
 * main's save dialog, and verifying a saved file against this computer's
 * identity, which is what finishes setup. Each passphrase and kit is handed
 * to main as its request starts and cleared here at once, success or not.
 */
export function DecisionsRecoveryKit({
  status,
  disabled,
  onVerified,
  focusRequest,
  onFocused,
}: DecisionsRecoveryKitProps) {
  const recovery = useRecoveryKit(onVerified);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [verifyPassphrase, setVerifyPassphrase] = useState("");
  const [kit, setKit] = useState<ChosenKit | null>(null);
  const [kitError, setKitError] = useState<string | null>(null);
  const exportField = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Bumped by each choice, submit and unmount, so a slower read can't land after them. */
  const kitRead = useRef(0);

  useEffect(
    () => () => {
      kitRead.current += 1;
    },
    []
  );

  const busy = disabled || recovery.pending !== null;

  // A request waits while the field is disabled, and counts as met only once
  // the field has focus, so one made mid-request isn't lost.
  const focusField = useEffectEvent(() => {
    const field = exportField.current;
    if (!field) return;
    field.scrollIntoView?.({ block: "center", behavior: "smooth" });
    field.focus({ preventScroll: true });
    if (document.activeElement === field) onFocused?.();
  });
  useEffect(() => {
    if (focusRequest > 0 && !busy) focusField();
  }, [focusRequest, busy]);

  const verifiedAt = status.recoveryKitVerifiedAt;

  /** Every secret here goes as a request starts, whichever form sent it. */
  const clearSecrets = () => {
    kitRead.current += 1;
    setExportPassphrase("");
    setVerifyPassphrase("");
    setKit(null);
    setKitError(null);
  };

  const submitExport = () => {
    if (busy || exportPassphrase.length < MIN_KIT_PASSPHRASE_LENGTH) return;
    const payload = { passphrase: exportPassphrase };
    clearSecrets();
    recovery.exportKit(payload);
  };

  const submitVerify = () => {
    if (busy || !kit || verifyPassphrase === "") return;
    const payload = { kit: kit.text, passphrase: verifyPassphrase };
    clearSecrets();
    recovery.verifyKit(payload);
  };

  const chooseKit = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared, so choosing the same file again still reads it.
    event.target.value = "";
    if (!file) return;
    const read = ++kitRead.current;
    setKit(null);
    // A new choice is what the person is looking at now, so its error is what is said.
    recovery.reset();
    if (file.size > MAX_KIT_BYTES) {
      setKitError("That file is too large to be a recovery kit");
      return;
    }
    setKitError(null);
    file.text().then(
      (text) => {
        if (kitRead.current === read) setKit({ name: file.name, text });
      },
      (failure: unknown) => {
        if (kitRead.current === read) {
          setKitError(formatErrorMessage(failure, "That file couldn't be read"));
        }
      }
    );
  };

  const outcome = recovery.outcome
    ? recovery.outcome.action === "export"
      ? describeExportResult(recovery.outcome.result)
      : describeVerifyResult(recovery.outcome.result)
    : null;
  const errorLabel =
    recovery.error?.action === "export"
      ? "Couldn't save the recovery kit"
      : "Couldn't verify the recovery kit";
  const announcement =
    recovery.pending === "export"
      ? "Saving the recovery kit…"
      : recovery.pending === "verify"
        ? "Verifying the recovery kit…"
        : outcome
          ? `${outcome.label}. ${outcome.detail}`
          : recovery.error
            ? `${errorLabel}. ${recovery.error.message}`
            : (kitError ?? "");

  return (
    <SettingsGroup>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <SettingsRow
        id="decisions-recovery-kit-status"
        label={verifiedAt !== undefined ? "Recovery kit verified" : "No recovery kit verified"}
        accessory={
          verifiedAt === undefined ? (
            <SeverityMark
              severity="warning"
              label="Not verified"
              className="h-3.5 w-3.5"
              decorative
            />
          ) : undefined
        }
        description={
          verifiedAt !== undefined
            ? `Last verified ${formatVerifiedAt(verifiedAt)}. Save and verify a new kit whenever you want another copy.`
            : "Setup finishes once a saved kit is verified. Without a kit or this computer's keys, nothing on the relay can be read again."
        }
      />
      <SettingsRow
        id="decisions-recovery-kit-save"
        label="Save a recovery kit"
        description={`A file holding this computer's Decisions keys, locked with a passphrase of at least ${MIN_KIT_PASSPHRASE_LENGTH} characters. Keep it somewhere other than this computer, such as a password manager. Daintree keeps neither the file nor the passphrase.`}
        layout="stacked"
        disabled={busy}
        control={({ labelId, descriptionId, disabled: rowDisabled }) => (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitExport();
            }}
          >
            <Input
              ref={exportField}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={1024}
              value={exportPassphrase}
              onChange={(event) => setExportPassphrase(event.target.value)}
              placeholder="Passphrase"
              aria-labelledby={labelId}
              aria-describedby={descriptionId}
              disabled={rowDisabled}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              loading={recovery.pending === "export"}
              disabled={rowDisabled || exportPassphrase.length < MIN_KIT_PASSPHRASE_LENGTH}
            >
              Save kit…
            </Button>
          </form>
        )}
      />
      <SettingsRow
        id="decisions-recovery-kit-verify"
        label="Verify a saved kit"
        description="Choose the kit file and enter its passphrase. Daintree checks that it opens and holds this computer's identity with every key it has now."
        layout="stacked"
        disabled={busy}
        error={kitError ?? undefined}
        control={({ labelId, descriptionId, disabled: rowDisabled }) => (
          <form
            className="flex flex-wrap items-center gap-2"
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            onSubmit={(event) => {
              event.preventDefault();
              submitVerify();
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Recovery kit file to verify"
              tabIndex={-1}
              onChange={chooseKit}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rowDisabled}
              aria-describedby={descriptionId}
              onClick={() => fileInput.current?.click()}
            >
              {kit ? "Choose another kit…" : "Choose kit…"}
            </Button>
            <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
              {kit?.name ?? "No kit chosen"}
            </span>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={1024}
              value={verifyPassphrase}
              onChange={(event) => setVerifyPassphrase(event.target.value)}
              placeholder="Passphrase"
              aria-label="Passphrase of the kit to verify"
              aria-describedby={descriptionId}
              className="w-52"
              disabled={rowDisabled}
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              loading={recovery.pending === "verify"}
              disabled={rowDisabled || !kit || verifyPassphrase === ""}
            >
              Verify kit
            </Button>
          </form>
        )}
      />
      {outcome && (
        <SettingsRow
          id="decisions-recovery-kit-outcome"
          label={outcome.label}
          accessory={
            <SeverityMark
              severity={outcome.severity}
              label={outcome.label}
              className="h-3.5 w-3.5"
              decorative
            />
          }
          description={outcome.detail}
        />
      )}
      {recovery.error && (
        <SettingsRow
          id="decisions-recovery-kit-outcome"
          label={errorLabel}
          accessory={
            <SeverityMark severity="error" label="Failed" className="h-3.5 w-3.5" decorative />
          }
          description={recovery.error.message}
        />
      )}
    </SettingsGroup>
  );
}
