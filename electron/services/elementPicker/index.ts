import type { ElementPickerHost } from "./ElementPickerHost.js";
import { ElementPickerHostError } from "./errors.js";

/**
 * The app's one Element Picker source host. Importing this module loads
 * nothing else: the service is imported on first use, and its process forks
 * only on the first resolve after that.
 */

let instance: Promise<ElementPickerHost> | null = null;
let sealed = false;

export function getElementPickerHost(): Promise<ElementPickerHost> {
  if (sealed) {
    return Promise.reject(new ElementPickerHostError("HOST_DISPOSED", "the app is shutting down"));
  }
  instance ??= import("./ElementPickerHost.js").then(
    ({ ElementPickerHost: Host }) => new Host(),
    (error: unknown) => {
      // Not cached: a failed load must not disable the picker for the session.
      instance = null;
      throw error;
    }
  );
  return instance;
}

/** On quit. Disposes the service if anything ever created it; never creates one. */
export async function shutdownElementPickerHost(): Promise<void> {
  sealed = true;
  const pending = instance;
  instance = null;
  if (!pending) return;
  const host = await pending.catch(() => null);
  await host?.dispose();
}
