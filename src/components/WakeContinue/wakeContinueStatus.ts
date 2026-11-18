import type { WakeContinueEntry, WakeContinueOffer } from "@/store/wakeContinueStore";

/** What one pane's row says, in the offer's current phase. */
export function wakeEntryStatus(
  entry: WakeContinueEntry,
  phase: WakeContinueOffer["phase"]
): { label: string; tone: "muted" | "ok" | "warn" } {
  if (entry.outcome === "fresh") {
    return { label: "Started a new session — no note", tone: "warn" };
  }
  if (entry.outcome === "held") {
    return { label: "Not resumed yet — no note", tone: "muted" };
  }
  const delivery = entry.delivery;
  if (!delivery) {
    return phase === "offered"
      ? { label: "Resumed", tone: "muted" }
      : phase === "sending"
        ? { label: "Waiting its turn", tone: "muted" }
        : { label: "Not sent", tone: "warn" };
  }
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

/** Counts the notice and the dialog report. */
export function wakeOfferCounts(offer: WakeContinueOffer): {
  resumed: number;
  sent: number;
  settled: number;
} {
  let resumed = 0;
  let sent = 0;
  let settled = 0;
  for (const entry of offer.entries) {
    if (entry.outcome !== "resumed") continue;
    resumed++;
    const status = entry.delivery?.status;
    if (status === "sent") sent++;
    if (status === "sent" || status === "unconfirmed" || status === "failed") settled++;
  }
  return { resumed, sent, settled };
}
