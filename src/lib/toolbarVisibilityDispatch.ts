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
    // Synchronous, deliberately, even though `setAgentPinned` is an async IPC
    // that can roll its optimistic write back. Deferring the position until the
    // write resolves buys nothing: `Toolbar.tsx` materializes a position for any
    // agent reading as explicitly pinned, and it reads the SAME optimistic
    // state, so it would persist the position during the in-flight window
    // regardless. Two mechanisms racing to write the same value is worse than
    // one that always does.
    //
    // The residual is small and self-correcting: if the pin write fails, the
    // rollback leaves an unset pin over a real position, which
    // `isAgentButtonOnToolbar` reads as on — so the button the user asked for
    // appears (and keeps appearing across restarts, since array membership is
    // exactly how a grandfathered agent stays visible) while `setAgentPinned`
    // separately surfaces the failure. Nothing is lost; the intent is recorded
    // in the other of the two stores.
    if (nextPinned) deps.positionAgentButton?.(buttonId);
    void deps.setAgentPinned(buttonId, nextPinned);
    return;
  }
  deps.toggleButtonVisibility(buttonId, side);
}
