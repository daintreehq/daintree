import type {
  PluginMcpConsentLookup,
  PluginMcpConsentRecord,
  PluginMcpToolFingerprint,
  PluginMcpToolIdentity,
} from "../../../shared/types/pluginMcpConsent.js";

/**
 * Trust-on-first-use (TOFU) pin store for plugin-MCP tool descriptions and
 * schemas. Persists each `(pluginId, serverId, toolName)` triple alongside a
 * {@link PluginMcpToolFingerprint} so subsequent calls can detect rug-pull
 * mutations (OWASP MCP03) and re-prompt the user.
 *
 * Persistence is delegated to electron-store via the inject point: the caller
 * supplies a `(patch) => void` saver and a `() => record` reader, exactly
 * mirroring the `AuditService`/`PluginActionAuditService` pattern. The store
 * itself is process-local in-memory; the saver/reader pair owns durability.
 *
 * The store does NOT hash; callers compute the fingerprint via
 * `electron/utils/pluginMcpHash.ts` and pass the digests in. That separation
 * keeps the store hermetic (no `node:crypto` import) and makes the hashing
 * order — raw bytes, pre-strip — the *caller's* invariant.
 */
export class PluginMcpConsentStore {
  private pins: Map<string, PluginMcpConsentRecord> = new Map();
  private revoked: Set<string> = new Set();
  private hydrated = false;

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>
  ) {}

  /**
   * Look up consent state for a tool. The fingerprint passed in is the *current*
   * one (computed from what the server just advertised); the lookup compares it
   * against the persisted pin (if any) and classifies the result so the
   * dispatch chain knows whether to prompt and which framing to use.
   *
   * `raw-changed` is checked before `schema-changed` before `annotation-changed`
   * deliberately: a raw mutation is the most security-relevant (it could carry a
   * prompt-injection payload invisible in the display string), so the user must
   * always see it even when several fields changed simultaneously. A legacy pin
   * minted before `annotationHash` existed carries the `""` sentinel (see
   * {@link normalizeRecord}), which never equals a real 64-char digest, so it
   * surfaces as `annotation-changed` and re-prompts.
   */
  lookup(
    identity: PluginMcpToolIdentity,
    current: PluginMcpToolFingerprint
  ): PluginMcpConsentLookup {
    this.hydrate();
    const key = makeKey(identity);
    if (this.revoked.has(key)) return { kind: "revoked" };
    const pin = this.pins.get(key);
    if (!pin) return { kind: "first-use" };
    if (pin.fingerprint.rawHash !== current.rawHash) {
      return { kind: "raw-changed", previousPin: pin };
    }
    if (pin.fingerprint.schemaHash !== current.schemaHash) {
      return { kind: "schema-changed", previousPin: pin };
    }
    if (pin.fingerprint.annotationHash !== current.annotationHash) {
      return { kind: "annotation-changed", previousPin: pin };
    }
    return { kind: "approved", pin };
  }

  /**
   * Mint or refresh a pin. Clears any prior revocation for the same identity
   * (an explicit re-approval supersedes the earlier revoke).
   */
  pin(
    identity: PluginMcpToolIdentity,
    fingerprint: PluginMcpToolFingerprint
  ): PluginMcpConsentRecord {
    this.hydrate();
    const key = makeKey(identity);
    const record: PluginMcpConsentRecord = {
      pluginId: identity.pluginId,
      serverId: identity.serverId,
      toolName: identity.toolName,
      fingerprint,
      approvedAt: Date.now(),
    };
    this.pins.set(key, record);
    this.revoked.delete(key);
    this.flush();
    return record;
  }

  /**
   * Mark a pin as revoked. Subsequent lookups return `kind: "revoked"` until
   * the user explicitly re-approves via {@link pin}. Revoking a never-pinned
   * identity is a no-op (we don't fabricate a tombstone for tools the user
   * has never seen).
   */
  revoke(identity: PluginMcpToolIdentity): void {
    this.hydrate();
    const key = makeKey(identity);
    if (!this.pins.has(key) && !this.revoked.has(key)) return;
    this.pins.delete(key);
    this.revoked.add(key);
    this.flush();
  }

  /** Read all live pins (revoked entries omitted). Newest-first. */
  list(): PluginMcpConsentRecord[] {
    this.hydrate();
    return [...this.pins.values()].sort((a, b) => b.approvedAt - a.approvedAt);
  }

  /** Drop every pin and revoke marker. Persists immediately. */
  clear(): void {
    this.hydrate();
    this.pins.clear();
    this.revoked.clear();
    this.flush();
  }

  /**
   * Purge all consent state for a plugin — every pin and every orphaned revoke
   * marker whose key decodes to `pluginId`. Used on uninstall so a reinstall
   * starts from `first-use` rather than inheriting prior TOFU approvals (the
   * pluginId is author-controlled, so a reinstalled or rebuilt plugin must
   * re-prompt). Unlike {@link revoke}, this leaves NO tombstone — the pins are
   * deleted outright, not converted to revocations. Flushes only when at least
   * one entry was removed.
   *
   * Returns whether the purge is durable: `true` if nothing changed (no stale
   * state to begin with) or the flush persisted; `false` if the flush threw, so
   * the caller knows the in-memory pins were dropped but the persisted snapshot
   * may still hold them — they'd rehydrate on the next launch (consent-bypass
   * for a same-name reinstall) unless the caller retries or escalates.
   */
  revokeAllForPlugin(pluginId: string): boolean {
    this.hydrate();
    let changed = false;
    for (const [key, record] of this.pins) {
      if (record.pluginId === pluginId) {
        this.pins.delete(key);
        changed = true;
      }
    }
    for (const key of this.revoked) {
      if (decodeKeyPluginId(key) === pluginId) {
        this.revoked.delete(key);
        changed = true;
      }
    }
    if (!changed) return true;
    return this.flush();
  }

  private hydrate(): void {
    if (this.hydrated) return;
    const config = this.readConfig();
    const persistedPins = config.pins;
    if (Array.isArray(persistedPins)) {
      for (const raw of persistedPins) {
        const record = normalizeRecord(raw);
        if (record) this.pins.set(makeKey(record), record);
      }
    }
    const persistedRevoked = config.revoked;
    if (Array.isArray(persistedRevoked)) {
      for (const key of persistedRevoked) {
        if (typeof key === "string") this.revoked.add(key);
      }
    }
    this.hydrated = true;
  }

  private flush(): boolean {
    try {
      this.saveConfig({
        pins: [...this.pins.values()],
        revoked: [...this.revoked],
      });
      return true;
    } catch (err) {
      console.error("[PluginMcpConsentStore] Failed to flush pins:", err);
      return false;
    }
  }

  _resetForTest(): void {
    this.pins.clear();
    this.revoked.clear();
    this.hydrated = false;
  }
}

/**
 * Build the pin-store lookup key for an identity. JSON-encoded so a component
 * containing the `"::"` separator cannot collide with a differently-split
 * triple (e.g. `pluginId="a::b", serverId="c"` vs `pluginId="a", serverId="b::c"`).
 * Plugin ids are author-controlled in the manifest, so the encoded form is
 * the only invariant that prevents a crafted manifest from inheriting another
 * plugin's consent pin.
 */
function makeKey(identity: PluginMcpToolIdentity): string {
  return JSON.stringify([identity.pluginId, identity.serverId, identity.toolName]);
}

/**
 * Decode the pluginId (first component) from a {@link makeKey} string. Returns
 * `null` for a malformed key so a corrupt persisted `revoked` entry can't throw
 * during a plugin purge.
 */
function decodeKeyPluginId(key: string): string | null {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null;
  } catch {
    return null;
  }
}

function normalizeRecord(raw: unknown): PluginMcpConsentRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const fp = r.fingerprint;
  if (!fp || typeof fp !== "object") return null;
  const fpRec = fp as Record<string, unknown>;
  if (
    typeof r.pluginId !== "string" ||
    typeof r.serverId !== "string" ||
    typeof r.toolName !== "string" ||
    typeof r.approvedAt !== "number" ||
    typeof fpRec.rawHash !== "string" ||
    typeof fpRec.displayHash !== "string" ||
    typeof fpRec.schemaHash !== "string"
  ) {
    return null;
  }
  return {
    pluginId: r.pluginId,
    serverId: r.serverId,
    toolName: r.toolName,
    approvedAt: r.approvedAt,
    fingerprint: {
      rawHash: fpRec.rawHash,
      displayHash: fpRec.displayHash,
      schemaHash: fpRec.schemaHash,
      // Legacy pins predate `annotationHash`. The `""` sentinel never equals a
      // real digest, so the next lookup classifies them as `annotation-changed`
      // and re-prompts — the tool was approved without annotation coverage, so
      // re-consent is the fail-safe behaviour.
      annotationHash: typeof fpRec.annotationHash === "string" ? fpRec.annotationHash : "",
    },
  };
}
