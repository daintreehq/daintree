import type { PluginFocusedPanel } from "@shared/types/plugin";
import {
  NO_FOCUSED_PANEL,
  pluginFocusedPanelEquals,
  toPluginFocusedPanel,
} from "@shared/utils/pluginFocusedPanel";
import { isAgentTerminal } from "@/utils/terminalType";
import { usePanelStore } from "./panelStore";
import { useMacroFocusStore } from "./macroFocusStore";

/**
 * The panel holding real DOM focus in this view, as a plugin may see it.
 * `focusedId` is not used: it keeps naming the last panel while the Portal,
 * the assistant or the sidebar has focus. A panel's DOM root carries
 * `data-panel-id`, and a `<webview>` guest's focus leaves the element itself
 * as the embedder's `activeElement`, so browser panels resolve the same way.
 */
export function readFocusedPanel(): PluginFocusedPanel {
  if (typeof document === "undefined" || !document.hasFocus()) return NO_FOCUSED_PANEL;
  const active = document.activeElement;
  // The Portal dock's own chrome (tab strip, launchpad). Focus inside a Portal
  // page is a separate webContents, which main observes directly.
  const portalDock = useMacroFocusStore.getState().refs.get("portal");
  if (portalDock && active && portalDock.contains(active)) {
    return toPluginFocusedPanel({ kind: "portal" });
  }
  const root = active instanceof Element ? active.closest("[data-panel-id]") : null;
  const panelId = root?.getAttribute("data-panel-id");
  if (!panelId) return NO_FOCUSED_PANEL;
  const panel = usePanelStore.getState().panelsById[panelId];
  if (!panel) return NO_FOCUSED_PANEL;
  // A PTY-backed plugin panel is stored as a terminal; it is still a plugin's.
  return toPluginFocusedPanel({
    kind: panel.pluginPanelKindId ? "plugin" : (panel.kind ?? "terminal"),
    // Cleared by the projection for anything that is not a terminal.
    agent: isAgentTerminal(panel),
    worktreeId: panel.worktreeId ?? null,
  });
}

/**
 * Report this view's focused panel kind to main whenever it changes (#13221):
 * on DOM focus moving, on the window gaining or losing focus, and on a store
 * change that can alter the answer without moving focus (an agent starting in
 * the focused terminal, the panel moving worktree).
 */
export function subscribeFocusedPanelReporter(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const send = window.electron?.plugin?.reportFocusedPanel;
  if (typeof send !== "function") return () => {};

  let last: PluginFocusedPanel | null = null;
  let scheduled = false;
  let disposed = false;

  const flush = () => {
    scheduled = false;
    if (disposed) return;
    const next = readFocusedPanel();
    if (last !== null && pluginFocusedPanelEquals(last, next)) return;
    last = next;
    try {
      send(next);
    } catch {
      // Fire-and-forget: a torn-down preload must not break focus handling.
    }
  };
  // Deferred to a microtask: mid-transition `activeElement` is `<body>`
  // between a focusout and the matching focusin.
  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", schedule);
  const unsubscribeStore = usePanelStore.subscribe(schedule);
  // A view coming back from the cache re-sends even an unchanged answer: main
  // ignored this view while it was cached and may hold its stale report.
  const onVisibilityChange = () => {
    if (document.hidden) return;
    last = null;
    schedule();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  schedule();

  return () => {
    disposed = true;
    document.removeEventListener("focusin", schedule);
    document.removeEventListener("focusout", schedule);
    window.removeEventListener("focus", schedule);
    window.removeEventListener("blur", schedule);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unsubscribeStore();
  };
}
