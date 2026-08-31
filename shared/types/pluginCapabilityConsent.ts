import type { BuiltInPluginCapability, PluginScopeKey } from "./plugin.js";

/**
 * Just-in-time (JIT) capability consent for plugin host-API surfaces (#10524).
 *
 * Distinct from the per-tool plugin-MCP TOFU machinery (`pluginMcpConsent.ts`):
 * that gates each `(pluginId, serverId, toolName)` MCP `tools/call` on a
 * fingerprint of the advertised tool surface. This gates the FIRST runtime use
 * of a high-risk host capability — `shell:exec`, `fs:*-write`, `git:write` —
 * on a single `(scopeKey, pluginId, capability)` grant. A plugin declares the capability
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
 * store by the JSON-encoded `[scopeKey, pluginId, capability]` triple (see
 * `PluginCapabilityConsentStore.makeKey`) — JSON-encoded, never `::`-joined, so
 * a pluginId containing the separator cannot collide with another plugin's
 * grant (pluginIds are author-controlled in the manifest).
 *
 * The scope is part of the identity so the same plugin id, loaded from a
 * project rather than app-wide, cannot inherit a grant the user made elsewhere.
 */
export interface PluginCapabilityIdentity {
  /** Contributing plugin id (`manifest.name`). */
  pluginId: string;
  /** The high-risk capability being gated. */
  capability: BuiltInPluginCapability;
  /**
   * Scope the grant belongs to. Omitted means `"global"` — the app-wide scope
   * every installed and builtin plugin loads into.
   */
  scopeKey?: PluginScopeKey;
}

/**
 * Persisted grant record. Minted on `approved-and-pin`. No fingerprint — the
 * grant is for the capability, which is a static manifest declaration.
 */
export interface PluginCapabilityConsentRecord {
  pluginId: string;
  capability: BuiltInPluginCapability;
  /**
   * Scope the grant was minted in. Records written before the key widened have
   * no `scopeKey` on disk and read back as `"global"`.
   */
  scopeKey: PluginScopeKey;
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
 *
 * Every member of this union describes something that happened *in the dialog*.
 * A prompt that never reached a renderer at all is not a decision — see
 * {@link PluginCapabilityConsentOutcome}.
 */
export type PluginCapabilityConsentDecision =
  "approved-once" | "approved-and-pin" | "rejected" | "timeout";

/**
 * What the main-process consent bridge resolves with — every
 * {@link PluginCapabilityConsentDecision} plus `undeliverable`, which covers
 * every way a prompt can fail to *reach and stay in front of* a user (#11708):
 * no window to host it, no receipt acknowledgement within
 * {@link PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS}, the push threw, the
 * handler was torn down, or the renderer holding it was destroyed — before or
 * after acknowledging. The last case did display a dialog, but it vanished
 * unanswered, so it is grouped here rather than with the decisions.
 *
 * The split exists because `webContents.send()` to a document with no listener
 * is a silent no-op — nothing throws and nothing logs — so before #11708 an
 * undeliverable prompt was indistinguishable from a user who sat on the dialog
 * for five minutes, and both surfaced to the plugin as "was denied". The
 * renderer never produces this value; it is minted only by the bridge.
 *
 * All outcomes still fail closed: the gated host call throws
 * `PERMISSION_REQUIRED:` regardless. Only the wording and the timing differ.
 */
export type PluginCapabilityConsentOutcome = PluginCapabilityConsentDecision | "undeliverable";

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
 *
 * Main and the renderer arm this independently and from slightly different
 * origins: the renderer at enqueue, main once delivery is acknowledged. The
 * renderer therefore expires first, by however long delivery took (bounded by
 * {@link PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS}), and its `"timeout"`
 * reply settles main's copy. That ordering is deliberate — a decision reply
 * beats a main-side guess — and the skew is immaterial against five minutes.
 */
export const PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long the bridge waits for a renderer to acknowledge receipt of a pushed
 * consent prompt before settling it `undeliverable` (#11708).
 *
 * This is a *delivery* bound, not a decision bound: it only has to cover the
 * gap between the push and the consent hook's `useEffect` running in the target
 * renderer. It is generous enough to absorb a cold project switch, whose React
 * boot `ProjectViewSwitchController` documents at ~1.5-4s, plus slack for the
 * Efficiency resource profile — and the bridge re-pushes every
 * {@link PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS} within the window, so a
 * renderer that mounts late still gets the prompt rather than losing it.
 *
 * Once a receipt lands, {@link PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS} takes over
 * and the user gets the full five minutes to decide.
 */
export const PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS = 10 * 1000;

/**
 * How often the bridge re-pushes an unacknowledged consent prompt to the same
 * target renderer, until either a receipt arrives or
 * {@link PLUGIN_CAPABILITY_CONSENT_DELIVERY_TIMEOUT_MS} elapses (#11708).
 *
 * The target is resolved once and never re-resolved, so re-pushes cannot drift
 * to a different window or invalidate the response sender pin. The renderer
 * de-duplicates by `requestId` and simply re-acknowledges a prompt it already
 * holds, so a re-push that races a receipt is a no-op rather than a second
 * dialog.
 */
export const PLUGIN_CAPABILITY_CONSENT_RESEND_INTERVAL_MS = 2 * 1000;

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

/**
 * Renderer → main receipt for a `plugin-capability:consent-request` push
 * (#11708). Sent as soon as the prompt is enqueued into the dialog FIFO, well
 * before the user decides — it answers "did this reach a renderer that can show
 * it", which a bare `webContents.send()` cannot, since a push into a document
 * with no listener neither throws nor logs.
 *
 * Until this arrives the bridge treats the prompt as undelivered and re-pushes;
 * after it arrives the five-minute decision clock starts. Acknowledgements are
 * sender-pinned exactly like the decision reply, so a sibling window cannot
 * acknowledge another window's prompt.
 */
export interface PluginCapabilityAcknowledgeConsentInput {
  requestId: string;
}

/** Renderer → main reply to a `plugin-capability:consent-request` push. */
export interface PluginCapabilityResolveConsentInput {
  requestId: string;
  decision: PluginCapabilityConsentDecision;
}
