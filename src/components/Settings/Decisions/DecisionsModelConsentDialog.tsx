import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { MODEL_ADAPTERS } from "./decisionModelCopy";

interface DecisionsModelConsentDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  onAccept: () => void;
}

const DESTINATIONS = Object.values(MODEL_ADAPTERS)
  .map(({ label, provider }) => `${label} to ${provider}`)
  .join(", ");

/**
 * Shown the first time learning is turned on (#16027): its own agreement,
 * apart from Decisions', since learning keeps the person's answers in clear
 * and an agent CLI can send them on. Learning stays off behind it: only
 * "Turn on learning" turns it on.
 */
export function DecisionsModelConsentDialog({
  isOpen,
  onCancel,
  onAccept,
}: DecisionsModelConsentDialogProps) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="default"
      size="md"
      title="Turn on learning?"
      description="The decision model learns from your answers so it can answer the way you would. Nothing is sent until you choose an agent CLI for it."
      confirmLabel="Turn on learning"
      cancelLabel="Cancel"
      onConfirm={onAccept}
    >
      <ul className="space-y-2 text-xs text-text-secondary select-text">
        <li>
          <span className="font-medium text-text-primary">
            Kept on this computer, not encrypted.
          </span>{" "}
          Each question you answer from your phone, with its context and options, your answer and
          any note, its project and when it was asked and answered, stored beside the Decisions keys
          with the model&apos;s latest evaluation. Credentials in common formats (API keys, tokens,
          private keys, passwords in settings lines) are removed before anything is kept; other
          sensitive text stays.
        </li>
        <li>
          <span className="font-medium text-text-primary">
            Sent only through the agent CLI you choose.
          </span>{" "}
          When the model is asked a question or evaluated, that CLI sends the question, its context
          and options, and your past answers like it to its provider ({DESTINATIONS}, unless the
          CLI is set up to use another), using its own sign-in and settings on this computer. An
          evaluation sends your past questions and answers to it, one at a time.
        </li>
        <li>
          <span className="font-medium text-text-primary">Answers only once you allow it.</span> It
          answers in your place only after you&apos;ve seen its evaluation and chosen the confidence
          it answers from, and only questions that allow a proxy answer. Its answers are labelled as
          a proxy&apos;s.
        </li>
        <li>Turning learning off keeps what it learned. Clear history deletes it.</li>
      </ul>
    </ConfirmDialog>
  );
}
