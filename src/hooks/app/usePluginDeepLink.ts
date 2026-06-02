import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginDeepLinkIntent } from "@shared/types/plugin";

export interface PluginDeepLinkState {
  /** The deep-link intent awaiting handling, or `null` when none is pending. */
  intent: PluginDeepLinkIntent | null;
  /** Clear the current intent once it has been consumed (e.g. dialog opened). */
  clear: () => void;
}

/**
 * `daintree://` deep-link receiver (#9559).
 *
 * The main process delivers the intent on `plugin:deep-link` once the primary
 * window has painted. This hook subscribes unconditionally on mount so the
 * listener is live before the paint signal fires, then surfaces the intent
 * gated on `isStateLoaded`: the deep link can arrive between first paint and
 * the end of hydration, and opening the Plugin Manager against an unhydrated
 * app would race the panel/plugin stores (#8465). Intents that land early are
 * buffered and released on the hydration transition.
 *
 * Latest-wins, mirroring the main-side `pendingIntent`: a newer deep link
 * supersedes an unconsumed older one.
 */
export function usePluginDeepLink(isStateLoaded: boolean): PluginDeepLinkState {
  const [intent, setIntent] = useState<PluginDeepLinkIntent | null>(null);
  const bufferedRef = useRef<PluginDeepLinkIntent | null>(null);
  const loadedRef = useRef(isStateLoaded);

  useEffect(() => {
    loadedRef.current = isStateLoaded;
  }, [isStateLoaded]);

  useEffect(() => {
    return window.electron.plugin.onDeepLink((next) => {
      if (loadedRef.current) {
        setIntent(next);
      } else {
        bufferedRef.current = next;
      }
    });
  }, []);

  useEffect(() => {
    if (isStateLoaded && bufferedRef.current) {
      setIntent(bufferedRef.current);
      bufferedRef.current = null;
    }
  }, [isStateLoaded]);

  const clear = useCallback(() => setIntent(null), []);

  return { intent, clear };
}
