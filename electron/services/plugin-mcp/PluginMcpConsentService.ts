import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { PluginCapability } from "../../../shared/types/plugin.js";
import type {
  PluginMcpConsentDecision,
  PluginMcpConsentReason,
  PluginMcpDangerTier,
  PluginMcpToolFingerprint,
  PluginMcpToolIdentity,
} from "../../../shared/types/pluginMcpConsent.js";
import {
  PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED_CODE,
  PLUGIN_MCP_CONSENT_TIMEOUT_CODE,
  PLUGIN_MCP_USER_REJECTED_CODE,
} from "../../../shared/types/ipc/pluginMcpAudit.js";
import { sha256Hex, stableArgsSha256 } from "../../utils/pluginMcpHash.js";
import { stripAnsiAndOscCodes } from "../../../shared/utils/urlUtils.js";
import { summarizeMcpArgs } from "../../../shared/utils/mcpArgsSummary.js";
import { deriveDangerTier } from "./PluginMcpTierAuth.js";
import type { PluginMcpConsentStore } from "./PluginMcpConsentStore.js";

/** Stable code recorded when the consent bridge is missing — typically a startup race. */
export const PLUGIN_MCP_NO_CONSENT_BRIDGE_CODE = "PLUGIN_MCP_NO_CONSENT_BRIDGE";

/**
 * Payload presented to the consent UI bridge when a prompt is required. All
 * fields are display-safe: `descriptionDisplay` has been stripped of ANSI and
 * OSC escape sequences and is intended to render as a plain React text node.
 * The raw description is *never* exposed to the renderer — it is hashed and
 * discarded server-side.
 */
export interface PluginMcpConsentRequest {
  identity: PluginMcpToolIdentity;
  /** Human-readable plugin display name (manifest `displayName ?? name`). */
  pluginDisplayName: string;
  /** Tool description, ANSI/OSC stripped, ready to render verbatim. */
  descriptionDisplay: string;
  /**
   * Sanitised, single-level args preview. Empty for D0 and for a call with no
   * arguments; produced for every other tier — D1 included, which the consent
   * dialog renders behind a disclosure.
   */
  argsSummary: string;
  dangerTier: PluginMcpDangerTier;
  /** Plugin's manifest `capabilities[]` list — surfaced for transparency. */
  declaredCapabilities: readonly PluginCapability[];
  reason: PluginMcpConsentReason;
}

/** Bridge that owns the consent UI surface (renderer dialog). */
export type PluginMcpConsentBridge = (
  request: PluginMcpConsentRequest
) => Promise<PluginMcpConsentDecision>;

/** Outcome of {@link PluginMcpConsentService.authorizeToolCall}. */
export type PluginMcpAuthorizeOutcome =
  | {
      kind: "approved";
      dangerTier: PluginMcpDangerTier;
      consentReason?: PluginMcpConsentReason;
      consentDecision?: PluginMcpConsentDecision;
    }
  | {
      kind: "denied";
      dangerTier: PluginMcpDangerTier;
      errorCode: string;
      consentReason?: PluginMcpConsentReason;
      consentDecision?: PluginMcpConsentDecision;
    };

/**
 * Input to {@link PluginMcpConsentService.authorizeToolCall}. The plugin-MCP
 * supervisor (#9233, not yet merged) builds this from the raw `tools/call`
 * request and the cached `tools/list` entry for the named tool.
 */
export interface PluginMcpAuthorizeInput {
  identity: PluginMcpToolIdentity;
  pluginDisplayName: string;
  /** Raw description bytes from `tools/list`. */
  descriptionRaw: string;
  /** Raw `inputSchema` object from `tools/list`. */
  inputSchema: unknown;
  annotations: ToolAnnotations | undefined;
  /** Plugin's manifest `capabilities[]`. */
  manifestCapabilities: readonly PluginCapability[];
  /** Call arguments as the model sent them. */
  rawArgs: unknown;
}

/**
 * Orchestrates the consent pipeline for a single plugin-MCP `tools/call`.
 * Computes the danger tier, fingerprints the tool, consults the TOFU pin
 * store, raises a consent prompt via the injected bridge when required, and
 * pins on `approved-and-pin`.
 *
 * This service does NOT write audit records. The audit row binds the consent
 * outcome to the dispatch outcome (success / error) and so must be written by
 * the supervisor (#9233) after `client.callTool()` resolves. The
 * authorization outcome is structured so the supervisor can forward every
 * relevant field straight into `PluginMcpAuditService.append()`.
 *
 * Wiring: the plugin-MCP supervisor calls `authorizeToolCall()` immediately
 * before invoking `client.callTool()` and forwards the call only on
 * `kind: "approved"`. On `kind: "denied"` the supervisor returns the
 * configured error code to the server.
 */
export class PluginMcpConsentService {
  private bridge: PluginMcpConsentBridge | null = null;

  constructor(private readonly consentStore: PluginMcpConsentStore) {}

  /**
   * Inject the UI consent bridge. Called by the renderer registration handler
   * once the renderer is ready to host the consent dialog. A null bridge
   * causes the service to deny any call that requires a prompt (D0 + already-
   * pinned approvals still succeed) — the supervisor is expected to wait for
   * the bridge before dispatching plugin-MCP traffic that may prompt.
   */
  setConsentBridge(bridge: PluginMcpConsentBridge | null): void {
    this.bridge = bridge;
  }

  /**
   * Purge every consent pin for a plugin. Delegated to the pin store (which is
   * private to this service) so uninstall callers go through the service rather
   * than reaching into the store directly. Used on uninstall so a reinstall
   * re-prompts instead of inheriting stale TOFU approvals.
   *
   * Returns whether the purge was durably persisted, so the uninstall caller can
   * retry or escalate rather than silently leave stale pins that rehydrate on
   * the next launch.
   */
  revokeAllForPlugin(pluginId: string): boolean {
    return this.consentStore.revokeAllForPlugin(pluginId);
  }

  async authorizeToolCall(input: PluginMcpAuthorizeInput): Promise<PluginMcpAuthorizeOutcome> {
    const tierResult = deriveDangerTier(input.annotations, input.manifestCapabilities);
    if (tierResult.kind === "deny") {
      return {
        kind: "denied",
        dangerTier: tierResult.observedFloor,
        errorCode: PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED_CODE,
      };
    }

    const dangerTier = tierResult.tier;
    const fingerprint = fingerprintTool(input.descriptionRaw, input.inputSchema, input.annotations);
    const lookup = this.consentStore.lookup(input.identity, fingerprint);

    // D0 with a pinned (matching) approval auto-approves; otherwise the user
    // sees a first-use prompt even for read-only tools, on the principle that
    // the user must consent to *any* plugin-MCP tool before its first call.
    if (lookup.kind === "approved") {
      return { kind: "approved", dangerTier };
    }

    const reason = lookupToReason(lookup.kind);

    if (this.bridge === null) {
      return {
        kind: "denied",
        dangerTier,
        errorCode: PLUGIN_MCP_NO_CONSENT_BRIDGE_CODE,
        consentReason: reason,
      };
    }

    const argsSummary =
      dangerTier === "D0" || input.rawArgs === undefined || input.rawArgs === null
        ? ""
        : summarizeMcpArgs(input.rawArgs, stripAnsiAndOscCodes);

    const request: PluginMcpConsentRequest = {
      identity: input.identity,
      pluginDisplayName: input.pluginDisplayName,
      descriptionDisplay: stripAnsiAndOscCodes(input.descriptionRaw),
      argsSummary,
      dangerTier,
      declaredCapabilities: input.manifestCapabilities,
      reason,
    };

    let decision: PluginMcpConsentDecision;
    try {
      decision = await this.bridge(request);
    } catch (err) {
      console.error("[PluginMcpConsentService] Consent bridge threw:", err);
      decision = "rejected";
    }

    if (decision === "approved-and-pin") {
      this.consentStore.pin(input.identity, fingerprint);
      return { kind: "approved", dangerTier, consentReason: reason, consentDecision: decision };
    }
    if (decision === "approved-once") {
      return { kind: "approved", dangerTier, consentReason: reason, consentDecision: decision };
    }
    if (decision === "timeout") {
      return {
        kind: "denied",
        dangerTier,
        errorCode: PLUGIN_MCP_CONSENT_TIMEOUT_CODE,
        consentReason: reason,
        consentDecision: decision,
      };
    }
    return {
      kind: "denied",
      dangerTier,
      errorCode: PLUGIN_MCP_USER_REJECTED_CODE,
      consentReason: reason,
      consentDecision: decision,
    };
  }
}

/**
 * Compute the four-component fingerprint used by the TOFU pin store. The
 * `rawHash` is over the raw description bytes (NOT stripped) so a rug-pull
 * payload hidden in invisible Unicode still flips the pin. The `displayHash`
 * is over the stripped string for diagnostics. The `schemaHash` is over the
 * input-schema JSON with keys sorted at every depth so a stable schema does
 * not produce different fingerprints in different runs. The `annotationHash`
 * is over the three tier-influencing `ToolAnnotations` hints so a server that
 * flips `readOnlyHint` → `destructiveHint` (raising the danger tier without
 * touching the description or schema) still re-prompts. Only those three
 * fields are hashed — future SDK annotation fields must not re-prompt.
 */
export function fingerprintTool(
  descriptionRaw: string,
  inputSchema: unknown,
  annotations: ToolAnnotations | undefined
): PluginMcpToolFingerprint {
  const displayHash = sha256Hex(stripAnsiAndOscCodes(descriptionRaw));
  // Match the audit service's null-schema sentinel (sha256Hex("")) so an
  // operator correlating a consent pin's schemaHash against an audit row's
  // input_schema_sha for a no-schema tool sees the same value.
  const schemaHash =
    inputSchema === null || inputSchema === undefined
      ? sha256Hex("")
      : stableArgsSha256(inputSchema);
  return {
    rawHash: sha256Hex(descriptionRaw),
    displayHash,
    schemaHash,
    annotationHash: hashAnnotations(annotations),
  };
}

/**
 * Hash the three tier-influencing annotation hints, null-normalised and
 * emitted in a fixed key order so an absent hint and an explicit `undefined`
 * hash identically and key ordering can't perturb the digest. Confining the
 * input to these three fields keeps the fingerprint stable when the MCP SDK
 * adds new (non-tier) annotation fields.
 */
function hashAnnotations(annotations: ToolAnnotations | undefined): string {
  return sha256Hex(
    JSON.stringify({
      d: annotations?.destructiveHint ?? null,
      o: annotations?.openWorldHint ?? null,
      r: annotations?.readOnlyHint ?? null,
    })
  );
}

function lookupToReason(
  kind: "first-use" | "raw-changed" | "schema-changed" | "annotation-changed" | "revoked"
): PluginMcpConsentReason {
  return kind;
}
