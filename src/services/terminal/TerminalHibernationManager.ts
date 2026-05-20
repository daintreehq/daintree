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
  openLink: (url: string, id: string, event?: MouseEvent) => void;
  getCwdProvider: (id: string) => (() => string) | undefined;
  onHibernationChanged: (id: string) => void;
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
    if (!this.isSafeToHibernate(managed)) return;

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

    // Dispose terminal-bound listeners (keep IPC listeners at the beginning)
    const terminalBoundListeners = managed.listeners.splice(managed.ipcListenerCount);
    for (const unsub of terminalBoundListeners) {
      try {
        unsub();
      } catch {
        /* ignore — terminal already disposing */
      }
    }

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
    try {
      managed.terminal.dispose();
    } catch {
      /* ignore — terminal already disposing */
    }

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

    // Create fresh addons
    const openLink = (url: string, event?: MouseEvent) => {
      this.deps.openLink(url, id, event);
    };
    const addons = setupTerminalAddons(
      terminal,
      () => (this.deps.getCwdProvider(id) ?? (() => ""))(),
      (event, uri) => openLink(uri, event)
    );
    managed.fitAddon = addons.fitAddon;
    managed.serializeAddon = addons.serializeAddon;
    managed.searchAddon = addons.searchAddon;
    managed.imageAddon = addons.imageAddon;
    managed.fileLinksDisposable = addons.fileLinksDisposable;
    managed.webLinksAddon = addons.webLinksAddon;

    // Reuse existing hostElement — clear old xterm DOM nodes to prevent ghosting
    const hostElement = managed.hostElement;
    hostElement.replaceChildren();

    // Re-create parser handler
    managed.parserHandler = new TerminalParserHandler(managed, () => {
      this.deps.applyDeferredResize(id);
    });

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
   * - Non-agent terminals: always safe.
   * - Agents in resting states (`idle`/`completed`/`exited`, or undefined
   *   state for legacy paths that never assigned canonicalAgentState):
   *   always safe. `idle` is not in ACTIVE_AGENT_STATES — it represents
   *   the agent itself reporting it has nothing to do.
   * - Agents in active states (`working`/`waiting`/`directing`): safe
   *   only if no writes are in flight AND the last rendered output is
   *   either non-existent or at least AGENT_IDLE_SILENCE_MS old. The
   *   "never wrote" case is treated as safe because silence is by
   *   definition infinite if no write has ever been recorded.
   */
  private isSafeToHibernate(managed: ManagedTerminal, now: number = Date.now()): boolean {
    if (!managed.runtimeAgentId) return true;
    const state = managed.canonicalAgentState;
    if (state === undefined || !ACTIVE_AGENT_STATES.has(state)) return true;
    if ((managed.pendingWrites ?? 0) > 0) return false;
    if (managed.lastWriteAt === undefined) return true;
    return now - managed.lastWriteAt >= AGENT_IDLE_SILENCE_MS;
  }

  /**
   * Eligibility for the auto-hibernation timer: BACKGROUND-tier terminals
   * that pass the shared safety check. An agent terminal in an active state
   * (working/waiting/directing) becomes eligible after AGENT_IDLE_SILENCE_MS
   * of output silence so a long-parked agent doesn't permanently strand
   * memory the way the original "active agent → never hibernate" rule did.
   */
  isHibernationEligible(
    tier: TerminalRefreshTier,
    managed: ManagedTerminal,
    now: number = Date.now()
  ): boolean {
    if (tier !== TerminalRefreshTier.BACKGROUND) return false;
    return this.isSafeToHibernate(managed, now);
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
    if (
      managed.runtimeAgentId &&
      managed.canonicalAgentState !== undefined &&
      ACTIVE_AGENT_STATES.has(managed.canonicalAgentState) &&
      (managed.pendingWrites ?? 0) === 0 &&
      managed.lastWriteAt !== undefined
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
