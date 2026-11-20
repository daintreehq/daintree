import { pluralize } from "@/lib/pluralize";
import type {
  DecisionsAttentionItem,
  DecisionsHostAttentionResult,
} from "@shared/types/decisionsAttention";
import { deliverySubjectPlural } from "@shared/utils/decisionsDeliveryReasons";
import { aliasLabel, type AttentionSubject } from "./decisionsAttentionModel";

/**
 * What the inbox says about a Remote Host's stopped delivery (#18031) beside
 * what the Host itself offers: what its controls act on, what to do when it
 * can't be resolved from here, and what became of an action the Host never
 * answered.
 */

/**
 * Why a Host's stopped delivery can't be resolved from here now:
 *
 * - `needs-update`: the Host's Daintree is from before it could be.
 * - `disconnected`: there's no link to the Host.
 * - `not-running`: the Host's Decisions isn't serving this computer, or isn't running.
 * - `too-large`: what the Host would show doesn't fit one reply.
 * - `unlisted`: no Host this computer knows lists the question now.
 */
export type HostAttentionUnavailable =
  "needs-update" | "disconnected" | "not-running" | "too-large" | "unlisted";

/** What a read answered, as the inbox shows it. */
export type HostAttentionRead =
  | {
      kind: "item";
      item: NonNullable<Extract<DecisionsHostAttentionResult, { result: "read" }>["item"]>;
    }
  /** Nothing of the question needs a person any more. */
  | { kind: "gone" }
  | { kind: "unavailable"; reason: HostAttentionUnavailable }
  /** The Host couldn't be read now: worth another try. */
  | { kind: "failed" };

export function hostAttentionReadOf(result: DecisionsHostAttentionResult): HostAttentionRead {
  switch (result.result) {
    case "read":
      return result.item === null ? { kind: "gone" } : { kind: "item", item: result.item };
    case "off":
    case "not-running":
      return { kind: "unavailable", reason: "not-running" };
    case "too-large":
      return { kind: "unavailable", reason: "too-large" };
    case "no-host":
      return { kind: "unavailable", reason: "unlisted" };
    case "unreachable":
      return result.failure === "needs-update" || result.failure === "disconnected"
        ? { kind: "unavailable", reason: result.failure }
        : { kind: "failed" };
    // Never the answer to a read.
    case "copied":
    case "acted":
      return { kind: "failed" };
  }
}

/** A plain note saying what resolving it from here needs, never an action that does nothing. */
export function hostUnavailableText(reason: HostAttentionUnavailable, host: string): string {
  switch (reason) {
    case "needs-update":
      return `Update Daintree on ${host} to resolve this from here.`;
    case "disconnected":
      return `Reconnect to ${host} to resolve this from here.`;
    case "not-running":
      return `Decisions isn't running on ${host}, so this can't be resolved from here now.`;
    case "too-large":
      return `This is too large to resolve from here. Resolve it on ${host}.`;
    case "unlisted":
      return `${host} no longer lists this question, so it can't be resolved from here.`;
  }
}

export function hostReadFailedText(host: string): string {
  return `Couldn't read this delivery from ${host}.`;
}

/** Past this, what is waiting is cut: the question's thread below has it whole. */
const WAITING_CHARS = 160;

/**
 * What the controls act on, as the Host read it with them: the answer, the
 * timeout notice, and the follow-ups waiting to be typed in. Null when the
 * read names none of them.
 */
export function hostWaitingText(
  item: Pick<DecisionsAttentionItem, "answer" | "answerUnavailable" | "notice" | "followUps">,
  host: string
): string | null {
  const parts: string[] = [];
  if (item.answer !== null) {
    const words = [
      ...item.answer.choices,
      ...(item.answer.text !== null ? [item.answer.text.replace(/\s+/g, " ").trim()] : []),
    ]
      .filter((part) => part !== "")
      .join(" · ");
    const shown = words.length > WAITING_CHARS ? `${words.slice(0, WAITING_CHARS - 1)}…` : words;
    const named = item.answer.correction ? "the corrected answer" : "the answer";
    parts.push(shown === "" ? named : `${named} “${shown}”`);
  } else if (item.notice !== null) {
    parts.push("the timeout notice");
  } else if (item.answerUnavailable === "unreadable") {
    parts.push("an answer that couldn't be opened");
  }
  if (item.followUps.length > 0) {
    parts.push(pluralize(item.followUps.length, "follow-up", "follow-ups"));
  }
  return parts.length === 0 ? null : `Waiting on ${host}: ${parts.join(" and ")}`;
}

/**
 * What a resume or Mark handled the Host didn't answer with an outcome came
 * to: never that it was done, and for an answer lost on the way back, that
 * it may have been.
 */
export function hostActionFailureText(
  result: Exclude<DecisionsHostAttentionResult, { result: "acted" }>,
  host: string,
  alias: number
): string {
  const q = aliasLabel(alias);
  // Only where nothing could have reached the Host's delivery is it said that nothing changed.
  const unknown = `${host} didn't say what became of ${q}, so it may or may not have changed. Check it again once ${host} answers.`;
  switch (result.result) {
    case "unreachable":
      switch (result.failure) {
        case "disconnected":
          return `${host} isn't connected, so nothing changed`;
        case "needs-update":
          return hostUnavailableText("needs-update", host);
        default:
          return unknown;
      }
    case "no-host":
      return hostUnavailableText("unlisted", host);
    case "off":
      return `${host} isn't serving this computer its questions now, so nothing changed`;
    default:
      return unknown;
  }
}

/**
 * What marking a Host's delivery handled takes away (#16638): each way of
 * delivering it still offered, here or, for another of its panes, on the Host.
 */
export function hostHandledConfirmBody(
  subject: AttentionSubject,
  host: string,
  offered: { copy: boolean; resume: boolean; reassign: boolean }
): string {
  const plural = deliverySubjectPlural(subject);
  const it = plural ? "them" : "it";
  const ways = [
    offered.copy ? "Copy" : null,
    offered.resume ? "Try resume" : null,
    offered.reassign ? `Choose destination on ${host}` : null,
  ].filter((way) => way !== null);
  const going =
    ways.length === 0
      ? ""
      : ways.length === 1
        ? `${ways[0]} goes with ${it}. `
        : `${ways.slice(0, -1).join(", ")} and ${ways.at(-1)} go with ${it}. `;
  return (
    `Its ${subject} ${plural ? "leave" : "leaves"} Needs attention here and on ${host}, and ` +
    `Daintree won't type ${it} in. ${going}` +
    `The Decisions audit trail on ${host} records the question as handled.`
  );
}
