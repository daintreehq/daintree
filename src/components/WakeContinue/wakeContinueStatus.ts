import { useShallow } from "zustand/react/shallow";
import { liveWakeOutcome, type WakeLiveOutcome } from "@/services/wakeContinue/wakeContinue";
import { usePanelStore } from "@/store/panelStore";
import type { WakeContinueEntry, WakeContinueOffer } from "@/store/wakeContinueStore";

/** Each entry's live outcome, in entry order; re-renders only when one changes. */
export function useLiveWakeOutcomes(offer: WakeContinueOffer | null): WakeLiveOutcome[] {
  return usePanelStore(
    useShallow((state) =>
      (offer?.entries ?? []).map((entry) =>
        liveWakeOutcome(entry, state.panelsById[entry.terminalId])
      )
    )
  );
}

/** What one pane's row says, in the offer's current phase. */
export function wakeEntryStatus(
  entry: WakeContinueEntry,
  outcome: WakeLiveOutcome,
  phase: WakeContinueOffer["phase"]
): { label: string; tone: "muted" | "ok" | "warn" } {
  const delivery = entry.delivery;
  if (delivery) {
    switch (delivery.status) {
      case "queued":
      case "starting":
        return { label: "Waiting for its prompt", tone: "muted" };
      case "needs-you":
        return { label: "Waiting on you before the note can go in", tone: "warn" };
      case "sending":
        return { label: "Sending…", tone: "muted" };
      case "sent":
        return { label: "Sent", tone: "ok" };
      case "unconfirmed":
        return { label: "Typed in, delivery unconfirmed", tone: "warn" };
      case "failed":
        return { label: delivery.message, tone: "warn" };
    }
  }
  switch (outcome) {
    case "fresh":
      return { label: "Started a new session — no note", tone: "warn" };
    case "held":
      return { label: "Not resumed yet — no note", tone: "muted" };
    case "restarted":
      return { label: "Restarted since — no note", tone: "muted" };
    case "closed":
      return { label: "Closed — no note", tone: "muted" };
    case "resumed":
      return phase === "offered"
        ? { label: "Resumed", tone: "muted" }
        : { label: "Not sent", tone: "warn" };
  }
}

/** Counts the notice and the dialog report. */
export function wakeOfferCounts(
  offer: WakeContinueOffer,
  outcomes: readonly WakeLiveOutcome[]
): { resumed: number; held: number; sent: number; unconfirmed: number; failed: number } {
  const counts = { resumed: 0, held: 0, sent: 0, unconfirmed: 0, failed: 0 };
  offer.entries.forEach((entry, index) => {
    const status = entry.delivery?.status;
    if (status === "sent") counts.sent++;
    // A partial write may have left text in the input: not the same as nothing sent.
    else if (
      status === "unconfirmed" ||
      (entry.delivery?.status === "failed" && entry.delivery.partial === true)
    ) {
      counts.unconfirmed++;
    } else if (status === "failed") counts.failed++;
    // Once sending starts, the panes counted are the ones it took on, whatever
    // they have done since; a pane started afterwards was never one of them.
    if (offer.phase === "offered" ? outcomes[index] === "resumed" : status !== undefined) {
      counts.resumed++;
    } else if (
      outcomes[index] === "held" &&
      entry.holdReason === "resume-deferred" &&
      entry.heldSessionId !== undefined
    ) {
      counts.held++;
    }
  });
  return counts;
}
