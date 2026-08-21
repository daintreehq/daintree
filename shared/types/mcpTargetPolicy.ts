import { z } from "zod";
import type { McpSurfaceTier } from "./mcpSurface.js";

/**
 * The authorization tiers a target policy can report. Same set `mcp.surface`
 * reports, aliased rather than restated so the two contracts cannot drift.
 */
export type McpTargetTier = McpSurfaceTier;

/** Which mechanism admits this target for this session, in dispatch-gate order. */
export type McpTargetAuthorizedBy = "tier" | "grant" | "nativeGrant";

/** Whether a client may call this target through a generic invoker. */
export type McpTargetInvocationMode = "allowed" | "wrapper-required";

/**
 * The authoritative policy record for ONE action, as one session sees it
 * (#11910).
 *
 * Answers what a client needs before it dispatches a target it discovered
 * rather than one it was written against: may I call this, what will it cost me
 * in confirmation, and will that answer still hold in a minute. Tool
 * annotations cannot serve this purpose — the MCP spec is explicit that they
 * are untrusted hints, so a client that policed itself with them would be
 * running a second security policy that drifts from the host's.
 *
 * Only ever accompanies an `ok: true` lookup. An action this session cannot
 * reach — hidden, restricted, outside its tier, or withheld from a
 * workspace-bound session — collapses to the same `NOT_FOUND` an unknown id
 * returns, and carries no policy at all. That is deliberate: #11585 established
 * that a discoverable-but-uncallable state is not a state any shipped client can
 * act on, so withholding a name is equivalent to revoking it, and this record
 * must not reintroduce the split by describing what it refuses to name.
 *
 * A SNAPSHOT, not a lease. Grants expire and are revoked between a lookup and a
 * call, and `requiresConfirmation` can flip when the last use of a native grant
 * is spent. The dispatch gate stays authoritative; this record only lets a
 * client stop guessing.
 */
export interface McpTargetPolicy {
  /**
   * Shape version of this record, bumped by hand when a field is added,
   * removed, or given new meaning. Distinct from {@link hash}: a client reads
   * this to know whether it can still parse the record at all.
   */
  version: number;
  /**
   * Lowercase hex SHA-256 over this target's compatibility-relevant fields.
   * Changes iff something a caller's own code depends on changes — schemas,
   * danger, tier, annotations, invocation mode. Never moves for a reworded
   * description, and never for live session state, so a client can cache a
   * validated target against it.
   */
  hash: string;
  /** Whether a dispatch would be admitted right now, confirmation aside. */
  callable: boolean;
  /**
   * Why an otherwise-reachable target is not callable. Only ever `DISABLED` —
   * an action whose own `isEnabled` is false in this context. Authorization
   * denials never reach this field; they are `NOT_FOUND`.
   */
  unavailableReason: "DISABLED" | null;
  /**
   * The lowest tier on the CALLER'S OWN ladder that permits this target. Always
   * `external` for an external caller, whose allowlist is a flat peer of the
   * in-app ladder rather than a rung on it.
   */
  minimumTier: McpTargetTier;
  /** The tier this session was admitted at when the lookup ran. */
  effectiveTier: McpTargetTier;
  /** The target's DECLARED danger. Static; part of {@link hash}. */
  danger: "safe" | "confirm";
  /**
   * Whether a dispatch right now would block on a human confirmation dialog.
   * Live, unlike {@link danger}: a native automation grant pre-authorizes the
   * dispatch, so a `confirm` target can report `false` here until that grant is
   * spent or expires.
   */
  requiresConfirmation: boolean;
  /**
   * Whether ARGUMENTS can raise a `safe` target to confirmation-gated. True for
   * targets accepting a `recipeId`: an agent-sourced call carrying one spawns
   * the recipe's terminals, so the host elevates it per-dispatch (#11860). A
   * client reading only {@link danger} would call such a target expecting no
   * dialog and get `CONFIRMATION_REQUIRED` instead.
   */
  confirmationMayEscalate: boolean;
  /**
   * Whether this session could be granted this target on a denial. False for
   * every session whose origin cannot hold grants at all — an api-key client
   * has no renderer to approve in, so no scoped grant is reachable for it no
   * matter which tier admits the tool elsewhere.
   */
  grantable: boolean;
  /**
   * Which mechanism admits the target, resolved in the dispatch gate's own
   * order. `tier` is durable for the session; the other two are time-bounded,
   * so a client that wants to know whether its access can lapse reads this.
   */
  authorizedBy: McpTargetAuthorizedBy;
  /** Whether a generic invoker may call this target directly. */
  dynamicInvocation: McpTargetInvocationMode;
  /**
   * A purpose-built tool to call instead of invoking this target generically,
   * or `null` when none exists. Always `null` today: no host-side wrapper
   * registry exists, and deriving names from the client's own roster would be
   * the second, drifting policy this contract rejects.
   */
  preferredTool: string | null;
}

const TIER_VALUES = ["workbench", "action", "system", "external"] as const;

/**
 * The policy half of the `actions.getSchema` result.
 *
 * NOT reached by the renderer's own `resultSchema` validation: that runs in
 * `ActionService.dispatch`, before main has substituted the real record, so what
 * it validates is always the `null` placeholder. This schema's job is to be the
 * shape a client — and `McpGetSchemaWireResultSchema` — checks the finished
 * record against.
 */
export const McpTargetPolicySchema = z.object({
  version: z.number().int().positive(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  callable: z.boolean().describe("Whether a dispatch would be admitted now, confirmation aside"),
  unavailableReason: z.literal("DISABLED").nullable(),
  minimumTier: z.enum(TIER_VALUES).describe("Lowest tier on this caller's ladder permitting it"),
  effectiveTier: z.enum(TIER_VALUES),
  danger: z.enum(["safe", "confirm"]).describe("Declared danger; static"),
  requiresConfirmation: z.boolean().describe("Whether a call now would block on a human dialog"),
  confirmationMayEscalate: z
    .boolean()
    .describe("Whether arguments can raise a safe target to confirmation-gated"),
  grantable: z.boolean().describe("Whether this session could be granted it on a denial"),
  authorizedBy: z.enum(["tier", "grant", "nativeGrant"]),
  dynamicInvocation: z.enum(["allowed", "wrapper-required"]),
  preferredTool: z.string().nullable().describe("A typed tool to prefer over generic invocation"),
});

/**
 * The `actions.getSchema` result (#11910).
 *
 * A flat object with four always-present keys rather than the discriminated
 * union it replaces. Two reasons, both load-bearing:
 *
 * 1. One shape means a client reads `ok` and finds every key where it expects
 *    it, instead of narrowing a union before it can tell a denial from an
 *    answer. It also keeps the door open for advertising this as an MCP
 *    `outputSchema` later: `buildToolOutputSchema` only advertises a schema
 *    whose generated JSON Schema has a top-level `type: "object"`, which the
 *    previous top-level `z.union` could never produce.
 * 2. The renderer cannot fill `policy`: it has no session, tier, or grant
 *    state. It returns `null` there and main substitutes the real record after
 *    session filtering, so the field must be nullable rather than optional for
 *    the renderer's own `resultSchema` validation to pass.
 *
 * Read `ok`, never the key set: `entry` and `policy` are present-and-null on a
 * failure, not absent.
 */
export const McpGetSchemaResultSchema = z.object({
  ok: z.boolean(),
  entry: z.record(z.string(), z.unknown()).nullable(),
  policy: McpTargetPolicySchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

/**
 * What a CLIENT actually receives, after main has substituted the policy.
 *
 * Deliberately stricter than {@link McpGetSchemaResultSchema}, which has to stay
 * loose enough to accept the renderer's half-built staging value (`policy:
 * null` on a success). That looseness is a validation gap on the wire — it
 * admits `{ ok: true, policy: null }` and `{ ok: false, entry: {...} }`, neither
 * of which main can emit — so the finished shape gets its own schema rather than
 * inheriting the staging one.
 *
 * Discriminated on a literal `ok`, so a consumer narrows on it and gets
 * non-null `entry`/`policy` on the success arm without re-checking. This is the
 * contract the companion CLI (daintreehq/assistant#368) codes against.
 */
export const McpGetSchemaWireResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    entry: z.record(z.string(), z.unknown()),
    policy: McpTargetPolicySchema,
    error: z.null(),
  }),
  z.object({
    ok: z.literal(false),
    entry: z.null(),
    policy: z.null(),
    error: z.object({ code: z.literal("NOT_FOUND"), message: z.string() }),
  }),
]);
