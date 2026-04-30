import type { ServiceConnectivityStatus } from "../../../shared/types/ipc/connectivity.js";
import { logDebug, logInfo, logWarn } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/** How often background reachability probes run when the app is actively used. */
export const AGENT_CONNECTIVITY_INTERVAL_MS = 30 * 60 * 1000;

/** Minimum gap between probes triggered by focus/wake events. */
export const AGENT_CONNECTIVITY_FOCUS_COOLDOWN_MS = 5 * 60 * 1000;

/** Timeout on the probe's fetch call. */
export const AGENT_CONNECTIVITY_FETCH_TIMEOUT_MS = 10_000;

export type AgentConnectivityProvider = "claude" | "gemini" | "codex";

const PROBE_ENDPOINTS: Record<AgentConnectivityProvider, string> = {
  claude: "https://api.anthropic.com/v1/models",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  codex: "https://api.openai.com/v1/models",
};

interface ProviderState {
  status: ServiceConnectivityStatus;
  checkedAt: number;
  pendingCheck: Promise<void> | null;
}

export interface AgentConnectivityChange {
  provider: AgentConnectivityProvider;
  status: ServiceConnectivityStatus;
  checkedAt: number;
}

type StateChangeListener = (change: AgentConnectivityChange) => void;

type FetchFn = typeof globalThis.fetch;

interface AgentConnectivityServiceOptions {
  /** Override for tests — inject a mock fetch. */
  fetchImpl?: FetchFn;
  /** Override for tests — inject a deterministic clock. */
  now?: () => number;
}

/**
 * Background reachability probes for agent provider APIs (Claude, Gemini, Codex).
 *
 * The probes deliberately send unauthenticated GET requests to each provider's
 * `/models` endpoint. Daintree does not own the agent CLI's API keys, so we
 * cannot — and should not — attempt token-validity checks here. The only
 * question this service answers is "can the network reach the provider?".
 *
 * Classification:
 *   - Any HTTP response (including 4xx/5xx) → `reachable`. A 401 from Anthropic
 *     without an `x-api-key` header still confirms the API host is up.
 *   - Network-level failures (DNS resolution, timeouts, connection refused,
 *     `AbortError`, etc.) → `unreachable`.
 *
 * This contrasts with `GitHubTokenHealthService`, which DOES care about token
 * validity. Don't conflate the two — they serve different UX needs.
 */
class AgentConnectivityServiceImpl {
  private readonly providers: AgentConnectivityProvider[] = ["claude", "gemini", "codex"];
  private readonly state: Record<AgentConnectivityProvider, ProviderState>;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<StateChangeListener>();
  private disposed = false;

  private fetchImpl: FetchFn;
  private now: () => number;

  constructor(options: AgentConnectivityServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());

    this.state = {
      claude: { status: "unknown", checkedAt: 0, pendingCheck: null },
      gemini: { status: "unknown", checkedAt: 0, pendingCheck: null },
      codex: { status: "unknown", checkedAt: 0, pendingCheck: null },
    };
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of one provider's current state. */
  getProviderState(provider: AgentConnectivityProvider): {
    status: ServiceConnectivityStatus;
    checkedAt: number;
  } {
    const entry = this.state[provider];
    return { status: entry.status, checkedAt: entry.checkedAt };
  }

  /**
   * Begin polling. Safe to call multiple times — subsequent calls are no-ops.
   * Fires immediate probes asynchronously so initial state is available soon
   * after startup without blocking the caller.
   */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.refresh({ reason: "interval" });
    }, AGENT_CONNECTIVITY_INTERVAL_MS);
    void this.refresh({ reason: "start", force: true });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.disposed = true;
    for (const provider of this.providers) {
      this.state[provider] = { status: "unknown", checkedAt: 0, pendingCheck: null };
    }
  }

  /**
   * Run probes for every provider, subject to a per-provider cooldown unless
   * `force` is set. Returns once every issued probe has settled — providers
   * that are skipped due to cooldown resolve immediately.
   */
  refresh(options: { force?: boolean; reason?: string } = {}): Promise<void> {
    const reason = options.reason ?? "refresh";
    const force = options.force === true;
    const probes = this.providers.map((provider) => this.runCheck(provider, { force, reason }));
    return Promise.all(probes).then(() => undefined);
  }

  /** Test-only helper. */
  _resetForTests(): void {
    this.stop();
    this.listeners.clear();
    this.disposed = false;
    for (const provider of this.providers) {
      this.state[provider] = { status: "unknown", checkedAt: 0, pendingCheck: null };
    }
  }

  /** Test-only helper. */
  _setFetchForTests(fetchImpl: FetchFn): void {
    this.fetchImpl = fetchImpl;
  }

  /** Test-only helper. */
  _setNowForTests(now: () => number): void {
    this.now = now;
  }

  private async runCheck(
    provider: AgentConnectivityProvider,
    context: { force: boolean; reason: string }
  ): Promise<void> {
    const entry = this.state[provider];

    // Coalesce concurrent probes for the same provider.
    if (entry.pendingCheck) return entry.pendingCheck;

    if (!context.force) {
      const elapsed = this.now() - entry.checkedAt;
      if (entry.checkedAt > 0 && elapsed < AGENT_CONNECTIVITY_FOCUS_COOLDOWN_MS) {
        logDebug("Agent connectivity: skipping refresh within cooldown", {
          provider,
          elapsed,
        });
        return;
      }
    }

    const url = PROBE_ENDPOINTS[provider];

    const probe = (async () => {
      try {
        await this.fetchImpl(url, {
          method: "GET",
          signal: AbortSignal.timeout(AGENT_CONNECTIVITY_FETCH_TIMEOUT_MS),
        });
        // Any HTTP response — including 4xx — means the host is reachable.
        // We send no auth headers, so 401/403 are expected and authoritative
        // about network reachability, not token validity.
        this.transitionTo(provider, "reachable");
      } catch (err) {
        // Network-layer failures: DNS, timeout, connection refused, abort.
        logDebug("Agent connectivity: probe failed (network/transport)", {
          provider,
          error: formatErrorMessage(err, "Agent connectivity probe failed"),
          reason: context.reason,
        });
        this.transitionTo(provider, "unreachable");
      }
    })().finally(() => {
      entry.pendingCheck = null;
    });

    entry.pendingCheck = probe;
    return probe;
  }

  private transitionTo(
    provider: AgentConnectivityProvider,
    status: ServiceConnectivityStatus
  ): void {
    // Stale completion after dispose() — ignore so we don't overwrite the
    // freshly-reset state or notify listeners that have been re-attached to
    // a recreated service instance.
    if (this.disposed) return;
    const entry = this.state[provider];
    const previous = entry.status;
    entry.status = status;
    entry.checkedAt = this.now();

    if (previous !== status) {
      if (status === "reachable") {
        logInfo("Agent connectivity: reachable", { provider });
      } else if (status === "unreachable") {
        logInfo("Agent connectivity: unreachable", { provider });
      }
      this.notifyListeners({ provider, status, checkedAt: entry.checkedAt });
    } else {
      logDebug("Agent connectivity: unchanged", { provider, status });
    }
  }

  private notifyListeners(change: AgentConnectivityChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        logWarn("Agent connectivity listener threw", {
          error: formatErrorMessage(err, "Connectivity listener failed"),
        });
      }
    }
  }
}

export { AgentConnectivityServiceImpl };
export const agentConnectivityService = new AgentConnectivityServiceImpl();
