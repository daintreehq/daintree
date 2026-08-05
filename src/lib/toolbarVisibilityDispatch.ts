import { isBuiltInAgentId } from "@shared/config/agentIds";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { isAgentToolbarVisible } from "../../shared/utils/agentPinned";

export interface ToolbarVisibilityDispatchDeps {
  agentSettings: AgentSettings | null | undefined;
  agentAvailability: CliAvailability | null | undefined;
  setAgentPinned: (agentId: string, pinned: boolean) => void | Promise<void>;
  toggleButtonVisibility: (buttonId: AnyToolbarButtonId, side: "left" | "right") => void;
  /**
   * Gives a newly-pinned agent a toolbar position when it has none (#11680).
   * Optional so callers that only need the pin write — and cannot render a
   * toolbar anyway — keep working unchanged.
   */
  positionAgentButton?: (buttonId: AnyToolbarButtonId) => void;
}

/**
 * Routes a toolbar visibility toggle to the correct store.
 *
 * Agent IDs (entries in `BUILT_IN_AGENT_IDS`) write through `setAgentPinned`
 * so the pin lives in `agentSettingsStore` (the IPC-persisted, tri-state
 * source per #7673). Every other ID — including `launcher` and plugin
 * buttons — writes through `toggleButtonVisibility` on the toolbar store.
 *
 * When `explicitPinned` is omitted the agent branch toggles the *currently
 * derived* visible state, so an `undefined` pin (no explicit user
 * preference) flips to the opposite of the live CLI-availability state
 * rather than to the opposite of raw `pinned`.
 *
 * Pinning an agent also asks for a position. Since #11680 removed the
 * `LAUNCHABLE_AGENT_IDS` spread from `DEFAULT_LEFT_BUTTONS`, a fresh profile's
 * agent ids sit in neither side array, so the pin alone would leave the button
 * with nowhere to render — the same gap `setPanelButtonOnToolbar` closes for
 * `browser`/`dev-server`. Both surfaces that can pin an agent (the launcher and
 * Settings → Toolbar) route through this one function precisely so they cannot
 * disagree about that.
 */
export function dispatchToolbarVisibility(
  buttonId: AnyToolbarButtonId,
  side: "left" | "right",
  deps: ToolbarVisibilityDispatchDeps,
  explicitPinned?: boolean
): void {
  if (isBuiltInAgentId(buttonId)) {
    const nextPinned =
      explicitPinned ??
      !isAgentToolbarVisible(
        deps.agentSettings?.agents?.[buttonId],
        deps.agentAvailability?.[buttonId]
      );
    // Position before the pin write: the pin is an async IPC round-trip, and
    // ordering the synchronous local write first means the button never renders
    // for a frame with no slot to render into.
    if (nextPinned) deps.positionAgentButton?.(buttonId);
    void deps.setAgentPinned(buttonId, nextPinned);
    return;
  }
  deps.toggleButtonVisibility(buttonId, side);
}
