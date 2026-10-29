import { useState } from "react";
import type { HelpPastSession } from "@shared/types/ipc/help";

// Keyed by the picker's own agent union, so an agent it learns to list has to be
// added here too, or the dialogs that end a conversation would stop saying so.
const LISTED_AGENTS: Record<HelpPastSession["agentId"], true> = { claude: true, codex: true };

/**
 * A confirm body for ending a lane's run (#14979). Ending one clears only the
 * lane's resume pointer: the transcript stays in the agent's own store, which
 * "Resume a past session…" reads for Claude and Codex. Any other agent's
 * conversation has nowhere in the app to come back from, so its body says only
 * what ends.
 */
export function withPastSessionsNote(consequence: string, agentId: string | null | undefined) {
  return agentId && Object.hasOwn(LISTED_AGENTS, agentId)
    ? `${consequence}. The current conversation stays in past sessions.`
    : consequence;
}

/**
 * `withPastSessionsNote` for a dialog that stays rendered through its exit. Confirming
 * or cancelling clears the pending lane (and a stop clears its agent) before the fade
 * ends, so the last body shown while open keeps rendering while it exits.
 */
export function usePastSessionsNote(
  open: boolean,
  consequence: string,
  agentId: string | null | undefined
) {
  const body = withPastSessionsNote(consequence, agentId);
  const [shown, setShown] = useState(body);
  if (open && body !== shown) setShown(body);
  return open ? body : shown;
}
