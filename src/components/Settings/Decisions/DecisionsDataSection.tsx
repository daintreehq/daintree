import { useEffect, useEffectEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SeverityMark } from "@/lib/statusSeverity";
import type { DecisionsStatus } from "@shared/types/decisions";
import { DecisionsDisclosure } from "./DecisionsDisclosure";
import { DecisionsDisclosureToggle } from "./DecisionsDisclosureToggle";
import { DecisionsRecoveryKit } from "./DecisionsRecoveryKit";
import { DecisionsExportDialog } from "./DecisionsExportDialog";
import { DecisionsDeleteRelayDialog } from "./DecisionsDeleteRelayDialog";
import { DecisionsDeleteLocalDialog } from "./DecisionsDeleteLocalDialog";
import { DecisionsRemoveHistoryDialog } from "./DecisionsRemoveHistoryDialog";
import { useDecisionsData, type DecisionsDataOutcome } from "./useDecisionsData";
import { useLinkedDisclosure } from "./useLinkedDisclosure";
import {
  describeExportResult,
  describeHistoryRemoveResult,
  describeLocalDeleteResult,
  describeRelayDeleteResult,
} from "./decisionsDataCopy";
import type { RelayObservation } from "./relayCheckCopy";

type OpenDialog = "export" | "remove-history" | "delete-relay" | "delete-local" | null;

function describeOutcome(outcome: DecisionsDataOutcome): RelayObservation | null {
  switch (outcome.action) {
    case "export":
      return describeExportResult(outcome.result);
    case "remove-history":
      return describeHistoryRemoveResult(outcome.result);
    case "delete-relay":
      return describeRelayDeleteResult(outcome.result);
    case "delete-local":
      return describeLocalDeleteResult(outcome.result);
  }
}

/**
 * Data: once a relay is set up, its recovery kit to save and verify at any
 * time (#16007); what's sent and where, the same list the consent dialog
 * showed, folded away until asked for, with the note on dictating answers
 * beside it; then exporting the decision history, removing this computer's
 * settled questions (#18033) and deleting the relay's stored content or this
 * computer's Decisions data (#16025). Each action says what main observed it
 * do, on its own row; the removal and the deletions sit last, apart.
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
  // Keys an interrupted deletion set aside are keys too: deleting puts them back, then deletes them.
  const keysStored = status.keysStored === true || status.keysVersion !== undefined;
  const data = useDecisionsData((next) => onChanged?.(next));
  const [open, setOpen] = useState<OpenDialog>(null);
  const busy = locked || data.pending !== null;
  const sentPanelId = useId();
  // Only a search for it opens the list: the relay-removal banner links to this
  // section to retry the deletions below, which the list would push down.
  const [sentOpen, setSentOpen] = useLinkedDisclosure(["decisions-data"], {
    initial: false,
    searchOnly: true,
  });

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
          : data.pending === "remove-history"
            ? "Removing settled questions…"
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
          description="What Decisions sends to your relay, and what the relay can read"
          control={({ labelId }) => (
            <div>
              <DecisionsDisclosureToggle
                open={sentOpen}
                onToggle={() => setSentOpen(!sentOpen)}
                controls={sentPanelId}
                labelId={labelId}
              >
                Details
              </DecisionsDisclosureToggle>
              <div id={sentPanelId}>{sentOpen && <DecisionsDisclosure className="mt-3" />}</div>
            </div>
          )}
        />
        <SettingsRow
          id="decisions-voice"
          label="Dictating answers"
          description="Set in the phone app. It isn't end-to-end encrypted: a speech provider hears what you say and a correction provider reads the transcript with the question. The answer you send is still encrypted."
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
        <SettingsRow
          id="decisions-data-remove-history"
          label="Remove settled questions"
          description="Removes the questions in History whose deliveries are finished from this computer, with their answers. Open questions, keys, the relay and enrolled Hosts stay."
          disabled={busy}
          control={({ descriptionId, disabled }) => (
            <Button
              variant="ghost-danger"
              size="sm"
              disabled={disabled}
              aria-describedby={descriptionId}
              onClick={() => {
                data.reset();
                setOpen("remove-history");
              }}
            >
              Remove settled questions
            </Button>
          )}
        />
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
      <DecisionsRemoveHistoryDialog
        isOpen={open === "remove-history"}
        removing={data.pending === "remove-history"}
        error={errorFor("remove-history")}
        onCancel={close}
        onConfirm={() => {
          data.removeSettledQuestions().then(finish, () => {});
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
        keysVersion={status.keysVersion}
        kitCurrent={status.recoveryKitCurrent === true}
        deleting={data.pending === "delete-local"}
        error={errorFor("delete-local")}
        onCancel={close}
        onConfirm={(oneClick) => {
          data
            .deleteLocalData({ oneClick, relayOrigin, keys: status.keysVersion ?? null })
            .then(finish, () => {});
        }}
      />
    </SettingsSection>
  );
}
