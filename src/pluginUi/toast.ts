import type {
  PluginToastHandle,
  PluginUndoToastOptions,
  PluginViewToastOptions,
  UseToastResult,
} from "@shared/types/plugin-sdk-react";
import { usePluginKitOwner } from "@/components/PluginKit/kitScope";
import { withKit } from "./kit";

/**
 * Puts one toast up through the kit, handing back a handle that works before
 * the kit has even loaded: a dismiss that arrives first cancels the toast.
 */
function showThroughKit(
  put: (kit: Parameters<Parameters<typeof withKit>[0]>[0]) => string | null
): PluginToastHandle {
  let id: string | null = null;
  let dismissed = false;
  withKit((kit) => {
    if (dismissed) return;
    id = put(kit);
  });
  return {
    dismiss: () => {
      if (dismissed) return;
      dismissed = true;
      if (id !== null) {
        const shown = id;
        withKit((kit) => kit.dismissViewToast(shown));
      }
    },
  };
}

/**
 * Toasts from a view, in the app's own toaster. The message carries your
 * plugin's name, as a worker's `host.showToast` does, and the same bounds
 * apply, clamped rather than rejected: four tones, 2000 characters, a
 * `durationMs` of at most a minute, and a per-plugin rate limit that sends a
 * burst to the notification inbox. Unlike the worker's, a view toast can carry
 * one action button (it then stays up until answered unless given a
 * `durationMs`), and `showUndo` is the app's Undo toast, one per plugin at a
 * time. Their callbacks can run after the component that showed them has
 * unmounted, so act on state that outlives it.
 */
export function useToast(): UseToastResult {
  const owner = usePluginKitOwner();
  return {
    show: (options: PluginViewToastOptions) =>
      showThroughKit((kit) => kit.showViewToast(owner, options)),
    showUndo: (options: PluginUndoToastOptions) =>
      showThroughKit((kit) => kit.showViewUndoToast(owner, options)),
  };
}
