import type { PluginFocusedPanel } from "@shared/types/plugin";
import {
  NO_FOCUSED_PANEL,
  pluginFocusedPanelEquals,
  toPluginFocusedPanel,
} from "@shared/utils/pluginFocusedPanel";
import { isAgentTerminal } from "@/utils/terminalType";
import { usePanelStore } from "./panelStore";

/**
 * The panel holding real DOM focus in this view, as a plugin may see it.
 * `focusedId` is not used: it keeps naming the last panel while the assistant
 * or the sidebar has focus. A panel's DOM root carries
 * `data-panel-id`, and a `<webview>` guest's focus leaves the element itself
 * as the embedder's `activeElement`, so browser panels resolve the same way.
 */
export function readFocusedPanel(): PluginFocusedPanel {
  return projectFocusTarget(resolveFocusTarget());
}

type PanelRecord = ReturnType<typeof usePanelStore.getState>["panelsById"][string];

/**
 * Where DOM focus sits, resolved once per move. The focused element's
 * ancestry can't change while it keeps focus: a focused node that is removed
 * or reparented hands focus to `<body>`.
 */
interface FocusTarget {
  readonly hasFocus: boolean;
  readonly active: Element | null;
  readonly root: Element | null;
  readonly panelId: string | null;
}

const NO_FOCUS_TARGET: FocusTarget = {
  hasFocus: false,
  active: null,
  root: null,
  panelId: null,
};

function resolveFocusTarget(): FocusTarget {
  if (typeof document === "undefined") return NO_FOCUS_TARGET;
  const hasFocus = document.hasFocus();
  const active = document.activeElement;
  if (!hasFocus) return { ...NO_FOCUS_TARGET, active };
  const root = active instanceof Element ? active.closest("[data-panel-id]") : null;
  return { ...NO_FOCUS_TARGET, hasFocus, active, root, panelId: panelIdOf(root) };
}

function panelIdOf(root: Element | null): string | null {
  return root?.getAttribute("data-panel-id") || null;
}

/** Whether `target` still stands, checked without walking the DOM. */
function focusTargetHolds(target: FocusTarget): boolean {
  return (
    document.hasFocus() === target.hasFocus &&
    document.activeElement === target.active &&
    (target.root === null || panelIdOf(target.root) === target.panelId)
  );
}

function focusedRecord(target: FocusTarget): PanelRecord | undefined {
  return target.panelId === null ? undefined : usePanelStore.getState().panelsById[target.panelId];
}

function projectFocusTarget(
  target: FocusTarget,
  panel: PanelRecord | undefined = focusedRecord(target)
): PluginFocusedPanel {
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
  let target: FocusTarget | null = null;
  let projectedFrom: PanelRecord | undefined;
  let scheduled = false;
  let fullRead = false;
  let disposed = false;

  const flush = () => {
    scheduled = false;
    if (disposed) return;
    // Store writes land on nearly every frame while agents stream, the focused
    // terminal's own record included: walk the DOM only when focus may have
    // moved, and project the current record through where it was found.
    let current = target;
    const resolve = fullRead || current === null || !focusTargetHolds(current);
    fullRead = false;
    if (resolve || current === null) current = target = resolveFocusTarget();
    const panel = focusedRecord(current);
    if (!resolve && panel === projectedFrom) return;
    projectedFrom = panel;
    const next = projectFocusTarget(current, panel);
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
  const queueSample = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(flush);
  };
  const schedule = () => {
    fullRead = true;
    queueSample();
  };

  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", schedule);
  // A store change can remove or move the focused DOM node, and removal fires
  // no `focusout`; sample again once React has committed it.
  let frame: number | null = null;
  const onStoreChange = () => {
    queueSample();
    if (frame !== null || typeof requestAnimationFrame !== "function") return;
    frame = requestAnimationFrame(() => {
      frame = null;
      queueSample();
    });
  };
  const unsubscribeStore = usePanelStore.subscribe(onStoreChange);
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
    if (frame !== null) cancelAnimationFrame(frame);
    unsubscribeStore();
  };
}
