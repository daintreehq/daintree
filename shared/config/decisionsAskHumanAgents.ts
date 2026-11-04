import { SAFE_AGENT_ID_PATTERN } from "../types/userAgentRegistry.js";

/** Far longer than any agent id in use, so a real one is never refused. */
export const MAX_ASK_HUMAN_AGENT_ID_LENGTH = 128;
/** Far more agents than anyone installs, so a damaged value can't grow the setting without bound. */
export const MAX_ASK_HUMAN_AGENTS = 256;

/** An agent id in the shape the agent registries accept, short enough to keep. */
export function isAskHumanAgentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ASK_HUMAN_AGENT_ID_LENGTH &&
    SAFE_AGENT_ID_PATTERN.test(value)
  );
}

/**
 * The agent ids switched on for `ask_human` (#16223), as saved: in the order
 * they were switched on, each once. Anything that isn't an agent id is
 * dropped, so a damaged value switches nothing on; an id whose agent is gone
 * stays, so the agent is still on if it comes back. Main's sanitiser and the
 * launch gate both read the saved value through this.
 */
export function askHumanAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) {
    if (ids.size >= MAX_ASK_HUMAN_AGENTS) break;
    if (isAskHumanAgentId(id)) ids.add(id);
  }
  return [...ids];
}
