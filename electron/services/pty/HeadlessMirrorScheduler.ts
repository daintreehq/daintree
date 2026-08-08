/**
 * Paces data feeds into the per-terminal `@xterm/headless` mirror terminals so
 * their deferred parse work cannot saturate the pty-host event loop.
 *
 * Why: each mirror's WriteBuffer self-slices parsing to 12ms per macrotask,
 * but that budget is PER INSTANCE. With M terminals streaming concurrently,
 * every event-loop iteration runs up to M×12ms of back-to-back parse slices in
 * the timers phase before transport flushes (setImmediate) get a turn — the
 * "scrolling one full-screen TUI locks up every terminal" mechanism. Nothing
 * queues past a watermark, so backpressure never engages; the thread is simply
 * busy.
 *
 * How: feeds are held here (FIFO per terminal) and released by a shared drain
 * tick under two closed-loop bounds — a per-terminal per-tick budget for
 * fairness, and an aggregate unparsed-bytes cap across ALL mirrors. Since a
 * mirror only parses what it has been fed, the aggregate cap bounds the total
 * parse work any single event-loop iteration can contain (~128K chars ≈ a few
 * ms at xterm's 5-35MB/s). Feeds are pre-sliced so no single write entry
 * parses atomically for longer than ~16K chars' worth.
 *
 * What this deliberately does NOT do: drop or reorder bytes (VT frames are
 * non-idempotent incremental deltas — every byte must eventually parse, in
 * order, per terminal). Under sustained overload the queue grows here instead
 * of inside xterm's WriteBuffer; growth is bounded upstream by the transport
 * watermark pausing the PTY itself.
 *
 * Consumers of the mirror buffer (agent-state poll, identity watcher, wake
 * serialize, MCP reads) tolerate bounded staleness; paths that need the tail
 * parsed use flush(). The one strict contract preserved: enqueue callbacks
 * fire only after the chunk has actually parsed, in per-terminal FIFO order —
 * `pendingHeadlessWrites` gating semantics are unchanged.
 */

type MirrorWritable = {
  write(data: string, callback?: () => void): void;
};

type FeedSlice = {
  data: string;
  // Fires when this slice has been parsed by the mirror. Only the final slice
  // of an enqueued chunk carries the caller's callback.
  onParsed?: () => void;
};

type MirrorQueue = {
  mirror: MirrorWritable;
  slices: FeedSlice[];
  inFlightChars: number;
  // Set by flush(): this queue ignores the per-tick fairness budget until it
  // fully drains, so an exit-snapshot flush isn't stretched across many ticks.
  expedite: boolean;
  // Set by clear(): suppress accounting AND callbacks from any slice callbacks
  // that still fire (mirrors today's "disposed headless write callbacks never
  // fire" semantics — a cleared queue must not decrement counters it no longer
  // owns).
  cleared: boolean;
};

// Max chars in one mirror.write() entry — a single entry parses atomically
// (the WriteBuffer's 12ms budget is only checked between entries).
const FEED_SLICE_CHARS = 16 * 1024;
// Max chars released to one terminal per drain tick — fairness across mirrors.
const PER_TERMINAL_TICK_CHARS = 64 * 1024;
// Cap on unparsed chars across all mirrors — bounds aggregate parse work per
// event-loop iteration. Refills as parse callbacks complete (closed loop), so
// throughput is limited by parse speed, not by this constant.
const AGGREGATE_INFLIGHT_CHARS = 128 * 1024;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function sliceFeed(data: string, onParsed?: () => void): FeedSlice[] {
  if (data.length <= FEED_SLICE_CHARS) {
    return [{ data, onParsed }];
  }
  const slices: FeedSlice[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + FEED_SLICE_CHARS, data.length);
    // Defensive: keep surrogate pairs whole. xterm's decoder holds interim
    // state across writes, so this is belt-and-braces, not load-bearing.
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) {
      end--;
      if (end <= start) end = Math.min(start + FEED_SLICE_CHARS, data.length);
    }
    slices.push({ data: data.slice(start, end) });
    start = end;
  }
  slices[slices.length - 1]!.onParsed = onParsed;
  return slices;
}

export class HeadlessMirrorScheduler {
  private queues = new Map<string, MirrorQueue>();
  private aggregateInFlightChars = 0;
  private tickScheduled = false;
  // Round-robin cursor: id of the queue served FIRST on the next tick. Set to
  // the id AFTER the last fully-budget-consuming queue so a hot terminal can't
  // monopolize successive ticks.
  private nextServeId: string | null = null;
  // Terminal currently inside drainForResize(). While set, enqueue() for that
  // id must never take the synchronous fast path — see drainForResize().
  private drainingForResizeId: string | null = null;

  /**
   * Queue `data` for the terminal's mirror. `onParsed` fires after the entire
   * chunk has been parsed (FIFO per terminal). Fast path: an idle terminal
   * under the aggregate cap feeds synchronously, so quiet/single-terminal
   * behavior is identical to calling `mirror.write()` directly.
   */
  enqueue(id: string, mirror: MirrorWritable, data: string, onParsed?: () => void): void {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { mirror, slices: [], inFlightChars: 0, expedite: false, cleared: false };
      this.queues.set(id, queue);
    }
    // The mirror can be recreated at the same terminal id (respawn) — always
    // track the latest instance.
    queue.mirror = mirror;

    const slices = sliceFeed(data, onParsed);
    if (
      queue.slices.length === 0 &&
      id !== this.drainingForResizeId &&
      this.aggregateInFlightChars + data.length <= AGGREGATE_INFLIGHT_CHARS
    ) {
      for (const slice of slices) {
        this.feedSlice(id, queue, slice);
        // A write failure clears the queue mid-loop; stop feeding into it.
        if (queue.cleared) break;
      }
      return;
    }

    queue.slices.push(...slices);
    this.scheduleTick();
  }

  /**
   * Fire `onFlushed` once everything already queued for `id` has been fed and
   * parsed. Marks the queue expedited (exempt from the per-tick fairness
   * budget) so exit-path flushes complete promptly; the aggregate cap still
   * applies, bounding the wait to other mirrors' in-flight parses.
   *
   * `mirror` is required because writes can reach a mirror WITHOUT the
   * scheduler ever seeing that terminal (session restore writes directly at
   * construction) — with no queue registered, the drain-wait must still be
   * delegated to the mirror's own write queue via a sentinel, not skipped.
   */
  flush(id: string, mirror: MirrorWritable, onFlushed: () => void): void {
    const queue = this.queues.get(id);
    if (!queue || (queue.slices.length === 0 && queue.inFlightChars === 0)) {
      mirror.write("", onFlushed);
      return;
    }
    queue.expedite = true;
    queue.slices.push({ data: "", onParsed: onFlushed });
    this.scheduleTick();
  }

  /**
   * Hand every slice still queued for `id` to the mirror, synchronously, then
   * run `applyResize` with this terminal's queue held closed (#11719).
   *
   * Why the resize is passed in rather than done by the caller afterwards: the
   * two steps are one atomic ordering contract, and holding the queue closed
   * across BOTH is the whole point. xterm's `Terminal.resize()` calls
   * `WriteBuffer.flushSync()` before it reflows, so bytes already inside the
   * mirror's own write buffer parse at the PRE-resize grid — correct, since
   * that is the grid they were emitted at. Bytes still held HERE would instead
   * be fed after the reflow and parse at the new grid, which is the buffer
   * corruption this fixes.
   *
   * Why not `flush()`: its callback fires from inside a mirror write callback,
   * and resizing there re-enters `flushSync` while xterm is mid-`_innerWrite`;
   * and it drains over `setImmediate` ticks, so post-resize output can queue
   * behind the sentinel and reach the write buffer before the resize lands —
   * getting parsed at the old grid, the same corruption mirrored.
   *
   * Deliberately ignores both pacing bounds. The per-tick fairness budget and
   * the aggregate in-flight cap exist to stop mirrors monopolising the event
   * loop, and neither can be honoured here: no other tick can run between the
   * drain and the resize without breaking the ordering. The aggregate ledger
   * goes temporarily over cap and is repaid in full when the resize's
   * `flushSync` fires the parse callbacks.
   *
   * Returns false when a failing write tore the queue down mid-drain, in which
   * case the mirror is disposing and `applyResize` is skipped.
   */
  drainThenResize(id: string, mirror: MirrorWritable, applyResize: () => void): boolean {
    const queue = this.queues.get(id);
    // The guard spans the resize as well as the drain: `flushSync` fires parse
    // callbacks synchronously, and one of those synchronously enqueueing fresh
    // (post-resize) output would otherwise take the fast path straight into the
    // write buffer xterm is still draining — parsing new-grid bytes at the old
    // grid.
    this.drainingForResizeId = id;
    try {
      if (queue) {
        queue.mirror = mirror;
        while (queue.slices.length > 0) {
          const slice = queue.slices.shift()!;
          this.feedSlice(id, queue, slice);
          if (queue.cleared) return false;
        }
        queue.expedite = false;
      }
      applyResize();
    } finally {
      this.drainingForResizeId = null;
    }
    // Deferred output parked by the guard still needs a tick to be released.
    if (this.hasPendingSlices()) this.scheduleTick();
    return true;
  }

  /**
   * Drop everything held for `id` and detach its accounting. Queued slices are
   * discarded WITHOUT firing callbacks, matching the pre-scheduler behavior of
   * disposing a headless terminal with writes still queued.
   */
  clear(id: string): void {
    const queue = this.queues.get(id);
    if (!queue) return;
    queue.cleared = true;
    this.aggregateInFlightChars -= queue.inFlightChars;
    queue.inFlightChars = 0;
    queue.slices.length = 0;
    this.queues.delete(id);
    if (this.nextServeId === id) this.nextServeId = null;
    // Releasing this queue's in-flight share may unblock feeds that were
    // waiting on the aggregate cap — and the cleared queue's parse callbacks
    // (the usual re-arm source) are inert from here on, so re-arm explicitly
    // or survivors could sit queued until unrelated activity ticks again.
    if (this.hasPendingSlices()) {
      this.scheduleTick();
    }
  }

  /** Chars queued (not yet fed) for a terminal — test/diagnostic accessor. */
  queuedChars(id: string): number {
    const queue = this.queues.get(id);
    if (!queue) return 0;
    let total = 0;
    for (const slice of queue.slices) total += slice.data.length;
    return total;
  }

  /** Chars fed but not yet parsed across all mirrors — test/diagnostic accessor. */
  inFlightChars(): number {
    return this.aggregateInFlightChars;
  }

  private feedSlice(id: string, queue: MirrorQueue, slice: FeedSlice): void {
    if (queue.cleared) return;
    const chars = slice.data.length;
    queue.inFlightChars += chars;
    this.aggregateInFlightChars += chars;
    try {
      queue.mirror.write(slice.data, () => {
        if (queue.cleared) return;
        queue.inFlightChars -= chars;
        this.aggregateInFlightChars -= chars;
        slice.onParsed?.();
        if (queue.slices.length > 0 || this.hasPendingSlices()) {
          this.scheduleTick();
        }
      });
    } catch (error) {
      // A torn-down mirror core throws on write. Undo this slice's accounting
      // and drop the queue — its terminal is disposing; stuck accounting would
      // otherwise wedge the aggregate cap for every other terminal.
      queue.inFlightChars -= chars;
      this.aggregateInFlightChars -= chars;
      console.error(`[HeadlessMirrorScheduler] mirror write failed for ${id}:`, error);
      this.clear(id);
    }
  }

  // O(queue count) scan, called from parse callbacks and clear(). Fine at the
  // real scale (tens of terminals, each check nanoseconds next to a multi-ms
  // parse); revisit with a pending-count field only if terminal counts grow
  // orders of magnitude.
  private hasPendingSlices(): boolean {
    for (const queue of this.queues.values()) {
      if (queue.slices.length > 0) return true;
    }
    return false;
  }

  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    setImmediate(() => {
      this.tickScheduled = false;
      this.tick();
    });
  }

  private tick(): void {
    if (this.queues.size === 0) return;

    // Serve order: rotate so the queue after last tick's first-served goes
    // first. Map preserves insertion order; build the rotation once per tick.
    const ids = [...this.queues.keys()];
    const startIndex = this.nextServeId ? Math.max(0, ids.indexOf(this.nextServeId)) : 0;
    let served = 0;
    let cursorAdvanced = false;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[(startIndex + i) % ids.length]!;
      const queue = this.queues.get(id);
      if (!queue || queue.slices.length === 0) continue;

      if (!cursorAdvanced) {
        this.nextServeId = ids[(startIndex + i + 1) % ids.length]!;
        cursorAdvanced = true;
      }

      let releasedThisTick = 0;
      while (queue.slices.length > 0) {
        // Strict cap: check the PROJECTED total so a near-full ledger can't be
        // pushed over by one more slice (a zero-length flush sentinel always
        // fits). Parse-completion callbacks re-arm the tick once room opens.
        if (this.aggregateInFlightChars + queue.slices[0]!.data.length > AGGREGATE_INFLIGHT_CHARS) {
          return;
        }
        // The per-terminal fairness budget is a post-check by design — it may
        // overshoot by at most one ≤16K slice, which matters for fairness
        // (bounded) but not for the aggregate parse bound above.
        if (!queue.expedite && releasedThisTick >= PER_TERMINAL_TICK_CHARS) {
          break;
        }
        const slice = queue.slices.shift()!;
        releasedThisTick += slice.data.length;
        served += slice.data.length;
        this.feedSlice(id, queue, slice);
        // feedSlice may have cleared the queue on a write failure.
        if (queue.cleared) break;
      }
      if (queue.slices.length === 0) {
        queue.expedite = false;
      }
    }

    if (this.hasPendingSlices() && served > 0) {
      this.scheduleTick();
    }
  }
}

/**
 * Process-wide instance: the whole point is bounding AGGREGATE parse work
 * across every terminal in the pty-host, so all TerminalProcess instances
 * share one scheduler. Tests may construct their own instances.
 */
export const headlessMirrorScheduler = new HeadlessMirrorScheduler();
