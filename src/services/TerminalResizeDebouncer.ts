// Resize configuration for visibility and buffer awareness
export interface ResizeConfig {
  immediate: boolean; // Force immediate resize (user-initiated)
  bufferLineCount: number; // Current buffer size
  isVisible: boolean; // Terminal visibility state
}

// Buffer size threshold - below this, resize immediately (matches VS Code)
const START_DEBOUNCING_THRESHOLD = 200;
// Horizontal resize debounce delay (reflow is expensive)
const HORIZONTAL_DEBOUNCE_MS = 100;
// Vertical resize throttle delay - TUI apps redraw entire screen on height changes.
// Use leading-edge + trailing throttle to balance responsiveness with TUI redraw storms.
const VERTICAL_THROTTLE_MS = 150;
// Max wait time for idle callbacks (both X and Y)
const IDLE_CALLBACK_TIMEOUT_MS = 1000;

type ResizeXCallback = (cols: number) => void;
type ResizeYCallback = (rows: number) => void;
type ResizeBothCallback = (cols: number, rows: number) => void;

// ID distinguisher: setTimeout returns small integers, requestIdleCallback returns larger ones
// This is used to determine which cleanup function to call
type JobId = { type: "timeout"; id: number } | { type: "idle"; id: number };

export class TerminalResizeDebouncer {
  private latestCols = 0;
  private latestRows = 0;

  private resizeXJob: JobId | null = null;
  private resizeYJob: JobId | null = null;

  // Track last Y resize time for leading-edge throttle
  private lastYResizeTime = 0;

  private resizeXCallback: ResizeXCallback;
  private resizeYCallback: ResizeYCallback;
  private resizeBothCallback: ResizeBothCallback;

  constructor(resizeX: ResizeXCallback, resizeY: ResizeYCallback, resizeBoth: ResizeBothCallback) {
    this.resizeXCallback = resizeX;
    this.resizeYCallback = resizeY;
    this.resizeBothCallback = resizeBoth;
  }

  resize(cols: number, rows: number, config: ResizeConfig): void {
    this.latestCols = cols;
    this.latestRows = rows;

    // Immediate resize for small buffers or explicit immediate flag
    if (config.immediate || config.bufferLineCount < START_DEBOUNCING_THRESHOLD) {
      this.clear();
      this.resizeBothCallback(cols, rows);
      return;
    }

    // Invisible terminals: defer to idle callback
    if (!config.isVisible) {
      this.scheduleIdleResize();
      return;
    }

    // Visible terminals: throttle Y (TUI apps redraw on height change), debounce X (expensive reflow)
    this.throttleResizeY(rows);
    this.debounceResizeX(cols);
  }

  // Force flush any pending resize operations
  flush(): void {
    if (this.resizeXJob || this.resizeYJob) {
      this.clear();
      this.resizeBothCallback(this.latestCols, this.latestRows);
    }
  }

  private scheduleIdleResize(): void {
    const win = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const hasIdleCallback = typeof win.requestIdleCallback === "function";

    if (!this.resizeXJob) {
      if (hasIdleCallback && win.requestIdleCallback) {
        const id = win.requestIdleCallback(
          () => {
            this.resizeXCallback(this.latestCols);
            this.resizeXJob = null;
          },
          { timeout: IDLE_CALLBACK_TIMEOUT_MS }
        );
        this.resizeXJob = { type: "idle", id };
      } else {
        // Fallback for browsers without requestIdleCallback
        const id = window.setTimeout(() => {
          this.resizeXCallback(this.latestCols);
          this.resizeXJob = null;
        }, IDLE_CALLBACK_TIMEOUT_MS);
        this.resizeXJob = { type: "timeout", id };
      }
    }

    if (!this.resizeYJob) {
      if (hasIdleCallback && win.requestIdleCallback) {
        const id = win.requestIdleCallback(
          () => {
            this.resizeYCallback(this.latestRows);
            this.resizeYJob = null;
          },
          { timeout: IDLE_CALLBACK_TIMEOUT_MS }
        );
        this.resizeYJob = { type: "idle", id };
      } else {
        const id = window.setTimeout(() => {
          this.resizeYCallback(this.latestRows);
          this.resizeYJob = null;
        }, IDLE_CALLBACK_TIMEOUT_MS);
        this.resizeYJob = { type: "timeout", id };
      }
    }
  }

  private debounceResizeX(cols: number): void {
    // Clear existing horizontal debounce
    if (this.resizeXJob) {
      this.clearJob(this.resizeXJob);
      this.resizeXJob = null;
    }

    const id = window.setTimeout(() => {
      this.resizeXCallback(cols);
      this.resizeXJob = null;
    }, HORIZONTAL_DEBOUNCE_MS);
    this.resizeXJob = { type: "timeout", id };
  }

  // Leading-edge throttle for Y resize: fire immediately on first call,
  // then schedule trailing update if more changes come within throttle window.
  // This balances quick visual alignment with TUI redraw storm prevention.
  private throttleResizeY(rows: number): void {
    const now = Date.now();
    const timeSinceLastY = now - this.lastYResizeTime;

    // Leading edge: if enough time has passed, fire immediately
    if (timeSinceLastY >= VERTICAL_THROTTLE_MS) {
      this.lastYResizeTime = now;
      // Clear any pending trailing update
      if (this.resizeYJob) {
        this.clearJob(this.resizeYJob);
        this.resizeYJob = null;
      }
      this.resizeYCallback(rows);
      return;
    }

    // Within throttle window: schedule trailing update if not already scheduled
    if (!this.resizeYJob) {
      const remainingTime = VERTICAL_THROTTLE_MS - timeSinceLastY;
      const id = window.setTimeout(() => {
        this.lastYResizeTime = Date.now();
        this.resizeYCallback(this.latestRows);
        this.resizeYJob = null;
      }, remainingTime);
      this.resizeYJob = { type: "timeout", id };
    }
    // If already scheduled, the trailing update will use latestRows
  }

  private clearJob(job: JobId): void {
    if (job.type === "idle") {
      const win = window as typeof window & {
        cancelIdleCallback?: (handle: number) => void;
      };
      win.cancelIdleCallback?.(job.id);
    } else {
      clearTimeout(job.id);
    }
  }

  clear(): void {
    if (this.resizeXJob) {
      this.clearJob(this.resizeXJob);
      this.resizeXJob = null;
    }

    if (this.resizeYJob) {
      this.clearJob(this.resizeYJob);
      this.resizeYJob = null;
    }
  }

  dispose(): void {
    this.clear();
  }
}
