/**
 * The guest's copy of the picker's origin policy (`shared/elementPicker/originPolicy.ts`),
 * which the renderer reads too: the browser panel offers the picker only where
 * the bridge would install it.
 */
import {
  evaluateOriginPolicy,
  type GuestOriginPolicy,
} from "../../../shared/elementPicker/originPolicy.js";

export {
  DEFAULT_GUEST_ORIGIN_POLICY,
  isLocalPreviewUrl,
  originPolicyAllows,
  type GuestOriginPolicy,
  type OriginPolicyContext,
} from "../../../shared/elementPicker/originPolicy.js";

/**
 * The policy as an expression the guest evaluates against its own document,
 * for the host to place at the very top of the injected script. `true` means
 * the script may go on to install itself.
 *
 * `initialDocument` is hard-coded false, and must stay that way: a script only
 * ever runs in a document that exists, and the one it runs in is by definition
 * one the guest navigated to — including a blank one, whose origin is the
 * initiator's. The pre-navigation allowance is the host's to make at install
 * time, from state the page cannot reach.
 */
export function buildOriginGuardSource(policy: GuestOriginPolicy): string {
  return `(${evaluateOriginPolicy.toString()})(${JSON.stringify(policy)}, location.href, false)`;
}
