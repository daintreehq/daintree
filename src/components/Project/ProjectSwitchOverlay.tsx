import { createPortal } from "react-dom";

import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";

export interface ProjectSwitchOverlayProps {
  isSwitching: boolean;
  projectName?: string;
}

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
 */
export function ProjectSwitchOverlay({ isSwitching, projectName }: ProjectSwitchOverlayProps) {
  const showOverlay = useDohertyGate(isSwitching);

  if (!showOverlay || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      // Above the toolbar (z-60) so the whole outgoing surface reads as busy,
      // below the panel-transition (z-100) and all-clear (z-200) overlays.
      // Opacity-only scrim — no backdrop-filter: a viewport blur re-rasterizes
      // every frame while the incoming WebContentsView is painting beneath.
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim-soft/60"
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
