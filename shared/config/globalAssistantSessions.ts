/**
 * The global assistant's sessions (#18142), apart from its tool lists so the
 * renderer can name them without loading the host-control surface.
 */

/** The lane the first session's resume pointer is stored under, in the project hibernation store. */
export const GLOBAL_ASSISTANT_SLOT = 0;

/**
 * The global assistant sessions a machine may hold at once (#18142): the
 * first, and one beside it for when the first one's CLI runs out of quota.
 * Each is a lane of the reserved id, with its own resume pointer.
 */
export const GLOBAL_ASSISTANT_SLOTS = [0, 1] as const;
export type GlobalAssistantSlot = (typeof GLOBAL_ASSISTANT_SLOTS)[number];
export const GLOBAL_ASSISTANT_SESSION_LIMIT = GLOBAL_ASSISTANT_SLOTS.length;

export function isGlobalAssistantSlot(value: unknown): value is GlobalAssistantSlot {
  return GLOBAL_ASSISTANT_SLOTS.includes(value as GlobalAssistantSlot);
}

/** How every window names a session: by its slot, which never changes while it lives. */
export function globalAssistantSessionNumber(slot: GlobalAssistantSlot): number {
  return slot + 1;
}

/** The agents a person may start a new global assistant session on (#18142). */
export const GLOBAL_ASSISTANT_SESSION_AGENT_IDS: readonly string[] = [
  "claude",
  "codex",
  "antigravity",
];

/**
 * The agents started as an assistant with no view (#13511): the assistant
 * backends that run live, each answering its own folder-trust question or told
 * to trust its folder at launch. A global assistant session is one of them.
 */
export const VIEWLESS_ASSISTANT_AGENT_IDS: readonly string[] = [
  "claude",
  "codex",
  "copilot",
  "antigravity",
];
