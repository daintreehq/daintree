import { createHash } from "node:crypto";
import type { ActionManifestEntry } from "../../../shared/types/actions.js";
import type { McpSurfaceManifest, McpSurfaceTool } from "../../../shared/types/mcpSurface.js";
import { type McpTier, minimumPermittingTier } from "./shared.js";
import {
  buildAnnotations,
  buildToolInputSchema,
  buildToolOutputSchema,
  shouldExposeTool,
} from "./tierAuth.js";

export const MCP_SURFACE_TOOL_ID = "mcp.surface";

/**
 * Shape version of the `mcp.surface` payload. Bump when a field is added,
 * removed, or given new meaning — never for a change in which tools the surface
 * contains, which is what `hash` is for.
 *
 * Lives here rather than beside the payload types in `shared/` on purpose: main
 * is the only process that stamps it, and keeping it out of the shared module
 * lets that module stay a type-only import from here, so its `zod` value import
 * never becomes an eager edge on the main-process boot path.
 */
export const MCP_SURFACE_MANIFEST_VERSION = 1;

/**
 * Recursively key-sorted JSON, so the hash preimage depends on the surface's
 * content rather than on the order a JSON Schema generator happened to emit
 * object keys in. Arrays keep their order — a reordered `enum` or `required`
 * list is a real schema change.
 *
 * Deliberately a local copy rather than a reuse of `sessionDedup`'s
 * `canonicalArgsHash`: this canonical form is part of a published client
 * contract, and it must not shift because the unrelated per-call dedup key
 * changed shape.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = record[key];
      }
      return sorted;
    }
    return v;
  });
}

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
 * it, where it says which tools would survive a demotion. The `?? tier` fallback
 * covers a tool permitted by no static allowlist, which reports the tier that
 * actually surfaced it rather than inventing a rung.
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
 * The reported set is tier-only. Transient per-tool approvals widen dispatch for
 * minutes at a time and never appear in `tools/list`; including them would make
 * `hash` flap on a timer and describe a surface no listing ever showed.
 */
export function buildSurfaceManifest(
  manifest: readonly ActionManifestEntry[],
  tier: McpTier,
  appVersion: string
): McpSurfaceManifest {
  const exposed = manifest.filter((entry) => shouldExposeTool(entry, tier));
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

    // The digest covers more than the payload: argument and result schemas are
    // what a client's own calls are built against, so a changed parameter is a
    // genuine incompatibility even though the schemas themselves stay on
    // `tools/list` rather than bloating this response.
    //
    // Descriptions are deliberately excluded. They are model-facing prose that
    // is reworded often, and a compatibility check that cried drift on every
    // wording edit is one clients would learn to ignore.
    hashRows.push([
      tool.id,
      tool.tier,
      tool.kind,
      tool.readOnlyHint,
      tool.idempotentHint,
      tool.deprecated ?? null,
      buildToolInputSchema(entry),
      buildToolOutputSchema(entry) ?? null,
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
