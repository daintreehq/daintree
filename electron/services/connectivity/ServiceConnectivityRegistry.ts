import type {
  ConnectivityServiceKey,
  ServiceConnectivityPayload,
  ServiceConnectivitySnapshot,
  ServiceConnectivityStatus,
} from "../../../shared/types/ipc/connectivity.js";
import { CONNECTIVITY_SERVICE_KEYS } from "../../../shared/types/ipc/connectivity.js";
import type { GitHubTokenHealthPayload } from "../../../shared/types/ipc/github.js";
import { logWarn } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  agentConnectivityService as defaultAgentConnectivityService,
  type AgentConnectivityChange,
  type AgentConnectivityProvider,
} from "./AgentConnectivityService.js";

interface GitHubHealthLike {
  getState(): GitHubTokenHealthPayload;
  onStateChange(listener: (payload: GitHubTokenHealthPayload) => void): () => void;
}

interface McpServerLike {
  readonly isRunning: boolean;
  onStatusChange(listener: (running: boolean) => void): () => void;
}

interface AgentConnectivityLike {
  getProviderState(provider: AgentConnectivityProvider): {
    status: ServiceConnectivityStatus;
    checkedAt: number;
  };
  onStateChange(listener: (change: AgentConnectivityChange) => void): () => void;
}

type SnapshotChangeListener = (payload: ServiceConnectivityPayload) => void;
type RecoveryNotifier = (serviceKey: ConnectivityServiceKey, label: string) => void;

const PROVIDER_TO_KEY: Record<AgentConnectivityProvider, ConnectivityServiceKey> = {
  claude: "agent:claude",
  gemini: "agent:gemini",
  codex: "agent:codex",
};

const SERVICE_LABELS: Record<ConnectivityServiceKey, string> = {
  github: "GitHub",
  "agent:claude": "Claude",
  "agent:gemini": "Gemini",
  "agent:codex": "Codex",
  mcp: "MCP server",
};

export interface ServiceConnectivityRegistryOptions {
  gitHubHealth: GitHubHealthLike;
  mcpServer: McpServerLike;
  agentConnectivity?: AgentConnectivityLike;
  /**
   * Called when a service flips from `unreachable` to `reachable`. Receives the
   * service key and a human-readable label. Optional — when omitted, recovery
   * notifications are silently dropped.
   */
  onRecovery?: RecoveryNotifier;
  /** Override for tests. */
  now?: () => number;
}

/**
 * Aggregates connectivity health from multiple underlying services into one
 * snapshot keyed by `ConnectivityServiceKey`.
 *
 * - `agent:claude|gemini|codex` is sourced from `AgentConnectivityService`.
 * - `github` is derived from `GitHubTokenHealthService`. A 401 (token revoked)
 *   maps to `unknown` here, not `unreachable` — token validity is a separate
 *   concern surfaced via `GitHubTokenHealthPayload`.
 * - `mcp` is derived synchronously from `mcpServerService.isRunning`.
 *
 * The renderer subscribes to a single broadcast channel and reads a fixed-shape
 * map. Dev-server connectivity is intentionally excluded — it's per-session and
 * already broadcast through `DEV_PREVIEW_STATE_CHANGED`.
 */
export class ServiceConnectivityRegistry {
  private readonly snapshot: ServiceConnectivitySnapshot;
  private readonly listeners = new Set<SnapshotChangeListener>();
  private readonly cleanups: Array<() => void> = [];
  private readonly gitHubHealth: GitHubHealthLike;
  private readonly mcpServer: McpServerLike;
  private readonly agentConnectivity: AgentConnectivityLike;
  private readonly onRecovery: RecoveryNotifier | null;
  private readonly now: () => number;
  private started = false;

  constructor(options: ServiceConnectivityRegistryOptions) {
    this.gitHubHealth = options.gitHubHealth;
    this.mcpServer = options.mcpServer;
    this.agentConnectivity = options.agentConnectivity ?? defaultAgentConnectivityService;
    this.onRecovery = options.onRecovery ?? null;
    this.now = options.now ?? (() => Date.now());

    this.snapshot = Object.fromEntries(
      CONNECTIVITY_SERVICE_KEYS.map((key) => [
        key,
        { serviceKey: key, status: "unknown" as ServiceConnectivityStatus, checkedAt: 0 },
      ])
    ) as ServiceConnectivitySnapshot;
  }

  /** Subscribe to per-service state changes. */
  onChange(listener: SnapshotChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of every service's current state — safe to call before any probe has run. */
  getSnapshot(): ServiceConnectivitySnapshot {
    // Return a shallow clone so consumers can't mutate internal state.
    return Object.fromEntries(
      CONNECTIVITY_SERVICE_KEYS.map((key) => [key, { ...this.snapshot[key] }])
    ) as ServiceConnectivitySnapshot;
  }

  /**
   * Wire up listeners on every underlying service and seed initial snapshot
   * values from their current state. Safe to call multiple times — subsequent
   * calls are no-ops.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Seed from existing state so secondary windows don't see `unknown` for a
    // service that has already settled.
    this.applyGitHubState(this.gitHubHealth.getState(), { silent: true });
    // MCP is started by a deferred task that runs *after* this registry, so
    // `isRunning === false` here means "not started yet" — distinct from
    // "was running, now stopped". Leave the snapshot at `unknown` and let
    // the first live emitStatusChange define the initial state. Otherwise
    // every normal launch with MCP enabled would see an unreachable→reachable
    // transition fire a spurious "Connection restored" toast.
    if (this.mcpServer.isRunning) {
      this.applyMcpState(true, { silent: true });
    }
    for (const provider of ["claude", "gemini", "codex"] as const) {
      const state = this.agentConnectivity.getProviderState(provider);
      this.applyAgentState(provider, state, { silent: true });
    }

    this.cleanups.push(
      this.gitHubHealth.onStateChange((payload) => this.applyGitHubState(payload))
    );
    this.cleanups.push(this.mcpServer.onStatusChange((running) => this.applyMcpState(running)));
    this.cleanups.push(
      this.agentConnectivity.onStateChange((change) =>
        this.applyAgentState(change.provider, change)
      )
    );
  }

  dispose(): void {
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch (err) {
        logWarn("ServiceConnectivityRegistry: cleanup threw", {
          error: formatErrorMessage(err, "Cleanup failed"),
        });
      }
    }
    this.cleanups.length = 0;
    this.listeners.clear();
    this.started = false;
  }

  private applyGitHubState(
    payload: GitHubTokenHealthPayload,
    options: { silent?: boolean } = {}
  ): void {
    // Deliberately collapse `healthy` → `reachable` and `unhealthy|unknown`
    // → `unknown`. A 401 means GitHub is reachable but the token is dead;
    // surfacing that as "unreachable" would be misleading. The dedicated
    // `useGitHubTokenHealth` hook handles the token-revoked UX.
    const status: ServiceConnectivityStatus =
      payload.status === "healthy" ? "reachable" : "unknown";
    // Pass `payload.checkedAt` through as-is — `0` is the documented value
    // for "no probe has run yet" and must reach the snapshot intact.
    this.update("github", status, payload.checkedAt, options);
  }

  private applyMcpState(running: boolean, options: { silent?: boolean } = {}): void {
    const status: ServiceConnectivityStatus = running ? "reachable" : "unreachable";
    // MCP has no native checkedAt — use now() since this is a real transition
    // observation (silent seeding only calls us when running === true).
    this.update("mcp", status, this.now(), options);
  }

  private applyAgentState(
    provider: AgentConnectivityProvider,
    state: { status: ServiceConnectivityStatus; checkedAt: number },
    options: { silent?: boolean } = {}
  ): void {
    const key = PROVIDER_TO_KEY[provider];
    this.update(key, state.status, state.checkedAt, options);
  }

  private update(
    serviceKey: ConnectivityServiceKey,
    status: ServiceConnectivityStatus,
    checkedAt: number,
    options: { silent?: boolean } = {}
  ): void {
    const previous = this.snapshot[serviceKey];
    if (previous.status === status && previous.checkedAt === checkedAt) {
      return;
    }

    const next: ServiceConnectivityPayload = { serviceKey, status, checkedAt };
    this.snapshot[serviceKey] = next;

    if (options.silent) return;

    if (previous.status === "unreachable" && status === "reachable" && this.onRecovery) {
      try {
        this.onRecovery(serviceKey, SERVICE_LABELS[serviceKey]);
      } catch (err) {
        logWarn("ServiceConnectivityRegistry: recovery notifier threw", {
          error: formatErrorMessage(err, "Recovery notifier failed"),
        });
      }
    }

    this.notifyListeners(next);
  }

  private notifyListeners(payload: ServiceConnectivityPayload): void {
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch (err) {
        logWarn("ServiceConnectivityRegistry: listener threw", {
          error: formatErrorMessage(err, "Connectivity listener failed"),
        });
      }
    }
  }
}
