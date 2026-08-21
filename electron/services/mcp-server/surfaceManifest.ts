import { createHash } from "node:crypto";
import type { ActionManifestEntry } from "../../../shared/types/actions.js";
import type { McpSurfaceManifest, McpSurfaceTool } from "../../../shared/types/mcpSurface.js";
import { type McpTier, minimumPermittingTier } from "./shared.js";
import {
  buildAnnotations,
  buildToolOutputSchema,
  shouldExposeTool,
  UNBOUND_SESSION_SURFACE,
  type SessionSurfacePolicy,
} from "./tierAuth.js";
import { canonicalJson, toCompatibilityShape } from "./compatibilityHash.js";

export const MCP_SURFACE_TOOL_ID = "mcp.surface";

/**
 * Shape version of the `mcp.surface` payload. Bump when a field is added,
 * removed, or given new meaning — never for a change in which tools the surface
 * contains, which is what `hash` is for.
 *
 * v2: `hash` was given new meaning. Its preimage used to be the ADVERTISED input
 * schema (`buildToolInputSchema`), which now projects away the value-range
 * keywords for the model's benefit. Hashing that projection would have made a
 * genuine incompatibility invisible — tightening a `maximum` from 100 to 50
 * starts rejecting calls that used to succeed while the digest sat still — so
 * the preimage moved to the unprojected `entry.inputSchema`. Every stored digest
 * from v1 is therefore stale by construction, which is precisely what a version
 * bump is for.
 *
 * Lives here rather than beside the payload types in `shared/` on purpose: main
 * is the only process that stamps it, and keeping it out of the shared module
 * lets that module stay a type-only import from here, so its `zod` value import
 * never becomes an eager edge on the main-process boot path.
 */
export const MCP_SURFACE_MANIFEST_VERSION = 2;

/**
 * The tier to report for one tool, from the CALLER'S OWN ladder.
 *
 * `external` sessions get `"external"` unconditionally: that allowlist is a flat
 * curated peer of the in-app ladder, so `minimumPermittingTier` — which answers
 * "how far would an in-app session have to elevate" — would report a rung this
 * caller cannot climb, and would report nothing at all for a tool that is
 * external-only.
 *
 * In-app sessions get the real minimum. It is degenerate at `workbench` (where
 * everything reachable is workbench-tier by definition) and informative above
 * it, where it says which tools would survive a demotion.
 *
 * The `?? tier` fallback is unreachable today and safe if it ever is not:
 * reaching here means `shouldExposeTool` already returned true, so the id is in
 * `TIER_ALLOWLISTS[tier]` and `minimumPermittingTier` finds it at or below
 * `tier`. Were exposure ever widened past the static allowlists, `tier` would
 * still be a tier that genuinely permits the tool — an over-approximation of
 * the minimum, never a false claim that it is permitted at all.
 */
function resolveToolTier(entry: ActionManifestEntry, tier: McpTier): McpSurfaceTool["tier"] {
  if (tier === "external") return "external";
  return minimumPermittingTier(entry.id) ?? tier;
}

/**
 * Build the surface manifest for one session (#11549).
 *
 * Pure: the caller passes the manifest and the resolved tier, so this is
 * testable without a session, a server, or a renderer. Gated by the same
 * `shouldExposeTool` predicate the `tools/list` handler uses, against the same
 * manifest — that shared gate is what makes the two describe one surface rather
 * than two that happen to agree today.
 *
 * The reported set is tier plus the session's own binding, matching `tools/list`
 * exactly. Transient per-tool approvals are excluded: they widen dispatch for
 * minutes at a time and never appear in `tools/list`, so including them would
 * make `hash` flap on a timer and describe a surface no listing ever showed. A
 * workspace binding (#11789) is the opposite — fixed at handshake for the life
 * of the session — so it belongs in the report, and omitting it would have this
 * tool advertise a `recipe.run` the same session's `tools/list` withholds.
 */
export function buildSurfaceManifest(
  manifest: readonly ActionManifestEntry[],
  tier: McpTier,
  appVersion: string,
  session: SessionSurfacePolicy = UNBOUND_SESSION_SURFACE
): McpSurfaceManifest {
  const exposed = manifest.filter((entry) => shouldExposeTool(entry, tier, session));
  exposed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const tools: McpSurfaceTool[] = [];
  // Hashed rows are built alongside the reported ones, from the same values, so
  // a field can never be reported without being covered by the digest.
  const hashRows: unknown[] = [];

  for (const entry of exposed) {
    const annotations = buildAnnotations(entry);
    const tool: McpSurfaceTool = {
      id: entry.id,
      tier: resolveToolTier(entry, tier),
      kind: entry.kind,
      readOnlyHint: annotations.readOnlyHint ?? false,
      idempotentHint: annotations.idempotentHint ?? false,
      ...(entry.deprecated
        ? {
            deprecated: {
              reason: entry.deprecated.reason,
              ...(entry.deprecated.replacedBy ? { replacedBy: entry.deprecated.replacedBy } : {}),
            },
          }
        : {}),
    };
    tools.push(tool);

    // The digest covers more than the payload, because a client's compatibility
    // depends on more than the payload:
    //
    // - Argument and result schemas are what its own calls are built against,
    //   so a changed parameter is a genuine incompatibility. They stay on
    //   `tools/list` rather than bloating this response.
    // - `danger` and the two remaining annotations decide whether a call
    //   returns straight away or first blocks on a host confirmation dialog.
    //   A tool moving from `safe` to `confirm` changes the invocation contract
    //   completely while leaving every reported field identical (#11549 review).
    //
    // Descriptions are deliberately excluded, here and inside the schemas (see
    // `toCompatibilityShape`). They are model-facing prose that is reworded
    // often, and a compatibility check that cried drift on every wording edit
    // is one clients would learn to ignore.
    //
    // The INPUT schema is hashed unprojected — `entry.inputSchema`, not
    // `buildToolInputSchema(entry)`. Those differ: the wire view drops the
    // value-range keywords (`shared/utils/mcpWireSchema.ts`) because a model
    // cannot act on them, but a *client* very much can. Tightening a `maximum`
    // from 100 to 50 starts rejecting calls that used to succeed, which is
    // exactly the incompatibility this digest promises to report, so hashing the
    // projected view would let it pass silently. Compatibility is a property of
    // what the server accepts, not of what the model is shown.
    hashRows.push([
      tool.id,
      tool.tier,
      tool.kind,
      tool.readOnlyHint,
      tool.idempotentHint,
      tool.deprecated ?? null,
      entry.danger,
      annotations.destructiveHint ?? null,
      annotations.openWorldHint ?? null,
      toCompatibilityShape(entry.inputSchema ?? null),
      toCompatibilityShape(buildToolOutputSchema(entry) ?? null),
    ]);
  }

  // The tier is part of the preimage: two tiers of the same build advertise
  // different surfaces, and their hashes must say so even when one is a subset
  // of the other. `manifestVersion` and `appVersion` are not — the hash answers
  // "did the surface change", not "did the build change".
  const hash = createHash("sha256")
    .update(canonicalJson({ tier, tools: hashRows }))
    .digest("hex");

  return {
    manifestVersion: MCP_SURFACE_MANIFEST_VERSION,
    appVersion,
    tier,
    hash,
    tools,
  };
}
