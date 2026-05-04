import { useEffect, useEffectEvent } from "react";

export type BrowserActionCallbacks = {
  onReload: () => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onSetZoom: (rawZoom: number) => void;
  onCaptureScreenshot: () => void;
  onToggleConsole: () => void;
  onClearConsole: () => void;
  onToggleDevTools: () => void;
  onHardReload: () => void;
};

const BROWSER_ACTION_EVENTS = [
  "daintree:reload-browser",
  "daintree:browser-navigate",
  "daintree:browser-back",
  "daintree:browser-forward",
  "daintree:browser-set-zoom",
  "daintree:browser-capture-screenshot",
  "daintree:browser-toggle-console",
  "daintree:browser-clear-console",
  "daintree:browser-toggle-devtools",
  "daintree:hard-reload-browser",
] as const;

/**
 * Subscribes a BrowserPane instance to the action-driven `daintree:*` window
 * events that drive its toolbar/keybinding integrations. Each callback is
 * invoked only when the event's `detail.id` matches the panel's `id`.
 *
 * Callbacks are read non-reactively via `useEffectEvent`, so the underlying
 * effect only re-binds when `id` changes.
 */
export function useBrowserActionListeners(id: string, callbacks: BrowserActionCallbacks): void {
  const dispatch = useEffectEvent((eventType: string, detail: Record<string, unknown>) => {
    switch (eventType) {
      case "daintree:reload-browser":
        callbacks.onReload();
        return;
      case "daintree:browser-navigate":
        if (typeof detail.url === "string") callbacks.onNavigate(detail.url);
        return;
      case "daintree:browser-back":
        callbacks.onBack();
        return;
      case "daintree:browser-forward":
        callbacks.onForward();
        return;
      case "daintree:browser-set-zoom":
        if (typeof detail.zoomFactor === "number") callbacks.onSetZoom(detail.zoomFactor);
        return;
      case "daintree:browser-capture-screenshot":
        callbacks.onCaptureScreenshot();
        return;
      case "daintree:browser-toggle-console":
        callbacks.onToggleConsole();
        return;
      case "daintree:browser-clear-console":
        callbacks.onClearConsole();
        return;
      case "daintree:browser-toggle-devtools":
        callbacks.onToggleDevTools();
        return;
      case "daintree:hard-reload-browser":
        callbacks.onHardReload();
        return;
    }
  });

  useEffect(() => {
    const handle = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail: unknown = e.detail;
      if (typeof detail !== "object" || detail === null) return;
      if (!("id" in detail) || typeof detail.id !== "string") return;
      if (detail.id !== id) return;
      dispatch(e.type, detail as Record<string, unknown>);
    };

    const controller = new AbortController();
    for (const type of BROWSER_ACTION_EVENTS) {
      window.addEventListener(type, handle, { signal: controller.signal });
    }
    return () => controller.abort();
  }, [id]);
}
