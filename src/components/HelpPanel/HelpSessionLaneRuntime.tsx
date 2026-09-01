import { useEffect } from "react";
import { useHelpPanelStore, selectSlot } from "@/store/helpPanelStore";
import { acquireHelpSessionController } from "@/controllers/helpSessionControllerRegistry";
import type { HelpProjectRef } from "@/controllers/HelpSessionController";

interface HelpSessionLaneRuntimeProps {
  slot: number;
  isReadyToLaunch: boolean;
  currentProject: HelpProjectRef | null;
  preferredAgentId: string | null;
  supportedInstalledAgentIds: readonly string[];
  autoLaunchEnabled: boolean;
  visibilityEpoch: number;
  /** Panel-level open state — shared by every lane, since one panel hosts them all. */
  isOpen: boolean;
  /** Whether this lane is the one currently on screen. */
  isActive: boolean;
}

/**
 * Keeps one background assistant lane running (#12108). Renders nothing.
 *
 * The visible lane's controller is driven by `HelpPanel` itself; this covers
 * every other open lane, whose controller must stay armed even though its body
 * is not mounted. Without it a background session would silently stop
 * surfacing tool-call activity and approval prompts — and a tier-mismatch
 * prompt that nobody answers stalls that session outright — while its idle
 * hibernate timer would never fire.
 *
 * `isOpen` is deliberately reported as false for a lane that is not on screen.
 * The controller treats "open" as "the user is looking at this conversation",
 * and it gates auto-launch and the idle-hibernate arm on it: a background lane
 * must not auto-launch (that would bill a session the user never asked for)
 * and SHOULD be allowed to hibernate once idle.
 */
export function HelpSessionLaneRuntime({
  slot,
  isReadyToLaunch,
  currentProject,
  preferredAgentId,
  supportedInstalledAgentIds,
  autoLaunchEnabled,
  visibilityEpoch,
  isOpen,
  isActive,
}: HelpSessionLaneRuntimeProps) {
  const controller = acquireHelpSessionController(slot);
  const terminalId = useHelpPanelStore((s) => selectSlot(s, slot).terminalId);

  useEffect(() => {
    controller.start();
    // Deliberately NOT stopped on unmount. This component unmounts when its
    // lane becomes the active one (HelpPanel takes over driving the same
    // controller instance), and stopping there would disarm the listeners of a
    // live session. A lane that is genuinely closed is released explicitly via
    // `releaseHelpSessionController`.
  }, [controller]);

  useEffect(() => {
    controller.syncInputs({
      isOpen: isOpen && isActive,
      isReadyToLaunch,
      currentProject,
      terminalId,
      preferredAgentId,
      supportedInstalledAgentIds,
      autoLaunchEnabled,
      visibilityEpoch,
    });
  }, [
    controller,
    isOpen,
    isActive,
    isReadyToLaunch,
    currentProject,
    terminalId,
    preferredAgentId,
    supportedInstalledAgentIds,
    autoLaunchEnabled,
    visibilityEpoch,
  ]);

  return null;
}
