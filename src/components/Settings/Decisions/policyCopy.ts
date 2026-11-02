import { pluralize } from "@/lib/pluralize";
import type { DecisionsPolicy, DecisionsWorkflowGate } from "@shared/types/decisions";
import { DEFAULT_QUESTION_EXPIRY_MS } from "@shared/config/decisionsQuestionExpiry";

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
  if (!gate.bindsAttachments) return `${who}${what}`;
  // Several sentences, so each one ends with a period.
  return `${who}${what}. The question has to carry screenshots, and the agent learns whether your phone showed you exactly the ones attached.`;
}

/** A default expiry as Settings offers it: a span, or "Never". */
export function questionExpiryLabel(ms: number | null): string {
  return ms === null ? "Never" : questionWaitText(ms);
}

/**
 * How long a question waits, and how long its agent can make it wait, as the
 * library applies the saved default, and where that default doesn't reach.
 */
export function questionExpiryText(
  policy: Pick<DecisionsPolicy, "defaultQuestionExpiryMs" | "maxQuestionExpiryMs">
): string {
  const { defaultQuestionExpiryMs: wait, maxQuestionExpiryMs: max } = policy;
  const first =
    wait === null
      ? "A question waits for your answer until it's answered or cancelled, unless the agent that asked sets an expiry"
      : `A question waits ${questionWaitText(wait)} for your answer, unless the agent that asked sets another time`;
  const limit = max === null ? "" : `, at most ${questionWaitText(max)}`;
  // A Host's lifetime runs on the library's defaults; the owner's choice isn't sent to it.
  const host = `Questions asked on a Remote Host still wait ${questionWaitText(DEFAULT_QUESTION_EXPIRY_MS)} by default.`;
  return `${first}${limit}. ${host} An expired question authorises nothing, and the agent is told so.`;
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
  return `Lets a question without a registered workflow gate accept an answer from the decision model on this computer, when the agent that asked allows one. ${gated} The model answers only once it has been evaluated against your own past answers, and its answers are labelled as a proxy's. Off by default.`;
}
