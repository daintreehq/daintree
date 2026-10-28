import type { AgentAvailabilityState } from "../types/ipc/system.js";
import { agentToolbarPin, type AgentToolbarPins } from "../types/ipc/agentToolbarPins.js";
import { isAgentInstalled } from "./agentAvailability.js";

/**
 * Every resolver here takes one agent's pin from this machine's toolbar pins
 * (`agentToolbarPin(pins, id)`, #14702): `true` an explicit pin, `false` an
 * explicit unpin, `undefined` no intent.
 */
export type AgentPin = boolean | undefined;

/**
 * True only for an explicit pin. An unset pin resolves to `false` — used by
 * routing paths that need to know whether the user deliberately pinned an
 * agent. For toolbar visibility prefer `isAgentToolbarVisible` so an unset pin
 * follows live CLI availability (tri-state semantics — see #7673).
 */
export function isAgentPinned(pin: AgentPin): boolean {
  return pin === true;
}

export function isAgentPinnedById(
  pins: Readonly<AgentToolbarPins> | null | undefined,
  agentId: string
): boolean {
  return isAgentPinned(agentToolbarPin(pins, agentId));
}

/**
 * Tri-state resolver for whether an agent button should appear in the toolbar.
 *
 *  - `true`  → always visible (explicit user pin)
 *  - `false` → always hidden  (explicit user unpin)
 *  - `undefined` → follow live CLI availability — visible when the binary is
 *    installed, hidden when missing
 *
 * Canonical selector for `Toolbar.tsx` and `ToolbarSettingsTab.tsx`; both
 * surfaces must use this so they never disagree (see #7673).
 */
export function isAgentToolbarVisible(
  pin: AgentPin,
  availability: AgentAvailabilityState | undefined
): boolean {
  if (pin === true) return true;
  if (pin === false) return false;
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
  pin: AgentPin,
  availability: AgentAvailabilityState | undefined,
  isPositioned: boolean
): boolean {
  if (pin === true) return true;
  if (pin === false) return false;
  return isPositioned && isAgentInstalled(availability);
}
