import { ASSISTANT_SLOTS, assistantSlotKey } from "@shared/config/assistantSlots";
import type { HelpLaunchOptions } from "@/controllers/HelpSessionController";
import type { HelpHibernateSession } from "@/store/helpPanelStore";
import { isListedAssistantAgent } from "./pastSessionsNote";

/** What main keeps for one lane of a workspace, read through its non-consuming peek. */
export interface KeptLane {
  slot: number;
  agentId: string;
  /** The agent's own conversation id; empty when the lane never learned one. */
  agentSessionId: string;
  /** Its assistant is still running on the host, with no view showing it. */
  live: boolean;
  /** Captured from a view that went away with the panel open (#10815), in this run of the app. */
  panelWasOpen: boolean;
}

/**
 * Every lane of `workspaceId` main keeps something for, in slot order, or null
 * when the bindings are missing. The listing counts a captured conversation and
 * a running assistant alike; only the peek tells them apart (#16495). Rejects
 * when a read fails.
 */
export async function readKeptLanes(workspaceId: string): Promise<KeptLane[] | null> {
  const help = window.electron?.help;
  if (!help?.listPendingHibernationSlots || !help.peekPendingHibernation) return null;
  const slots = await help.listPendingHibernationSlots(workspaceId);
  const entries = await Promise.all(
    slots.map((slot) => help.peekPendingHibernation(workspaceId, slot))
  );
  return slots.flatMap((slot, index) => {
    const entry = entries[index];
    return entry
      ? [
          {
            slot,
            agentId: entry.agentId,
            agentSessionId: entry.agentSessionId,
            live: entry.live === true,
            panelWasOpen: entry.panelWasOpen === true,
          },
        ]
      : [];
  });
}

/**
 * Main's kept lanes plus the ones only this view's mirror still holds. A plain
 * launch resumes from the mirror when main has nothing, so those count as kept.
 */
export function withMirroredLanes(
  kept: readonly KeptLane[],
  workspaceId: string,
  hibernateSessions: Readonly<Record<string, HelpHibernateSession>>
): KeptLane[] {
  const keptSlots = new Set(kept.map((lane) => lane.slot));
  const mirrored = ASSISTANT_SLOTS.flatMap((slot) => {
    const entry = hibernateSessions[assistantSlotKey(workspaceId, slot)];
    return entry && !keptSlots.has(slot)
      ? [
          {
            slot,
            agentId: entry.agentId,
            agentSessionId: entry.sessionId,
            live: false,
            panelWasOpen: false,
          },
        ]
      : [];
  });
  return [...kept, ...mirrored];
}

/**
 * Whether a new session may take this lane's slot (#16495): nothing runs there,
 * and its conversation stays in past sessions once the lane stops pointing at
 * it. Any other agent's conversation has nowhere else to come back from.
 */
export function isReplaceableKeptLane(lane: KeptLane): boolean {
  return !lane.live && lane.agentSessionId !== "" && isListedAssistantAgent(lane.agentId);
}

/**
 * The slot a new session opens in, among those `isTaken` leaves free: the lowest
 * one main keeps nothing for, else the lowest whose kept conversation it may
 * replace. Null when neither is left.
 */
export function pickNewSessionSlot(
  kept: readonly KeptLane[],
  isTaken: (slot: number) => boolean
): { slot: number; replacesKept: boolean } | null {
  const keptBySlot = new Map(kept.map((lane) => [lane.slot, lane]));
  const free = ASSISTANT_SLOTS.filter((slot) => !isTaken(slot));
  const empty = free.find((slot) => !keptBySlot.has(slot));
  if (empty !== undefined) return { slot: empty, replacesKept: false };
  const replaceable = free.find((slot) => {
    const lane = keptBySlot.get(slot);
    return lane !== undefined && isReplaceableKeptLane(lane);
  });
  return replaceable !== undefined ? { slot: replaceable, replacesKept: true } : null;
}

/**
 * A launch that starts a new conversation in a lane something is kept for.
 * Reserved, like "New session": it never adopts or resumes, and drops the lane's
 * pointer. Through the version gate, which a lane with no terminal hasn't passed.
 */
export function freshSessionLaunch(agentId: string): HelpLaunchOptions {
  return {
    agentId,
    replaceExisting: true,
    requestedId: `terminal-${crypto.randomUUID()}`,
    checkVersion: true,
  };
}
