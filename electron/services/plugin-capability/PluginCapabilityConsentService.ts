import type { BuiltInPluginCapability } from "../../../shared/types/plugin.js";
import type { PluginCapabilityConsentOutcome } from "../../../shared/types/pluginCapabilityConsent.js";
import type { PluginCapabilityConsentStore } from "./PluginCapabilityConsentStore.js";

/** Prefix on the thrown error so `useHostChannel` discriminates a denial. */
export const PLUGIN_CAPABILITY_DENIED_PREFIX = "PERMISSION_REQUIRED";

/**
 * Display-safe payload handed to the consent UI bridge when a first-use prompt
 * is required. Every field is renderer-safe.
 */
export interface PluginCapabilityConsentRequest {
  pluginId: string;
  /** Human-readable plugin display name (manifest `displayName ?? name`). */
  pluginDisplayName: string;
  capability: BuiltInPluginCapability;
  /** Plugin's manifest `capabilities[]` list — surfaced for transparency. */
  declaredCapabilities: readonly BuiltInPluginCapability[];
}

/** Bridge that owns the consent UI surface (renderer dialog). */
export type PluginCapabilityConsentBridge = (
  request: PluginCapabilityConsentRequest
) => Promise<PluginCapabilityConsentOutcome>;

/**
 * Orchestrates just-in-time consent for a single plugin host capability
 * (#10524). The first time a plugin exercises a gated capability
 * (`shell:exec`, `fs:*-write`, `git:write`) the service raises a prompt via the
 * injected bridge and, on `approved-and-pin`, persists the grant so later calls
 * run silently. A granted capability short-circuits without a prompt.
 *
 * Wiring: `PluginService` calls `ensureAllowed()` at the top of each gated host
 * API closure (after the static `manifest.capabilities` check passes) and only
 * proceeds when it resolves; on denial it rejects, and the closure surfaces the
 * `PERMISSION_REQUIRED:` error to the plugin.
 *
 * Concurrent first-use calls for the same `(pluginId, capability)` are coalesced
 * onto a single in-flight prompt — a plugin firing several `host.process.spawn`
 * calls at once raises one dialog, not a stack of duplicates.
 */
export class PluginCapabilityConsentService {
  private bridge: PluginCapabilityConsentBridge | null = null;
  private readonly inFlight = new Map<string, Promise<PluginCapabilityConsentDecision>>();

  constructor(private readonly consentStore: PluginCapabilityConsentStore) {}

  /**
   * Inject the UI consent bridge. A null bridge causes the service to deny any
   * call that needs a prompt (already-granted capabilities still pass) — the
   * fail-closed default, so a capability never runs unprompted just because the
   * renderer isn't ready to host the dialog yet.
   */
  setConsentBridge(bridge: PluginCapabilityConsentBridge | null): void {
    this.bridge = bridge;
  }

  /** Whether a UI bridge is currently installed (test/diagnostic introspection). */
  hasBridge(): boolean {
    return this.bridge !== null;
  }

  /**
   * Purge every grant for a plugin. Delegated to the store (which is private to
   * this service) so uninstall callers go through the service. Returns whether
   * the purge was durably persisted so the caller can retry or escalate.
   */
  revokeAllForPlugin(pluginId: string): boolean {
    return this.consentStore.revokeAllForPlugin(pluginId);
  }

  /**
   * Gate a gated host capability call. Resolves silently when the capability is
   * already granted or the user approves; throws a `PERMISSION_REQUIRED:` error
   * otherwise.
   *
   * Every failure path fails closed, but they no longer speak with one voice
   * (#11708). Only an actual refusal says the plugin "was denied": a prompt that
   * expired unanswered says it timed out, and a prompt that never reached a
   * renderer says Daintree could not present it. Reporting an undelivered prompt
   * as a denial was the misleading half of the original bug — it sent plugin
   * authors looking for a user who had refused, and a manifest problem that
   * didn't exist.
   */
  async ensureAllowed(
    pluginId: string,
    pluginDisplayName: string,
    capability: BuiltInPluginCapability,
    declaredCapabilities: readonly BuiltInPluginCapability[]
  ): Promise<void> {
    if (this.consentStore.hasGrant({ pluginId, capability })) return;

    const outcome = await this.requestOutcome(
      pluginId,
      pluginDisplayName,
      capability,
      declaredCapabilities
    );

    if (outcome === "approved-and-pin") {
      this.consentStore.grant({ pluginId, capability });
      return;
    }
    if (outcome === "approved-once") return;

    if (outcome === "undeliverable") {
      // The prompt never reached a renderer that could show it. Logged at error
      // level, not warn: unlike an abandoned dialog this is a Daintree-side
      // delivery failure, not a user behaviour (#11708).
      console.error(
        `[PluginCapabilityConsentService] could not present the consent prompt for plugin "${pluginId}" capability "${capability}" — no renderer acknowledged it`
      );
      throw new Error(
        `${PLUGIN_CAPABILITY_DENIED_PREFIX}: Daintree could not present the "${capability}" capability consent prompt for plugin "${pluginId}"`
      );
    }

    if (outcome === "timeout") {
      // Fail closed exactly like "rejected", but log distinctly so an abandoned
      // dialog is diagnosable in the operator logs rather than reading as a
      // deliberate refusal (#10841).
      console.warn(
        `[PluginCapabilityConsentService] consent prompt timed out for plugin "${pluginId}" capability "${capability}"`
      );
      throw new Error(
        `${PLUGIN_CAPABILITY_DENIED_PREFIX}: the "${capability}" capability consent prompt for plugin "${pluginId}" timed out`
      );
    }

    throw new Error(
      `${PLUGIN_CAPABILITY_DENIED_PREFIX}: plugin "${pluginId}" was denied use of the "${capability}" capability`
    );
  }

  /**
   * Resolve the outcome for a `(pluginId, capability)`, coalescing concurrent
   * first-use requests onto one in-flight prompt. Re-checks the grant store
   * after awaiting a coalesced prompt so a sibling call that just got
   * `approved-and-pin` lets the rest through without a second decision.
   *
   * Both non-decision paths — no bridge installed, and a bridge that throws —
   * are delivery failures rather than refusals, so they resolve `undeliverable`
   * (#11708). The fail-closed guarantee is unchanged; only the reported reason
   * differs.
   */
  private requestOutcome(
    pluginId: string,
    pluginDisplayName: string,
    capability: BuiltInPluginCapability,
    declaredCapabilities: readonly BuiltInPluginCapability[]
  ): Promise<PluginCapabilityConsentOutcome> {
    if (this.bridge === null) {
      // Fail closed — no UI to approve through.
      return Promise.resolve("undeliverable");
    }
    const key = JSON.stringify([pluginId, capability]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const bridge = this.bridge;
    const promise = bridge({ pluginId, pluginDisplayName, capability, declaredCapabilities })
      .catch((err) => {
        console.error("[PluginCapabilityConsentService] Consent bridge threw:", err);
        return "undeliverable" as PluginCapabilityConsentOutcome;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  _resetForTest(): void {
    this.bridge = null;
    this.inFlight.clear();
  }
}
