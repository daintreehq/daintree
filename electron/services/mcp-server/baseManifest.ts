import type { ActionManifestEntry } from "../../../shared/types/actions.js";
import { MCP_EXTERNAL_BASE_MANIFEST } from "./generated/mcpExternalBaseManifest.js";

/**
 * The tool surface a workspace-bound external session is served when its
 * workspace has no single live view (#12082).
 *
 * Host-authoritative on purpose. The alternative — answering from
 * `getCachedManifest()` — describes whichever *other* window last reported one,
 * which is a cross-workspace isolation bug wearing a convenience's clothes: the
 * bound session would be told about a tool surface belonging to a workspace it
 * is specifically forbidden from routing to. This instead comes from a
 * generated artifact built from the real action registry at commit time, so it
 * is identical in every process, needs no live renderer, and cannot describe
 * anyone's view.
 *
 * Scoped to {@link MCP_EXTERNAL_TIER_TOOLS} rather than the whole built-in set,
 * because that is the entire reachable surface here: binding is refused for any
 * origin or tier but `external`, and a bound session can never be elevated
 * (`setSessionTier` and `issueGrant` are gated on renderer-owned origins). A
 * larger catalog would be filtered back down to the same list by
 * `shouldExposeTool` and only cost bytes.
 *
 * Discovery only. Nothing here authorizes a dispatch: the bound pre-dispatch
 * guard still requires a live workspace route, and the dispatch closure still
 * calls `dispatchActionForWorkspace`, so a viewless `tools/call` stays
 * fail-closed rather than borrowing the host's word for what the action is.
 */
export function getExternalBaseManifest(): ActionManifestEntry[] {
  // A shallow clone per call, guarding the one mutation that is plausible: a
  // caller reassigning a top-level field (`enabled`, `danger`) on an entry and
  // rewriting every later session's surface. Nested values — schemas, examples
  // — stay shared with the imported artifact, so a future consumer that mutates
  // a schema in place would still cross sessions; every current one treats them
  // as read-only, and deep-cloning the whole catalog on every `tools/list`
  // would be real work for a hazard nothing exercises.
  return MCP_EXTERNAL_BASE_MANIFEST.map((entry) => ({ ...entry }));
}
