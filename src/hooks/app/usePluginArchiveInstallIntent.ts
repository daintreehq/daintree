import { useEffect } from "react";
import { usePluginArchiveInstallStore } from "@/store/pluginArchiveInstallStore";

/**
 * Receiver for double-clicked `.dntr` archives awaiting confirmation (#11280).
 *
 * Subscribes unconditionally on mount so the listener is live before main's
 * paint-gated push arrives, and enqueues straight into the store rather than
 * component state. That ordering matters: the confirmation dialog mounts behind
 * hydration, well after this hook, so intents that land early sit in the queue
 * instead of being dropped on the floor.
 */
export function usePluginArchiveInstallIntent(): void {
  useEffect(() => {
    return window.electron.plugin.onArchiveInstallIntent((intent) => {
      usePluginArchiveInstallStore.getState().enqueue(intent);
    });
  }, []);
}
