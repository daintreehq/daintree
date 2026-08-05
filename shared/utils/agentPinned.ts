import type { AgentSettings, AgentSettingsEntry } from "../types/agentSettings.js";
import type { AgentAvailabilityState } from "../types/ipc/system.js";
import { isAgentInstalled } from "./agentAvailability.js";

/**
 * Returns true only when the entry explicitly sets `pinned: true`. Missing
 * entries and missing `pinned` fields resolve to `false` — used by routing
 * paths (e.g. `getPinnedAgents`) that need to know whether a user has
 * deliberately pinned an agent. For toolbar visibility prefer
 * `isAgentToolbarVisible` so a missing `pinned` value follows live CLI
 * availability (tri-state semantics — see #7673).
 */
export function isAgentPinned(entry: AgentSettingsEntry | undefined | null): boolean {
  if (!entry) return false;
  return entry.pinned === true;
}

export function isAgentPinnedById(
  settings: AgentSettings | null | undefined,
  agentId: string
): boolean {
  return isAgentPinned(settings?.agents?.[agentId]);
}

/**
 * Tri-state resolver for whether an agent button should appear in the toolbar.
 *
 *  - `pinned: true`  → always visible (explicit user pin)
 *  - `pinned: false` → always hidden  (explicit user unpin)
 *  - `pinned: undefined` or no entry → follow live CLI availability — visible
 *    when the binary is installed, hidden when missing
 *
 * Canonical selector for `Toolbar.tsx` and `ToolbarSettingsTab.tsx`; both
 * surfaces must use this so they never disagree (see #7673).
 */
export function isAgentToolbarVisible(
  entry: AgentSettingsEntry | undefined | null,
  availability: AgentAvailabilityState | undefined
): boolean {
  if (entry?.pinned === true) return true;
  if (entry?.pinned === false) return false;
  return isAgentInstalled(availability);
}

/**
 * Whether an agent currently has its own top-level toolbar button — the agent
 * counterpart of `isPanelButtonOnToolbar`, and what the launcher's pin
 * affordance reads (#11680).
 *
 * `isAgentToolbarVisible` cannot answer this. It resolves an unset pin to "the
 * binary is installed", which was the same thing while every agent id shipped in
 * `DEFAULT_LEFT_BUTTONS`; since #11680 dropped that spread, a fresh profile's
 * installed-but-unpinned agent is in neither side array and renders nothing,
 * while `isAgentToolbarVisible` still reports it as on.
 *
 * Same three states, same order as `isPanelButtonOnToolbar`: an explicit `false`
 * is a hide and wins over any position; an explicit `true` is the user's own
 * promotion and reads as on even in the window before the position is rebuilt;
 * otherwise the position decides. The availability term stays on the
 * fall-through branch because that branch *is* the grandfathered profile — it
 * carries every agent id in its arrays and has always shown exactly the
 * installed ones.
 */
export function isAgentButtonOnToolbar(
  entry: AgentSettingsEntry | undefined | null,
  availability: AgentAvailabilityState | undefined,
  isPositioned: boolean
): boolean {
  if (entry?.pinned === true) return true;
  if (entry?.pinned === false) return false;
  return isPositioned && isAgentInstalled(availability);
}
