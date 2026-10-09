import type { PluginFocusedPanel } from "../../shared/types/plugin.js";
import {
  NO_FOCUSED_PANEL,
  pluginFocusedPanelEquals,
  toPluginFocusedPanel,
} from "../../shared/utils/pluginFocusedPanel.js";

/** The focused panel, plus the project view it was reported from (`null` for the Portal). */
export interface FocusedPanelState {
  readonly panel: PluginFocusedPanel;
  readonly workspaceId: string | null;
}

export const NO_FOCUSED_PANEL_STATE: FocusedPanelState = Object.freeze({
  panel: NO_FOCUSED_PANEL,
  workspaceId: null,
});

const PORTAL_FOCUSED_STATE: FocusedPanelState = Object.freeze({
  panel: Object.freeze({ kind: "portal", agent: false, worktreeId: null }),
  workspaceId: null,
});

interface SenderReport {
  windowId: number;
  workspaceId: string | null;
  panel: PluginFocusedPanel;
  seq: number;
}

export interface FocusedPanelSenderChecks {
  /** The reporting webContents holds native keyboard focus in its window. */
  isFocused: (webContentsId: number) => boolean;
  /**
   * The reporting webContents is its window's active project view. Consulted
   * only when no reporting view holds native focus, which is the case while
   * a `<webview>` guest inside the view has it.
   */
  isActive: (webContentsId: number) => boolean;
  /** The project a reporting view belongs to, read when composing so a view registered after its first report is still attributed. */
  workspaceOf: (webContentsId: number) => string | null;
}

/**
 * Which kind of panel has real focus, app-wide (#13221). Each fact comes from
 * the process that can actually observe it: the panel (kind, agent flag,
 * worktree) from the project view's renderer, Portal focus from the Portal
 * view's own webContents, and OS foreground from the BrowserWindow, because a
 * child view's webContents does not reliably blur when its window does.
 */
export class FocusedPanelTracker {
  private readonly reports = new Map<number, SenderReport>();
  private readonly portalFocusedWindows = new Set<number>();
  private focusedWindowId: number | null = null;
  private seq = 0;
  private current: FocusedPanelState = NO_FOCUSED_PANEL_STATE;
  private readonly listeners = new Set<(state: FocusedPanelState) => void>();
  private checks: Partial<FocusedPanelSenderChecks>;

  constructor(checks: Partial<FocusedPanelSenderChecks> = {}) {
    this.checks = checks;
  }

  /** Installed by main, which owns the webContents registry this module stays free of. */
  setSenderChecks(checks: Partial<FocusedPanelSenderChecks>): void {
    this.checks = checks;
    this.recompute();
  }

  /** Re-derive after a fact the checks read changed (a view gained or lost native focus). */
  refresh(): void {
    this.recompute();
  }

  getCurrent(): FocusedPanelState {
    return this.current;
  }

  subscribe(listener: (state: FocusedPanelState) => void): () => void {
    const entry = (state: FocusedPanelState) => listener(state);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  setFocusedWindow(windowId: number | null): void {
    this.focusedWindowId = windowId;
    this.recompute();
  }

  /** A window blurred: clears focus only if it was the focused one, so blur-after-focus can't race. */
  blurWindow(windowId: number): void {
    if (this.focusedWindowId !== windowId) return;
    this.focusedWindowId = null;
    this.recompute();
  }

  setPortalFocused(windowId: number, focused: boolean): void {
    if (focused) this.portalFocusedWindows.add(windowId);
    else this.portalFocusedWindows.delete(windowId);
    this.recompute();
  }

  report(
    webContentsId: number,
    windowId: number,
    workspaceId: string | null,
    payload: unknown
  ): void {
    this.reports.set(webContentsId, {
      windowId,
      workspaceId,
      panel: toPluginFocusedPanel(payload),
      seq: ++this.seq,
    });
    this.recompute();
  }

  removeSender(webContentsId: number): void {
    if (!this.reports.delete(webContentsId)) return;
    this.recompute();
  }

  removeWindow(windowId: number): void {
    this.portalFocusedWindows.delete(windowId);
    for (const [id, report] of this.reports) {
      if (report.windowId === windowId) this.reports.delete(id);
    }
    if (this.focusedWindowId === windowId) this.focusedWindowId = null;
    this.recompute();
  }

  private resolve(): FocusedPanelState {
    const windowId = this.focusedWindowId;
    if (windowId === null) return NO_FOCUSED_PANEL_STATE;
    if (this.portalFocusedWindows.has(windowId)) return PORTAL_FOCUSED_STATE;
    const { isFocused, isActive, workspaceOf } = this.checks;
    const inWindow: Array<[number, SenderReport]> = [];
    for (const entry of this.reports) {
      if (entry[1].windowId === windowId) inWindow.push(entry);
    }
    // Native focus first: during a project switch the outgoing view can keep
    // focus after the incoming one is already "active".
    let pool = isFocused ? inWindow.filter(([id]) => isFocused(id)) : inWindow;
    if (pool.length === 0 && isActive) pool = inWindow.filter(([id]) => isActive(id));
    let latest: [number, SenderReport] | null = null;
    for (const entry of pool) {
      if (latest === null || entry[1].seq > latest[1].seq) latest = entry;
    }
    if (latest === null || latest[1].panel.kind === null) return NO_FOCUSED_PANEL_STATE;
    const [id, report] = latest;
    // The Portal is app-wide however it was observed, so it never carries a
    // project — a project plugin must not see it through the dock's chrome.
    if (report.panel.kind === "portal") return PORTAL_FOCUSED_STATE;
    return { panel: report.panel, workspaceId: workspaceOf?.(id) ?? report.workspaceId };
  }

  private recompute(): void {
    const next = this.resolve();
    if (
      next.workspaceId === this.current.workspaceId &&
      pluginFocusedPanelEquals(next.panel, this.current.panel)
    ) {
      return;
    }
    this.current = Object.freeze(next);
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current);
      } catch (err) {
        console.error("[FocusedPanelTracker] listener failed:", err);
      }
    }
  }
}

let instance: FocusedPanelTracker | null = null;

/** The process-wide tracker. Created on first use so tests can construct their own. */
export function getFocusedPanelTracker(): FocusedPanelTracker {
  if (!instance) instance = new FocusedPanelTracker();
  return instance;
}

export function _setFocusedPanelTrackerForTests(tracker: FocusedPanelTracker | null): void {
  instance = tracker;
}
