import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { pluralize } from "@/lib/pluralize";
import { dismissWakeContinue } from "@/services/wakeContinue/wakeContinue";
import { useProjectStore } from "@/store/projectStore";
import { useWakeContinueStore } from "@/store/wakeContinueStore";
import { WakeContinueDialog } from "./WakeContinueDialog";
import { wakeOfferCounts } from "./wakeContinueStatus";

const BANNER_CLASS =
  "mx-1 mt-1 shrink-0 rounded-[var(--radius-sm)] border border-border-default bg-surface-panel";

/**
 * The offer to tell agents a restore resumed to carry on (#17883), at the top
 * of the panel grid. It asks once per wake: × withdraws it, and while notes
 * are going out × stops the ones that haven't gone in.
 */
export function WakeContinueNotice() {
  const offer = useWakeContinueStore((s) => s.offer);
  const setDialogOpen = useWakeContinueStore((s) => s.setDialogOpen);
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  if (!offer || offer.projectId !== projectId) return null;

  const { resumed, sent, settled } = wakeOfferCounts(offer);
  const agents = pluralize(resumed, "agent");
  const openDetails = () => setDialogOpen(true);

  const banner =
    offer.phase === "offered" ? (
      <InlineStatusBanner
        layout="strip"
        severity="info"
        role="status"
        title={`${resumed === 1 ? "1 agent" : agents} resumed ${resumed === 1 ? "its" : "their"} session`}
        description="Send a note telling them to pick up where they left off?"
        actions={[{ id: "review", label: "Review note", variant: "primary", onClick: openDetails }]}
        className={BANNER_CLASS}
        onClose={dismissWakeContinue}
        closeAriaLabel="Dismiss"
        closeTitle="Dismiss — nothing is sent"
        data-testid="wake-continue-notice"
      />
    ) : (
      <InlineStatusBanner
        layout="strip"
        severity="neutral"
        role="status"
        title={offer.phase === "sending" ? "Sending continue notes…" : "Continue notes finished"}
        description={`${sent} of ${agents} sent${
          offer.phase === "done" && settled > sent ? ` · ${settled - sent} not confirmed` : ""
        }`}
        actions={[{ id: "details", label: "Details", onClick: openDetails }]}
        className={BANNER_CLASS}
        onClose={dismissWakeContinue}
        closeAriaLabel={offer.phase === "sending" ? "Stop sending" : "Dismiss"}
        closeTitle={
          offer.phase === "sending" ? "Stop — notes not yet typed in aren't sent" : "Dismiss"
        }
        data-testid="wake-continue-notice"
      />
    );

  return (
    <>
      {banner}
      <WakeContinueDialog />
    </>
  );
}
