import { useState } from "react";
import { getAgentConfig } from "@/config/agents";
import type { HelpPastSession } from "@shared/types/ipc/help";

// Keyed by the picker's own agent union, so an agent it learns to list has to be
// added here too, or the dialogs that end a conversation would stop saying so.
const LISTED_AGENTS: Record<HelpPastSession["agentId"], true> = { claude: true, codex: true };

/** Whether "Resume a past session…" can bring this agent's conversations back. */
export function isListedAssistantAgent(
  agentId: string | null | undefined
): agentId is HelpPastSession["agentId"] {
  return Boolean(agentId && Object.hasOwn(LISTED_AGENTS, agentId));
}

/**
 * A confirm body for ending a lane's run (#14979). Ending one clears only the
 * lane's resume pointer: the transcript stays in the agent's own store, which
 * "Resume a past session…" reads for Claude and Codex. Any other agent's
 * conversation has nowhere in the app to come back from, so its body says only
 * what ends.
 */
export function withPastSessionsNote(consequence: string, agentId: string | null | undefined) {
  return isListedAssistantAgent(agentId)
    ? `${consequence}. The current conversation stays in past sessions.`
    : consequence;
}

/** What closing a lane would cost, frozen when the close was asked for. */
export interface PendingCloseCost {
  /** The lane's agent is mid-turn. */
  working: boolean;
  agentId: string | null;
  /** A tab restored for a captured conversation: there is no agent to stop. */
  dormant: boolean;
  /** The last tab, whose close also slides the panel away. */
  sole: boolean;
}

/**
 * The close confirm's body (#15385). Only two closes still ask: a lane whose agent
 * is working, and a conversation the app has no way to bring back. Each says which
 * of those it is, since that is the whole reason this close stopped when others
 * don't.
 */
export function closeSessionDescription({ working, agentId, dormant, sole }: PendingCloseCost) {
  const agentName = agentId ? (getAgentConfig(agentId)?.name ?? agentId) : "The agent";
  const ends = working
    ? `${agentName} is working. Closing stops its current turn and closes this tab.`
    : dormant
      ? "This tab closes."
      : `${agentName} stops and this tab closes.`;
  const after = isListedAssistantAgent(agentId)
    ? "The current conversation stays in past sessions."
    : "You can't resume this conversation in Daintree.";
  return `${ends} ${after}${sole ? " The assistant panel closes too." : ""}`;
}

/**
 * Keeps a dialog's body as it was last shown while open. Confirming or cancelling
 * clears the pending lane (and a stop clears its agent) before the fade ends, so
 * the body must not change under the exit.
 */
export function useLatchedWhileOpen(open: boolean, body: string) {
  const [shown, setShown] = useState(body);
  if (open && body !== shown) setShown(body);
  return open ? body : shown;
}

/** `withPastSessionsNote` for a dialog that stays rendered through its exit. */
export function usePastSessionsNote(
  open: boolean,
  consequence: string,
  agentId: string | null | undefined
) {
  return useLatchedWhileOpen(open, withPastSessionsNote(consequence, agentId));
}
