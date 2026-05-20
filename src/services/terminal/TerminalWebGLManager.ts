import type { WebglAddon as WebglAddonType } from "@xterm/addon-webgl";
import type { IDisposable } from "@xterm/xterm";
import {
  getMaxContexts,
  getPassiveThreshold,
  setMaxContexts as setConfiguredMaxContexts,
  setPassiveThreshold as setConfiguredPassiveThreshold,
} from "./TerminalWebGLConfig";
import { WRITE_BURST_RECENCY_MS, type ManagedTerminal } from "./types";

const WEBGL_DISABLED = import.meta.env.DAINTREE_DISABLE_WEBGL === "1";

type WebglAddonConstructor = new () => WebglAddonType;

// @xterm/addon-webgl loads via dynamic import so it stays out of the renderer's
// eager critical path. ensureContext() routes every new request through a
// requestAnimationFrame drain queue (one attach per frame): without that
// stagger, a burst of synchronous attaches during bulk worktree creation
// over-subscribes Chromium's 16-context-per-renderer cap, causing silent
// eviction of older contexts that then sit blank for 3s waiting on
// webglcontextrestored before xterm's onContextLoss fires (see #7467).
let WebglAddonClass: WebglAddonConstructor | null = null;
let webglAddonLoadPromise: Promise<WebglAddonConstructor> | null = null;

function loadWebglAddon(): Promise<WebglAddonConstructor> {
  if (WebglAddonClass) return Promise.resolve(WebglAddonClass);
  if (webglAddonLoadPromise) return webglAddonLoadPromise;
  webglAddonLoadPromise = import("@xterm/addon-webgl").then(
    (mod) => {
      WebglAddonClass = mod.WebglAddon as unknown as WebglAddonConstructor;
      return WebglAddonClass;
    },
    (err) => {
      // Allow a later ensureContext call to retry after a transient failure.
      webglAddonLoadPromise = null;
      throw err;
    }
  );
  return webglAddonLoadPromise;
}

// Force synchronous GPU-side context release. Reaches into @xterm/addon-webgl
// 0.19's renderer internals to get the WebGL context and call loseContext()
// before addon.dispose() — without this, Chromium's 16-context budget is not
// freed until garbage collection runs the WebGL teardown. Wrapped in try/catch
// so a future addon shape change degrades gracefully rather than throwing.
function forceGpuSlotRelease(addon: WebglAddonType): void {
  try {
    const gl = (
      addon as unknown as {
        _renderer?: { _gl?: WebGL2RenderingContext | WebGLRenderingContext };
      }
    )._renderer?._gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // ignore — internal addon shape may have changed in a future version
  }
}

function combineDisposables(disposables: IDisposable[]): IDisposable | null {
  if (disposables.length === 0) return null;
  return {
    dispose(): void {
      for (const disposable of disposables) {
        try {
          disposable.dispose();
        } catch {
          // ignore — teardown should continue for the rest of the listeners
        }
      }
    },
  };
}

type WebglAddonWithRendererInternals = WebglAddonType & {
  _renderer?: {
    _clearModel?: (clearGlyphRenderer: boolean) => void;
    handleResize?: (cols: number, rows: number) => void;
  };
};

function resetLocalWebGLRenderer(addon: WebglAddonType, cols: number, rows: number): boolean {
  const renderer = (addon as WebglAddonWithRendererInternals)._renderer;
  if (cols > 0 && rows > 0 && typeof renderer?.handleResize === "function") {
    try {
      renderer.handleResize(cols, rows);
      return true;
    } catch {
      // fall through to the lighter local-model reset
    }
  }
  if (typeof renderer?._clearModel !== "function") {
    return false;
  }
  try {
    renderer._clearModel(true);
    return true;
  } catch {
    return false;
  }
}

interface WebGLEntry {
  addon: WebglAddonType;
  managed: ManagedTerminal;
  contextLossDisposable: IDisposable;
  captureDisposable: (() => void) | null;
  atlasResyncDisposable: IDisposable | null;
}

export class TerminalWebGLManager {
  // Chromium caps active WebGL contexts at 16 per renderer process.
  // Reserve 4 slots for potential non-terminal WebGL consumers in the
  // main renderer (browser/dev-preview panels are process-isolated via
  // <webview> partitions and have their own budgets). The pool size lives
  // in TerminalWebGLConfig so the eager renderer chunk can adjust it
  // without dragging @xterm/addon-webgl into the entry bundle.

  // Circuit breaker: if N genuine context-loss events occur within W ms,
  // disable WebGL for the rest of the session to avoid strobing reacquisition
  // on systems with persistent GPU faults. Two recurrence paths to keep in
  // mind when tuning these constants:
  //   1. M-series Macs on external displays at fractional scaling — repeated
  //      per-context faults spaced over seconds; each loss is a distinct GPU
  //      event and must each count toward the threshold (issue #6163).
  //   2. Chromium 146 D3D11on12 memory pressure (and equivalent bulk
  //      GL_OUT_OF_MEMORY paths) — the GPU process drops every active context
  //      via a single IPC, dispatching webglcontextlost synchronously to N
  //      pool entries in the same animation frame. Counting each of those as
  //      a separate breaker event would trip the threshold from one GPU event.
  // To preserve case 1 while neutralising case 2, recordContextLoss is fed
  // through scheduleContextLossFlush: per-frame burst coalescing means one
  // GPU event = one breaker tick regardless of how many pool entries fired.
  private static readonly LOSS_THRESHOLD = 3;
  private static readonly LOSS_WINDOW_MS = 60_000;

  static get MAX_CONTEXTS(): number {
    return getMaxContexts();
  }

  static setMaxContexts(n: number): void {
    setConfiguredMaxContexts(n);
  }

  static setPassiveThreshold(n: number): void {
    setConfiguredPassiveThreshold(n);
  }

  private pool = new Map<string, WebGLEntry>();
  private lruOrder: string[] = [];
  private hardwareAvailable = true;
  private hasLoggedSoftwareSkip = false;
  private lossTimestamps: number[] = [];
  private hasLoggedBreakerTrip = false;
  // Burst coalescer for context-loss events: a bulk GPU-process eviction can
  // synchronously fire webglcontextlost on every pool entry within one frame.
  // pendingLossCount accumulates raw notifications; flushContextLoss records
  // exactly one breaker tick per frame regardless of how many fired.
  private pendingLossCount = 0;
  private lossCoalesceRafId: number | null = null;
  // Pool-pressure diagnostics (Tier 0 — silent log). Eviction at a full pool is
  // expected behaviour in 20–30 terminal tiled fleets and falls back seamlessly
  // to the DOM renderer, so this is observable-only, not user-facing. Rate
  // limited to one console.warn per minute, mirroring hasLoggedBreakerTrip.
  private evictionCount = 0;
  // -Infinity so the first eviction always crosses the interval and warns,
  // independent of the absolute clock value (real epoch or a faked time of 0).
  private lastEvictionWarnAt = Number.NEGATIVE_INFINITY;
  private static readonly EVICTION_WARN_INTERVAL_MS = 60_000;
  // Queue of pending ensure requests: drained one-per-rAF so each context
  // allocation completes its GPU IPC roundtrip before the next is requested.
  private pendingEnsures = new Map<string, ManagedTerminal>();
  // Tracked separately from the rAF id: the "scheduled" flag has different
  // semantics than the cancellation handle when rAF runs synchronously (e.g.
  // under a test shim that invokes the callback inline).
  private pendingDrainScheduled = false;
  private pendingEnsureRafId: number | null = null;
  // xterm shares one module-global TextureAtlas across every terminal with a
  // matching font/theme config. A page-merge (TextureAtlas._mergePages) splices
  // pages and rewrites glyph texturePage indices, but each WebGL renderer keeps
  // its own local model/vertex buffers. Colored/dim status lines amplify this
  // because atlas entries are keyed by code + bg + fg + ext, so the same text
  // shape can churn many colored glyph entries. If a cell's code/bg/fg/ext did
  // not change, xterm can skip rebuilding that cell even though the underlying
  // atlas coordinates changed, leaving the renderer sampling the wrong glyph
  // image. The normal user-visible recovery, resizing the terminal, works
  // because xterm's WebGL resize path locally resizes the glyph renderer,
  // reattaches the atlas, clears the model, and then repaints. The public
  // clearTextureAtlas() API clears the shared atlas too, so using it as a
  // per-renderer recovery can perturb co-owners under tiled-agent load. Instead,
  // run only the local resize-like reset through the pinned 0.19 internal shape
  // and follow with a full terminal.refresh(). If that internal shape drifts,
  // fall back to releasing/reacquiring only this context.
  // Recurrence signature to watch for when triaging: ~12 concurrent agents, a
  // Claude Code status line rewritten via \r at 1Hz, and visible-but-unfocused
  // panes that take no further writes staying corrupted until a resize or
  // atlasResync (see #8080).
  private atlasResyncPending = new Set<string>();
  private atlasResyncRafId: number | null = null;

  setHardwareAvailable(available: boolean): void {
    this.hardwareAvailable = available;
  }

  ensureContext(id: string, managed: ManagedTerminal): void {
    if (WEBGL_DISABLED) return;
    if (!this.hardwareAvailable) {
      if (!this.hasLoggedSoftwareSkip && !this.hasLoggedBreakerTrip) {
        console.warn("[TerminalWebGLManager] Skipping WebGL: software-only GPU detected");
        this.hasLoggedSoftwareSkip = true;
      }
      return;
    }
    if (!managed.isOpened) return;

    // Passive-mode gate: when a large agent fleet is visible at once, the pool
    // (capped well below the visible count) would otherwise cycle the same
    // terminals through release/reacquire, flashing them. Once the threshold of
    // contexts is occupied, suppress new acquisitions — those terminals stay on
    // the DOM renderer. Existing pooled contexts are untouched and drain
    // naturally via releaseContext/onTerminalDestroyed; the next ensure from a
    // newly-visible terminal passes the gate once the count falls back below it.
    // Re-ensures of terminals already pooled (LRU touch) or already queued must
    // pass through — they don't add a new context, and gating them on the raw
    // pool+queue size would spuriously suppress an unrelated free slot.
    if (!this.pool.has(id) && !this.pendingEnsures.has(id)) {
      if (this.pool.size + this.pendingEnsures.size >= getPassiveThreshold()) return;
    }

    // Dedupe: latest request per id wins until the queue drains.
    this.pendingEnsures.set(id, managed);

    if (WebglAddonClass) {
      this.scheduleDrain();
      return;
    }

    void loadWebglAddon().then(
      () => this.scheduleDrain(),
      () => {
        // Retain pending; a subsequent ensureContext call will retry the load.
      }
    );
  }

  releaseContext(id: string): void {
    this.pendingEnsures.delete(id);
    if (this.pool.has(id)) {
      this.doRelease(id);
    }
  }

  isActive(id: string): boolean {
    return this.pool.has(id);
  }

  onTerminalDestroyed(id: string): void {
    this.pendingEnsures.delete(id);
    const entry = this.pool.get(id);
    if (entry) {
      try {
        entry.contextLossDisposable.dispose();
      } catch {
        // ignore
      }
      try {
        entry.captureDisposable?.();
      } catch {
        // ignore
      }
      try {
        entry.atlasResyncDisposable?.dispose();
      } catch {
        // ignore
      }
      // terminal.dispose() handles addon cleanup, so we skip addon.dispose()
      // here — but we still need to force the synchronous GPU-slot release so
      // a hibernation-then-bulk-recreate cycle does not stall on the 16-slot
      // Chromium budget the same way #7467 stalled the attach path.
      forceGpuSlotRelease(entry.addon);
      this.pool.delete(id);
      this.removeFromLru(id);
    }
  }

  dispose(): void {
    if (this.pendingEnsureRafId !== null) {
      try {
        cancelAnimationFrame(this.pendingEnsureRafId);
      } catch {
        // ignore
      }
    }
    this.pendingEnsureRafId = null;
    this.pendingDrainScheduled = false;
    this.pendingEnsures.clear();
    if (this.atlasResyncRafId !== null) {
      try {
        cancelAnimationFrame(this.atlasResyncRafId);
      } catch {
        // ignore
      }
    }
    this.atlasResyncRafId = null;
    this.atlasResyncPending.clear();
    if (this.lossCoalesceRafId !== null) {
      try {
        cancelAnimationFrame(this.lossCoalesceRafId);
      } catch {
        // ignore
      }
    }
    this.lossCoalesceRafId = null;
    this.pendingLossCount = 0;
    for (const id of [...this.pool.keys()]) {
      this.doRelease(id);
    }
  }

  private scheduleDrain(): void {
    if (this.pendingDrainScheduled) return;
    if (this.pendingEnsures.size === 0) return;
    this.pendingDrainScheduled = true;
    const id = requestAnimationFrame(this.drainOne);
    // If drainOne ran synchronously (test shim or unusual host), it will have
    // already cleared pendingDrainScheduled and there is no rAF id to cancel.
    if (this.pendingDrainScheduled) {
      this.pendingEnsureRafId = id;
    }
  }

  private drainOne = (): void => {
    this.pendingDrainScheduled = false;
    this.pendingEnsureRafId = null;
    if (!WebglAddonClass) return;
    if (!this.hardwareAvailable) {
      this.pendingEnsures.clear();
      return;
    }
    const next = this.pendingEnsures.entries().next();
    if (next.done) return;
    const [id, managed] = next.value;
    this.pendingEnsures.delete(id);
    if (managed.isOpened) {
      // attachWithLoadedAddon dedups via pool.has(id) and routes the
      // already-active case through moveLruToEnd so the touch semantics of
      // a repeat ensure are preserved.
      this.attachWithLoadedAddon(id, managed, WebglAddonClass);
    }
    if (this.pendingEnsures.size > 0) {
      this.scheduleDrain();
    }
  };

  // Coalesce a burst of onRemoveTextureAtlasCanvas events (one per merged-away
  // page, per co-owner) into a single resync on the next frame.
  private scheduleAtlasResync(id: string): void {
    this.atlasResyncPending.add(id);
    if (this.atlasResyncRafId !== null) return;
    const rafId = requestAnimationFrame(this.runAtlasResync);
    // If runAtlasResync ran synchronously (test shim), the pending set is
    // already drained and there is no rAF handle to retain.
    if (this.atlasResyncPending.size > 0) {
      this.atlasResyncRafId = rafId;
    }
  }

  // Resync every renderer that co-owns the merged atlas (the ids whose merge
  // event fired). The reset must be local to each renderer; clearing the shared
  // CPU atlas here can create synchronized glyph churn across tiled panes.
  private runAtlasResync = (): void => {
    this.atlasResyncRafId = null;
    const ids = [...this.atlasResyncPending];
    this.atlasResyncPending.clear();
    for (const id of ids) {
      const entry = this.pool.get(id);
      if (!entry) continue;
      if (
        !resetLocalWebGLRenderer(
          entry.addon,
          entry.managed.terminal.cols,
          entry.managed.terminal.rows
        )
      ) {
        this.reacquireContext(id, entry);
        continue;
      }
      try {
        // Re-check identity after local reset: the addon can synchronously
        // lose context and release itself before we ask xterm to repaint.
        if (this.pool.get(id) !== entry) continue;
        if (entry.managed.isOpened && entry.managed.terminal.rows > 0) {
          entry.managed.terminal.refresh(0, entry.managed.terminal.rows - 1);
        }
      } catch {
        // ignore — DOM-renderer fallback or a later WebGL ensure will repaint
      }
    }
  };

  // Coalesce a burst of webglcontextlost events (one per active pool entry on
  // a bulk GPU eviction — see LOSS_THRESHOLD comment) into one breaker tick.
  private scheduleContextLossFlush(): void {
    this.pendingLossCount += 1;
    if (this.lossCoalesceRafId !== null) return;
    const rafId = requestAnimationFrame(this.flushContextLoss);
    // If flushContextLoss ran synchronously (test shim), pendingLossCount is
    // already 0 and there is no rAF handle to retain.
    if (this.pendingLossCount > 0) {
      this.lossCoalesceRafId = rafId;
    }
  }

  private flushContextLoss = (): void => {
    this.lossCoalesceRafId = null;
    if (this.pendingLossCount === 0) return;
    this.pendingLossCount = 0;
    this.recordContextLoss();
  };

  private reacquireContext(id: string, entry: WebGLEntry): void {
    if (this.pool.get(id) !== entry) return;
    const managed = entry.managed;
    this.doRelease(id);
    if (managed.isOpened) {
      this.ensureContext(id, managed);
    }
  }

  private attachWithLoadedAddon(
    id: string,
    managed: ManagedTerminal,
    AddonClass: WebglAddonConstructor
  ): void {
    if (this.pool.has(id)) {
      this.moveLruToEnd(id);
      return;
    }

    if (this.pool.size >= getMaxContexts()) {
      const evictId = this.pickEvictTarget();
      if (evictId) {
        this.doRelease(evictId);
        this.recordEvictionForDiagnostics();
      }
    }

    let addon: WebglAddonType | null = null;
    let clDisposable: IDisposable | null = null;
    let captureDisposable: (() => void) | null = null;
    let atlasResyncDisposable: IDisposable | null = null;
    const atlasResyncDisposables: IDisposable[] = [];
    try {
      addon = new AddonClass();
      const ownAddon = addon;
      clDisposable = addon.onContextLoss(() => {
        if (this.pool.get(id)?.addon === ownAddon) {
          // record before release; pool entry still valid here
          this.scheduleContextLossFlush();
          this.releaseContext(id);
        }
      });
      managed.terminal.loadAddon(addon);

      // Watch the shared TextureAtlas for page merges, and the renderer for
      // atlas-object swaps caused by font/theme/DPR changes. The pinned addon
      // typings declare both events; the guards keep older test mocks working.
      const subscribeAtlasEvent = (
        eventName: "onRemoveTextureAtlasCanvas" | "onChangeTextureAtlas"
      ): void => {
        const subscribe = addon?.[eventName];
        if (typeof subscribe !== "function") return;
        try {
          atlasResyncDisposables.push(subscribe(() => this.scheduleAtlasResync(id)));
        } catch {
          // ignore — resync stays best-effort if the event is unavailable
        }
      };
      subscribeAtlasEvent("onRemoveTextureAtlasCanvas");
      subscribeAtlasEvent("onChangeTextureAtlas");
      atlasResyncDisposable = combineDisposables(atlasResyncDisposables);

      // Capture-phase listener on the terminal element fires before xterm's
      // own webglcontextlost handler (which would otherwise sit on a 3s
      // restore timer before notifying us). Pre-empting that timer eliminates
      // the visible blank window when Chromium evicts the context.
      const element = managed.terminal.element;
      if (element) {
        const captureHandler = (): void => {
          if (this.pool.get(id)?.addon !== ownAddon) return;
          this.scheduleContextLossFlush();
          this.releaseContext(id);
          try {
            if (managed.isOpened && managed.terminal.rows > 0) {
              managed.terminal.refresh(0, managed.terminal.rows - 1);
            }
          } catch {
            // ignore — DOM-renderer fallback paints on next frame regardless
          }
        };
        element.addEventListener("webglcontextlost", captureHandler, { capture: true });
        captureDisposable = () => {
          element.removeEventListener("webglcontextlost", captureHandler, { capture: true });
        };
      }
      this.pool.set(id, {
        addon,
        managed,
        contextLossDisposable: clDisposable,
        captureDisposable,
        atlasResyncDisposable,
      });
      this.lruOrder.push(id);
    } catch {
      try {
        clDisposable?.dispose();
      } catch {
        // ignore
      }
      try {
        atlasResyncDisposable?.dispose();
      } catch {
        // ignore
      }
      try {
        captureDisposable?.();
      } catch {
        // ignore
      }
      try {
        addon?.dispose();
      } catch {
        // ignore
      }
    }
  }

  private doRelease(id: string): void {
    const entry = this.pool.get(id);
    if (!entry) return;

    // Delete from pool/lru first so the capture-phase listener (and stale
    // onContextLoss fires) treat the loseContext below as a self-initiated
    // release rather than a real eviction.
    this.pool.delete(id);
    this.removeFromLru(id);

    try {
      entry.contextLossDisposable.dispose();
    } catch {
      // ignore
    }
    try {
      entry.captureDisposable?.();
    } catch {
      // ignore
    }
    try {
      entry.atlasResyncDisposable?.dispose();
    } catch {
      // ignore
    }
    // Force synchronous GPU-side context release before addon.dispose() so the
    // 16-context Chromium budget actually frees this slot before the next
    // getContext() call.
    forceGpuSlotRelease(entry.addon);
    try {
      entry.addon.dispose();
    } catch {
      // ignore
    }
  }

  private recordContextLoss(): void {
    const now = Date.now();
    this.lossTimestamps = this.lossTimestamps.filter(
      (t) => now - t < TerminalWebGLManager.LOSS_WINDOW_MS
    );
    this.lossTimestamps.push(now);
    if (this.lossTimestamps.length >= TerminalWebGLManager.LOSS_THRESHOLD) {
      this.setHardwareAvailable(false);
      if (!this.hasLoggedBreakerTrip) {
        console.warn(
          "[TerminalWebGLManager] WebGL circuit breaker tripped — falling back to DOM renderer"
        );
        this.hasLoggedBreakerTrip = true;
      }
    }
  }

  // Eviction priority scorer. Returns the pool id that should give up its
  // WebGL slot first under pool pressure. Lower tier = evict sooner; LRU
  // position breaks ties within a tier so existing recency semantics survive.
  //
  // Tiers (most → least evictable):
  //   0  done/idle (no agent, or completed/exited/idle) — DOM renderer is fine
  //   1  waiting, unfocused, not recently writing — idle between prompts
  //   2  working but drained (pendingWrites 0, no recent write), unfocused
  //   3  waiting + in an active write burst (lastWriteAt within window)
  //   4  focused — user is looking at it; glyph quality matters
  //   5  working with queued writes — actively streaming output
  //   6  focused + directing — user typing into a live agent; never evict first
  //
  // Reads the live `managed` ref on each pool entry (mutated in place by the
  // write and agent-state controllers), so no cross-controller coupling.
  private pickEvictTarget(): string | undefined {
    const lruIndex = new Map<string, number>();
    for (let i = 0; i < this.lruOrder.length; i++) {
      lruIndex.set(this.lruOrder[i]!, i);
    }

    const now = Date.now();
    let bestId: string | undefined;
    let bestTier = Number.POSITIVE_INFINITY;
    let bestLru = Number.POSITIVE_INFINITY;

    for (const [id, entry] of this.pool) {
      const m = entry.managed;
      const state = m.agentState ?? "idle";
      const focused = m.isFocused === true;
      const pending = m.pendingWrites ?? 0;
      const recentlyWriting =
        m.lastWriteAt !== undefined && now - m.lastWriteAt < WRITE_BURST_RECENCY_MS;

      let tier: number;
      if (state === "directing" && focused) {
        tier = 6;
      } else if (state === "working" && pending > 0) {
        tier = 5;
      } else if (focused) {
        tier = 4;
      } else if (recentlyWriting && state === "waiting") {
        // Burst protection only applies to "waiting" — an agent between prompts
        // that just streamed output. A recent lastWriteAt on a done state
        // (idle/completed/exited) is a final flush, not an ongoing burst, so
        // those fall through to tier 0 below.
        tier = 3;
      } else if (state === "working" && pending === 0 && !recentlyWriting) {
        tier = 2;
      } else if (state === "waiting" && !recentlyWriting) {
        tier = 1;
      } else if (state === "idle" || state === "completed" || state === "exited") {
        tier = 0;
      } else {
        // "waiting" while recently writing, or any unmapped state — keep it
        // above the cleanly-idle tier but below focused/active work.
        tier = 2;
      }

      const lru = lruIndex.get(id) ?? Number.POSITIVE_INFINITY;
      if (tier < bestTier || (tier === bestTier && lru < bestLru)) {
        bestTier = tier;
        bestLru = lru;
        bestId = id;
      }
    }

    // Fall back to the LRU front if the pool/LRU ever desynchronise.
    return bestId ?? this.lruOrder[0]!;
  }

  private recordEvictionForDiagnostics(): void {
    this.evictionCount += 1;
    const now = Date.now();
    if (now - this.lastEvictionWarnAt > TerminalWebGLManager.EVICTION_WARN_INTERVAL_MS) {
      console.warn(
        `[TerminalWebGLManager] Pool pressure: evicted ${this.evictionCount} WebGL context(s) since last warning (pool=${this.pool.size}/${getMaxContexts()})`
      );
      this.evictionCount = 0;
      this.lastEvictionWarnAt = now;
    }
  }

  private moveLruToEnd(id: string): void {
    const idx = this.lruOrder.indexOf(id);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
    this.lruOrder.push(id);
  }

  private removeFromLru(id: string): void {
    const idx = this.lruOrder.indexOf(id);
    if (idx !== -1) {
      this.lruOrder.splice(idx, 1);
    }
  }
}

// Internal hooks — exposed only for tests in this repo. Not part of the public API.
export const __testing = {
  setWebglAddonClass(cls: WebglAddonConstructor | null): void {
    WebglAddonClass = cls;
  },
  resetLoaderState(): void {
    WebglAddonClass = null;
    webglAddonLoadPromise = null;
  },
  isLoaded(): boolean {
    return WebglAddonClass !== null;
  },
};
