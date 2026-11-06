import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import type { DecisionsStatus } from "@shared/types/decisions";
import { DecisionsDisclosure } from "./DecisionsDisclosure";
import { DecisionsRecoveryKit } from "./DecisionsRecoveryKit";
import { DecisionsExportDialog } from "./DecisionsExportDialog";
import { DecisionsDeleteRelayDialog } from "./DecisionsDeleteRelayDialog";
import { DecisionsDeleteLocalDialog } from "./DecisionsDeleteLocalDialog";
import { useDecisionsData, type DecisionsDataOutcome } from "./useDecisionsData";
import {
  describeExportResult,
  describeLocalDeleteResult,
  describeRelayDeleteResult,
} from "./decisionsDataCopy";
import type { RelayObservation } from "./relayCheckCopy";

type OpenDialog = "export" | "delete-relay" | "delete-local" | null;

function describeOutcome(outcome: DecisionsDataOutcome): RelayObservation | null {
  switch (outcome.action) {
    case "export":
      return describeExportResult(outcome.result);
    case "delete-relay":
      return describeRelayDeleteResult(outcome.result);
    case "delete-local":
      return describeLocalDeleteResult(outcome.result);
  }
}

/**
 * Data: once a relay is set up, its recovery kit to save and verify at any
 * time (#16007); what's sent and where, the same list the consent dialog
 * showed; then exporting the decision history and deleting the relay's
 * stored content or this computer's Decisions data (#16025). Each action says what main
 * observed it do, on its own row; the deletions sit last, apart.
 */
export function DecisionsDataSection({
  status,
  locked = false,
  onChanged,
  onStatus,
  kitFocusRequest = 0,
  onKitFocused,
}: {
  status: DecisionsStatus;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
  /** A local deletion settled: main's status when it said, null when it didn't. */
  onChanged?: (status: DecisionsStatus | null) => void;
  /** Main answered with a newer status: a kit was verified. */
  onStatus?: (status: DecisionsStatus) => void;
  /** Bumped when setup asks for the recovery kit. */
  kitFocusRequest?: number;
  /** The request was met, so a later mount doesn't take focus again. */
  onKitFocused?: () => void;
}) {
  const relayOrigin = status.relayOrigin ?? null;
  const keysStored = status.keysStored === true;
  const data = useDecisionsData((next) => onChanged?.(next));
  const [open, setOpen] = useState<OpenDialog>(null);
  const busy = locked || data.pending !== null;

  // A relay set up or removed since leaves the last relay outcome about another relay.
  const forget = useEffectEvent(() => {
    if (data.outcome?.action === "delete-relay") data.reset();
    if (open === "delete-relay") setOpen(null);
  });
  useEffect(() => {
    forget();
  }, [relayOrigin]);

  const observation = data.outcome ? describeOutcome(data.outcome) : null;
  const errorFor = (action: DecisionsDataOutcome["action"]) =>
    data.error?.action === action ? data.error.message : null;
  const finish = (done: boolean) => {
    if (done) setOpen(null);
  };
  const close = () => {
    if (data.pending === null) setOpen(null);
  };

  return (
    <SettingsSection title="Data" id="decisions-data">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {data.pending === "export"
          ? "Exporting the decision history…"
          : data.pending === "delete-relay"
            ? "Deleting the relay's data…"
            : data.pending === "delete-local"
              ? "Deleting this computer's Decisions data…"
              : observation
                ? `${observation.label}. ${observation.detail}`
                : ""}
      </span>
      {relayOrigin !== null && (
        <DecisionsRecoveryKit
          status={status}
          disabled={busy}
          onVerified={(next) => onStatus?.(next)}
          focusRequest={kitFocusRequest}
          onFocused={() => onKitFocused?.()}
        />
      )}
      <SettingsGroup>
        <SettingsRow
          id="decisions-data-sent"
          layout="stacked"
          label="What's sent, and where"
          description={<DecisionsDisclosure className="mt-2" />}
        />
        <SettingsRow
          id="decisions-data-export"
          label="Export decision history"
          description="Saves every question and answer stored on this computer, with the audit log, to a file you pick, encrypted with a passphrase"
          disabled={busy}
          control={({ descriptionId, disabled }) => (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-describedby={descriptionId}
              onClick={() => {
                data.reset();
                setOpen("export");
              }}
            >
              Export…
            </Button>
          )}
        />
        {observation && (
          <SettingsRow
            id="decisions-data-outcome"
            label={observation.label}
            accessory={
              <SeverityMark
                severity={observation.severity}
                label={observation.label}
                className="h-3.5 w-3.5"
                decorative
              />
            }
            description={<span className="select-text">{observation.detail}</span>}
          />
        )}
      </SettingsGroup>
      <SettingsGroup>
        {relayOrigin !== null && (
          <SettingsRow
            id="decisions-data-delete-relay"
            label="Delete relay data"
            description="Permanently deletes the questions, answers and attachments the relay stores. The Worker, its paired devices and this computer's history stay."
            disabled={busy}
            control={({ descriptionId, disabled }) => (
              <Button
                variant="ghost-danger"
                size="sm"
                disabled={disabled}
                aria-describedby={descriptionId}
                onClick={() => {
                  data.reset();
                  setOpen("delete-relay");
                }}
              >
                Delete relay data
              </Button>
            )}
          />
        )}
        <SettingsRow
          id="decisions-data-delete-local"
          label="Delete local data"
          description="Deletes this computer's decision history, Decisions keys and record of the relay. Nothing on the relay changes."
          disabled={busy}
          control={({ descriptionId, disabled }) => (
            <Button
              variant="ghost-danger"
              size="sm"
              disabled={disabled}
              aria-describedby={descriptionId}
              onClick={() => {
                data.reset();
                setOpen("delete-local");
              }}
            >
              Delete local data
            </Button>
          )}
        />
      </SettingsGroup>
      <DecisionsExportDialog
        isOpen={open === "export"}
        exporting={data.pending === "export"}
        error={errorFor("export")}
        onCancel={close}
        onExport={(passphrase) => {
          data.exportHistory(passphrase).then(finish, () => {});
        }}
      />
      {relayOrigin !== null && (
        <DecisionsDeleteRelayDialog
          isOpen={open === "delete-relay"}
          relayOrigin={relayOrigin}
          deleting={data.pending === "delete-relay"}
          error={errorFor("delete-relay")}
          onCancel={close}
          onConfirm={() => {
            data.deleteRelayData(relayOrigin).then(finish, () => {});
          }}
        />
      )}
      <DecisionsDeleteLocalDialog
        isOpen={open === "delete-local"}
        relayOrigin={relayOrigin}
        keysStored={keysStored}
        deleting={data.pending === "delete-local"}
        error={errorFor("delete-local")}
        onCancel={close}
        onConfirm={() => {
          data.deleteLocalData().then(finish, () => {});
        }}
      />
    </SettingsSection>
  );
}
