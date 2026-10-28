import type { BuiltInPluginCapability, PluginScopeKey } from "../../../shared/types/plugin.js";
import {
  EXTERNAL_LINK_CONSENT,
  type PluginCapabilityConsentOutcome,
  type PluginCapabilityIdentity,
  type PluginRestorableGrant,
  type PluginConsentSubject,
} from "../../../shared/types/pluginCapabilityConsent.js";
import type { PluginCapabilityConsentStore } from "./PluginCapabilityConsentStore.js";

/** Prefix on the thrown error so a plugin view can recognise a denial. */
export const PLUGIN_CAPABILITY_DENIED_PREFIX = "PERMISSION_REQUIRED";

/**
 * Display-safe payload handed to the consent UI bridge when a first-use prompt
 * is required. Every field is renderer-safe.
 */
export interface PluginCapabilityFirstUseRequest {
  pluginId: string;
  /** Human-readable plugin display name (manifest `displayName ?? name`). */
  pluginDisplayName: string;
  capability: PluginConsentSubject;
  /** Hostname the plugin wants to open links to; set only for {@link EXTERNAL_LINK_CONSENT}. */
  site?: string;
  /** Plugin's manifest `capabilities[]` list — surfaced for transparency. */
  declaredCapabilities: readonly BuiltInPluginCapability[];
  restore?: undefined;
}

/** The one-approval offer-back after a replacing install (#14019). */
export interface PluginCapabilityRestoreRequest {
  pluginId: string;
  pluginDisplayName: string;
  /** Never empty. */
  restore: readonly PluginRestorableGrant[];
  declaredCapabilities: readonly BuiltInPluginCapability[];
  capability?: undefined;
  site?: undefined;
}

export type PluginCapabilityConsentRequest =
  PluginCapabilityFirstUseRequest | PluginCapabilityRestoreRequest;

/** What a replacing install hands back to {@link PluginCapabilityConsentService.offerRestore}. */
export interface PluginCapabilityRestoreOffer {
  pluginId: string;
  pluginDisplayName: string;
  /** The grants to put back on approval, scopes included. A site grant is never offered. */
  grants: readonly PluginCapabilityIdentity[];
  declaredCapabilities: readonly BuiltInPluginCapability[];
  /**
   * Whether the version this offer was made for is still the one installed,
   * asked again once the user answers.
   */
  isCurrent: () => boolean;
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
 * Concurrent first-use calls for the same `(scopeKey, pluginId, capability)`
 * are coalesced onto a single in-flight prompt — a plugin firing several
 * `host.process.spawn` calls at once raises one dialog, not a stack of
 * duplicates. The coalescing key carries the scope for the same reason the
 * grant key does: two scopes are two decisions, so they must not collapse onto
 * one dialog.
 */
export class PluginCapabilityConsentService {
  private bridge: PluginCapabilityConsentBridge | null = null;
  private readonly inFlight = new Map<string, Promise<PluginCapabilityConsentOutcome>>();
  // Bumped when a plugin's grants are purged. A prompt still open at that point
  // belongs to the plugin that was removed, so its answer must not mint a grant
  // a same-id reinstall would inherit.
  private readonly purgeEpochs = new Map<string, number>();

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
   * Purge every grant for a plugin, in every scope. Delegated to the store (which is private to
   * this service) so uninstall callers go through the service. Returns whether
   * the purge was durably persisted so the caller can retry or escalate.
   */
  revokeAllForPlugin(pluginId: string): boolean {
    this.purgeEpochs.set(pluginId, (this.purgeEpochs.get(pluginId) ?? 0) + 1);
    return this.consentStore.revokeAllForPlugin(pluginId);
  }

  /** Every grant a plugin holds, in every scope — read before a replacing install purges them. */
  listGrantsForPlugin(pluginId: string): PluginCapabilityIdentity[] {
    return this.consentStore
      .listForPlugin(pluginId)
      .map(({ pluginId: id, capability, site, scopeKey }) => ({
        pluginId: id,
        capability,
        ...(site !== undefined ? { site } : {}),
        scopeKey,
      }));
  }

  /**
   * Offer back, in one approval, the grants a replaced version held that the
   * new version still asks for (#14019). The new code is a new trust decision —
   * the plugin id is author-chosen and archives are unsigned — so nothing
   * returns without the user's say; this only stops the reset being silent.
   *
   * Resolves whether the grants came back. Main decides what they are: the
   * renderer answers yes or no and never names a grant. An answer only counts
   * while the version it was asked about is still installed and the plugin has
   * not been purged since, so an uninstall or another replacement while the
   * dialog is open voids it. Every non-approval, including a prompt nobody
   * could see, leaves the grants off.
   */
  async offerRestore(offer: PluginCapabilityRestoreOffer): Promise<boolean> {
    const { pluginId } = offer;
    const grants = offer.grants.filter((grant) => grant.capability !== EXTERNAL_LINK_CONSENT);
    if (grants.length === 0) return false;
    const bridge = this.bridge;
    if (bridge === null) {
      console.warn(
        `[PluginCapabilityConsentService] no consent surface to offer back ${grants.length} permission(s) for replaced plugin "${pluginId}"; they stay off`
      );
      return false;
    }

    const epoch = this.purgeEpochs.get(pluginId) ?? 0;
    let outcome: PluginCapabilityConsentOutcome;
    try {
      outcome = await bridge({
        pluginId,
        pluginDisplayName: offer.pluginDisplayName,
        restore: restoreList(grants),
        declaredCapabilities: offer.declaredCapabilities,
      });
    } catch (err) {
      console.error("[PluginCapabilityConsentService] Consent bridge threw:", err);
      outcome = "undeliverable";
    }

    if (outcome !== "approved-and-pin") {
      if (outcome === "undeliverable") {
        console.warn(
          `[PluginCapabilityConsentService] could not offer back the permissions of replaced plugin "${pluginId}"; they stay off`
        );
      }
      return false;
    }
    if ((this.purgeEpochs.get(pluginId) ?? 0) !== epoch || !offer.isCurrent()) {
      console.warn(
        `[PluginCapabilityConsentService] plugin "${pluginId}" was removed or replaced while its permissions were being offered back; not restoring them`
      );
      return false;
    }
    if (!this.consentStore.grantAll(grants)) {
      console.error(
        `[PluginCapabilityConsentService] restoring the permissions of plugin "${pluginId}" failed to persist`
      );
      return false;
    }
    return true;
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
    declaredCapabilities: readonly BuiltInPluginCapability[],
    scopeKey?: PluginScopeKey
  ): Promise<void> {
    return this.ensureSubjectAllowed(
      { pluginId, capability, scopeKey },
      pluginDisplayName,
      declaredCapabilities
    );
  }

  /**
   * Gate opening links to one site. The grant is keyed by hostname as well as
   * plugin and scope, so approving `example.com` answers for nothing else and a
   * capability grant never answers for a site. `site` must already be a
   * normalised hostname.
   */
  async ensureExternalSiteAllowed(
    pluginId: string,
    pluginDisplayName: string,
    site: string,
    declaredCapabilities: readonly BuiltInPluginCapability[],
    scopeKey?: PluginScopeKey
  ): Promise<void> {
    if (site === "") {
      throw new Error(`${PLUGIN_CAPABILITY_DENIED_PREFIX}: no site to open a link to`);
    }
    return this.ensureSubjectAllowed(
      { pluginId, capability: EXTERNAL_LINK_CONSENT, site, scopeKey },
      pluginDisplayName,
      declaredCapabilities
    );
  }

  private async ensureSubjectAllowed(
    // Only what a prompt can ask about: a user switch with no token of its own
    // is never asked for (#13821).
    identity: PluginCapabilityIdentity & { capability: PluginConsentSubject },
    pluginDisplayName: string,
    declaredCapabilities: readonly BuiltInPluginCapability[]
  ): Promise<void> {
    const { pluginId, capability, scopeKey, site } = identity;
    if (this.consentStore.hasGrant(identity)) return;

    const epoch = this.purgeEpochs.get(pluginId) ?? 0;
    const outcome = await this.requestOutcome(
      pluginId,
      pluginDisplayName,
      capability,
      declaredCapabilities,
      scopeKey,
      site
    );

    if (
      (outcome === "approved-and-pin" || outcome === "approved-once") &&
      (this.purgeEpochs.get(pluginId) ?? 0) !== epoch
    ) {
      throw new Error(
        `${PLUGIN_CAPABILITY_DENIED_PREFIX}: plugin "${pluginId}" was removed or replaced while its consent prompt was open`
      );
    }
    if (outcome === "approved-and-pin") {
      this.consentStore.grant(identity);
      return;
    }
    if (outcome === "approved-once") return;

    if (outcome === "undeliverable") {
      // The prompt never reached a renderer that could show it. Logged at error
      // level, not warn: unlike an abandoned dialog this is a Daintree-side
      // delivery failure, not a user behaviour (#11708).
      console.error(
        `[PluginCapabilityConsentService] could not present the consent prompt for plugin "${pluginId}" capability "${capability}" — it never reached a renderer, or the renderer holding it went away before answering`
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
   * Resolve the outcome for a `(scopeKey, pluginId, capability)`, coalescing concurrent
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
    capability: PluginConsentSubject,
    declaredCapabilities: readonly BuiltInPluginCapability[],
    scopeKey?: PluginScopeKey,
    site?: string
  ): Promise<PluginCapabilityConsentOutcome> {
    if (this.bridge === null) {
      // Fail closed — no UI to approve through.
      return Promise.resolve("undeliverable");
    }
    // The purge epoch is part of the key: a call made after the plugin was
    // replaced must not join a prompt the replaced version raised, or its
    // answer would land under the new epoch and mint a grant for the new code.
    const key = JSON.stringify([
      scopeKey ?? "global",
      pluginId,
      capability,
      site ?? null,
      this.purgeEpochs.get(pluginId) ?? 0,
    ]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const bridge = this.bridge;
    // Invoke through an async wrapper so a bridge that throws *synchronously*
    // becomes a rejection the `.catch` below can classify. Calling it bare would
    // let that throw escape `requestOutcome` entirely, and the gated call would
    // reject with a raw error instead of a `PERMISSION_REQUIRED:` one — still
    // closed, but outside the contract plugins are told to expect.
    const invoke = async () =>
      bridge({
        pluginId,
        pluginDisplayName,
        capability,
        ...(site !== undefined ? { site } : {}),
        declaredCapabilities,
      });
    const promise = invoke()
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
    this.purgeEpochs.clear();
  }
}

/** One row per thing granted: the same grant held in two scopes is one line to approve. */
function restoreList(grants: readonly PluginCapabilityIdentity[]): PluginRestorableGrant[] {
  const list = new Set<PluginRestorableGrant>();
  for (const { capability } of grants) {
    if (capability !== EXTERNAL_LINK_CONSENT) list.add(capability);
  }
  return [...list];
}
