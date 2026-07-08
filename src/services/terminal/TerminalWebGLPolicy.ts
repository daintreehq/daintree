import type { ManagedTerminal } from "./types";
import { isWebGLEligibleTier } from "./types";
import { TerminalRefreshTier } from "@/types";

export interface TerminalWebGLPolicyDeps {
  getMode: () => "webgl" | "dom";
  getPinnedId: () => string | null;
  isAltBufferPinned: (id: string) => boolean;
}

/**
 * Pure WebGL eligibility decisions — distinct from `TerminalWebGLManager`
 * (context pool/circuit-breaker/rAF drain) and `TerminalRendererPolicy`
 * (tier-application state machine). Three past incidents (#10671 want-set
 * accumulation, the DOM-mode pinned-context circuit breaker, and bulk-attach
 * staggering) shipped in exactly this logic — treat any future change here
 * as high-risk, not a routine edit.
 */
export class TerminalWebGLPolicy {
  constructor(private deps: TerminalWebGLPolicyDeps) {}

  /**
   * Whether a terminal wants a WebGL context at the given tier. Agent
   * terminals are eligible at every WebGL-eligible tier (FOCUSED/BURST/
   * VISIBLE) — the DOM renderer mangles the block glyphs agent headers use
   * (see isWebGLEligibleTier in types.ts). Plain terminals are eligible only
   * while focused: FOCUSED, or a BURST on the focused pane (input bursts and
   * streaming output must not drop the context mid-use). BURST alone is
   * write-driven for every terminal, so granting it to unfocused plain shells
   * would add a want per streaming build/log pane and trip the count-based
   * mode switch; VISIBLE is excluded for the same budget reason.
   */
  wantsWebGLAtTier(
    managed: ManagedTerminal,
    tier: TerminalRefreshTier | undefined,
    opts?: { trustDomVisibility?: boolean }
  ): boolean {
    if (!isWebGLEligibleTier(tier)) return false;
    // Visibility gates every case: an off-screen pane never wants WebGL, even
    // an agent streaming at BURST. The want set is fleet-wide per project view,
    // so hidden streaming agents would otherwise accumulate wants and trip the
    // count-based mode switch, dropping the whole visible fleet to DOM
    // (#10671). The reveal path (setVisible(true) → debounced shouldRestoreWebGL
    // → ensureContext) re-acquires the want once the pane is on-screen again —
    // and on a warm WebContentsView resume it passes trustDomVisibility because
    // it has already proven the pane on-screen from DOM truth, so the stale
    // reactive isVisible flag must not veto the want there.
    if (!opts?.trustDomVisibility && !managed.isVisible) return false;
    if (managed.runtimeAgentId) return true;
    return (
      tier === TerminalRefreshTier.FOCUSED ||
      (tier === TerminalRefreshTier.BURST && managed.isFocused)
    );
  }

  /**
   * Eligibility for visibility-driven WebGL restore. Mirrors the gates in
   * onTierApplied (agent identity / focus + tier) plus liveness checks
   * (opened, not attaching). Used by the debounced timer in setVisible()
   * before re-acquiring a context.
   */
  shouldRestoreWebGL(managed: ManagedTerminal, opts?: { trustDomVisibility?: boolean }): boolean {
    if (!managed.isOpened) return false;
    // The reveal path proves visibility from DOM ground truth (isConnected +
    // checkVisibility + box) before calling, because the reactive isVisible flag
    // can be stale-false on a warm WebContentsView resume (#10632 item 4). Trust
    // that here so a dropped WebGL context is reattached on reveal instead of
    // leaving the pane on the DOM renderer until the ~3s watchdog (which is
    // itself suppressed for the first ~5s by the project-switch resize lock).
    if (!opts?.trustDomVisibility && !managed.isVisible) return false;
    if (managed.isAttaching) return false;
    return this.wantsWebGLAtTier(
      managed,
      managed.lastAppliedTier ?? managed.getRefreshTier?.(),
      opts
    );
  }

  /**
   * Watchdog-only WebGL eligibility. Identical to {@link shouldRestoreWebGL} but
   * additionally false for a non-pinned pane in DOM-mode fallback: in DOM mode
   * the manager only ever attaches the single focus-pinned context, so a
   * non-pinned pane's context can never become active. Without this the
   * watchdog's `shouldHaveWebGL && !isWebGLActive` stays permanently true for
   * every non-pinned agent pane and burns a heavy-repair slot every tick (plus a
   * spurious "context missing" warning). The reveal / visibility restore paths
   * deliberately keep using {@link shouldRestoreWebGL} so they still call
   * `ensureContext` and keep the pane in the manager's `wants` set — which is
   * what lets a later focus change pin and attach it immediately.
   */
  shouldHaveActiveWebGL(managed: ManagedTerminal): boolean {
    if (!this.shouldRestoreWebGL(managed)) return false;
    // In DOM mode the manager only keeps contexts on pinned panes (the focus
    // pin and alt-buffer pins). A non-pinned pane can never have an active
    // context, so the watchdog must not treat its absence as a fault.
    if (
      this.deps.getMode() === "dom" &&
      managed.id !== this.deps.getPinnedId() &&
      !this.deps.isAltBufferPinned(managed.id)
    ) {
      return false;
    }
    return true;
  }
}
