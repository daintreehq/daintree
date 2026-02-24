import { Terminal } from "@xterm/xterm";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { ManagedTerminal } from "./types";
import type { TerminalOutputIngestService } from "./TerminalOutputIngestService";

const START_DEBOUNCING_THRESHOLD = 200;
const RESIZE_DEBOUNCE_MS = 100;
const IDLE_CALLBACK_TIMEOUT_MS = 1000;
const RESIZE_LOCK_TTL_MS = 5000;
const SETTLED_RESIZE_DELAY_MS = 500;

export function getXtermCellDimensions(
  terminal: Terminal
): { width: number; height: number } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = (terminal as any)._core;
    const dimensions = core?._renderService?.dimensions?.css?.cell;
    if (
      dimensions &&
      typeof dimensions.width === "number" &&
      typeof dimensions.height === "number"
    ) {
      return { width: dimensions.width, height: dimensions.height };
    }
  } catch {
    // Fall through to null
  }
  return null;
}

export interface ResizeControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  dataBuffer: TerminalOutputIngestService;
}

export class TerminalResizeController {
  private resizeLocks = new Map<string, number>();
  private settledResizeTimers = new Map<string, number>();
  private deps: ResizeControllerDeps;

  constructor(deps: ResizeControllerDeps) {
    this.deps = deps;
  }

  lockResize(id: string, locked: boolean, customTtlMs?: number): void {
    if (locked) {
      const ttl = customTtlMs ?? RESIZE_LOCK_TTL_MS;
      this.resizeLocks.set(id, Date.now() + ttl);
    } else {
      this.resizeLocks.delete(id);
    }
  }

  isResizeLocked(id: string): boolean {
    const expiry = this.resizeLocks.get(id);
    if (!expiry) return false;

    if (Date.now() > expiry) {
      this.resizeLocks.delete(id);
      return false;
    }
    return true;
  }

  fit(id: string): { cols: number; rows: number } | null {
    const managed = this.deps.getInstance(id);
    if (!managed) return null;
    if (this.isResizeLocked(id)) return null;

    const rect = managed.hostElement.getBoundingClientRect();
    if (rect.left < -10000 || rect.width < 50 || rect.height < 50) {
      return null;
    }

    try {
      managed.fitAddon.fit();
      const { cols, rows } = managed.terminal;
      managed.latestCols = cols;
      managed.latestRows = rows;
      this.sendPtyResize(id, cols, rows);
      return { cols, rows };
    } catch (error) {
      console.warn("Terminal fit failed:", error);
      return null;
    }
  }

  flushResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.resizeJob !== undefined) {
      this.clearResizeJob(managed);
      this.applyResize(id, managed.latestCols, managed.latestRows);
    }
  }

  resize(
    id: string,
    width: number,
    height: number,
    options: { immediate?: boolean } = {}
  ): { cols: number; rows: number } | null {
    const managed = this.deps.getInstance(id);
    if (!managed) return null;

    if (this.isResizeLocked(id)) {
      return null;
    }

    const currentTier =
      managed.lastAppliedTier ?? managed.getRefreshTier?.() ?? TerminalRefreshTier.FOCUSED;
    if (currentTier === TerminalRefreshTier.BACKGROUND && !managed.isFocused) {
      return null;
    }

    if (Math.abs(managed.lastWidth - width) < 1 && Math.abs(managed.lastHeight - height) < 1) {
      return null;
    }

    const buffer = managed.terminal.buffer.active;
    const wasAtBottom = buffer.baseY - buffer.viewportY < 1;

    try {
      // Calculate cols/rows directly from the passed dimensions and cell metrics.
      // xterm.js 6's proposeDimensions() takes no arguments and reads from the DOM,
      // which may not reflect the ResizeObserver dimensions yet. Computing manually
      // avoids stale-DOM mismatches.
      const cellDims = getXtermCellDimensions(managed.terminal);

      if (!cellDims || cellDims.width === 0 || cellDims.height === 0) {
        managed.fitAddon.fit();
        const cols = managed.terminal.cols;
        const rows = managed.terminal.rows;
        managed.lastWidth = width;
        managed.lastHeight = height;
        managed.latestCols = cols;
        managed.latestRows = rows;
        managed.latestWasAtBottom = wasAtBottom;
        managed.isUserScrolledBack = !wasAtBottom;
        this.sendPtyResize(id, cols, rows);
        return { cols, rows };
      }

      const cols = Math.max(2, Math.floor(width / cellDims.width));
      const rows = Math.max(1, Math.floor(height / cellDims.height));

      if (managed.terminal.cols === cols && managed.terminal.rows === rows) {
        return null;
      }

      managed.lastWidth = width;
      managed.lastHeight = height;
      managed.latestCols = cols;
      managed.latestRows = rows;
      managed.latestWasAtBottom = wasAtBottom;
      managed.isUserScrolledBack = !wasAtBottom;

      const bufferLineCount = this.getBufferLineCount(id);

      if (options.immediate || managed.isFocused || bufferLineCount < START_DEBOUNCING_THRESHOLD) {
        this.clearResizeJob(managed);
        this.applyResize(id, cols, rows);
        return { cols, rows };
      }

      if (!managed.isVisible) {
        this.scheduleIdleResize(id, managed);
        return { cols, rows };
      }

      this.debounceResize(id, managed, cols, rows);

      return { cols, rows };
    } catch (error) {
      console.warn(`[TerminalResizeController] Resize failed for ${id}:`, error);
      return null;
    }
  }

  resizeTerminal(managed: ManagedTerminal, cols: number, rows: number): void {
    managed.terminal.resize(cols, rows);
  }

  applyDeferredResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    if (this.isResizeLocked(id)) return;

    const currentCols = managed.terminal.cols;
    const currentRows = managed.terminal.rows;
    const targetCols = managed.latestCols;
    const targetRows = managed.latestRows;

    if (currentCols !== targetCols || currentRows !== targetRows) {
      managed.terminal.resize(targetCols, targetRows);
      this.sendPtyResize(id, targetCols, targetRows);
    }
  }

  applyResize(id: string, cols: number, rows: number): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (this.isResizeLocked(id)) {
      return;
    }

    this.deps.dataBuffer.flushForTerminal(id);
    this.deps.dataBuffer.resetForTerminal(id);

    if (this.getResizeStrategy(managed) === "settled") {
      // For settled agents, defer xterm.js resize to fire atomically
      // with the PTY resize inside the settled timer callback.
      // This avoids a 500ms mismatch where xterm.js shows new dimensions
      // while the agent is still rendering at old dimensions.
      managed.latestCols = cols;
      managed.latestRows = rows;
      this.sendPtyResize(id, cols, rows);
    } else {
      this.resizeTerminal(managed, cols, rows);
      this.sendPtyResize(id, cols, rows);
    }
  }

  clearResizeJob(managed: ManagedTerminal): void {
    if (managed.resizeJob !== undefined) {
      clearTimeout(managed.resizeJob);
      managed.resizeJob = undefined;
    }
  }

  clearResizeLock(id: string): void {
    this.resizeLocks.delete(id);
  }

  sendPtyResize(id: string, cols: number, rows: number): void {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      terminalClient.resize(id, cols, rows);
      return;
    }

    if (this.getResizeStrategy(managed) === "settled") {
      const existing = this.settledResizeTimers.get(id);
      if (existing !== undefined) clearTimeout(existing);

      const timer = globalThis.setTimeout(() => {
        this.settledResizeTimers.delete(id);

        const current = this.deps.getInstance(id);
        if (!current) {
          return;
        }

        this.resizeTerminal(current, cols, rows);
        terminalClient.resize(id, cols, rows);
      }, SETTLED_RESIZE_DELAY_MS) as unknown as number;
      this.settledResizeTimers.set(id, timer);
    } else {
      terminalClient.resize(id, cols, rows);
    }
  }

  forceImmediateResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    const cols = managed.latestCols;
    const rows = managed.latestRows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      return;
    }

    this.clearSettledTimer(id);
    terminalClient.resize(id, cols, rows);
  }

  clearSettledTimer(id: string): void {
    const timer = this.settledResizeTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.settledResizeTimers.delete(id);
    }
  }

  private getResizeStrategy(managed: ManagedTerminal): "default" | "settled" {
    if (!managed.agentId) return "default";
    const config = getEffectiveAgentConfig(managed.agentId);
    return config?.capabilities?.resizeStrategy ?? "default";
  }

  private scheduleIdleResize(id: string, managed: ManagedTerminal): void {
    if (managed.resizeJob !== undefined) return;

    const idleId = requestIdleCallback(
      () => {
        const current = this.deps.getInstance(id);
        if (current) {
          current.resizeJob = undefined;
          this.deps.dataBuffer.flushForTerminal(id);
          this.deps.dataBuffer.resetForTerminal(id);
          this.resizeTerminal(current, current.latestCols, current.latestRows);
          this.sendPtyResize(id, current.latestCols, current.latestRows);
        }
      },
      { timeout: IDLE_CALLBACK_TIMEOUT_MS }
    );
    managed.resizeJob = idleId as unknown as number;
  }

  private debounceResize(id: string, managed: ManagedTerminal, cols: number, rows: number): void {
    this.clearResizeJob(managed);

    const timeoutId = window.setTimeout(() => {
      const current = this.deps.getInstance(id);
      if (current) {
        current.resizeJob = undefined;
        this.deps.dataBuffer.flushForTerminal(id);
        this.deps.dataBuffer.resetForTerminal(id);
        this.resizeTerminal(current, cols, rows);
        this.sendPtyResize(id, cols, rows);
      }
    }, RESIZE_DEBOUNCE_MS);
    managed.resizeJob = timeoutId;
  }

  private getBufferLineCount(id: string): number {
    const managed = this.deps.getInstance(id);
    if (!managed) return 0;
    return managed.terminal.buffer.active.length;
  }
}
