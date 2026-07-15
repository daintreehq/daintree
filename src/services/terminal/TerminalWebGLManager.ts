import type { WebglAddon as WebglAddonType } from "@xterm/addon-webgl";
import type { IDisposable } from "@xterm/xterm";
import {
  getWebglLowerThreshold,
  getWebglUpperThreshold,
  setWebglLowerThreshold as setConfiguredLowerThreshold,
  setWebglThresholds as setConfiguredThresholds,
  setWebglUpperThreshold as setConfiguredUpperThreshold,
} from "./TerminalWebGLConfig";
import { type ManagedTerminal } from "./types";

// WebGL is gated by a count-based mode switch, not per-context eviction.
// Below the upper threshold, every wanting terminal gets WebGL. Above it,
// the manager flips to DOM mode and releases active contexts through a
// requestAnimationFrame drain queue; it flips back to WebGL once the count
// returns to the lower threshold.
// The hysteresis gap prevents flapping when a single panel opens or closes at
// the boundary.
//
// DAINTREE_DISABLE_WEBGL=1 is an escape hatch for deterministic environments
// (E2E suites, perf benchmarks) — when set, the manager starts with
// hardwareAvailable=false so every ensureContext is a no-op. Vite exposes
// DAINTREE_* env vars to import.meta.env via envPrefix in vite.config.ts.
//
// Why this shape instead of an LRU pool:
// Chromium caps active WebGL contexts per renderer (default 16, raised and
// RAM-tiered to 24/28/32 here via the max-active-webgl-contexts switch — see
// electron/setup/environment.ts) and silently evicts the oldest on overflow
// (webglcontextlost — see crbug 40939743). An
// LRU pool inside our renderer was making the same eviction decisions
// Chromium was already making one layer below, producing visible churn at
// 12-20 visible agent terminals: contexts cycled out, fell back to DOM,
// reacquired, flashed. The mode switch is a single coordinated decision
// applied to every terminal at once, which trades one wholesale repaint per
// boundary crossing for the continuous churn we had before.

type WebglAddonConstructor = new () => WebglAddonType;

// @xterm/addon-webgl loads via dynamic import so it stays out of the renderer's
// eager critical path. ensureContext() routes every new request through a
// requestAnimationFrame drain queue (one attach per frame): without that
// stagger, a burst of synchronous attaches during bulk worktree creation or a
// DOM→WebGL mode flip over-subscribes Chromium's per-renderer context cap,
// causing silent eviction of older contexts that then sit blank for 3s waiting
// on webglcontextrestored before xterm's onContextLoss fires (see #7467).
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
// 0.20's renderer internals to get the WebGL context and call loseContext()
// before addon.dispose() — without this, Chromium's per-renderer context budget is not
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

type Mode = "webgl" | "dom";

export class TerminalWebGLManager {
  // Circuit breaker: if N genuine context-loss events occur within W ms,
  // disable WebGL for the rest of the session to avoid strobing reacquisition
  // on systems with persistent GPU faults. Two recurrence paths matter:
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

  static get UPPER_THRESHOLD(): number {
    return getWebglUpperThreshold();
  }

  static get LOWER_THRESHOLD(): number {
    return getWebglLowerThreshold();
  }

  static setWebglUpperThreshold(n: number): void {
    setConfiguredUpperThreshold(n);
  }

  static setWebglLowerThreshold(n: number): void {
    setConfiguredLowerThreshold(n);
  }

  static setWebglThresholds(upper: number, lower: number): void {
    setConfiguredThresholds(upper, lower);
  }

  // Every terminal that currently wants WebGL. The consumer (visibility/agent
  // gating in TerminalInstanceService) decides what "wants" means; the manager
  // just counts. wants stays populated in DOM mode so a later flip back to
  // WebGL re-attaches every still-wanting terminal in one pass.
  private wants = new Map<string, ManagedTerminal>();
  private pool = new Map<string, WebGLEntry>();
  private mode: Mode = "webgl";
  // Start with hardware unavailable if the env-level disable is set; mode
  // is "webgl" so the first ensureContext is what flips to "dom" cleanly via
  // evaluateMode (mirrors the breaker path).
  private hardwareAvailable = import.meta.env.DAINTREE_DISABLE_WEBGL !== "1";
  private hasLoggedSoftwareSkip = false;
  private hasLoggedBreakerTrip = false;
  private hasLoggedModeFlip = false;

  // Coalesce a burst of webglcontextlost events (one per active pool entry on
  // a bulk GPU eviction — see LOSS_THRESHOLD comment) into one breaker tick.
  private lossTimestamps: number[] = [];
  private pendingLossCount = 0;
  private lossCoalesceRafId: number | null = null;

  // Queue of pending ensure requests: drained one-per-rAF so each context
  // allocation completes its GPU IPC roundtrip before the next is requested.
  private pendingEnsures = new Map<string, ManagedTerminal>();
  // Tracked separately from the rAF id: the "scheduled" flag has different
  // semantics than the cancellation handle when rAF runs synchronously (e.g.
  // under a test shim that invokes the callback inline).
  private pendingDrainScheduled = false;
  private pendingEnsureRafId: number | null = null;

  // Queue of active contexts to release after a fleet-wide DOM-mode downgrade.
  // Releasing a WebGL addon forces synchronous GPU-side context loss, so the
  // downgrade is paced the same way as attach: one terminal per frame.
  private pendingReleases = new Map<string, ManagedTerminal>();
  private pendingReleaseDrainScheduled = false;
  private pendingReleaseRafId: number | null = null;

  // Focus pin: in DOM mode, exactly one WebGL context stays attached to the
  // focused terminal so the pane the user is reading keeps fast, glyph-correct
  // rendering above the mode-switch threshold. One context is far below
  // Chromium's per-renderer cap, and its churn is bounded by user focus clicks — not the
  // N-terminal output/visibility cycling the wholesale mode switch replaced
  // (see header comment). In WebGL mode the pin is bookkeeping only; it takes
  // effect when the fleet flips to DOM.
  private pinnedId: string | null = null;

  // Alt-buffer pins: terminals running a full-screen alt-buffer TUI (vim,
  // opencode, Gemini CLI, …) stay on WebGL even after the fleet flips to DOM,
  // exactly like the focus pin. On HiDPI/fractional-scaled displays xterm's DOM
  // renderer divides a rounded canvas height by the row count, yielding a
  // fractional CSS cell height; Chromium then pixel-snaps adjacent row
  // boundaries inconsistently and the near-black terminal background bleeds
  // through the seams as horizontal "zebra" banding (#10768). WebGL has no such
  // seam, so keeping alt-buffer panes on it is the primary fix; the DOM
  // integer-snap in TerminalListenerInstaller is the fallback for panes that
  // genuinely must use DOM (breaker tripped / hardware unavailable).
  //
  // Unlike pinnedId (always exactly one, driven by focus), this is a set:
  // multiple panes can run alt-buffer TUIs at once. Both categories are honored
  // identically by isPinned() at every DOM-mode exemption site; they are kept
  // separate only because their lifecycles differ (focus events vs buffer-mode
  // changes). Each alt-buffer pin still holds one WebGL context against
  // Chromium's per-renderer cap, so this is bounded by how many alt-buffer panes are
  // visible — far below the cap in practice, and the breaker trip clears them
  // all (see setHardwareAvailable).
  private altBufferPinnedIds = new Set<string>();

  // A terminal is exempt from DOM-mode context release while it is the focus
  // pin or an alt-buffer pin. Both keep one WebGL context attached in DOM mode.
  private isPinned(id: string): boolean {
    return id === this.pinnedId || this.altBufferPinnedIds.has(id);
  }

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
  // run only the local resize-like reset through the pinned 0.20 internal shape
  // and follow with a full terminal.refresh(). If that internal shape drifts,
  // fall back to releasing/reacquiring only this context.
  // Recurrence signature to watch for when triaging: ~12 concurrent agents, a
  // Claude Code status line rewritten via \r at 1Hz, and visible-but-unfocused
  // panes that take no further writes staying corrupted until a resize or
  // atlasResync (see #8080).
  private atlasResyncPending = new Set<string>();
  private atlasResyncRafId: number | null = null;
  // Re-entrancy guard for runAtlasResync. resetLocalWebGLRenderer re-runs the
  // renderer's handleResize → _refreshCharAtlas, which SYNCHRONOUSLY re-fires the
  // onChangeTextureAtlas / onRemoveTextureAtlasCanvas events whose handler
  // (scheduleAtlasResync) schedules the next resync. Without this guard each
  // resync schedules the next on the following frame — a self-sustaining 60fps
  // reset loop that thrashes the renderer (constant redraw / glyph corruption on
  // heavy-output alt-buffer TUIs like OpenCode, and a general perf drain). True
  // only for the duration of the reset loop; the re-fire is synchronous, so the
  // flag is cleared synchronously (finally) — no rAF/timing window is involved.
  private suppressAtlasResync = false;

  setHardwareAvailable(available: boolean): void {
    const wasAvailable = this.hardwareAvailable;
    this.hardwareAvailable = available;
    if (wasAvailable && !available) {
      // Hardware degraded — force DOM mode regardless of count and stay
      // there. The focus pin offers no exemption here: clear it (and drop its
      // context if already in DOM mode, where flipToDom early-returns) so no
      // WebGL context outlives the breaker trip.
      const pinned = this.pinnedId;
      this.pinnedId = null;
      if (pinned !== null && this.pool.has(pinned)) {
        this.dropPoolEntry(pinned);
      }
      // Alt-buffer pins offer no exemption against a breaker trip either —
      // clear them (and drop any live contexts) before flipToDom so no WebGL
      // context outlives the trip. flipToDom only skips still-pinned ids, so
      // the set must be emptied first.
      const altPinned = [...this.altBufferPinnedIds];
      this.altBufferPinnedIds.clear();
      for (const altId of altPinned) {
        if (this.pool.has(altId)) {
          this.dropPoolEntry(altId);
        }
      }
      this.flipToDom();
    }
  }

  ensureContext(id: string, managed: ManagedTerminal): void {
    if (!this.hardwareAvailable) {
      if (!this.hasLoggedSoftwareSkip && !this.hasLoggedBreakerTrip) {
        console.warn("[TerminalWebGLManager] Skipping WebGL: software-only GPU detected");
        this.hasLoggedSoftwareSkip = true;
      }
      return;
    }
    if (!managed.isOpened) return;

    const wasWanted = this.wants.has(id);
    this.wants.set(id, managed);
    if (!wasWanted) {
      this.evaluateMode();
    }
    // In WebGL mode, queue an attach for this id if not already pooled. In
    // DOM mode only pinned terminals (focus pin or alt-buffer pins) attach;
    // other wants are tracked but wait for the next flip back.
    // attachWithLoadedAddon dedups via pool.has(id), so a repeat ensure on an
    // already-attached terminal is a cheap no-op.
    if (!this.pool.has(id) && (this.mode === "webgl" || this.isPinned(id))) {
      this.queueAttach(id, managed);
    }
  }

  releaseContext(id: string): void {
    if (this.pinnedId === id) {
      // The consumer no longer wants WebGL here (hidden/demoted); the pin is
      // re-established by the next focus event.
      this.pinnedId = null;
    }
    // Deliberately NOT clearing altBufferPinnedIds here: a hidden alt-buffer
    // pane stays "should be on WebGL" even though its context is dropped below.
    // Unlike the focus pin (re-armed by the next focus event), nothing re-fires
    // a buffer-mode transition when the pane is revealed, so the pin must
    // survive hide/show. Dropping the want + context below is enough; the next
    // ensureContext on reveal re-attaches because isPinned(id) is still true.
    const wasWanted = this.wants.delete(id);
    this.pendingEnsures.delete(id);
    this.pendingReleases.delete(id);
    if (this.pool.has(id)) {
      this.dropPoolEntry(id);
    }
    if (wasWanted) {
      this.evaluateMode();
    }
  }

  // Move the focus pin. Called on every terminal focus change; in DOM mode the
  // previous pinned context is released through the paced drain and the new
  // one attaches through the rAF attach queue (one GPU IPC roundtrip per
  // frame, same as a mode flip).
  pinFocus(id: string, managed: ManagedTerminal): void {
    if (this.pinnedId === id) {
      if (this.mode === "dom") this.queuePinnedAttach(id, managed);
      return;
    }
    const previous = this.pinnedId;
    this.pinnedId = id;
    if (this.mode !== "dom") return;
    if (previous !== null) {
      this.pendingEnsures.delete(previous);
      const prevEntry = this.pool.get(previous);
      if (prevEntry) {
        this.pendingReleases.set(previous, prevEntry.managed);
        this.scheduleReleaseDrain();
      }
    }
    this.pendingReleases.delete(id);
    this.queuePinnedAttach(id, managed);
  }

  private queuePinnedAttach(id: string, managed: ManagedTerminal): void {
    if (!this.hardwareAvailable) return;
    if (!managed.isOpened) return;
    if (this.pool.has(id)) return;
    // drainOne re-checks wants.has(id): a pin that lands before the consumer's
    // ensureContext stays queued-but-skipped until the want exists, and
    // ensureContext re-queues the pinned id in DOM mode.
    this.queueAttach(id, managed);
  }

  // Pin a terminal that has entered its alt-buffer so it keeps WebGL through a
  // fleet DOM-mode flip (see altBufferPinnedIds). Idempotent. In WebGL mode the
  // pin is bookkeeping only — every want already attaches — and it takes effect
  // when the fleet next flips to DOM. In DOM mode it attaches one context now
  // through the same rAF-staggered queue the focus pin uses (#7480). A no-op
  // when hardware is unavailable: queuePinnedAttach bails, mirroring pinFocus.
  pinAltBuffer(id: string, managed: ManagedTerminal): void {
    // When hardware is unavailable the breaker has tripped for the session —
    // WebGL never comes back, so tracking the pin would only make the watchdog
    // burn repair slots (shouldHaveActiveWebGL gates on it) for a context that
    // can never attach. Skip entirely; the DOM integer-snap handles the seam.
    if (!this.hardwareAvailable) return;
    if (this.altBufferPinnedIds.has(id)) {
      // Cancel any in-flight release symmetrically with the first-pin branch
      // below — flipToDom never queues a release for an already-pinned id, but
      // keeping both branches identical avoids a use-after-free trap if a
      // future path ever schedules one.
      if (this.mode === "dom") {
        this.pendingReleases.delete(id);
        this.queuePinnedAttach(id, managed);
      }
      return;
    }
    this.altBufferPinnedIds.add(id);
    if (this.mode !== "dom") return;
    // Cancel any in-flight release of this id (it may have been queued by a
    // mode flip before the alt-buffer transition landed) and attach.
    this.pendingReleases.delete(id);
    this.queuePinnedAttach(id, managed);
  }

  // Release an alt-buffer pin when the terminal returns to its normal buffer.
  // In DOM mode its WebGL context is scheduled for release through the paced
  // drain — unless the terminal is also the focus pin, in which case the focus
  // pin keeps it attached.
  unpinAltBuffer(id: string): void {
    if (!this.altBufferPinnedIds.delete(id)) return;
    if (this.mode !== "dom") return;
    if (id === this.pinnedId) return;
    this.pendingEnsures.delete(id);
    const entry = this.pool.get(id);
    if (entry) {
      this.pendingReleases.set(id, entry.managed);
      this.scheduleReleaseDrain();
    }
  }

  // Test/diagnostic introspection and the watchdog's DOM-mode eligibility check.
  isAltBufferPinned(id: string): boolean {
    return this.altBufferPinnedIds.has(id);
  }

  // External re-evaluation hook. Threshold changes pushed from the main
  // process via useResourceProfile arrive between consumer events; without
  // this, a profile downgrade from balanced (12/10) to efficiency (8/6) would
  // leave 9+ wants on WebGL until the next ensure/release happens to land.
  refreshMode(): void {
    this.evaluateMode();
  }

  isActive(id: string): boolean {
    return this.pool.has(id);
  }

  // Proactively repair a single renderer's local glyph model before its view
  // becomes compositable again. On warm project-view reactivation (Chromium
  // freeze → active), the compositor can push a stale cached GPU surface before
  // the renderer's wake fan-out runs, briefly flashing the pre-freeze atlas
  // state. Running the same local resize-like reset as runAtlasResync — without
  // the rAF coalescing, the breaker, or touching the shared CPU atlas — clears
  // the stale local model in place so the first painted frame samples current
  // glyph state. Synchronous and called directly from the wake seam, so it also
  // bypasses the setVisible webGLRestoreTimer debounce. Returns true when a live
  // pool entry was repaired and repainted; false for DOM-renderer terminals, a
  // missing/just-released context, or a zero-size grid.
  repairAtlasForReactivation(id: string): boolean {
    const entry = this.pool.get(id);
    if (!entry) return false;
    // Only repair a live, sized, visible-capable renderer. A not-yet-laid-out
    // grid (rows/cols 0) has no model worth clearing — its first real resize on
    // wake builds the model fresh — and a closed terminal has no element to
    // repaint.
    if (!entry.managed.isOpened) return false;
    const { cols, rows } = entry.managed.terminal;
    if (cols <= 0 || rows <= 0) return false;
    if (!resetLocalWebGLRenderer(entry.addon, cols, rows)) {
      return false;
    }
    try {
      // Re-check identity after the local reset: the addon can synchronously
      // lose context and release itself before we ask xterm to repaint.
      if (this.pool.get(id) !== entry) return false;
      entry.managed.terminal.refresh(0, rows - 1);
    } catch {
      // ignore — a DOM-renderer fallback or later WebGL ensure will repaint
      return false;
    }
    return true;
  }

  // Test/diagnostic introspection — not part of the consumer API.
  getMode(): Mode {
    return this.mode;
  }

  getWantsSize(): number {
    return this.wants.size;
  }

  getPinnedId(): string | null {
    return this.pinnedId;
  }

  onTerminalDestroyed(id: string): void {
    if (this.pinnedId === id) {
      this.pinnedId = null;
    }
    this.altBufferPinnedIds.delete(id);
    const wasWanted = this.wants.delete(id);
    this.pendingEnsures.delete(id);
    this.pendingReleases.delete(id);
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
      // a hibernation-then-bulk-recreate cycle does not stall on the
      // per-renderer Chromium context budget the same way #7467 stalled the attach path.
      forceGpuSlotRelease(entry.addon);
      this.pool.delete(id);
    }
    if (wasWanted) {
      this.evaluateMode();
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
    if (this.pendingReleaseRafId !== null) {
      try {
        cancelAnimationFrame(this.pendingReleaseRafId);
      } catch {
        // ignore
      }
    }
    this.pendingReleaseRafId = null;
    this.pendingReleaseDrainScheduled = false;
    this.pendingReleases.clear();
    this.wants.clear();
    this.pinnedId = null;
    this.altBufferPinnedIds.clear();
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
      this.dropPoolEntry(id);
    }
  }

  private evaluateMode(): void {
    if (!this.hardwareAvailable) {
      // Hardware-unavailable is a one-way trip — stay in DOM regardless of count.
      if (this.mode !== "dom") this.flipToDom();
      return;
    }
    const count = this.wants.size;
    if (this.mode === "webgl" && count > getWebglUpperThreshold()) {
      this.flipToDom();
    } else if (this.mode === "dom" && count <= getWebglLowerThreshold()) {
      this.flipToWebgl();
    }
  }

  private flipToDom(): void {
    if (this.mode === "dom") return;
    this.mode = "dom";
    if (!this.hasLoggedModeFlip) {
      console.warn(
        `[TerminalWebGLManager] Switching to DOM renderer (wants=${this.wants.size}, upper=${getWebglUpperThreshold()})`
      );
      this.hasLoggedModeFlip = true;
    }
    // Cancel pending attaches — only pinned terminals (focus pin or alt-buffer
    // pins) are honored in DOM mode.
    for (const id of [...this.pendingEnsures.keys()]) {
      if (!this.isPinned(id)) {
        this.pendingEnsures.delete(id);
      }
    }
    if (this.pendingEnsures.size === 0) {
      if (this.pendingEnsureRafId !== null) {
        try {
          cancelAnimationFrame(this.pendingEnsureRafId);
        } catch {
          // ignore
        }
        this.pendingEnsureRafId = null;
      }
      this.pendingDrainScheduled = false;
    }

    // Release active contexts progressively, keeping pinned terminals (focus
    // pin and alt-buffer pins) attached. Each released terminal falls back to
    // xterm's DOM renderer on its next paint. Visible terminals refresh when
    // their release lands so the renderer swap is not deferred until output.
    for (const [id, entry] of this.pool) {
      if (this.isPinned(id)) continue;
      this.pendingReleases.set(id, entry.managed);
    }
    this.scheduleReleaseDrain();
  }

  private flipToWebgl(): void {
    if (this.mode === "webgl") return;
    this.mode = "webgl";
    this.cancelReleaseDrain();
    // Reset the mode-flip warning so a future downgrade is logged again
    // (per-session, but recoverable across the cycle).
    this.hasLoggedModeFlip = false;
    // Queue every still-wanting terminal for attach. The rAF drain serialises
    // them so the bulk attach never over-subscribes the per-renderer context budget.
    for (const [id, managed] of this.wants) {
      if (!this.pool.has(id)) {
        this.queueAttach(id, managed);
      }
    }
  }

  private queueAttach(id: string, managed: ManagedTerminal): void {
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
    // A mode flip during an in-flight drain is honored — flipToDom drops the
    // queued attaches, except pinned terminals (focus pin and alt-buffer pins)
    // which stay valid in DOM mode.
    if (this.mode !== "webgl") {
      for (const id of [...this.pendingEnsures.keys()]) {
        if (!this.isPinned(id)) {
          this.pendingEnsures.delete(id);
        }
      }
      if (this.pendingEnsures.size === 0) return;
    }
    const next = this.pendingEnsures.entries().next();
    if (next.done) return;
    const [id, managed] = next.value;
    this.pendingEnsures.delete(id);
    // Re-check the want: the terminal may have called releaseContext between
    // queueing and now (visibility change, agent ended, etc).
    if (managed.isOpened && this.wants.has(id)) {
      this.attachWithLoadedAddon(id, managed, WebglAddonClass);
    }
    if (this.pendingEnsures.size > 0) {
      this.scheduleDrain();
    }
  };

  private scheduleReleaseDrain(): void {
    if (this.pendingReleaseDrainScheduled) return;
    if (this.pendingReleases.size === 0) return;
    this.pendingReleaseDrainScheduled = true;
    const id = requestAnimationFrame(this.drainOneRelease);
    // If drainOneRelease ran synchronously (test shim or unusual host), it
    // will have already cleared pendingReleaseDrainScheduled and there is no
    // rAF id to cancel.
    if (this.pendingReleaseDrainScheduled) {
      this.pendingReleaseRafId = id;
    }
  }

  private cancelReleaseDrain(): void {
    if (this.pendingReleaseRafId !== null) {
      try {
        cancelAnimationFrame(this.pendingReleaseRafId);
      } catch {
        // ignore
      }
    }
    this.pendingReleaseRafId = null;
    this.pendingReleaseDrainScheduled = false;
    this.pendingReleases.clear();
  }

  private drainOneRelease = (): void => {
    this.pendingReleaseDrainScheduled = false;
    this.pendingReleaseRafId = null;

    // A quick recovery back to WebGL makes the release queue stale. Keep any
    // still-active contexts instead of churning them through DOM and back.
    if (this.mode !== "dom") {
      this.pendingReleases.clear();
      return;
    }

    const next = this.pendingReleases.entries().next();
    if (next.done) return;
    const [id, managed] = next.value;
    this.pendingReleases.delete(id);

    // A pin may have landed on an id queued for release before the focus or
    // buffer-mode change registered (focus pin or alt-buffer pin) — keep its
    // context.
    if (this.isPinned(id)) {
      if (this.pendingReleases.size > 0) {
        this.scheduleReleaseDrain();
      }
      return;
    }

    if (this.pool.has(id)) {
      this.dropPoolEntry(id);
      if (managed.isOpened && managed.isVisible && managed.terminal.rows > 0) {
        try {
          managed.terminal.refresh(0, managed.terminal.rows - 1);
        } catch {
          // ignore — next user-driven paint will catch up regardless
        }
      }
    }

    if (this.pendingReleases.size > 0) {
      this.scheduleReleaseDrain();
    }
  };

  // Coalesce a burst of onRemoveTextureAtlasCanvas events (one per merged-away
  // page, per co-owner) into a single resync on the next frame.
  private scheduleAtlasResync(id: string): void {
    // Drop atlas-change events re-fired synchronously by our own reset (see
    // suppressAtlasResync) — otherwise the resync re-arms itself every frame.
    if (this.suppressAtlasResync) return;
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
    // Suppress the synchronous atlas-change events that resetLocalWebGLRenderer
    // re-fires (see suppressAtlasResync) for the whole reset loop, so the resync
    // cannot schedule itself again. finally guarantees the flag is cleared even
    // if a reset throws, so a genuine later page-merge still resyncs.
    this.suppressAtlasResync = true;
    try {
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
    } finally {
      this.suppressAtlasResync = false;
    }
  };

  // Coalesce a burst of webglcontextlost events into one breaker tick.
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
    this.dropPoolEntry(id);
    if (managed.isOpened && this.wants.has(id) && (this.mode === "webgl" || this.isPinned(id))) {
      this.queueAttach(id, managed);
    }
  }

  private attachWithLoadedAddon(
    id: string,
    managed: ManagedTerminal,
    AddonClass: WebglAddonConstructor
  ): void {
    if (this.pool.has(id)) return;
    // No eviction branch: the mode switch guarantees the pool never exceeds
    // upperThreshold while we are in WebGL mode. The real path that can reach
    // here over the line is a threshold change pushed via setWebglThresholds
    // between when this attach was queued and when the rAF drain landed —
    // refreshMode() is best-effort but the queue can already be in flight.
    // Re-evaluating here flips to DOM and clears pendingEnsures, so the next
    // drain iteration bails immediately. Pinned terminals are the exception:
    // the focus pin and alt-buffer pins attach regardless of the count, since
    // DOM mode keeps one context on each of them.
    if (this.wants.size > getWebglUpperThreshold()) {
      this.evaluateMode();
      if (!this.isPinned(id) || this.mode !== "dom") return;
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
          // Drop the dead pool entry but LEAVE the terminal in `wants`.
          // A context loss kills the addon, not the consumer's eligibility:
          // calling releaseContext() would decrement the mode-switch count
          // and silently drop the terminal from the next dom→webgl recovery.
          // We deliberately do NOT auto-requeue here — a bulk Chromium
          // eviction (caused BY too many contexts) would re-request the
          // contexts immediately and re-trigger the same eviction, looping
          // until the breaker trips after 3 cycles. Instead the terminal
          // sits on the DOM renderer (which renders correctly under
          // lineHeight: 1.0) until a consumer-side re-ensure happens
          // (visibility change, tier transition, mode flip).
          this.dropPoolEntry(id);
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
          // Same reasoning as the onContextLoss handler above — drop the
          // pool entry but keep the want, and do not auto-requeue. The next
          // consumer event (visibility / tier / mode flip) will restore
          // WebGL; until then the terminal renders via DOM.
          this.dropPoolEntry(id);
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

      // Repaint after the DOM→WebGL swap. loadAddon() activates the WebGL
      // renderer but does not repaint the existing buffer — content already
      // painted by the DOM renderer (or written before this rAF-staggered
      // attach landed) stays blank until a focus/resize/write forces a
      // refresh. On bulk open the reveal refresh in TerminalInstanceService
      // often fires while the pane is still on DOM, so later terminals swap to
      // WebGL with nothing repainting them. Mirror the refresh the release,
      // atlas-resync, and context-loss paths already do after a renderer swap.
      // pool.set above runs first so a context loss during this paint resolves
      // against a valid pool entry (the onContextLoss / capture handlers gate
      // on pool.get(id)?.addon === ownAddon).
      if (managed.isOpened && managed.isVisible && managed.terminal.rows > 0) {
        try {
          managed.terminal.refresh(0, managed.terminal.rows - 1);
        } catch {
          // ignore — a later user-driven paint will catch up regardless
        }
      }
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

  // Drop the pool entry for an id without touching the wants set. Internal —
  // used by the context-loss path (the addon died but the consumer still wants
  // WebGL) and by mode flips. The public releaseContext() wraps this and also
  // mutates wants because that path means "consumer no longer wants WebGL".
  private dropPoolEntry(id: string): void {
    const entry = this.pool.get(id);
    if (!entry) return;

    // Delete from pool first so the capture-phase listener (and stale
    // onContextLoss fires) treat the loseContext below as a self-initiated
    // release rather than a real eviction.
    this.pool.delete(id);

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
    // per-renderer Chromium context budget actually frees this slot before the next
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
