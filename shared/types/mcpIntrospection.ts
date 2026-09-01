import { z } from "zod";

/**
 * The first-party existence catalog (#12117).
 *
 * A minimal record naming an action that EXISTS above the calling session's
 * tier. It is not a deferred tool listing: the id it names is absent from
 * `tools/list`, absent from `mcp.surface`, and undispatchable — #11585's
 * listed-means-callable invariant is untouched, because nothing here is
 * listed. What it fixes is the report, not the authorization.
 *
 * Before this existed, an out-of-tier id was indistinguishable from a
 * nonexistent one at every discovery surface, so a model asked to do something
 * its tier withholds could only conclude the product had no such feature and
 * say so — which is what #12117 was filed about. The tier still refuses the
 * call; the assistant can now name the tier that would permit it instead of
 * denying the capability exists.
 *
 * Only ever built for a renderer-owned session (`help` / `assistant-pane`) —
 * a pinned panel with a human watching, whose prompt carries the rule for
 * reading these. Every other caller, external clients included, receives the
 * payload it received before, with no key added.
 */
export interface McpUnavailableActionStub {
  /** The action id, as `actions.getSchema` would take it. */
  id: string;
  /** Human-readable title, the same string `tools/list` would annotate with. */
  title: string;
  /**
   * Risk band, derived in main from the entry's own danger and category rather
   * than read off the field the renderer attached — this crosses a tier
   * boundary, so it is computed from validated inputs.
   */
  band: "reversible" | "external-effect" | "destructive-local" | "destructive-network";
  /**
   * The lowest in-app tier that permits this action — what the user would have
   * to raise the session to. Never `external`: that allowlist is a flat peer of
   * the in-app ladder, not a rung a first-party session could climb to.
   */
  minimumTier: "workbench" | "action" | "system";
  /**
   * Always `false`. Written out rather than implied so a model reading one
   * entry in isolation cannot mistake it for something it may dispatch.
   */
  callable: false;
}

/**
 * Deliberately withheld: `description`, `inputSchema`, `outputSchema`,
 * `disabledReason`, and the policy record. Existence and the tier that would
 * permit it are what a session needs to stop reporting the capability as
 * absent; the schemas stay behind authorization (#12117).
 */
export const McpUnavailableActionStubSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  band: z.enum(["reversible", "external-effect", "destructive-local", "destructive-network"]),
  minimumTier: z.enum(["workbench", "action", "system"]),
  callable: z.literal(false),
});
