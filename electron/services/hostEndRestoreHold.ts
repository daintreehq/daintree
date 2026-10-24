import { store, type StoreSchema } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import type { PendingCrash } from "../../shared/types/ipc/crashRecovery.js";
import type { PanelHostEnd } from "../../shared/types/panel.js";
import { holdTerminalsEndedByHost, readHostEnd } from "./hostEndHoldPolicy.js";

export type HostEndEvent = NonNullable<StoreSchema["hostEndRestoreHolds"]>[number];

/** Ends still waiting on a workspace nobody has opened since; the oldest go first. */
const MAX_EVENTS = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readEvents(): HostEndEvent[] {
  try {
    const value: unknown = store.get("hostEndRestoreHolds");
    if (!Array.isArray(value)) return [];
    const events: HostEndEvent[] = [];
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      if (typeof item.crashId !== "string") continue;
      if (item.cause !== "watchdog-deadlock" && item.cause !== "external-kill") continue;
      if (typeof item.at !== "number" || !Number.isFinite(item.at)) continue;
      if (!Array.isArray(item.workspaceIds)) continue;
      const workspaceIds = item.workspaceIds.filter((id): id is string => typeof id === "string");
      if (workspaceIds.length === 0) continue;
      events.push({
        crashId: item.crashId,
        cause: item.cause,
        at: item.at,
        ...(typeof item.missedBeats === "number" && { missedBeats: item.missedBeats }),
        workspaceIds,
      });
    }
    return events;
  } catch {
    return [];
  }
}

function writeEvents(events: HostEndEvent[]): void {
  const pending = events.filter((event) => event.workspaceIds.length > 0).slice(-MAX_EVENTS);
  if (pending.length === 0) store.delete("hostEndRestoreHolds");
  else store.set("hostEndRestoreHolds", pending);
}

/**
 * Remember an unclean end until each workspace that was live when it happened
 * has had its saved agent panes held for it. The record outlives this session
 * on purpose: a project nobody opens until after a clean quit, or a reboot,
 * still had its agents cut short. A workspace that wasn't live, such as one put
 * to sleep, had nothing running for the end to cut short.
 *
 * `liveWorkspaceIds` comes from the crashed session's last backup; without one
 * there is no record of what was running, and nothing is held.
 */
export function recordHostEnd(
  pending: PendingCrash | null,
  liveWorkspaceIds: readonly string[] | null
): void {
  const hostEnd = readHostEnd(pending);
  const crashId = pending?.entry.id;
  if (!hostEnd || !crashId) return;
  if (!liveWorkspaceIds || liveWorkspaceIds.length === 0) {
    console.log("[HostEndHold] No record of what was running when the app ended; nothing held", {
      cause: hostEnd.cause,
    });
    return;
  }
  try {
    const events = readEvents();
    // Read again on a launch that died before it got further: same crash, same record.
    if (events.some((event) => event.crashId === crashId)) return;
    events.push({ crashId, ...hostEnd, workspaceIds: [...new Set(liveWorkspaceIds)] });
    writeEvents(events);
    console.log("[HostEndHold] Agents running when the app ended will wait to be resumed", {
      cause: hostEnd.cause,
      workspaces: liveWorkspaceIds.length,
    });
  } catch (error) {
    console.warn("[HostEndHold] Failed to record the unclean end:", error);
  }
}

function hostEndOf(event: HostEndEvent): PanelHostEnd {
  return {
    cause: event.cause,
    at: event.at,
    ...(event.missedBeats !== undefined && { missedBeats: event.missedBeats }),
  };
}

/**
 * Hold the saved agent panes of `workspaceId` that an unclean end cut short,
 * once per workspace per end. Awaited by every hydrate before it reads the
 * workspace's state, so each restore that reads it — this machine's own view
 * or a Shell relaunching onto this host — sees the hold. Resuming a pane is
 * what clears it, as for every other hold.
 */
export async function applyHostEndHold(workspaceId: string | null): Promise<number> {
  if (!workspaceId) return 0;
  // Oldest first, so a pane two ends in a row cut short is named by the first.
  const due = readEvents().filter((event) => event.workspaceIds.includes(workspaceId));
  if (due.length === 0) return 0;
  let held = 0;
  try {
    await projectStore.enqueueProjectStateUpdate(workspaceId, (existing) => {
      if (!existing || !Array.isArray(existing.terminals)) return null;
      let terminals = existing.terminals;
      let count = 0;
      for (const event of due) {
        const result = holdTerminalsEndedByHost(terminals, hostEndOf(event), workspaceId);
        terminals = result.terminals;
        count += result.held;
      }
      held = count;
      return count > 0 ? { ...existing, terminals } : null;
    });
  } catch (error) {
    // Left due, so the next hydrate tries again rather than resuming.
    console.warn("[HostEndHold] Failed to hold the workspace's agents:", error);
    return 0;
  }
  try {
    // Re-read: another end may have been recorded while the update ran.
    const applied = new Set(due.map((event) => event.crashId));
    writeEvents(
      readEvents().map((event) =>
        applied.has(event.crashId)
          ? { ...event, workspaceIds: event.workspaceIds.filter((id) => id !== workspaceId) }
          : event
      )
    );
  } catch (error) {
    console.warn("[HostEndHold] Failed to record the held workspace:", error);
  }
  if (held > 0) {
    console.log("[HostEndHold] Held agents an unclean end cut short", {
      workspaceId,
      count: held,
    });
  }
  return held;
}
