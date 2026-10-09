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

export interface FocusedPanelTrackerOptions {
  /**
   * Whether a reporting webContents may still speak for its window. A cached
   * (deactivated) project view is not, so a blur report it sends after the
   * switch can't overwrite the newly active view's focus.
   */
  isLiveSender?: (webContentsId: number) => boolean;
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
  private isLiveSender: (webContentsId: number) => boolean;

  constructor(options: FocusedPanelTrackerOptions = {}) {
    this.isLiveSender = options.isLiveSender ?? (() => true);
  }

  /** Installed by main, which owns the webContents registry this module stays free of. */
  setLiveSenderCheck(check: (webContentsId: number) => boolean): void {
    this.isLiveSender = check;
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
    let latest: SenderReport | null = null;
    for (const [id, report] of this.reports) {
      if (report.windowId !== windowId || !this.isLiveSender(id)) continue;
      if (latest === null || report.seq > latest.seq) latest = report;
    }
    if (latest === null || latest.panel.kind === null) return NO_FOCUSED_PANEL_STATE;
    return { panel: latest.panel, workspaceId: latest.workspaceId };
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
