import { isBuiltInAgentId } from "@shared/config/agentIds";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { isAgentToolbarVisible } from "../../shared/utils/agentPinned";

export interface ToolbarVisibilityDispatchDeps {
  agentSettings: AgentSettings | null | undefined;
  agentAvailability: CliAvailability | null | undefined;
  setAgentPinned: (agentId: string, pinned: boolean) => void | Promise<void>;
  toggleButtonVisibility: (buttonId: AnyToolbarButtonId, side: "left" | "right") => void;
}

/**
 * Routes a toolbar visibility toggle to the correct store.
 *
 * Agent IDs (entries in `BUILT_IN_AGENT_IDS`) write through `setAgentPinned`
 * so the pin lives in `agentSettingsStore` (the IPC-persisted, tri-state
 * source per #7673). Every other ID — including `agent-tray` and plugin
 * buttons — writes through `toggleButtonVisibility` on the toolbar store.
 *
 * When `explicitPinned` is omitted the agent branch toggles the *currently
 * derived* visible state, so an `undefined` pin (no explicit user
 * preference) flips to the opposite of the live CLI-availability state
 * rather than to the opposite of raw `pinned`.
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
    void deps.setAgentPinned(buttonId, nextPinned);
    return;
  }
  deps.toggleButtonVisibility(buttonId, side);
}
