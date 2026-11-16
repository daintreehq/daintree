import { useEffect } from "react";
import { isElectronAvailable } from "./useElectron";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { composePilotRunTitle } from "@/components/Pilot/pilotRows";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import type { IpcEventMap } from "@shared/types/ipc/maps";

// One-way latch, same shape as the idle-terminal listener: the broadcast IPC
// listener is an app-lifetime, notify-only singleton with no teardown, and
// resetting the latch on remount would fire duplicate toasts (#10455).
let ipcListenerAttached = false;

type ParkReleasedPayload = IpcEventMap["terminal:park-released"];

function findRun(snapshot: FleetSnapshot | null | undefined, runId: string) {
  return snapshot?.runs.find((candidate) => candidate.runId === runId);
}

function notifyParkReleased(payload: ParkReleasedPayload, run: FleetRunRow | undefined): void {
  const title = run !== undefined ? composePilotRunTitle(run) : "A parked agent";

  // Neutral about the RUN's own state on purpose: the release says the
  // gate finished (or closed), not that the parked run is idle — it may
  // still be working or blocked. The note travels on both reasons; it is
  // the user's own context and a closed gate doesn't make it less theirs.
  const reasonPhrase =
    payload.reason === "gate-closed" ? "its gate terminal closed" : "its gate came free";
  const message =
    payload.note !== undefined
      ? `${title} — ${reasonPhrase}. "${payload.note}"`
      : `${title} — ${reasonPhrase}`;

  notify({
    type: "info",
    title: "Park released",
    message,
    correlationId: `park-released:${payload.id}`,
    // A re-park and re-release of the same run retires the older row
    // rather than stacking near-duplicates in the inbox.
    supersedeKey: `park-released:${payload.id}`,
    context: {
      eventKind: "agent",
      panelId: payload.id,
      ...(run !== undefined ? { projectId: run.workspaceId } : {}),
      ...(run?.worktreeId !== undefined ? { worktreeId: run.worktreeId } : {}),
    },
    ...(run !== undefined
      ? {
          action: {
            label: "Open",
            successLabel: "Opened",
            actionId: "pilot.openRun",
            actionArgs: { runId: run.runId, workspaceId: run.workspaceId },
            // Awaited, and rejected on a failed dispatch, because
            // `successLabel` is a CLAIM: the toaster flashes "Opened" the
            // moment a synchronous handler returns, so discarding the
            // promise here made every click say the run opened — including
            // the ones where `pilot.openRun` was at that moment raising
            // "Couldn't open agent" beside it.
            onClick: async () => {
              const result = await actionService.dispatch("pilot.openRun", {
                runId: run.runId,
                workspaceId: run.workspaceId,
              });
              // The action has already said why, in its own toast. This
              // rejection only tells the toaster not to claim success —
              // hence no message worth reading.
              if (!result.ok) throw new Error(result.error.message);
            },
          },
        }
      : {}),
  });
}

/**
 * The hand-back half of run parking.
 *
 * Main releases a gated park when the gate terminal comes free (or closes)
 * and broadcasts `terminal:park-released`; this turns that into the one
 * notification the whole feature was built to earn — "the run you shelved is
 * ready, and here is the note you left on it". The parked run usually lives
 * in ANOTHER project, so the row popping back into Pilot's Waiting band is
 * not otherwise visible from where the user is working.
 */
export function useParkReleaseNotifications(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;

    window.electron.events.on("terminal:park-released", (payload) => {
      const run = findRun(useFleetSnapshotStore.getState().snapshot, payload.id);
      if (run !== undefined) {
        notifyParkReleased(payload, run);
        return;
      }
      // A view that was frozen hears this before the fleet snapshot naming the
      // run, which waits for its thaw (#17038), so ask main for the current one.
      // A failed read still hands the run back, just without its name.
      void window.electron.fleet
        .getSnapshot()
        .then(
          (snapshot) => findRun(snapshot, payload.id),
          () => undefined
        )
        .then((pulled) => notifyParkReleased(payload, pulled));
    });

    // Latch only after a successful subscribe so a throwing preload doesn't
    // wedge the latch and silently suppress all future notifications.
    ipcListenerAttached = true;
  }, []);
}
