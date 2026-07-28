import type { BuiltInPluginCapability } from "./plugin.js";

/**
 * Just-in-time (JIT) capability consent for plugin host-API surfaces (#10524).
 *
 * Distinct from the per-tool plugin-MCP TOFU machinery (`pluginMcpConsent.ts`):
 * that gates each `(pluginId, serverId, toolName)` MCP `tools/call` on a
 * fingerprint of the advertised tool surface. This gates the FIRST runtime use
 * of a high-risk host capability — `shell:exec`, `fs:*-write`, `git:write` —
 * on a single `(pluginId, capability)` grant. A plugin declares the capability
 * in its manifest (static gate), but the user is no longer asked to consent at
 * install/activation time; instead the consent prompt is deferred to the first
 * call into that capability and the grant is cached so later calls run silently.
 *
 * The grant is coarse and stable: one `shell:exec` consent covers every
 * `host.process.spawn` the plugin makes for its lifetime, not one per spawn.
 * There is no fingerprint and no rug-pull re-prompt — capabilities are static
 * manifest declarations, so a grant only resets when the plugin is uninstalled
 * (`revokeAllForPlugin`) or the user explicitly revokes it.
 */

/**
 * Stable pin-store identity for a single plugin capability grant. Keyed in the
 * store by the JSON-encoded `[pluginId, capability]` pair (see
 * `PluginCapabilityConsentStore.makeKey`) — JSON-encoded, never `::`-joined, so
 * a pluginId containing the separator cannot collide with another plugin's
 * grant (pluginIds are author-controlled in the manifest).
 */
export interface PluginCapabilityIdentity {
  /** Contributing plugin id (`manifest.name`). */
  pluginId: string;
  /** The high-risk capability being gated. */
  capability: BuiltInPluginCapability;
}

/**
 * Persisted grant record. Minted on `approved-and-pin`. No fingerprint — the
 * grant is for the capability, which is a static manifest declaration.
 */
export interface PluginCapabilityConsentRecord {
  pluginId: string;
  capability: BuiltInPluginCapability;
  /** Wall-clock epoch millis the grant was minted. */
  approvedAt: number;
}

/**
 * User decision returned by the consent dialog. `rejected` aborts the gated
 * host call (the closure throws a `PERMISSION_REQUIRED:` error); `approved-once`
 * runs the call without persisting; `approved-and-pin` runs it and writes the
 * grant so future calls skip the prompt. `timeout` is settled by the consent
 * bridge when an abandoned prompt outlives
 * {@link PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS}; it fails closed exactly like
 * `rejected` (the gated call still throws `PERMISSION_REQUIRED:`) but is
 * distinguished for diagnostics so a walked-away dialog reads differently from a
 * deliberate refusal in the logs.
 */
export type PluginCapabilityConsentDecision =
  "approved-once" | "approved-and-pin" | "rejected" | "timeout";

/**
 * How long a pushed plugin-capability consent prompt may stay unanswered before
 * the bridge settles it as `"timeout"` and frees the pending entry. Mirrors the
 * plugin-MCP timeout: a five-minute safety net for an abandoned dialog so the
 * gating promise (and the renderer dialog) never hangs forever. Both the
 * main-process bridge and the renderer confirm store arm an independent timer at
 * this duration.
 *
 * As with the MCP timeout, the clock starts when the prompt is raised, not when
 * the dialog becomes visible — a queued prompt shares this window rather than
 * getting its own per-display clock. The timeout is an abandonment backstop, and
 * the rare queued-then-expired case fails closed (denied), the safe direction.
 */
export const PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Display-safe consent prompt pushed from main to the renderer over the typed
 * event bus (`plugin-capability:consent-request`) when a plugin first exercises
 * a gated capability. Unlike the MCP consent payload there is no args preview or
 * danger tier — the capability itself names the risk. The renderer enqueues it
 * into the consent dialog FIFO and replies via `plugin-capability:resolve-consent`,
 * correlated by `requestId`.
 */
export interface PluginCapabilityConsentRequestEvent {
  /** Correlation id for the matching `plugin-capability:resolve-consent` reply. */
  requestId: string;
  pluginId: string;
  /** Human-readable plugin display name (manifest `displayName ?? name`). */
  pluginDisplayName: string;
  /** The capability the plugin is asking to use for the first time. */
  capability: BuiltInPluginCapability;
  /** Plugin's manifest `capabilities[]` list — surfaced for transparency. */
  declaredCapabilities: readonly BuiltInPluginCapability[];
}

/** Renderer → main reply to a `plugin-capability:consent-request` push. */
export interface PluginCapabilityResolveConsentInput {
  requestId: string;
  decision: PluginCapabilityConsentDecision;
}
