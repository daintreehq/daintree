import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { observeCanopySnapshots } from "../../ipc/handlers/canopy.js";
import { getFleetSnapshotService } from "../../ipc/handlers/projectCrud/index.js";
import { CanopyViewers } from "./viewer.js";

/** This machine's own Canopy and fleet, and its dispatcher, as viewers reach them. */
export function createLocalCanopyViewers(): CanopyViewers {
  return new CanopyViewers({
    source: {
      observeCanopy: observeCanopySnapshots,
      observeFleet: (listener) => getFleetSnapshotService()?.subscribe(listener) ?? null,
    },
    invoke: (invocation, channel, args) =>
      getIpcDispatcher().invokeForEndpoint(invocation, channel, args),
  });
}
