type DenialKind = "auth401" | "tierMismatch";

interface AbusePolicyConfig {
  readConfig: () => {
    auditEnabled: boolean;
    abusePolicyEnabled: boolean;
    abusePolicyMaxDenials: number;
    abusePolicyWindowMs: number;
  };
}

interface DenialState {
  count: number;
  windowStart: number;
}

export class AbusePolicy {
  private readonly state = new Map<string, DenialState>();
  private readonly readConfig: AbusePolicyConfig["readConfig"];

  constructor(config: AbusePolicyConfig) {
    this.readConfig = config.readConfig;
  }

  recordDenial(sessionId: string, _kind: DenialKind): { tripped: boolean } {
    const cfg = this.readConfig();
    if (cfg.auditEnabled === false || cfg.abusePolicyEnabled === false) {
      return { tripped: false };
    }

    const now = Date.now();
    const existing = this.state.get(sessionId);

    if (!existing || now - existing.windowStart > cfg.abusePolicyWindowMs) {
      this.state.set(sessionId, { count: 1, windowStart: now });
      return { tripped: cfg.abusePolicyMaxDenials <= 1 };
    }

    existing.count += 1;
    const tripped = existing.count >= cfg.abusePolicyMaxDenials;
    return { tripped };
  }

  /**
   * Drop the per-session denial counter. Called from the SessionStore
   * lifecycle hooks (idle expiry, explicit revoke, drain) and from the
   * abuse-trip handler in HttpLifecycle once the session has been
   * revoked. Otherwise the `state` Map grows unboundedly across normal
   * session churn — the only previous prune path was the trip itself,
   * which the vast majority of well-behaved sessions never hit.
   */
  dropSession(sessionId: string): void {
    this.state.delete(sessionId);
  }

  clear(): void {
    this.state.clear();
  }

  /** Exposed for tests — returns a snapshot of the tracked denial count for a session. */
  getSnapshot(sessionId: string): { count: number; tripped: boolean } | null {
    const cfg = this.readConfig();
    const s = this.state.get(sessionId);
    if (!s) return null;
    return { count: s.count, tripped: s.count >= cfg.abusePolicyMaxDenials };
  }
}
