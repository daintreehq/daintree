/**
 * Which agents this machine's toolbar pins (#14702). The toolbar belongs to the
 * screen, so the pins are the machine at the keyboard's: a remote window shows
 * this machine's pins on every host, and a host's own window shows the host's.
 *
 * Tri-state per agent, as it was on `AgentSettingsEntry.pinned` (#7673): `true`
 * is an explicit pin, `false` an explicit unpin, and a missing id has no
 * intent, so the toolbar follows its default. A pin outlives the agent's CLI:
 * an agent that isn't installed where the window's project lives stays pinned
 * and reads as unavailable there.
 */
export type AgentToolbarPins = Record<string, boolean>;

/**
 * The pins with this process's revision, which rises with every change, so a
 * reply that started before a newer push can be told apart from it.
 */
export interface AgentToolbarPinsSnapshot {
  pins: AgentToolbarPins;
  revision: number;
}

const MAX_AGENT_ID_LENGTH = 128;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Syntax only: a pin has to survive its agent's CLI being missing on one host
 * or its registry entry not having loaded yet.
 */
export function isStorableAgentToolbarPinId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AGENT_ID_LENGTH &&
    !RESERVED_KEYS.has(value) &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

/** The boolean entries of a stored or received pin map, anything else dropped. */
export function sanitizeAgentToolbarPins(value: unknown): AgentToolbarPins {
  const pins: AgentToolbarPins = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return pins;
  for (const [id, pinned] of Object.entries(value)) {
    if (typeof pinned === "boolean" && isStorableAgentToolbarPinId(id)) pins[id] = pinned;
  }
  return pins;
}

/** One agent's pin, or undefined when this machine has no intent for it. */
export function agentToolbarPin(
  pins: Readonly<AgentToolbarPins> | null | undefined,
  agentId: string
): boolean | undefined {
  if (!pins || !Object.hasOwn(pins, agentId)) return undefined;
  const pinned = pins[agentId];
  return typeof pinned === "boolean" ? pinned : undefined;
}
