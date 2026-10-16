import type { CanopyHostChannel, CanopyHostEvent } from "@shared/types/ipc/canopyHost";
import type { IpcInvokeMap } from "@shared/types/ipc/maps";

/**
 * Canopy on a host the view names that isn't its own: This Mac from a remote
 * window, or another connected host. The view's own host is read through
 * `window.electron.canopy`, exactly as before; naming it here is refused.
 */
export const canopyHostClient = {
  invoke: <C extends CanopyHostChannel>(
    hostId: string,
    channel: C,
    ...args: IpcInvokeMap[C]["args"]
  ): Promise<IpcInvokeMap[C]["result"]> => {
    return window.electron.canopyHost.invoke(hostId, channel, args) as Promise<
      IpcInvokeMap[C]["result"]
    >;
  },

  /** The panel stopped reading the host: its open state, scope and watch there end. */
  release: (hostId: string): Promise<void> => {
    return window.electron.canopyHost.release(hostId);
  },

  /** Every host's pushes, each tagged with the host it came from. */
  onEvent: (callback: (event: CanopyHostEvent) => void): (() => void) => {
    return window.electron.canopyHost.onEvent(callback);
  },
} as const;
