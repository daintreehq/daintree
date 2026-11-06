import type { PluginScopeKey } from "../../../shared/types/plugin.js";
import {
  EXTERNAL_LINK_CONSENT,
  type PluginCapabilityConsentRecord,
  type PluginCapabilityIdentity,
  type PluginGrantKey,
  type PluginPresetGrant,
} from "../../../shared/types/pluginCapabilityConsent.js";
import { AGENT_LAUNCH_PRESET_CAPABILITY } from "../../../shared/utils/agentPresetLaunchConsent.js";

/**
 * Just-in-time (JIT) grant store for plugin host capabilities (#10524).
 * Persists each `(scopeKey, pluginId, capability)` triple the user has approved
 * so the first call into a high-risk capability prompts once and every later
 * call runs silently. The scope is part of the identity, so a grant made for an
 * app-wide plugin never satisfies a check for the same plugin id loaded from a
 * project. Mirrors {@link PluginMcpConsentStore} but is simpler — there is no
 * fingerprint and no rug-pull re-prompt, because a capability is a static
 * manifest declaration, not a mutable advertised surface.
 *
 * Persistence is delegated to electron-store via the inject point: the caller
 * supplies a `(patch) => void` saver and a `() => record` reader. The store
 * itself is process-local in-memory; the saver/reader pair owns durability.
 */
const DEFAULT_SCOPE_KEY: PluginScopeKey = "global";

export class PluginCapabilityConsentStore {
  private grants: Map<string, PluginCapabilityConsentRecord> = new Map();
  private hydrated = false;

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>
  ) {}

  /**
   * Whether the user has an active grant for this identity. A preset grant is
   * only ever answered by {@link getGrant}, which hands back the fingerprint to
   * check; here it reads as present, which no gate relies on.
   */
  hasGrant(identity: PluginCapabilityIdentity): boolean {
    this.hydrate();
    return this.grants.has(makeKey(identity));
  }

  /** The grant stored for this identity, if any. */
  getGrant(identity: PluginCapabilityIdentity): PluginCapabilityConsentRecord | undefined {
    this.hydrate();
    return this.grants.get(makeKey(identity));
  }

  /**
   * Mint or refresh a grant for an identity. Idempotent — a re-approval just
   * refreshes `approvedAt`. A preset grant needs `preset`, the content it was
   * approved for; without it the grant would answer for nothing, so none is
   * minted.
   */
  grant(
    identity: PluginCapabilityIdentity,
    preset?: Pick<PluginPresetGrant, "fingerprint" | "presetName">
  ): PluginCapabilityConsentRecord {
    this.hydrate();
    const record = recordFor(identity, Date.now(), preset);
    if (record.capability === AGENT_LAUNCH_PRESET_CAPABILITY && record.preset === undefined) {
      throw new Error("A preset grant needs the preset it is for");
    }
    this.grants.set(makeKey(identity), record);
    this.flush();
    return record;
  }

  /**
   * Revoke a single grant. Subsequent calls into the capability re-prompt.
   * Revoking a never-granted identity is a no-op.
   */
  revoke(identity: PluginCapabilityIdentity): void {
    this.hydrate();
    const key = makeKey(identity);
    if (!this.grants.has(key)) return;
    this.grants.delete(key);
    this.flush();
  }

  /**
   * Set a grant from an explicit user switch and report whether it reached
   * disk (#13119). Unlike {@link grant}/{@link revoke}, a failed write is not
   * swallowed: a switch that reads "off" while the grant rehydrates on the next
   * launch is the one outcome this must never produce. A failed enable is
   * rolled back so memory matches disk; a failed disable stays revoked in
   * memory (the safe direction) and a retry re-writes the snapshot even though
   * there is nothing left to delete.
   */
  setGrant(identity: PluginCapabilityIdentity, enabled: boolean): boolean {
    this.hydrate();
    const key = makeKey(identity);
    const previous = this.grants.get(key);
    if (enabled) {
      // A switch never mints a preset grant: it has no content to approve.
      if (identity.capability === AGENT_LAUNCH_PRESET_CAPABILITY) return false;
      this.grants.set(key, recordFor(identity, previous?.approvedAt ?? Date.now()));
    } else {
      this.grants.delete(key);
    }
    if (this.flush() || this.flush()) return true;
    if (enabled) {
      if (previous) this.grants.set(key, previous);
      else this.grants.delete(key);
    }
    return false;
  }

  /**
   * Mint several grants as one write and report whether it reached disk
   * (#14019). The batch is one decision, so a failed write rolls every grant it
   * added back out rather than leaving some of them on in memory only.
   */
  grantAll(identities: readonly PluginCapabilityIdentity[]): boolean {
    this.hydrate();
    const previous = new Map<string, PluginCapabilityConsentRecord | undefined>();
    const approvedAt = Date.now();
    for (const identity of identities) {
      // Never offered back, so never restored (#16324): see PluginRestorableGrant.
      if (identity.capability === AGENT_LAUNCH_PRESET_CAPABILITY) continue;
      const key = makeKey(identity);
      if (!previous.has(key)) previous.set(key, this.grants.get(key));
      this.grants.set(key, recordFor(identity, approvedAt));
    }
    if (previous.size === 0) return true;
    if (this.flush() || this.flush()) return true;
    for (const [key, record] of previous) {
      if (record) this.grants.set(key, record);
      else this.grants.delete(key);
    }
    return false;
  }

  /** Read all live grants. Newest-first. */
  list(): PluginCapabilityConsentRecord[] {
    this.hydrate();
    return [...this.grants.values()].sort((a, b) => b.approvedAt - a.approvedAt);
  }

  /** Every grant one plugin holds, in every scope. */
  listForPlugin(pluginId: string): PluginCapabilityConsentRecord[] {
    return this.list().filter((record) => record.pluginId === pluginId);
  }

  /** Drop every grant. Persists immediately. */
  clear(): void {
    this.hydrate();
    this.grants.clear();
    this.flush();
  }

  /**
   * Purge all grants for a plugin, in every scope. Used on uninstall so a
   * same-name reinstall
   * starts from first-use rather than inheriting prior approvals (the pluginId
   * is author-controlled, so a reinstalled or rebuilt plugin must re-prompt).
   * Flushes only when at least one grant was removed.
   *
   * Returns whether the purge is durable: `true` if nothing changed (nothing to
   * purge) or the flush persisted; `false` if the flush threw, so the caller
   * knows the in-memory grants were dropped but the persisted snapshot may still
   * hold them — they'd rehydrate on the next launch (a consent-bypass for a
   * same-name reinstall) unless the caller retries or escalates.
   */
  revokeAllForPlugin(pluginId: string): boolean {
    this.hydrate();
    let changed = false;
    for (const [key, record] of this.grants) {
      if (record.pluginId === pluginId) {
        this.grants.delete(key);
        changed = true;
      }
    }
    if (!changed) return true;
    // Retry the flush once internally on a transient failure. The in-memory
    // grants are already dropped, so a caller-side `revoke() || revoke()` retry
    // would short-circuit on the second call (nothing left to delete →
    // `!changed` → `true`) and never re-attempt the persist — the flush must be
    // retried here, where the empty snapshot is what we re-write.
    if (this.flush()) return true;
    return this.flush();
  }

  private hydrate(): void {
    if (this.hydrated) return;
    const config = this.readConfig();
    const persisted = config.grants;
    if (Array.isArray(persisted)) {
      for (const raw of persisted) {
        const record = normalizeRecord(raw);
        if (record) this.grants.set(makeKey(record), record);
      }
    }
    this.hydrated = true;
  }

  private flush(): boolean {
    try {
      this.saveConfig({ grants: [...this.grants.values()] });
      return true;
    } catch (err) {
      console.error("[PluginCapabilityConsentStore] Failed to flush grants:", err);
      return false;
    }
  }

  _resetForTest(): void {
    this.grants.clear();
    this.hydrated = false;
  }
}

/**
 * Build the grant-store lookup key for an identity. JSON-encoded so a pluginId
 * or scopeKey containing `"::"` cannot collide with a differently-split triple.
 * Both are attacker-adjacent — pluginIds are author-controlled in the manifest
 * — so the encoded form is the only invariant that prevents a crafted manifest
 * from inheriting another plugin's, or another scope's, grant.
 */
function makeKey(identity: PluginCapabilityIdentity): string {
  const base = [identity.scopeKey ?? DEFAULT_SCOPE_KEY, identity.pluginId, identity.capability];
  // A site or preset grant carries a fourth element, so it can collide with no
  // capability key, and a capability with no target names no preset at all.
  if (identity.capability === EXTERNAL_LINK_CONSENT) {
    return JSON.stringify([...base, identity.site ?? ""]);
  }
  if (identity.capability === AGENT_LAUNCH_PRESET_CAPABILITY) {
    const preset = identity.preset;
    return JSON.stringify([
      ...base,
      preset ? [preset.agentId, preset.presetId, preset.source] : null,
    ]);
  }
  return JSON.stringify(base);
}

/** The record an identity is stored as, its site or preset carried over. */
function recordFor(
  identity: PluginCapabilityIdentity,
  approvedAt: number,
  preset?: Pick<PluginPresetGrant, "fingerprint" | "presetName">
): PluginCapabilityConsentRecord {
  return {
    pluginId: identity.pluginId,
    capability: identity.capability,
    ...(identity.site !== undefined ? { site: identity.site } : {}),
    ...(identity.capability === AGENT_LAUNCH_PRESET_CAPABILITY &&
    identity.preset !== undefined &&
    preset !== undefined
      ? {
          preset: {
            agentId: identity.preset.agentId,
            presetId: identity.preset.presetId,
            source: identity.preset.source,
            fingerprint: preset.fingerprint,
            presetName: preset.presetName,
          },
        }
      : {}),
    scopeKey: identity.scopeKey ?? DEFAULT_SCOPE_KEY,
    approvedAt,
  };
}

const PRESET_SOURCES: ReadonlySet<string> = new Set(["custom", "project", "ccr", "registry"]);

/** A stored preset grant's target, or null when any part of it is unreadable. */
function normalizePresetGrant(raw: unknown): PluginPresetGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.agentId !== "string" ||
    p.agentId === "" ||
    typeof p.presetId !== "string" ||
    p.presetId === "" ||
    typeof p.source !== "string" ||
    !PRESET_SOURCES.has(p.source) ||
    typeof p.fingerprint !== "string" ||
    p.fingerprint === "" ||
    typeof p.presetName !== "string"
  ) {
    return null;
  }
  return {
    agentId: p.agentId,
    presetId: p.presetId,
    source: p.source as PluginPresetGrant["source"],
    fingerprint: p.fingerprint,
    presetName: p.presetName,
  };
}

/**
 * A record persisted before the key widened carries no `scopeKey`; it was
 * necessarily app-wide, so it reads back as `"global"`. A `scopeKey` that is
 * present but not a string is malformed and drops the record rather than
 * defaulting — defaulting would silently promote an unreadable grant into the
 * widest scope.
 */
function normalizeRecord(raw: unknown): PluginCapabilityConsentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.pluginId !== "string" ||
    typeof r.capability !== "string" ||
    typeof r.approvedAt !== "number"
  ) {
    return null;
  }
  const scopeKey = r.scopeKey;
  if (scopeKey !== undefined && (typeof scopeKey !== "string" || scopeKey === "")) {
    return null;
  }
  // A link grant without a hostname would read as approval for every site, so
  // it is dropped; a stray `site` on a capability record is ignored.
  if (r.capability === EXTERNAL_LINK_CONSENT) {
    if (typeof r.site !== "string" || r.site === "") return null;
    return {
      pluginId: r.pluginId,
      capability: EXTERNAL_LINK_CONSENT,
      site: r.site,
      scopeKey: scopeKey ?? DEFAULT_SCOPE_KEY,
      approvedAt: r.approvedAt,
    };
  }
  // A preset grant without a readable preset and fingerprint would answer for
  // a preset nobody approved, so it is dropped like a link grant with no site.
  if (r.capability === AGENT_LAUNCH_PRESET_CAPABILITY) {
    const preset = normalizePresetGrant(r.preset);
    if (!preset) return null;
    return {
      pluginId: r.pluginId,
      capability: AGENT_LAUNCH_PRESET_CAPABILITY,
      preset,
      scopeKey: scopeKey ?? DEFAULT_SCOPE_KEY,
      approvedAt: r.approvedAt,
    };
  }
  return {
    pluginId: r.pluginId,
    capability: r.capability as PluginGrantKey,
    scopeKey: scopeKey ?? DEFAULT_SCOPE_KEY,
    approvedAt: r.approvedAt,
  };
}
