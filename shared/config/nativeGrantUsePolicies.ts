import type { BuiltInActionId } from "../types/actions.js";

/**
 * How a native automation grant's use budget (#10648) relates to what a single
 * call actually does (#12121).
 *
 * - `per-dispatch` — one call affects one thing, so one call costs one use.
 *   The budget the Settings card presents ("N of M uses left") is a truthful
 *   count of what the grant still authorizes. This is the default.
 * - `per-resolved-target` — one call fans out across every target it resolves
 *   at dispatch time, and losing those targets is what the user is being asked
 *   to approve. A use count cannot bound it, because the target set is not
 *   known when the use is charged, so these tools are not eligible for a
 *   generic native grant at all.
 *
 * Fan-out alone does not qualify a tool. `git.stageAll` touches every changed
 * file in one call and stays `per-dispatch`, because the budget is not
 * misrepresenting anything a user would count: staging is reversible and
 * carries no per-file consequence to weigh. What earns the stricter policy is
 * a call whose blast radius is both unbounded and the thing being approved.
 */
export type NativeGrantUsePolicy = "per-dispatch" | "per-resolved-target";

/**
 * Tools whose cost is NOT one-per-call. Everything unlisted is `per-dispatch`.
 *
 * `terminal.killAll` and `terminal.closeAll` both resolve their target set from
 * live renderer state inside `run()` — there is no target list in `args` and no
 * way for the main process to learn the count before the call is committed to
 * dispatch. A `maxUses: 10` grant therefore reads as "ten careful approvals"
 * while authorizing ten unbounded sweeps.
 *
 * **A new destructive fan-out action must be added here.** The default is
 * deliberately permissive so ordinary single-target tools need no declaration,
 * which means an omission fails open. The batch terminal kill in #12123 is the
 * next tool that belongs in this map: it takes explicit ids rather than a live
 * query, but its blast radius is still per-target, so it gets one bulk human
 * confirmation rather than a generic grant's blanket pre-authorization.
 */
export const NATIVE_GRANT_USE_POLICY_OVERRIDES: Readonly<
  Partial<Record<BuiltInActionId, NativeGrantUsePolicy>>
> = {
  "terminal.closeAll": "per-resolved-target",
  "terminal.killAll": "per-resolved-target",
};

// Keyed lookup rather than a bare index into the literal above: `toolId` is
// caller-supplied from the MCP surface, and a plain object inherits
// `Object.prototype`, so `"toString"` would resolve to a function.
const POLICY_BY_TOOL_ID: ReadonlyMap<string, NativeGrantUsePolicy> = new Map(
  Object.entries(NATIVE_GRANT_USE_POLICY_OVERRIDES).filter(
    (entry): entry is [string, NativeGrantUsePolicy] => entry[1] !== undefined
  )
);

export function getNativeGrantUsePolicy(toolId: string): NativeGrantUsePolicy {
  return POLICY_BY_TOOL_ID.get(toolId) ?? "per-dispatch";
}

/**
 * Whether a native automation grant may cover `toolId` at all. False for a
 * fan-out tool whose per-call cost a use count cannot express — such a call
 * still runs, it just never rides a grant's pre-authorization and never spends
 * a use.
 */
export function isGenericNativeGrantEligible(toolId: string): boolean {
  return getNativeGrantUsePolicy(toolId) === "per-dispatch";
}
