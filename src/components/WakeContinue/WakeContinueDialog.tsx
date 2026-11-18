import { useId, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Textarea } from "@/components/ui/textarea";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CONTINUE_NOTE,
  sendWakeContinueNotes,
  type WakeLiveOutcome,
} from "@/services/wakeContinue/wakeContinue";
import { useProjectStore } from "@/store/projectStore";
import { useWakeContinueStore, type WakeContinueOffer } from "@/store/wakeContinueStore";
import { logWarn } from "@/utils/logger";
import { useLiveWakeOutcomes, wakeEntryStatus, wakeOfferCounts } from "./wakeContinueStatus";

const TONE_CLASS = {
  muted: "text-text-secondary",
  ok: "text-text-primary",
  warn: "text-status-warning-text",
} as const;

/**
 * Review and send the continue note (#17883): the note, editable until it is
 * sent, and every agent the restore started again with what each gets.
 * Mounted once at the layout rather than with the grid strip, so the grid's
 * keys never reach the note and a layout change never resets it.
 */
export function WakeContinueDialog() {
  const offer = useWakeContinueStore((s) => s.offer);
  const isOpen = useWakeContinueStore((s) => s.dialogOpen);
  const setDialogOpen = useWakeContinueStore((s) => s.setDialogOpen);
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const outcomes = useLiveWakeOutcomes(offer);
  if (!offer || offer.projectId !== projectId) return null;
  return (
    <WakeContinueDialogBody
      // A newer wake starts from the default note again.
      key={offer.id}
      offer={offer}
      outcomes={outcomes}
      isOpen={isOpen}
      onClose={() => setDialogOpen(false)}
    />
  );
}

function WakeContinueDialogBody({
  offer,
  outcomes,
  isOpen,
  onClose,
}: {
  offer: WakeContinueOffer;
  outcomes: readonly WakeLiveOutcome[];
  isOpen: boolean;
  onClose: () => void;
}) {
  const [note, setNote] = useState(DEFAULT_CONTINUE_NOTE);
  const noteId = useId();
  const agentsLabelId = useId();
  const counts = wakeOfferCounts(offer, outcomes);
  const editable = offer.phase === "offered";
  const blank = note.trim() === "";

  const send = () => {
    onClose();
    void sendWakeContinueNotes(note).catch((error: unknown) =>
      logWarn("[WakeContinue] Sending continue notes failed", { error })
    );
  };

  const hint = !editable
    ? undefined
    : blank
      ? "Write a note to send"
      : counts.resumed === 0
        ? "No agent has resumed its session yet"
        : undefined;

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" data-testid="wake-continue-dialog">
      <AppDialog.Header>
        <AppDialog.Title>Continue resumed agents</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body className="space-y-4">
        <AppDialog.Description>
          Each agent gets the note once its resumed session is waiting at its prompt, a few at a
          time. Agents that started a new session, haven't resumed, or were typed in since get
          nothing.
        </AppDialog.Description>
        <div className="space-y-1.5">
          <label htmlFor={noteId} className={SECTION_LABEL_CLASS}>
            Note
          </label>
          <Textarea
            id={noteId}
            className="h-24"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={!editable}
            data-testid="wake-continue-note"
          />
        </div>
        <div className="space-y-1.5">
          <div id={agentsLabelId} className={SECTION_LABEL_CLASS}>
            Agents
          </div>
          {!editable && (
            <p className="text-xs text-text-secondary" role="status" aria-live="polite">
              {counts.sent} of {pluralize(counts.resumed, "agent")} sent
            </p>
          )}
          <ul
            aria-labelledby={agentsLabelId}
            className="space-y-1 text-sm"
            data-testid="wake-continue-entries"
          >
            {offer.entries.map((entry, index) => {
              const status = wakeEntryStatus(entry, outcomes[index] ?? "closed", offer.phase);
              return (
                <li
                  key={entry.terminalId}
                  data-terminal-id={entry.terminalId}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="min-w-24 shrink truncate text-text-primary">{entry.title}</span>
                  <span className={cn("min-w-0 text-right text-xs", TONE_CLASS[status.tone])}>
                    {status.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </AppDialog.Body>
      <AppDialog.Footer
        hint={hint}
        secondaryAction={{ label: editable ? "Cancel" : "Close", onClick: onClose }}
        primaryAction={
          editable
            ? {
                label: `Send to ${pluralize(counts.resumed, "agent")}`,
                onClick: send,
                disabled: blank || counts.resumed === 0,
              }
            : undefined
        }
      />
    </AppDialog>
  );
}
