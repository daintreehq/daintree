import { pluralize } from "./pluralize";

/**
 * The words every surface uses for an agent's state and for the buckets over
 * those states, so the same thing is never named twice.
 *
 * States are narrow and lower case, because they sit inside sentences: working,
 * waiting, finished, unread. Buckets are the quick-state bar's and Pilot's
 * filter segments, and are wider: Attention holds every agent asking for
 * something, whatever it is asking.
 *
 * An unread hand-back is never waiting. It is a finished turn the user has not
 * read yet, so it counts as finished and draws the solid unread glyph.
 */
export const AGENT_STATE_WORD = {
  working: "working",
  waiting: "waiting",
  finished: "finished",
  unread: "unread",
  blocked: "blocked",
} as const;

export type AgentStateWord = keyof typeof AGENT_STATE_WORD;

export const AGENT_BUCKET_LABEL = {
  working: "Working",
  attention: "Attention",
  finished: "Finished",
} as const;

export type AgentBucket = keyof typeof AGENT_BUCKET_LABEL;

/** "1 agent waiting", "3 agents unread": a count that names its unit. */
export function agentStatePhrase(count: number, state: AgentStateWord): string {
  return `${pluralize(count, "agent")} ${AGENT_STATE_WORD[state]}`;
}

/** "1 working", "2 need attention", "1 needs attention", "3 finished". */
export function bucketCountPhrase(count: number, bucket: AgentBucket): string {
  if (bucket === "attention") return `${count} ${count === 1 ? "needs" : "need"} attention`;
  return `${count} ${AGENT_BUCKET_LABEL[bucket].toLowerCase()}`;
}
