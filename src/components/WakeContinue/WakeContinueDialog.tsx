import { useId, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Textarea } from "@/components/ui/textarea";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { DEFAULT_CONTINUE_NOTE, sendWakeContinueNotes } from "@/services/wakeContinue/wakeContinue";
import { useWakeContinueStore, type WakeContinueOffer } from "@/store/wakeContinueStore";
import { logWarn } from "@/utils/logger";
import { wakeEntryStatus, wakeOfferCounts } from "./wakeContinueStatus";

const TONE_CLASS = {
  muted: "text-text-secondary",
  ok: "text-text-primary",
  warn: "text-status-warning",
} as const;

/**
 * Review and send the continue note (#17883): the note, editable until it is
 * sent, and every agent the restore started again with what each gets.
 */
export function WakeContinueDialog() {
  const offer = useWakeContinueStore((s) => s.offer);
  const isOpen = useWakeContinueStore((s) => s.dialogOpen);
  const setDialogOpen = useWakeContinueStore((s) => s.setDialogOpen);
  if (!offer) return null;
  return (
    <WakeContinueDialogBody
      // A newer wake starts from the default note again.
      key={offer.id}
      offer={offer}
      isOpen={isOpen}
      onClose={() => setDialogOpen(false)}
    />
  );
}

function WakeContinueDialogBody({
  offer,
  isOpen,
  onClose,
}: {
  offer: WakeContinueOffer;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [note, setNote] = useState(DEFAULT_CONTINUE_NOTE);
  const noteId = useId();
  const { resumed } = wakeOfferCounts(offer);
  const editable = offer.phase === "offered";
  const blank = note.trim() === "";

  const send = () => {
    onClose();
    void sendWakeContinueNotes(note).catch((error: unknown) =>
      logWarn("[WakeContinue] Sending continue notes failed", { error })
    );
  };

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" data-testid="wake-continue-dialog">
      <AppDialog.Header>
        <AppDialog.Title>Continue resumed agents</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body className="space-y-4">
        <AppDialog.Description>
          {editable
            ? "Each agent gets the note once its resumed session is waiting at its prompt, a few at a time. Agents that started a new session or haven't resumed get nothing."
            : "The note goes to each agent once its resumed session is waiting at its prompt, a few at a time."}
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
          <div className={SECTION_LABEL_CLASS}>Agents</div>
          <ul className="space-y-1 text-sm" data-testid="wake-continue-entries">
            {offer.entries.map((entry) => {
              const status = wakeEntryStatus(entry, offer.phase);
              return (
                <li key={entry.terminalId} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-text-primary">{entry.title}</span>
                  <span className={cn("shrink-0 text-xs", TONE_CLASS[status.tone])}>
                    {status.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </AppDialog.Body>
      <AppDialog.Footer
        hint={editable && blank ? "Write a note to send" : undefined}
        secondaryAction={{ label: editable ? "Cancel" : "Close", onClick: onClose }}
        primaryAction={
          editable
            ? {
                label: `Send to ${pluralize(resumed, "agent")}`,
                onClick: send,
                disabled: blank || resumed === 0,
              }
            : undefined
        }
      />
    </AppDialog>
  );
}
