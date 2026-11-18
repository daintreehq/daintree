import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { pluralize } from "@/lib/pluralize";
import { dismissWakeContinue } from "@/services/wakeContinue/wakeContinue";
import { useProjectStore } from "@/store/projectStore";
import { useWakeContinueStore } from "@/store/wakeContinueStore";
import { useLiveWakeOutcomes, wakeOfferCounts } from "./wakeContinueStatus";

const BANNER_CLASS =
  "mx-1 mt-1 shrink-0 rounded-[var(--radius-sm)] border border-border-default bg-surface-panel";

/**
 * The offer to tell agents a restore resumed to carry on (#17883), at the top
 * of the panel grid. It asks once per wake: × withdraws it, and while notes
 * are going out × stops the ones that haven't gone in. The review dialog is
 * mounted at the layout, outside the grid and its keys.
 */
export function WakeContinueNotice() {
  const offer = useWakeContinueStore((s) => s.offer);
  const setDialogOpen = useWakeContinueStore((s) => s.setDialogOpen);
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const outcomes = useLiveWakeOutcomes(offer);
  if (!offer || offer.projectId !== projectId) return null;

  const { resumed, held, sent, unconfirmed, failed } = wakeOfferCounts(offer, outcomes);
  // One id across phases, so focus returns to the same button after sending.
  const openDetails = { id: "details", onClick: () => setDialogOpen(true) };

  if (offer.phase === "offered") {
    const title =
      resumed > 0
        ? `${pluralize(resumed, "agent")} resumed`
        : `${pluralize(held, "agent")} waiting to resume`;
    const description =
      resumed === 0
        ? "Start them on their sessions, then send a note to pick up where they left off."
        : resumed === 1
          ? "Send it a note to pick up where it left off?"
          : "Send them a note to pick up where they left off?";
    return (
      <InlineStatusBanner
        layout="strip"
        severity="info"
        role="status"
        title={title}
        description={description}
        actions={[{ ...openDetails, label: "Review note", variant: "primary" }]}
        className={BANNER_CLASS}
        onClose={dismissWakeContinue}
        closeAriaLabel="Dismiss"
        closeTitle="Dismiss — nothing is sent"
        data-testid="wake-continue-notice"
      />
    );
  }

  const notes = [
    `${sent} of ${pluralize(resumed, "agent")} sent`,
    unconfirmed > 0 ? `${unconfirmed} unconfirmed` : null,
    failed > 0 ? `${failed} not sent` : null,
  ].filter((part): part is string => part !== null);
  return (
    <InlineStatusBanner
      layout="strip"
      severity="neutral"
      role="status"
      title={offer.phase === "sending" ? "Sending continue notes…" : "Continue notes finished"}
      description={notes.join(" · ")}
      actions={[{ ...openDetails, label: "Details" }]}
      className={BANNER_CLASS}
      onClose={dismissWakeContinue}
      closeAriaLabel={offer.phase === "sending" ? "Stop sending" : "Dismiss"}
      closeTitle={
        offer.phase === "sending" ? "Stop — notes not yet typed in aren't sent" : "Dismiss"
      }
      data-testid="wake-continue-notice"
    />
  );
}
