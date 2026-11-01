import { pluralize } from "@/lib/pluralize";
import type { DecisionsPolicy, DecisionsWorkflowGate } from "@shared/types/decisions";

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
      "The question has to carry screenshots, and the agent learns whether your phone showed you exactly the ones attached."
    );
  }
  return sentences.join(" ");
}

/** How long a question waits, and how long its agent can make it wait, as the library applies it. */
export function questionExpiryText(
  policy: Pick<DecisionsPolicy, "defaultQuestionExpiryMs" | "maxQuestionExpiryMs">
): string {
  const { defaultQuestionExpiryMs: wait, maxQuestionExpiryMs: max } = policy;
  const first =
    wait === null
      ? "A question waits for your answer until it's answered or cancelled, unless the agent that asked sets an expiry"
      : `A question waits ${questionWaitText(wait)} for your answer, unless the agent that asked sets another time`;
  const limit = max === null ? "" : `, at most ${questionWaitText(max)}`;
  return `${first}${limit}. An expired question authorises nothing, and the agent is told so.`;
}

/** What the proxy switch allows, given which registered gates still need the person. */
export function proxyAllowlistText(gates: readonly DecisionsWorkflowGate[]): string {
  const human = gates.filter((gate) => gate.requirement === "human-required").map((g) => g.id);
  const gated =
    human.length === 0
      ? "A question under a registered gate follows that gate's rule."
      : human.length === gates.length
        ? `A question under a registered gate (${human.join(", ")}) still needs your own answer.`
        : `A question under ${human.join(", ")} still needs your own answer.`;
  return `Lets a question without a registered workflow gate accept an answer from a decision model, when the agent that asked allows one. ${gated} No decision model is connected yet. Off by default.`;
}
