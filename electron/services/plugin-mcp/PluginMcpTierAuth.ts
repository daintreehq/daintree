import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { PluginCapability } from "../../../shared/types/plugin.js";
import type { PluginMcpDangerTier } from "../../../shared/types/pluginMcpConsent.js";
import { CONFIRM_TRIGGERING_CAPABILITIES } from "../../../shared/config/pluginCapabilities.js";

/**
 * Capability cap on the host-derived danger tier. The cap classifies what a
 * plugin's manifest entitles its MCP server's tool surface to *reach* — a
 * plugin that did not declare a high-risk capability cannot have its server
 * trigger a D2 confirmation just because the tool advertised
 * `destructiveHint: true`. The call is *denied* in that case, not silently
 * downgraded — a downgrade would let the model pretend its mutation was
 * read-only and bypass the audit narrative.
 *
 * The cap mirrors the existing `BUILT_IN_PLUGIN_CAPABILITIES` split: anything
 * that can change files / git state / processes is high-risk and entitles the
 * server to reach D2. Read-only and network-fetch capabilities cap at D1 — the
 * server can still ask for a confirmation, but cannot reach the "shared-state
 * mutation" tier.
 *
 * The high-risk set is `CONFIRM_TRIGGERING_CAPABILITIES` from
 * `shared/config/pluginCapabilities.ts` — the single source of truth shared with
 * `PluginService`'s action-danger model, so the MCP tier cap and the action
 * elevation can never drift apart.
 */
export type PluginMcpTierClassification =
  | { kind: "tier"; tier: PluginMcpDangerTier }
  | {
      kind: "deny";
      reason: "capability-cap-exceeded";
      observedFloor: PluginMcpDangerTier;
      cap: PluginMcpDangerTier;
    };

const TIER_ORDER: Readonly<Record<PluginMcpDangerTier, number>> = {
  D0: 0,
  D1: 1,
  D2: 2,
  D3: 3,
};

/**
 * Derive a {@link PluginMcpDangerTier} from the tool's MCP annotations and
 * cap it against what the plugin's declared `manifest.capabilities` entitle.
 *
 * Annotation → floor mapping:
 * - `readOnlyHint: true` → D0
 * - `destructiveHint: false` (or absent) → D1
 * - `destructiveHint: true` → D2
 * - `openWorldHint: true` raises the floor by one tier (clamped at D3) —
 *   network-side effects are unobservable and asymmetric, so the host treats
 *   them as a tier escalation.
 *
 * The annotations are advisory hints from the server (which the host does not
 * trust); the cap is authoritative. Returns `kind: "deny"` when the floor
 * exceeds the cap so the dispatch chain can refuse the call before showing
 * any consent UI.
 */
export function deriveDangerTier(
  annotations: ToolAnnotations | undefined,
  manifestCapabilities: readonly PluginCapability[] | undefined
): PluginMcpTierClassification {
  const floor = deriveAnnotationFloor(annotations);
  const cap = deriveCapabilityCap(manifestCapabilities ?? []);
  if (TIER_ORDER[floor] > TIER_ORDER[cap]) {
    return { kind: "deny", reason: "capability-cap-exceeded", observedFloor: floor, cap };
  }
  return { kind: "tier", tier: floor };
}

function deriveAnnotationFloor(annotations: ToolAnnotations | undefined): PluginMcpDangerTier {
  if (annotations?.readOnlyHint === true) {
    return raiseForOpenWorld("D0", annotations.openWorldHint);
  }
  if (annotations?.destructiveHint === true) {
    return raiseForOpenWorld("D2", annotations.openWorldHint);
  }
  return raiseForOpenWorld("D1", annotations?.openWorldHint);
}

function raiseForOpenWorld(
  base: PluginMcpDangerTier,
  openWorldHint: boolean | undefined
): PluginMcpDangerTier {
  if (openWorldHint !== true) return base;
  const next = TIER_ORDER[base] + 1;
  if (next >= TIER_ORDER.D3) return "D3";
  if (next >= TIER_ORDER.D2) return "D2";
  if (next >= TIER_ORDER.D1) return "D1";
  return "D0";
}

function deriveCapabilityCap(capabilities: readonly PluginCapability[]): PluginMcpDangerTier {
  for (const cap of capabilities) {
    if (CONFIRM_TRIGGERING_CAPABILITIES.has(cap)) return "D2";
  }
  return "D1";
}
