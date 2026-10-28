import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { CHANNELS } from "../../ipc/channels.js";
import { observeCanopySnapshots } from "../../ipc/handlers/canopy.js";
import { getFleetSnapshotService } from "../../ipc/handlers/projectCrud/index.js";
import { CanopyViewers } from "./viewer.js";

/**
 * The assistant calls only a host-owned viewer is let make over a link; each
 * handler refuses every other link caller itself. Admitted only while one is
 * open, so a machine nobody views an assistant on admits nothing.
 */
const ASSISTANT_VIEWER_HYBRIDS = [
  CHANNELS.CANOPY_WATCH_ASSISTANT_TERMINAL,
  CHANNELS.CANOPY_RESOLVE_ASSISTANT,
] as const;

/** This machine's own Canopy and fleet, and its dispatcher, as viewers reach them. */
export function createLocalCanopyViewers(): CanopyViewers {
  return new CanopyViewers({
    source: {
      observeCanopy: observeCanopySnapshots,
      observeFleet: (listener) => getFleetSnapshotService()?.subscribe(listener) ?? null,
    },
    invoke: (invocation, channel, args) =>
      getIpcDispatcher().invokeForEndpoint(invocation, channel, args),
    admitAssistantViewers: () => {
      const offs = ASSISTANT_VIEWER_HYBRIDS.map((channel) =>
        getIpcDispatcher().allowHybridOverLink(channel)
      );
      return () => {
        for (const off of offs) off();
      };
    },
  });
}
