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
  // Cloned per call: this array is process-global and a session that mutated a
  // shared entry would rewrite every later session's surface. One level of
  // spread is enough — no consumer reaches into the schema objects, and a deep
  // clone of 27 JSON schemas on every `tools/list` is real work for a hazard
  // nothing exercises.
  return MCP_EXTERNAL_BASE_MANIFEST.map((entry) => ({ ...entry }));
}
