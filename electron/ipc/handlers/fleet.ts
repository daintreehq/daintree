import type { FleetSnapshot } from "../../../shared/types/ipc/fleet.js";
import { getFleetSnapshotService } from "./projectCrud/index.js";
import { defineIpcNamespace, op } from "../define.js";
import { FLEET_METHOD_CHANNELS } from "./fleet.preload.js";

export const fleetNamespace = defineIpcNamespace({
  name: "fleet",
  ops: {
    /**
     * Pull the current fleet snapshot.
     *
     * The push path alone cannot hydrate a view. `pushSnapshotTo` fires at
     * `did-finish-load`, but a renderer subscribes from a React effect that
     * runs later, and Electron does not buffer a direct send — so the replay
     * can be dropped. Every subsequent poll then compares equal and is
     * suppressed, leaving that V8 context with no snapshot until the fleet
     * happens to change. Waiting, blocked and awaiting-review are exactly the
     * states that stop changing, so the fleet most worth seeing is the one
     * most likely to never arrive.
     *
     * Mirrors how `ProjectStatsService` is hydrated by the palette's bulk-stats
     * pull: push keeps a live view current, this makes a cold one correct.
     *
     * Returns null when nothing has been computed yet, which the renderer must
     * keep distinct from an empty fleet — only the latter may render as clear.
     */
    getSnapshot: op(
      FLEET_METHOD_CHANNELS.getSnapshot,
      async (): Promise<FleetSnapshot | null> =>
        getFleetSnapshotService()?.getLastBroadcast() ?? null
    ),
  },
});

export function registerFleetHandlers(): () => void {
  return fleetNamespace.register();
}
