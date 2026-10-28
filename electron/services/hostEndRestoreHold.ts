import { store, type StoreSchema } from "../store.js";
import { projectStore } from "./ProjectStore.js";
import type { PendingCrash } from "../../shared/types/ipc/crashRecovery.js";
import type { PanelHostEnd } from "../../shared/types/panel.js";
import { holdTerminalsEndedByHost, readHostEnd } from "./hostEndHoldPolicy.js";

export type HostEndEvent = NonNullable<StoreSchema["hostEndRestoreHolds"]>[number];

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
      if (
        item.cause !== "watchdog-deadlock" &&
        item.cause !== "external-kill" &&
        item.cause !== "unknown"
      ) {
        continue;
      }
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

// Never trimmed for size: each workspace owes at most one event (recordHostEnd
// leaves out one an older end still holds), so the list is bounded by them.
function writeEvents(events: HostEndEvent[]): void {
  const pending = events.filter((event) => event.workspaceIds.length > 0);
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
    // A workspace an older end still waits on is named by that one.
    const owed = new Set(events.flatMap((event) => event.workspaceIds));
    const workspaceIds = [...new Set(liveWorkspaceIds)].filter((id) => !owed.has(id));
    events.push({ crashId, ...hostEnd, workspaceIds });
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
 * `terminals` with each of `hostEnds` applied in turn, oldest first, so a pane
 * two ends in a row cut short is named by the first. Pure.
 */
export function holdTerminalsForHostEnds<T>(
  terminals: T[],
  hostEnds: readonly PanelHostEnd[],
  workspaceId?: string
): { terminals: T[]; held: number } {
  let held = 0;
  for (const hostEnd of hostEnds) {
    const result = holdTerminalsEndedByHost(terminals, hostEnd, workspaceId);
    terminals = result.terminals;
    held += result.held;
  }
  return { terminals, held };
}

const applying = new Map<string, Promise<PanelHostEnd[]>>();

/**
 * Hold the saved agent panes of `workspaceId` that an unclean end cut short,
 * once per workspace per end. Awaited by every hydrate before it reads the
 * workspace's state, so each restore that reads it — this machine's own view
 * or a Shell relaunching onto this host — sees the hold. Resuming a pane is
 * what clears it, as for every other hold.
 *
 * Resolves with the ends that were due, which the hydrate also applies to the
 * terminals it hands back: if the save failed, the payload is still held and
 * the workspace stays due for the next hydrate to save. One application runs
 * per workspace at a time, so a second hydrate never acknowledges a hold the
 * first one has yet to save.
 */
export function applyHostEndHold(workspaceId: string | null): Promise<PanelHostEnd[]> {
  if (!workspaceId) return Promise.resolve([]);
  const inFlight = applying.get(workspaceId);
  if (inFlight) return inFlight;
  const run = applyOnce(workspaceId).finally(() => applying.delete(workspaceId));
  applying.set(workspaceId, run);
  return run;
}

async function applyOnce(workspaceId: string): Promise<PanelHostEnd[]> {
  const due = readEvents().filter((event) => event.workspaceIds.includes(workspaceId));
  if (due.length === 0) return [];
  const hostEnds = due.map(hostEndOf);
  let held = 0;
  try {
    await projectStore.enqueueProjectStateUpdate(workspaceId, (existing) => {
      if (!existing || !Array.isArray(existing.terminals)) return null;
      const result = holdTerminalsForHostEnds(existing.terminals, hostEnds, workspaceId);
      held = result.held;
      return result.held > 0 ? { ...existing, terminals: result.terminals } : null;
    });
  } catch (error) {
    // Left due, so the next hydrate saves it; this one holds its payload.
    console.warn("[HostEndHold] Failed to hold the workspace's agents:", error);
    return hostEnds;
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
  return hostEnds;
}
