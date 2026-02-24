import { Terminal } from "@xterm/xterm";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { ManagedTerminal, ResizeJobId } from "./types";
import type { TerminalOutputIngestService } from "./TerminalOutputIngestService";

const START_DEBOUNCING_THRESHOLD = 200;
const HORIZONTAL_DEBOUNCE_MS = 100;
const VERTICAL_THROTTLE_MS = 150;
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

  updateExactWidth(managed: ManagedTerminal): void {
    const cellDims = getXtermCellDimensions(managed.terminal);
    if (!cellDims) return;

    const cols = managed.terminal.cols;
    const contentWidth = Math.ceil(cols * cellDims.width);

    // Detect scrollbar width by querying the actual viewport element
    // offsetWidth includes scrollbar, clientWidth excludes it
    const viewport = managed.hostElement.querySelector(".xterm-viewport") as HTMLElement | null;
    const scrollbarWidth = viewport ? viewport.offsetWidth - viewport.clientWidth : 0;

    // Never shrink below the container width; otherwise the viewport scrollbar
    // can appear inset from the panel edge after fit rounding.
    const exactWidth = contentWidth + scrollbarWidth;
    managed.hostElement.style.width = `max(100%, ${exactWidth}px)`;
  }

  resetWidthForFit(managed: ManagedTerminal): void {
    managed.hostElement.style.width = "100%";
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
      this.resetWidthForFit(managed);
      managed.fitAddon.fit();
      const { cols, rows } = managed.terminal;
      managed.latestCols = cols;
      managed.latestRows = rows;
      this.sendPtyResize(id, cols, rows);
      this.updateExactWidth(managed);
      return { cols, rows };
    } catch (error) {
      console.warn("Terminal fit failed:", error);
      return null;
    }
  }

  flushResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.resizeXJob || managed.resizeYJob) {
      this.clearResizeJobs(managed);
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
      // @ts-expect-error - internal API
      const proposed = managed.fitAddon.proposeDimensions?.({ width, height });

      if (!proposed) {
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
        this.updateExactWidth(managed);
        return { cols, rows };
      }

      const cols = proposed.cols;
      const rows = proposed.rows;

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
        this.clearResizeJobs(managed);
        this.applyResize(id, cols, rows);
        return { cols, rows };
      }

      if (!managed.isVisible) {
        this.scheduleIdleResize(id, managed);
        return { cols, rows };
      }

      this.throttleResizeY(id, managed, rows);
      this.debounceResizeX(id, managed, cols);

      return { cols, rows };
    } catch (error) {
      console.warn(`[TerminalResizeController] Resize failed for ${id}:`, error);
      return null;
    }
  }

  resizeTerminal(managed: ManagedTerminal, cols: number, rows: number): void {
    if (managed.isAltBuffer) {
      managed.terminal.write("\x1b[2J\x1b[H");
    }
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
    this.updateExactWidth(managed);
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
    this.updateExactWidth(managed);
  }

  clearResizeJobs(managed: ManagedTerminal): void {
    if (managed.resizeXJob) {
      this.clearJob(managed.resizeXJob);
      managed.resizeXJob = undefined;
    }
    if (managed.resizeYJob) {
      this.clearJob(managed.resizeYJob);
      managed.resizeYJob = undefined;
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

        // Sync xterm.js dimensions and clear display atomically with PTY resize.
        // Clear via xterm.js (not PTY stdin) to give Ratatui's diff engine
        // a clean slate without injecting unwanted input to the process.
        this.resizeTerminal(current, cols, rows);
        current.terminal.write("\x1b[2J\x1b[H");
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

  private clearJob(job: ResizeJobId): void {
    if (job.type === "idle") {
      const win = window as typeof window & {
        cancelIdleCallback?: (handle: number) => void;
      };
      win.cancelIdleCallback?.(job.id);
    } else {
      clearTimeout(job.id);
    }
  }

  private scheduleIdleResize(id: string, managed: ManagedTerminal): void {
    const win = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const hasIdleCallback = typeof win.requestIdleCallback === "function";

    if (!managed.resizeXJob) {
      if (hasIdleCallback && win.requestIdleCallback) {
        const idleId = win.requestIdleCallback(
          () => {
            const current = this.deps.getInstance(id);
            if (current) {
              this.deps.dataBuffer.flushForTerminal(id);
              this.deps.dataBuffer.resetForTerminal(id);
              this.resizeTerminal(current, current.latestCols, current.terminal.rows);
              this.sendPtyResize(id, current.latestCols, current.terminal.rows);
              this.updateExactWidth(current);
              current.resizeXJob = undefined;
            }
          },
          { timeout: IDLE_CALLBACK_TIMEOUT_MS }
        );
        managed.resizeXJob = { type: "idle", id: idleId };
      } else {
        const timeoutId = window.setTimeout(() => {
          const current = this.deps.getInstance(id);
          if (current) {
            this.deps.dataBuffer.flushForTerminal(id);
            this.deps.dataBuffer.resetForTerminal(id);
            this.resizeTerminal(current, current.latestCols, current.terminal.rows);
            this.sendPtyResize(id, current.latestCols, current.terminal.rows);
            this.updateExactWidth(current);
            current.resizeXJob = undefined;
          }
        }, IDLE_CALLBACK_TIMEOUT_MS);
        managed.resizeXJob = { type: "timeout", id: timeoutId };
      }
    }

    if (!managed.resizeYJob) {
      if (hasIdleCallback && win.requestIdleCallback) {
        const idleId = win.requestIdleCallback(
          () => {
            const current = this.deps.getInstance(id);
            if (current) {
              this.deps.dataBuffer.flushForTerminal(id);
              this.deps.dataBuffer.resetForTerminal(id);
              this.resizeTerminal(current, current.latestCols, current.latestRows);
              this.sendPtyResize(id, current.latestCols, current.latestRows);
              this.updateExactWidth(current);
              current.resizeYJob = undefined;
            }
          },
          { timeout: IDLE_CALLBACK_TIMEOUT_MS }
        );
        managed.resizeYJob = { type: "idle", id: idleId };
      } else {
        const timeoutId = window.setTimeout(() => {
          const current = this.deps.getInstance(id);
          if (current) {
            this.deps.dataBuffer.flushForTerminal(id);
            this.deps.dataBuffer.resetForTerminal(id);
            this.resizeTerminal(current, current.latestCols, current.latestRows);
            this.sendPtyResize(id, current.latestCols, current.latestRows);
            this.updateExactWidth(current);
            current.resizeYJob = undefined;
          }
        }, IDLE_CALLBACK_TIMEOUT_MS);
        managed.resizeYJob = { type: "timeout", id: timeoutId };
      }
    }
  }

  private debounceResizeX(id: string, managed: ManagedTerminal, cols: number): void {
    if (managed.resizeXJob) {
      this.clearJob(managed.resizeXJob);
      managed.resizeXJob = undefined;
    }

    const timeoutId = window.setTimeout(() => {
      const current = this.deps.getInstance(id);
      if (current) {
        this.deps.dataBuffer.flushForTerminal(id);
        this.deps.dataBuffer.resetForTerminal(id);
        this.resizeTerminal(current, cols, current.terminal.rows);
        this.sendPtyResize(id, cols, current.terminal.rows);
        this.updateExactWidth(current);
        current.resizeXJob = undefined;
      }
    }, HORIZONTAL_DEBOUNCE_MS);
    managed.resizeXJob = { type: "timeout", id: timeoutId };
  }

  private throttleResizeY(id: string, managed: ManagedTerminal, rows: number): void {
    const now = Date.now();
    const timeSinceLastY = now - managed.lastYResizeTime;

    if (timeSinceLastY >= VERTICAL_THROTTLE_MS) {
      managed.lastYResizeTime = now;
      if (managed.resizeYJob) {
        this.clearJob(managed.resizeYJob);
        managed.resizeYJob = undefined;
      }
      this.deps.dataBuffer.flushForTerminal(id);
      this.deps.dataBuffer.resetForTerminal(id);
      this.resizeTerminal(managed, managed.latestCols, rows);
      this.sendPtyResize(id, managed.latestCols, rows);
      this.updateExactWidth(managed);
      return;
    }

    if (!managed.resizeYJob) {
      const remainingTime = VERTICAL_THROTTLE_MS - timeSinceLastY;
      const timeoutId = window.setTimeout(() => {
        const current = this.deps.getInstance(id);
        if (current) {
          current.lastYResizeTime = Date.now();
          this.deps.dataBuffer.flushForTerminal(id);
          this.deps.dataBuffer.resetForTerminal(id);
          this.resizeTerminal(current, current.latestCols, current.latestRows);
          this.sendPtyResize(id, current.latestCols, current.latestRows);
          this.updateExactWidth(current);
          current.resizeYJob = undefined;
        }
      }, remainingTime);
      managed.resizeYJob = { type: "timeout", id: timeoutId };
    }
  }

  private getBufferLineCount(id: string): number {
    const managed = this.deps.getInstance(id);
    if (!managed) return 0;
    return managed.terminal.buffer.active.length;
  }
}
