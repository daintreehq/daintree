import { z } from "zod";
import type { HelpAssistantTier } from "./ipc/maps.js";
import type { ActionKind } from "./actions.js";

/**
 * The authorization tiers a surface manifest can report. Structurally identical
 * to `McpTier` in `electron/services/mcp-server/shared.ts`, restated here so the
 * wire contract is declared outside the main process — the builder there returns
 * this type, so the two cannot drift without a compile error.
 *
 * `external` is a peer of the in-app ladder, not a rung above it: it is an
 * independently curated allowlist for api-key sessions.
 */
export type McpSurfaceTier = HelpAssistantTier | "external";

/**
 * Why a tool is on its way out, and what to call instead. Absent on every tool
 * that is not deprecated — presence is the signal.
 */
export interface McpSurfaceDeprecation {
  reason: string;
  replacedBy?: string;
}

/**
 * One tool's entry in the surface manifest (#11549). Deliberately narrow: a
 * client checking itself against the live server needs the facts its own
 * behavior depends on, not a second copy of `tools/list`. Descriptions and
 * schemas are omitted — they are already on `tools/list`, and re-sending them
 * here would make the cheap startup check as expensive as the thing it replaces.
 */
export interface McpSurfaceTool {
  id: string;
  /**
   * The lowest tier on the CALLER'S OWN ladder that permits this tool. Always
   * `external` for an external caller, since that allowlist is flat. For an
   * in-app caller this is the minimum of workbench/action/system, so a `system`
   * session can see which of its tools would survive a demotion.
   */
  tier: McpSurfaceTier;
  kind: ActionKind;
  /** Mirrors the `readOnlyHint` annotation on `tools/list` — safe to retry. */
  readOnlyHint: boolean;
  /** Mirrors the `idempotentHint` annotation on `tools/list`. */
  idempotentHint: boolean;
  deprecated?: McpSurfaceDeprecation;
}

/**
 * The `mcp.surface` result (#11549): this session's tool surface as data, so a
 * client can verify at startup that the surface it was written against is the
 * one it is talking to, and fail loudly rather than silently.
 *
 * Describes exactly what `tools/list` returns for this session — the static
 * tier allowlist, NOT the transient per-tool approvals that can widen dispatch
 * for a few minutes. Folding those in would make `hash` flap as approvals come
 * and go and would describe a surface `tools/list` never showed.
 */
export interface McpSurfaceManifest {
  /**
   * Version of this payload's SHAPE, bumped by hand when a field is added,
   * removed, or given new meaning. Distinct from {@link hash} (which changes
   * when the tool surface changes) and from {@link appVersion} (which changes
   * on every release): a client reads this to know whether it can still parse
   * the response at all.
   */
  manifestVersion: number;
  /** The running Daintree build, so a captured response is diagnosable alone. */
  appVersion: string;
  /** The authorization tier this session is on. */
  tier: McpSurfaceTier;
  /**
   * Lowercase hex SHA-256 over the canonical form of the surface. Changes iff
   * the surface a client depends on changes; see `buildSurfaceManifest` for the
   * exact preimage. Comparing this is the cheap drift check — it never changes
   * for a description edit, and always changes for an argument-schema edit.
   */
  hash: string;
  /** Sorted by id, so two reads of an unchanged surface compare equal. */
  tools: McpSurfaceTool[];
}

const TIER_VALUES = ["workbench", "action", "system", "external"] as const;

/**
 * Published as the `mcp.surface` tool's `outputSchema`. A plain top-level
 * `z.object` on purpose: `buildToolOutputSchema` only advertises a schema whose
 * generated JSON Schema has `type: "object"`, so a top-level `.nullable()` or
 * `.union()` here would silently advertise nothing at all.
 */
export const McpSurfaceResultSchema = z.object({
  manifestVersion: z
    .number()
    .int()
    .positive()
    .describe("Shape version of this payload, bumped when its fields change meaning"),
  appVersion: z.string().describe("The running Daintree build"),
  tier: z.enum(TIER_VALUES).describe("The authorization tier this session is on"),
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .describe("Hex SHA-256 of the surface; compare it later to detect drift without diffing"),
  tools: z
    .array(
      z.object({
        id: z.string(),
        tier: z
          .enum(TIER_VALUES)
          .describe("Lowest tier on this caller's ladder that permits the tool"),
        kind: z.enum(["command", "query"]),
        readOnlyHint: z.boolean().describe("The tool does not modify state, so a retry is safe"),
        idempotentHint: z
          .boolean()
          .describe("Repeating the call with the same arguments has no additional effect"),
        deprecated: z
          .object({
            reason: z.string(),
            replacedBy: z.string().optional(),
          })
          .optional()
          .describe("Present only when the tool is on its way out"),
      })
    )
    // Not "every tool this session can call": a per-tool approval can widen
    // dispatch beyond this list for a few minutes without ever appearing in
    // `tools/list`, and this reports the listing.
    .describe("Every tool `tools/list` advertises to this session, sorted by id"),
});
