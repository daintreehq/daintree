import { pluralize } from "@/lib/pluralize";
import type { DecisionsWorkflowGate } from "@shared/types/decisions";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A span as the largest whole unit it fills: "7 days", "12 hours", "30 minutes". */
export function questionWaitText(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) return pluralize(ms / DAY_MS, "day");
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return pluralize(ms / HOUR_MS, "hour");
  return pluralize(Math.max(1, Math.round(ms / MINUTE_MS)), "minute");
}

function either(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
}

/** What a gate asks of whoever answers, as observed from how Daintree registered it. */
export function gateDescription(gate: DecisionsWorkflowGate): string {
  const who = gate.requirement === "human-required" ? "Only you can answer" : "A proxy may answer";
  const labels = gate.choices.map((choice) => choice.label);
  const what =
    labels.length === 0
      ? ""
      : gate.allowsText
        ? `: ${either(labels)}, with a note if you like`
        : `: ${either(labels)}, and nothing else`;
  const sentences = [`${who}${what}.`];
  if (gate.bindsAttachments) {
    sentences.push(
      "The question has to carry screenshots, and the agent learns whether the ones you reviewed are exactly the ones attached."
    );
  }
  return sentences.join(" ");
}
