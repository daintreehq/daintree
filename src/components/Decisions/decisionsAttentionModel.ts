import { pluralize } from "@/lib/pluralize";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
} from "@shared/types/decisionsAttention";

/**
 * What the needs-attention list says (#16020). Observations only: what
 * happened to an answer, and what Daintree will and won't do with it, never
 * a reading of what the agent is doing. The pane chip says the same things
 * from inside the terminal; here the terminal is one of several, so it is
 * named rather than "this terminal".
 */

/**
 * The library's codes for a delivery that stopped, in words. A code not here
 * still shows the item; only the explanation is left out.
 */
const REASONS: Record<string, string> = {
  relaunched: "The terminal that asked was relaunched after the question was asked.",
  pane_gone: "The terminal that asked was closed.",
  generation_mismatch: "The terminal that asked was restarted after the question was asked.",
  session_mismatch: "A different agent session is running in the terminal that asked.",
  resume_wrong_worktree: "The resumed agent opened in a different worktree.",
  inject_rejected: "The terminal refused the answer.",
  unavailable_unknown_reason: "The terminal refused the answer.",
  answer_unreadable: "The answer couldn't be decrypted on this computer.",
  no_target: "Nothing matches the terminal that asked.",
  target_mismatch: "Nothing matches the terminal that asked.",
  choice_required: "The answer doesn't fit what the question allows.",
  text_not_allowed: "The answer doesn't fit what the question allows.",
  too_many_choices: "The answer doesn't fit what the question allows.",
  unknown_option: "The answer doesn't fit what the question allows.",
  proxy_forbidden: "The question needs a person's answer, not a proxy's.",
  inject_ambiguous: "Typing it in was interrupted, so it isn't typed again on its own.",
  inject_threw: "Typing it in was interrupted, so it isn't typed again on its own.",
  crash_unreconciled: "Daintree stopped while typing it in, so it isn't typed again on its own.",
  delivered_without_proof: "Typing it in wasn't confirmed, so it isn't typed again on its own.",
  invalid_inject_result: "Typing it in wasn't confirmed, so it isn't typed again on its own.",
  resume_unsupported_agent: "This agent can't be resumed to type it in.",
  resume_other_host: "It was asked on another host.",
  resume_host_unreachable: "The terminal's host couldn't be reached to resume the agent.",
  resume_host_unreadable: "The terminal's host couldn't be read to resume the agent.",
  resume_no_session: "No agent session was recorded to resume.",
  resume_no_worktree: "No worktree was recorded to resume the agent in.",
  resume_worktree_gone: "The worktree that asked is gone.",
  resume_other_worktree: "The agent's session is open in another worktree.",
  resume_unknown_project: "The project that asked isn't open here.",
  resume_panel_limit: "There was no room for another terminal to resume the agent.",
  resume_missing_cli: "The agent's command isn't installed, so it couldn't be resumed.",
  resume_spawn_failed: "The resumed agent didn't start.",
  resume_timeout: "The resumed agent didn't reach its prompt in time.",
  resume_exited: "The resumed agent exited before the answer was typed in.",
  resume_closed: "The resumed terminal was closed before the answer was typed in.",
  resume_no_bearer: "The resumed terminal couldn't be matched to the question.",
  resume_target_changed: "The terminal changed while the agent was resuming.",
  resume_ended: "The terminal resumed for it was closed again.",
  resume_failed: "Resuming the agent failed.",
};

export function reasonText(code: string): string | null {
  return REASONS[code] ?? null;
}

export function aliasLabel(alias: number): string {
  return `q-${alias}`;
}

const UNCERTAIN_STATUS = "This answer may or may not have been delivered";
const ATTENTION_STATUS = "Answer needs attention";

export function statusText(item: Pick<DecisionsAttentionItem, "status">): string {
  return item.status === "delivery-uncertain" ? UNCERTAIN_STATUS : ATTENTION_STATUS;
}

/** The agent's name, falling back to its id. */
export function agentLabel(origin: { agentId: string; agentName: string | null }): string {
  return origin.agentName ?? origin.agentId;
}

/** The dialog's opening line, which also tells a screen reader what the list is. */
export const LIST_DESCRIPTION =
  "Daintree won't type these answers in on its own. Choose what happens to each one.";
export const EMPTY_DESCRIPTION =
  "Nothing needs attention right now. Answers Daintree won't type in on its own show up here.";

/** Why an item shows no answer: there is none waiting, or this computer can't open it. */
export function missingAnswerText(unavailable: "none" | "unreadable" | null): string {
  return unavailable === "unreadable"
    ? "There's nothing here to type in or copy."
    : "No answer is waiting to be typed in for it, so there's nothing to copy.";
}

/** What a resume does while it runs, and how long that can take. */
export const RESUME_PENDING =
  "Reopening the agent's session and waiting for its prompt. This can take up to a minute and a half.";
export const STILL_WORKING = "Still working…";

/**
 * Where it was asked: the agent and its terminal, then the project and
 * worktree. A terminal that is gone says so rather than showing nothing.
 */
export function originParts(
  item: DecisionsAttentionItem,
  worktreeName: string | null
): { pane: string; place: string | null } {
  const { origin } = item;
  const agent = agentLabel(origin);
  const pane =
    origin.paneTitle !== null ? `${agent} in “${origin.paneTitle}”` : `${agent}, terminal closed`;
  const place = [origin.projectName, worktreeName].filter((part) => part !== null).join(" · ");
  return { pane, place: place === "" ? null : place };
}

/** A pane as the confirmation names it: its title (or that it's closed), then its agent and place. */
export interface PaneLines {
  primary: string;
  detail: string;
}

/** The confirmation's From: the asking pane, or that it's closed, then where it ran. */
export function fromLines(item: DecisionsAttentionItem, worktreeName: string | null): PaneLines {
  const { origin } = item;
  return {
    primary: origin.paneTitle !== null ? `“${origin.paneTitle}”` : "Terminal closed",
    detail: [agentLabel(origin), origin.projectName, worktreeName]
      .filter((part) => part !== null)
      .join(" · "),
  };
}

/** The confirmation's To: the chosen pane, then its agent and where it runs. */
export function toLines(
  destination: DecisionsAnswerDestination,
  worktreeName: string | null
): PaneLines {
  return {
    primary: `“${destination.title}”`,
    detail: destinationDetail(destination, worktreeName),
  };
}

/** The footer's count of what is left. */
export function remainingText(count: number): string {
  return pluralize(count, "answer needs attention", "answers need attention");
}

/** A destination's second line: its agent, then where it runs. */
export function destinationDetail(
  destination: DecisionsAnswerDestination,
  worktreeName: string | null
): string {
  const parts = [agentLabel(destination)];
  if (destination.projectName !== null) parts.push(destination.projectName);
  if (worktreeName !== null) parts.push(worktreeName);
  return parts.join(" · ");
}

/** A pane as a confirmation names it: its title, or its agent when it has none. */
export function paneName(title: string | null, agent: string): string {
  return title !== null && title.trim() !== "" ? `“${title}”` : agent;
}

/**
 * What an action did, as one sentence naming the question: what the list
 * shows and announces. A result that leaves the item listed says why.
 */
export function outcomeText(alias: number, outcome: DecisionsAnswerOutcome): string {
  const q = aliasLabel(alias);
  switch (outcome.result) {
    case "delivered":
      return outcome.title !== null
        ? `Answer to ${q} typed into “${outcome.title}”`
        : `Answer to ${q} typed in`;
    case "waiting": {
      const where = outcome.title !== null ? `“${outcome.title}”` : "its terminal";
      return outcome.waitsFor === "host"
        ? `Answer to ${q} goes to ${where}, typed in once its host is back`
        : `Answer to ${q} goes to ${where}, typed in once it's idle`;
    }
    case "needs-attention":
      // The item shows the new reason; the line says only what became of it.
      return outcome.status === "delivery-uncertain"
        ? `Answer to ${q} may or may not have been delivered, and still needs attention`
        : `Answer to ${q} wasn't typed in and still needs attention`;
    case "handled":
      return `Answer to ${q} marked handled`;
    case "resolved":
      return `Answer to ${q} no longer needs attention`;
    case "refused":
      switch (outcome.reason) {
        case "not-running":
          return "Decisions isn't running, so nothing changed";
        case "uncertain":
          return `Answer to ${q} may already have been typed in, so it isn't typed again`;
        case "no-answer":
          return `No answer is kept for ${q}`;
        case "destination-gone":
          return `That terminal is no longer running an agent, so ${q}'s answer wasn't sent`;
      }
  }
}

/** Whether an outcome takes the item off the list. */
export function leavesList(outcome: DecisionsAnswerOutcome): boolean {
  return (
    outcome.result === "delivered" ||
    outcome.result === "waiting" ||
    outcome.result === "handled" ||
    outcome.result === "resolved"
  );
}

/** How an outcome reads: done, or not done. */
export function outcomeSeverity(outcome: DecisionsAnswerOutcome | null): "success" | "warning" {
  return outcome !== null && leavesList(outcome) ? "success" : "warning";
}
