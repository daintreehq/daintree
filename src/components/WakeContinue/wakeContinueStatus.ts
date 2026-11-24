import { useShallow } from "zustand/react/shallow";
import { makeDraftKey } from "@/lib/draftKey";
import { pluralize } from "@/lib/pluralize";
import { wakeEntryOutcome, type WakeRowOutcome } from "@/services/wakeContinue/wakeContinue";
import { useLastComposerSendStore } from "@/store/lastComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import type { WakeContinueEntry, WakeContinueOffer } from "@/store/wakeContinueStore";

export type { WakeRowOutcome };

/** Each entry's outcome, in entry order, read the way sending will read it. */
export function useLiveWakeOutcomes(offer: WakeContinueOffer | null): WakeRowOutcome[] {
  const sends = useLastComposerSendStore((state) => state.sends);
  const drafts = useTerminalInputStore((state) => state.draftInputs);
  const panels = usePanelStore(
    useShallow((state) => (offer?.entries ?? []).map((entry) => state.panelsById[entry.terminalId]))
  );
  return (offer?.entries ?? []).map((entry, index) =>
    wakeEntryOutcome(
      entry,
      panels[index],
      sends[entry.terminalId]?.seq,
      drafts.get(makeDraftKey(entry.terminalId, offer?.projectId)) ?? ""
    )
  );
}

export type WakeRowTone = "muted" | "ok" | "warn";

/**
 * What one pane's row says, in the offer's current phase. Once sending starts,
 * a pane it left out keeps the reason it had then, whatever it has done since.
 * `includedLabel` is what an offered pane that gets the note says.
 */
export function wakeEntryStatus(
  entry: WakeContinueEntry,
  live: WakeRowOutcome,
  phase: WakeContinueOffer["phase"],
  includedLabel = ""
): { label: string; tone: WakeRowTone } {
  const delivery = entry.delivery;
  const outcome = phase !== "offered" && entry.skippedAs ? entry.skippedAs : live;
  if (delivery) {
    switch (delivery.status) {
      // The wake's scheduler holds a pane as starting until it settles at its
      // prompt, and as queued once it is there and every slot is taken.
      case "starting":
        return { label: "Waiting for its prompt", tone: "muted" };
      case "queued":
        return { label: "Waiting its turn", tone: "muted" };
      case "needs-you":
        return { label: "Needs your answer first", tone: "warn" };
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
    case "messaged":
      return { label: "Messaged since — no note", tone: "muted" };
    case "drafted":
      return { label: "Has a draft in its input — no note", tone: "muted" };
    case "closed":
      return { label: "Closed — no note", tone: "muted" };
    case "resumed":
      return phase === "offered"
        ? { label: includedLabel, tone: "muted" }
        : { label: "Not sent", tone: "warn" };
  }
}

export interface WakeOfferCounts {
  resumed: number;
  held: number;
  sent: number;
  unconfirmed: number;
  failed: number;
  needsYou: number;
  /** Taken on and not settled yet: waiting for a prompt or a slot, or going in. */
  pending: number;
}

/** Counts the notice and the dialog report. */
export function wakeOfferCounts(
  offer: WakeContinueOffer,
  outcomes: readonly WakeRowOutcome[]
): WakeOfferCounts {
  const counts = {
    resumed: 0,
    held: 0,
    sent: 0,
    unconfirmed: 0,
    failed: 0,
    needsYou: 0,
    pending: 0,
  };
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
    else if (status === "needs-you") counts.needsYou++;
    else if (status !== undefined) counts.pending++;
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

/** The one-line delivery report: the phase, then what went in and what needs a look. */
export function wakeDeliverySummary(
  phase: WakeContinueOffer["phase"],
  counts: WakeOfferCounts
): string {
  const parts = [
    phase === "sending" ? "Sending" : "Finished",
    `${counts.sent} of ${pluralize(counts.resumed, "agent")} sent`,
    phase === "sending" && counts.pending > 0 ? `${counts.pending} to go` : null,
    counts.needsYou > 0
      ? `${counts.needsYou} ${counts.needsYou === 1 ? "needs" : "need"} you`
      : null,
    counts.unconfirmed > 0 ? `${counts.unconfirmed} unconfirmed` : null,
    counts.failed > 0 ? `${counts.failed} not sent` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}
