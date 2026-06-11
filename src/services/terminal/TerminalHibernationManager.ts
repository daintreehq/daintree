import { Terminal } from "@xterm/xterm";
import { TerminalRefreshTier } from "@/types";
import { AGENT_IDLE_SILENCE_MS, HIBERNATION_DELAY_MS, type ManagedTerminal } from "./types";
import { setupTerminalAddons } from "./TerminalAddonManager";
import { TerminalParserHandler } from "./TerminalParserHandler";
import { ACTIVE_AGENT_STATES } from "@shared/types/agent";
import { logDebug, logError } from "@/utils/logger";
import {
  installTerminalBoundListeners,
  type TerminalListenerInstallDeps,
} from "./TerminalListenerInstaller";

export interface HibernationManagerDeps extends TerminalListenerInstallDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  destroyRestoreState: (id: string) => void;
  resetBufferedOutput: (id: string) => void;
  releaseWebGL: (id: string) => void;
  clearResizeJob: (managed: ManagedTerminal) => void;
  clearSettledTimer: (id: string) => void;
  applyDeferredResize: (id: string) => void;
  /**
   * Draws the "Output dropped" marker for a PTY data-loss signal. Required (not
   * optional) so the wake path can never silently diverge from `getOrCreate()`
   * and drop the OSC 57301 callback again (#9907) — the omission becomes a
   * compile error instead.
   */
  drawDataLossMarker: (id: string, droppedBytes: number) => void;
  onHibernationChanged: (id: string) => void;
  /**
   * Builds the deferred Image/file-link/web-link addons on the fresh post-wake
   * Terminal — routing cwd/link wiring through the service. The wake path
   * re-creates these eagerly (a woken terminal is about to be shown), keeping
   * behaviour identical to pre-#9809 when `setupTerminalAddons` built the full
   * set. Idempotent.
   */
  ensureDeferredAddons: (id: string) => void;
  /**
   * Live lookup for "has the user explicitly backgrounded this panel?" —
   * reads the renderer-side `backgroundedTerminals` map. Evaluated at every
   * eligibility check (never captured into a timer closure) so a restore
   * between schedule and fire correctly drops the bypass.
   */
  getIsBackgrounded: (id: string) => boolean;
}

export class TerminalHibernationManager {
  private deps: HibernationManagerDeps;

  constructor(deps: HibernationManagerDeps) {
    this.deps = deps;
  }

  hibernate(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed || managed.isHibernated) return;
    // Single source of truth for "is this terminal safe to tear down right
    // now?" — shared with the eligibility predicate so the scheduled-timer
    // path and the direct (memory-pressure accelerated) path stay in
    // lockstep. The predicate adds a tier check on top; hibernate() itself
    // is permissive about tier because callers (memory-pressure accelerator)
    // may want to force teardown regardless of the renderer-policy tier.
    if (!this.isSafeToHibernate(managed, id)) return;

    logDebug(`[TIS.hibernate] Hibernating terminal ${id}`);

    if (managed.hibernationTimer) {
      clearTimeout(managed.hibernationTimer);
      managed.hibernationTimer = undefined;
    }
    if (managed.hibernationEligibilityTimer) {
      clearTimeout(managed.hibernationEligibilityTimer);
      managed.hibernationEligibilityTimer = undefined;
    }
    // Cancel any in-flight visibility-driven hide-dwell — hibernation is
    // authoritative and routes through onTerminalDestroyed (bypassing
    // releaseContext), so we don't want a stray timer firing later. Done
    // here, after the early-return guards above, so a hibernate() call that
    // bails on an active agent leaves the dwell timer running to handle the
    // release on its own.
    if (managed.webGLHideTimer !== undefined) {
      clearTimeout(managed.webGLHideTimer);
      managed.webGLHideTimer = undefined;
    }

    this.deps.destroyRestoreState(id);
    this.deps.resetBufferedOutput(id);

    // Release WebGL context first to avoid context leaks
    this.deps.releaseWebGL(id);

    // Dispose tier-managed addons
    try {
      managed.imageAddon?.dispose();
    } catch {
      /* ignore */
    }
    managed.imageAddon = null;
    try {
      managed.fileLinksDisposable?.dispose();
    } catch {
      /* ignore */
    }
    managed.fileLinksDisposable = null;
    try {
      managed.webLinksAddon?.dispose();
    } catch {
      /* ignore */
    }
    managed.webLinksAddon = null;
    try {
      managed.imageLinksDisposable?.dispose();
    } catch {
      /* ignore */
    }
    // Null is load-bearing: ensureDeferredAddons() only rebuilds when the
    // field is null, so a stale reference here would leave the woken terminal
    // wired to the old disposed instance.
    managed.imageLinksDisposable = null;

    // Dispose terminal-bound listeners (keep IPC listeners at the beginning)
    const terminalBoundListeners = managed.listeners.splice(managed.ipcListenerCount);
    for (const unsub of terminalBoundListeners) {
      try {
        unsub();
      } catch {
        /* ignore — terminal already disposing */
      }
    }

    // The selection listener is gone now, so the cached selection can only go
    // stale — clear it instead of letting it survive until destroy().
    this.deps.deleteCachedSelection(id);

    // Dispose parser handler
    try {
      managed.parserHandler?.dispose();
    } catch {
      /* ignore — terminal already disposing */
    }
    managed.parserHandler = undefined;

    // Dispose last activity marker
    try {
      managed.lastActivityMarker?.dispose();
    } catch {
      /* ignore — terminal already disposing */
    }
    managed.lastActivityMarker = undefined;

    // Dispose terminal instance — this removes xterm's injected DOM elements
    // from the hostElement but leaves the hostElement itself in the DOM
    // so XtermAdapter's container ref stays valid for reattachment
    const options = managed.terminal.options;
    try {
      managed.terminal.dispose();
    } catch {
      /* ignore — terminal already disposing */
    }
    // Swap in a fresh un-opened placeholder so the disposed instance — and
    // with it the whole scrollback buffer graph — becomes GC-eligible for the
    // duration of hibernation. The placeholder exists only to carry options
    // for unhibernate(); it must never be open()-ed or given addons/listeners.
    managed.terminal = new Terminal(options);

    managed.isHibernated = true;
    managed.isOpened = false;
    managed.keyHandlerInstalled = false;

    // Clear resize state
    this.deps.clearResizeJob(managed);
    this.deps.clearSettledTimer(id);

    // Notify after the flag is written so React snapshot reads return the
    // new value during the synchronous useSyncExternalStore consistency check.
    this.deps.onHibernationChanged(id);
  }

  unhibernate(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed || !managed.isHibernated) return;

    logDebug(`[TIS.unhibernate] Restoring terminal ${id}`);

    // Create fresh Terminal with same options
    const terminal = new Terminal(managed.terminal.options);
    managed.terminal = terminal;

    // Create fresh eager-core addons, then rebuild the deferred Image/link set
    // via the same path the cold-open uses — a woken terminal is about to be
    // shown, so it needs the full addon set immediately (#9809).
    const addons = setupTerminalAddons(terminal);
    managed.fitAddon = addons.fitAddon;
    managed.serializeAddon = addons.serializeAddon;
    managed.searchAddon = addons.searchAddon;
    managed.imageAddon = addons.imageAddon;
    managed.fileLinksDisposable = addons.fileLinksDisposable;
    managed.webLinksAddon = addons.webLinksAddon;
    this.deps.ensureDeferredAddons(id);

    // Reuse existing hostElement — clear old xterm DOM nodes to prevent ghosting
    const hostElement = managed.hostElement;
    hostElement.replaceChildren();

    // Re-create parser handler — mirror `getOrCreate()` exactly, including the
    // data-loss callback, so woken terminals keep rendering the "Output
    // dropped" marker (#9907). `id` is the live key, never a captured managed
    // ref — `drawDataLossMarker` does its own `instances.get(id)` lookup.
    managed.parserHandler = new TerminalParserHandler(
      managed,
      () => {
        this.deps.applyDeferredResize(id);
      },
      (droppedBytes) => {
        this.deps.drawDataLossMarker(id, droppedBytes);
      }
    );

    // Re-register terminal-bound listeners via the canonical installer so the
    // wake path stays in lockstep with `getOrCreate()`. IPC listeners
    // captured before `ipcListenerCount` survive in `managed.listeners`.
    installTerminalBoundListeners(terminal, managed, id, this.deps);

    // Reset restore state
    managed.writeChain = Promise.resolve();
    managed.restoreGeneration += 1;
    managed.isSerializedRestoreInProgress = false;
    managed.deferredOutput = [];
    // Clear the reflow throttle so post-wake writes trigger an immediate
    // IO re-evaluation.
    managed.lastReflowAt = 0;
    // Clear any counter stranded by a mid-write dispose — the old terminal's
    // write callbacks will never fire, and the fresh Terminal has no queued
    // writes, so a non-zero value here would block hibernation forever (#9912).
    managed.pendingWrites = 0;

    // Re-bind the fresh Terminal to its DOM host. Without this, the
    // terminal exists in memory with a working buffer but no rendered
    // output — a zombie. Only safe when the host has measurable
    // dimensions (xterm.js measures character cell size during open()).
    // If the host is offscreen/zero-sized, leave isOpened=false so
    // TerminalInstanceService.attach() will open it on next mount.
    if (hostElement.clientWidth > 0 && hostElement.clientHeight > 0) {
      try {
        terminal.open(hostElement);
        managed.isOpened = true;
        // Re-anchor the first-write perf delta to this wake's open() — a
        // terminal hibernated before its first byte would otherwise measure
        // TERMINAL_FIRST_WRITE from the stale pre-hibernation open (#9809).
        managed.terminalOpenStartedAt =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        managed.hasEmittedFirstWriteMark = false;
      } catch (err) {
        logError(`[TIS.unhibernate] terminal.open failed for ${id}`, err);
      }
    }

    managed.isHibernated = false;
    managed.isDetached = managed.isDetached ?? false;
    if (managed.isOpened) {
      managed.isDetached = false;
    }

    this.deps.onHibernationChanged(id);
  }

  /**
   * Safety check shared between the scheduled-timer eligibility predicate
   * and the direct hibernate() guard. Returns true if the terminal can be
   * torn down without losing in-flight activity. Tier-agnostic — the
   * eligibility predicate composes this with a BACKGROUND tier check.
   *
   * Rules:
   * - In-flight writes: never safe, for ANY terminal. Disposing xterm while
   *   its WriteBuffer holds queued chunks drops the write callbacks, which
   *   strands `pendingWrites` above zero forever (#9912). This guard is
   *   checked first so no other rule can bypass it.
   * - Non-agent terminals: otherwise always safe.
   * - Agents in resting states (`idle`/`completed`/`exited`, or undefined
   *   state for legacy paths that never assigned canonicalAgentState):
   *   otherwise always safe. `idle` is not in ACTIVE_AGENT_STATES — it
   *   represents the agent itself reporting it has nothing to do.
   * - Agents in active states (`working`/`waiting`/`directing`): safe
   *   only if the last rendered output is either non-existent or at least
   *   AGENT_IDLE_SILENCE_MS old. The "never wrote" case is treated as safe
   *   because silence is by definition infinite if no write has ever been
   *   recorded.
   * - User-backgrounded panels: the silence window is bypassed — the user
   *   explicitly hid the panel, so an active agent is no objection to
   *   reclaiming its memory under pressure. The `pendingWrites === 0` burst
   *   guard still holds unconditionally so we never tear down mid-write.
   *   Read live via `getIsBackgrounded` so a restore between schedule and
   *   fire drops the bypass.
   */
  private isSafeToHibernate(
    managed: ManagedTerminal,
    id: string,
    now: number = Date.now()
  ): boolean {
    if ((managed.pendingWrites ?? 0) > 0) return false;
    if (!managed.runtimeAgentId) return true;
    const state = managed.canonicalAgentState;
    if (state === undefined || !ACTIVE_AGENT_STATES.has(state)) return true;
    if (this.deps.getIsBackgrounded(id)) return true;
    if (managed.lastWriteAt === undefined) return true;
    return now - managed.lastWriteAt >= AGENT_IDLE_SILENCE_MS;
  }

  /**
   * Eligibility for the auto-hibernation timer: BACKGROUND-tier terminals
   * that pass the shared safety check. An agent terminal in an active state
   * (working/waiting/directing) becomes eligible after AGENT_IDLE_SILENCE_MS
   * of output silence so a long-parked agent doesn't permanently strand
   * memory the way the original "active agent → never hibernate" rule did.
   * A user-backgrounded panel skips that silence window entirely (see
   * `isSafeToHibernate`).
   */
  isHibernationEligible(
    tier: TerminalRefreshTier,
    managed: ManagedTerminal,
    id: string,
    now: number = Date.now()
  ): boolean {
    if (tier !== TerminalRefreshTier.BACKGROUND) return false;
    return this.isSafeToHibernate(managed, id, now);
  }

  /**
   * Arm the delayed hibernation timer. Idempotent — a second call while a
   * timer is pending is a no-op so callers (`onTierApplied` and `setVisible`)
   * don't have to coordinate. The fire path re-checks visibility and
   * hibernation state because the user may have revealed the terminal
   * between schedule and fire.
   *
   * `delayMs` defaults to HIBERNATION_DELAY_MS. The memory-pressure
   * accelerator passes a shorter value (5s for tier 1, 0ms for tier 2) so
   * the existing schedule path is reused under load instead of a parallel
   * mechanism. If the terminal is not yet idle-eligible because its last
   * write is too recent, an eligibility re-check timer is armed instead
   * — when that fires, scheduleHibernation re-runs and either arms the
   * normal timer or no-ops if the terminal has since become active.
   */
  scheduleHibernation(
    id: string,
    managed: ManagedTerminal,
    delayMs: number = HIBERNATION_DELAY_MS
  ): void {
    if (managed.hibernationTimer || managed.hibernationEligibilityTimer || managed.isHibernated)
      return;

    // Active-state agent that is silent but not yet past the idle window:
    // arm a single delayed re-check at the exact moment eligibility flips.
    // This is the "arm once" pattern from lesson #4974 — do not re-arm on
    // every write, since that would create unbounded deferral. The next
    // write will naturally re-trigger scheduleHibernation via the renderer
    // policy if the tier is still BACKGROUND.
    // A user-backgrounded panel skips the eligibility re-check entirely and
    // falls through to the normal hibernation timer — the silence window
    // does not apply when the user has explicitly hidden the panel.
    if (
      managed.runtimeAgentId &&
      managed.canonicalAgentState !== undefined &&
      ACTIVE_AGENT_STATES.has(managed.canonicalAgentState) &&
      (managed.pendingWrites ?? 0) === 0 &&
      managed.lastWriteAt !== undefined &&
      !this.deps.getIsBackgrounded(id)
    ) {
      const now = Date.now();
      const elapsed = now - managed.lastWriteAt;
      if (elapsed < AGENT_IDLE_SILENCE_MS) {
        // Outer idempotency guard already catches a re-arm attempt while
        // hibernationEligibilityTimer is pending.
        const wait = AGENT_IDLE_SILENCE_MS - elapsed;
        managed.hibernationEligibilityTimer = setTimeout(() => {
          // Re-fetch in callback — the closed-over ref could be stale if
          // the instance was destroyed/re-created (#4850 pattern).
          const current = this.deps.getInstance(id);
          if (!current) return;
          current.hibernationEligibilityTimer = undefined;
          if (current.isHibernated || current.isVisible) return;
          this.scheduleHibernation(id, current, delayMs);
        }, wait);
        return;
      }
    }

    managed.hibernationTimer = setTimeout(() => {
      managed.hibernationTimer = undefined;
      const current = this.deps.getInstance(id);
      // A terminal that became visible (or was revived) between schedule and
      // fire should not be hibernated — the user is looking at it.
      if (!current || current.isVisible || current.isHibernated) return;
      this.hibernate(id);
    }, delayMs);
  }

  /**
   * Cancel a pending hibernation timer. Safe to call when no timer is armed.
   * Also clears the eligibility re-check timer so a terminal that left
   * BACKGROUND tier doesn't have a stale callback fire later and re-arm.
   */
  cancelHibernation(managed: ManagedTerminal): void {
    if (managed.hibernationTimer) {
      clearTimeout(managed.hibernationTimer);
      managed.hibernationTimer = undefined;
    }
    if (managed.hibernationEligibilityTimer) {
      clearTimeout(managed.hibernationEligibilityTimer);
      managed.hibernationEligibilityTimer = undefined;
    }
  }
}
