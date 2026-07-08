import type { ManagedTerminal } from "./types";
import { GRID_RESIZE_COALESCE_MS } from "./types";
import { usePanelStore } from "@/store/panelStore";
import { logError } from "@/utils/logger";
import { yieldToScheduler } from "@/lib/schedulerYield";

// Terminals resized per task inside `runResizePass`, yielding to the scheduler
// between chunks. xterm.js 6.0 reflows the whole scrollback on a
// column-changing resize (~15-40ms each), so one-per-task keeps every task
// under the ~50ms long-task threshold and lets paint + input run between
// terminals instead of freezing the renderer for the whole batch.
const RESIZE_PASS_CHUNK_SIZE = 1;

export interface TerminalResizePassSchedulerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  isResizeLocked: (id: string) => boolean;
  resize: (id: string, width: number, height: number) => unknown;
}

/**
 * Multi-terminal batch/chunking resize orchestrator sitting above the
 * single-terminal `TerminalResizeController`. Owns the coalesced
 * (`scheduleBatchResize`) and chunked-cancellable (`runResizePass`) resize
 * passes that keep a large-grid close/open from freezing the renderer.
 */
export class TerminalResizePassScheduler {
  private gridResizeTimer: number | undefined;
  private readonly gridResizePendingIds = new Set<string>();
  private resizePassAbort: AbortController | undefined;

  constructor(private deps: TerminalResizePassSchedulerDeps) {}

  /**
   * Synchronous resize primitive: re-applies every eligibility guard
   * (instance exists, connected, visible, not resize-locked) and reads fresh
   * geometry before resizing. Private — callers outside this class must go
   * through {@link runResizePass} (chunked, cancellable) or
   * {@link scheduleBatchResize} (coalesced) so a survivor reflow never
   * freezes the renderer in one task. `executeResizePass` invokes this one
   * id at a time.
   */
  private batchResize(ids: string[]): void {
    if (ids.length === 0) return;

    type Pending = { id: string; width: number; height: number };
    const seen = new Set<string>();
    const pending: Pending[] = [];

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);

      const managed = this.deps.getInstance(id);
      if (!managed) continue;
      if (!managed.hostElement.isConnected) continue;
      if (!managed.hostElement.checkVisibility()) continue;
      if (this.deps.isResizeLocked(id)) continue;

      const rect = managed.hostElement.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) continue;

      pending.push({ id, width: rect.width, height: rect.height });
    }

    for (const { id, width, height } of pending) {
      this.deps.resize(id, width, height);
    }
  }

  /**
   * Coalesced variant of `batchResize`. A burst of grid open/close events each
   * union their ids and reset a trailing-edge timer; the actual resize runs
   * once the burst settles, on the next frame — so it never lands on the
   * synchronous open/close path the user is waiting on.
   */
  scheduleBatchResize(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.gridResizePendingIds.add(id);
    if (this.gridResizeTimer !== undefined) {
      clearTimeout(this.gridResizeTimer);
    }
    this.gridResizeTimer = window.setTimeout(() => {
      this.gridResizeTimer = undefined;
      const pendingIds = [...this.gridResizePendingIds];
      this.gridResizePendingIds.clear();
      requestAnimationFrame(() => this.runResizePass(pendingIds));
    }, GRID_RESIZE_COALESCE_MS);
  }

  /**
   * Resize a set of panels as a chunked, cancellable pass instead of one
   * synchronous loop. Closing or opening a panel resizes every surviving
   * xterm; in xterm.js 6.0 a column-changing resize reflows the entire
   * scrollback (O(scrollback)), so resizing ~15 terminals in a single
   * synchronous loop freezes the renderer for hundreds of ms — the
   * "app stops responding" the user feels on Cmd+W.
   *
   * This runs `RESIZE_PASS_CHUNK_SIZE` terminal(s) per task and yields to the
   * scheduler between chunks (see {@link yieldToScheduler}), so paint and
   * input stay live while the survivors settle progressively. The focused
   * panel resizes first so the pane the user is looking at settles in the
   * first frame; far corners of a large grid settle a beat later, unnoticed.
   *
   * Each new pass aborts any in-flight one: once a newer pass starts, the
   * survivor set the old one was resizing is already stale, so its remaining
   * reflows are cancelled. The trailing-edge debounce in
   * {@link scheduleBatchResize} coalesces a close/open burst before a pass
   * starts; this abort handles the case where a burst arrives once a pass is
   * already running. Fire-and-forget — callers never await it.
   */
  runResizePass(ids: string[]): void {
    if (ids.length === 0) return;
    // A newer pass supersedes any in-flight one — its survivor set is stale.
    this.resizePassAbort?.abort();
    const controller = new AbortController();
    this.resizePassAbort = controller;
    const run = () => this.executeResizePass(ids, controller);
    const task =
      typeof scheduler !== "undefined" && typeof scheduler.postTask === "function"
        ? scheduler.postTask(run, { priority: "user-visible", signal: controller.signal })
        : run();
    void task.catch((error) => {
      if (error instanceof Error && error.name === "AbortError") return;
      logError("terminal resize pass failed", error);
    });
  }

  /**
   * Abort any in-flight chunked resize pass without starting a new one. The
   * paint-fabric compositor uses this to give a multi-surface fabric the same
   * pass-supersession semantics the single service has: one logical pass spans
   * every surface, so starting a new pass must cancel stale chunked work on
   * surfaces that have no ids in the new pass (they'd otherwise keep reflowing
   * a survivor set that is already stale).
   */
  cancelActiveResizePass(): void {
    this.resizePassAbort?.abort();
    this.resizePassAbort = undefined;
  }

  private async executeResizePass(ids: string[], controller: AbortController): Promise<void> {
    const { signal } = controller;
    try {
      const ordered = this.orderFocusedFirst([...new Set(ids)]);
      for (let i = 0; i < ordered.length; i += RESIZE_PASS_CHUNK_SIZE) {
        if (signal.aborted) return;
        // batchResize re-applies every eligibility guard (instance exists,
        // connected, visible, not resize-locked) and reads fresh geometry —
        // correct here because layout has settled across the yields.
        this.batchResize(ordered.slice(i, i + RESIZE_PASS_CHUNK_SIZE));
        if (i + RESIZE_PASS_CHUNK_SIZE < ordered.length) {
          await yieldToScheduler();
        }
      }
    } finally {
      if (this.resizePassAbort === controller) {
        this.resizePassAbort = undefined;
      }
    }
  }

  /**
   * Order the resize set so the focused panel settles first. The user's eye
   * is on the focused pane; resizing it in the first chunk makes the pass
   * feel instant even though total work is unchanged.
   */
  private orderFocusedFirst(ids: string[]): string[] {
    const focusedId = usePanelStore.getState().focusedId;
    if (!focusedId || !ids.includes(focusedId)) return ids;
    return [focusedId, ...ids.filter((id) => id !== focusedId)];
  }

  // Abort any in-flight chunked resize pass so its yielded continuation
  // doesn't resume against a torn-down service. Called from
  // `TerminalInstanceService.dispose()`.
  dispose(): void {
    this.resizePassAbort?.abort();
    this.resizePassAbort = undefined;
  }
}
