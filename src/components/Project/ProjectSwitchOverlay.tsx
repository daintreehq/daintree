import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";

export interface ProjectSwitchOverlayProps {
  isSwitching: boolean;
  projectName?: string;
  /**
   * Id of the project being switched to. Used purely as the identity of the
   * current switch episode: when it changes, a fresh switch has begun, so the
   * watchdog latch releases even if a prior episode's flag never cleared.
   */
  switchTargetId?: string | null;
  /**
   * Hard-stop escape hatch invoked if the overlay stays visible past
   * {@link SWITCH_OVERLAY_MAX_MS}. Wired to the store's `clearSwitching` so a
   * stuck flag is reset, not just visually hidden.
   */
  onAutoDismiss?: () => void;
}

/**
 * Absolute ceiling on how long the busy overlay may stay visible. The main
 * process bounds a switch by the project load timeout (10s) plus the cold paint
 * gate hard timeout (4s) — see ProjectViewManager — so a switch that is still
 * genuinely in flight tops out around 14s. Above that the overlay is presumed
 * stuck (a transition whose busy flag never cleared) and force-dismisses itself
 * so it can never permanently trap input. Set generously beyond the legitimate
 * worst case so it only fires on a genuine hang, never on a slow-but-valid switch.
 */
export const SWITCH_OVERLAY_MAX_MS = 20_000;

/**
 * Busy indication shown over the main content area while a project switch is in
 * flight (#10736). During a switch the outgoing project's `WebContentsView`
 * stays composited on top until the incoming view paints (or the main-process
 * hard timeout fires), so the user otherwise stares at a frozen UI with no
 * feedback for up to several seconds on a cold switch. This portal scrim sits
 * above that frozen content and signals the transition.
 *
 * Gated through the 400ms Doherty threshold so it never flashes on fast warm
 * switches (cached view reactivation resolves in ~16-500ms). A centered
 * `Spinner` — not a skeleton — because the incoming project's layout shape is
 * unknown to this renderer.
 *
 * Two independent hard stops keep it from getting stuck (a state where it
 * blocks the whole app): the store clears the flag when a cached view returns
 * to the foreground (see `useResetSwitchOverlayOnReveal`), and this component
 * force-dismisses after {@link SWITCH_OVERLAY_MAX_MS} regardless.
 */
export function ProjectSwitchOverlay({
  isSwitching,
  projectName,
  switchTargetId,
  onAutoDismiss,
}: ProjectSwitchOverlayProps) {
  const showOverlay = useDohertyGate(isSwitching);
  // Latches once the watchdog fires so the overlay stops rendering even if the
  // store flag somehow doesn't clear — the true "never trap input" guarantee.
  const [timedOut, setTimedOut] = useState(false);

  // Release the latch when the switch ends OR a new switch episode begins (the
  // target changes). Keying on the target — not just `isSwitching` going false —
  // means that even if a prior episode's flag is wedged true, the next switch
  // still re-shows the overlay, so the component's guarantee holds independent
  // of whether `onAutoDismiss` managed to clear the store.
  useEffect(() => {
    setTimedOut(false);
  }, [isSwitching, switchTargetId]);

  // Watchdog: arm only while the overlay is actually visible, so a slow switch
  // that resolves before the Doherty gate never starts the clock. Keyed on the
  // target so each switch episode gets its own ceiling — without that a second
  // episode that re-shows on a stuck flag (above) would inherit the spent timer
  // and never be force-dismissed.
  useEffect(() => {
    if (!showOverlay) return;
    const timer = setTimeout(() => {
      setTimedOut(true);
      onAutoDismiss?.();
    }, SWITCH_OVERLAY_MAX_MS);
    return () => clearTimeout(timer);
  }, [showOverlay, switchTargetId, onAutoDismiss]);

  if (!showOverlay || timedOut || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      // Above the toolbar (z-60) so the whole outgoing surface reads as busy,
      // below the panel-transition (z-100) and all-clear (z-200) overlays.
      // backdrop-blur de-emphasises the outgoing project so the switch reads as
      // a real transition. The cost is bounded: it samples only this view's own
      // DOM (the incoming project is a separate WebContentsView the filter can't
      // reach) and only for the brief switch window. A streaming terminal under
      // the scrim can still force per-frame re-rasterisation, so this leans on
      // performance mode — which strips the blur via the global
      // [class*="backdrop-blur"] rule exactly when the machine is under load —
      // and the scrim alone still dims when the blur is dropped.
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim-soft/60 backdrop-blur-md"
    >
      <div className="flex max-w-[80vw] items-center gap-2 text-sm text-text-secondary">
        <Spinner size="md" />
        <span className="truncate">
          {projectName ? `Switching to ${projectName}…` : "Switching project…"}
        </span>
      </div>
    </div>,
    document.body
  );
}
