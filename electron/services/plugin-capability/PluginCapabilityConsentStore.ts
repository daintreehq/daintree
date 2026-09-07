import type { BuiltInPluginCapability, PluginScopeKey } from "../../../shared/types/plugin.js";
import type {
  PluginCapabilityConsentRecord,
  PluginCapabilityIdentity,
} from "../../../shared/types/pluginCapabilityConsent.js";

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

  /** Whether the user has an active grant for this identity. */
  hasGrant(identity: PluginCapabilityIdentity): boolean {
    this.hydrate();
    return this.grants.has(makeKey(identity));
  }

  /**
   * Mint or refresh a grant for an identity. Idempotent — a re-approval just
   * refreshes `approvedAt`.
   */
  grant(identity: PluginCapabilityIdentity): PluginCapabilityConsentRecord {
    this.hydrate();
    const record: PluginCapabilityConsentRecord = {
      pluginId: identity.pluginId,
      capability: identity.capability,
      scopeKey: identity.scopeKey ?? DEFAULT_SCOPE_KEY,
      approvedAt: Date.now(),
    };
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

  /** Read all live grants. Newest-first. */
  list(): PluginCapabilityConsentRecord[] {
    this.hydrate();
    return [...this.grants.values()].sort((a, b) => b.approvedAt - a.approvedAt);
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
  return JSON.stringify([
    identity.scopeKey ?? DEFAULT_SCOPE_KEY,
    identity.pluginId,
    identity.capability,
  ]);
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
  return {
    pluginId: r.pluginId,
    capability: r.capability as BuiltInPluginCapability,
    scopeKey: scopeKey ?? DEFAULT_SCOPE_KEY,
    approvedAt: r.approvedAt,
  };
}
