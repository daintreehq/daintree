import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceConnectivityRegistry } from "../ServiceConnectivityRegistry.js";
import type { GitHubTokenHealthPayload } from "../../../../shared/types/ipc/github.js";
import type {
  ConnectivityServiceKey,
  ServiceConnectivityStatus,
} from "../../../../shared/types/ipc/connectivity.js";

interface FakeGitHubHealth {
  state: GitHubTokenHealthPayload;
  listeners: Set<(payload: GitHubTokenHealthPayload) => void>;
  getState(): GitHubTokenHealthPayload;
  onStateChange(listener: (payload: GitHubTokenHealthPayload) => void): () => void;
  emit(payload: GitHubTokenHealthPayload): void;
}

interface FakeMcpServer {
  isRunning: boolean;
  listeners: Set<(running: boolean) => void>;
  onStatusChange(listener: (running: boolean) => void): () => void;
  setRunning(running: boolean): void;
}

interface FakeAgentConnectivity {
  state: Record<
    "claude" | "gemini" | "codex",
    { status: ServiceConnectivityStatus; checkedAt: number }
  >;
  listeners: Set<
    (change: {
      provider: "claude" | "gemini" | "codex";
      status: ServiceConnectivityStatus;
      checkedAt: number;
    }) => void
  >;
  getProviderState(provider: "claude" | "gemini" | "codex"): {
    status: ServiceConnectivityStatus;
    checkedAt: number;
  };
  onStateChange(
    listener: (change: {
      provider: "claude" | "gemini" | "codex";
      status: ServiceConnectivityStatus;
      checkedAt: number;
    }) => void
  ): () => void;
  emit(change: {
    provider: "claude" | "gemini" | "codex";
    status: ServiceConnectivityStatus;
    checkedAt: number;
  }): void;
}

function createFakeGitHubHealth(initial: GitHubTokenHealthPayload): FakeGitHubHealth {
  const fake: FakeGitHubHealth = {
    state: initial,
    listeners: new Set(),
    getState: () => fake.state,
    onStateChange: (listener) => {
      fake.listeners.add(listener);
      return () => {
        fake.listeners.delete(listener);
      };
    },
    emit: (payload) => {
      fake.state = payload;
      for (const listener of fake.listeners) listener(payload);
    },
  };
  return fake;
}

function createFakeMcpServer(initial: boolean): FakeMcpServer {
  const fake: FakeMcpServer = {
    isRunning: initial,
    listeners: new Set(),
    onStatusChange: (listener) => {
      fake.listeners.add(listener);
      return () => {
        fake.listeners.delete(listener);
      };
    },
    setRunning: (running: boolean) => {
      fake.isRunning = running;
      for (const listener of fake.listeners) listener(running);
    },
  };
  return fake;
}

function createFakeAgentConnectivity(): FakeAgentConnectivity {
  const fake: FakeAgentConnectivity = {
    state: {
      claude: { status: "unknown", checkedAt: 0 },
      gemini: { status: "unknown", checkedAt: 0 },
      codex: { status: "unknown", checkedAt: 0 },
    },
    listeners: new Set(),
    getProviderState: (provider) => fake.state[provider],
    onStateChange: (listener) => {
      fake.listeners.add(listener);
      return () => {
        fake.listeners.delete(listener);
      };
    },
    emit: (change) => {
      fake.state[change.provider] = { status: change.status, checkedAt: change.checkedAt };
      for (const listener of fake.listeners) listener(change);
    },
  };
  return fake;
}

describe("ServiceConnectivityRegistry", () => {
  let gitHubHealth: FakeGitHubHealth;
  let mcpServer: FakeMcpServer;
  let agentConnectivity: FakeAgentConnectivity;
  let registry: ServiceConnectivityRegistry;
  let onRecovery: ReturnType<
    typeof vi.fn<(serviceKey: ConnectivityServiceKey, label: string) => void>
  >;

  beforeEach(() => {
    gitHubHealth = createFakeGitHubHealth({
      status: "unknown",
      tokenVersion: -1,
      checkedAt: 0,
    });
    mcpServer = createFakeMcpServer(false);
    agentConnectivity = createFakeAgentConnectivity();
    onRecovery = vi.fn();
    registry = new ServiceConnectivityRegistry({
      gitHubHealth,
      mcpServer,
      agentConnectivity,
      onRecovery,
      now: () => 1_000_000,
    });
  });

  afterEach(() => {
    registry.dispose();
  });

  describe("getSnapshot()", () => {
    it("returns all five service keys with status `unknown` before start()", () => {
      const snapshot = registry.getSnapshot();

      expect(snapshot.github.status).toBe("unknown");
      expect(snapshot["agent:claude"].status).toBe("unknown");
      expect(snapshot["agent:gemini"].status).toBe("unknown");
      expect(snapshot["agent:codex"].status).toBe("unknown");
      expect(snapshot.mcp.status).toBe("unknown");
    });

    it("returns a fresh clone — mutating the result does not affect internal state", () => {
      const snapshot = registry.getSnapshot();
      snapshot.github.status = "reachable";

      const second = registry.getSnapshot();
      expect(second.github.status).toBe("unknown");
    });
  });

  describe("start()", () => {
    it("seeds initial state silently from each underlying service", () => {
      gitHubHealth.state = {
        status: "healthy",
        tokenVersion: 1,
        checkedAt: 500_000,
      };
      mcpServer.isRunning = true;
      agentConnectivity.state.claude = { status: "reachable", checkedAt: 600_000 };
      const listener = vi.fn();
      registry.onChange(listener);

      registry.start();

      const snapshot = registry.getSnapshot();
      expect(snapshot.github.status).toBe("reachable");
      expect(snapshot.mcp.status).toBe("reachable");
      expect(snapshot["agent:claude"].status).toBe("reachable");

      // Seeding should NOT emit change events — those are reserved for real
      // post-start transitions.
      expect(listener).not.toHaveBeenCalled();
      expect(onRecovery).not.toHaveBeenCalled();
    });

    it("is idempotent — calling start() twice does not double-subscribe", () => {
      registry.start();
      registry.start();

      const listener = vi.fn();
      registry.onChange(listener);

      gitHubHealth.emit({ status: "healthy", tokenVersion: 1, checkedAt: 1_000_000 });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("derived states", () => {
    beforeEach(() => {
      registry.start();
    });

    it("maps GitHub `healthy` to `reachable`", () => {
      gitHubHealth.emit({ status: "healthy", tokenVersion: 1, checkedAt: 1_000_000 });

      expect(registry.getSnapshot().github.status).toBe("reachable");
    });

    it("maps GitHub `unhealthy` (token revoked) to `unknown`, NOT `unreachable`", () => {
      // Seed reachable first so we can confirm the transition.
      gitHubHealth.emit({ status: "healthy", tokenVersion: 1, checkedAt: 1_000_000 });
      gitHubHealth.emit({ status: "unhealthy", tokenVersion: 1, checkedAt: 1_000_000 });

      expect(registry.getSnapshot().github.status).toBe("unknown");
    });

    it("maps MCP isRunning=true to `reachable` and false to `unreachable`", () => {
      mcpServer.setRunning(true);
      expect(registry.getSnapshot().mcp.status).toBe("reachable");

      mcpServer.setRunning(false);
      expect(registry.getSnapshot().mcp.status).toBe("unreachable");
    });

    it("propagates agent reachability changes", () => {
      agentConnectivity.emit({
        provider: "gemini",
        status: "reachable",
        checkedAt: 1_000_000,
      });

      expect(registry.getSnapshot()["agent:gemini"].status).toBe("reachable");
    });
  });

  describe("recovery notifications", () => {
    beforeEach(() => {
      registry.start();
    });

    it("fires onRecovery when a service transitions from `unreachable` to `reachable`", () => {
      // Force MCP into the unreachable state by simulating a real stop after
      // it had been running. Initial seed treats `false` as `unknown`.
      mcpServer.setRunning(true);
      mcpServer.setRunning(false);
      onRecovery.mockClear();

      mcpServer.setRunning(true);

      expect(onRecovery).toHaveBeenCalledWith("mcp", "MCP server");
    });

    it("does NOT fire onRecovery for MCP starting up on a fresh launch (regression)", () => {
      // Repro of the startup spurious-toast bug: registry starts before the
      // deferred MCP task. isRunning is false at seed time. When MCP later
      // starts, it must be unknown→reachable (no toast), not unreachable→reachable.
      onRecovery.mockClear();
      mcpServer.setRunning(true);

      expect(onRecovery).not.toHaveBeenCalled();
      expect(registry.getSnapshot().mcp.status).toBe("reachable");
    });

    it("does NOT fire onRecovery on `unknown` → `reachable` transitions (initial probes)", () => {
      // Default state is `unknown`. Going to `reachable` should NOT trigger
      // a recovery toast — that would be noise on every app startup.
      agentConnectivity.emit({
        provider: "claude",
        status: "reachable",
        checkedAt: 1_000_000,
      });

      expect(onRecovery).not.toHaveBeenCalled();
    });

    it("fires onRecovery for agent providers on unreachable → reachable", () => {
      agentConnectivity.emit({
        provider: "claude",
        status: "unreachable",
        checkedAt: 1_000_000,
      });
      onRecovery.mockClear();

      agentConnectivity.emit({
        provider: "claude",
        status: "reachable",
        checkedAt: 1_000_000,
      });

      expect(onRecovery).toHaveBeenCalledWith("agent:claude", "Claude");
    });

    it("does not fire onRecovery on `unhealthy` GitHub → `healthy` (token-validity flow)", () => {
      gitHubHealth.emit({ status: "unhealthy", tokenVersion: 1, checkedAt: 1_000_000 });
      onRecovery.mockClear();

      gitHubHealth.emit({ status: "healthy", tokenVersion: 1, checkedAt: 1_000_000 });

      // unhealthy maps to `unknown`, so a transition to `healthy` is
      // `unknown` → `reachable` — not a recovery in our model. The dedicated
      // GitHub token-health hook handles the token-revoked banner UX.
      expect(onRecovery).not.toHaveBeenCalled();
    });

    it("still emits the change event when onRecovery throws", () => {
      const throwing = vi.fn(() => {
        throw new Error("boom");
      });
      const isolatedRegistry = new ServiceConnectivityRegistry({
        gitHubHealth,
        mcpServer,
        agentConnectivity,
        onRecovery: throwing,
      });
      isolatedRegistry.start();
      const changeListener = vi.fn();
      isolatedRegistry.onChange(changeListener);

      // Force MCP unreachable then reachable.
      mcpServer.setRunning(true);
      mcpServer.setRunning(false);
      changeListener.mockClear();
      throwing.mockClear();
      mcpServer.setRunning(true);

      expect(throwing).toHaveBeenCalled();
      expect(changeListener).toHaveBeenCalledWith(
        expect.objectContaining({ serviceKey: "mcp", status: "reachable" })
      );
      isolatedRegistry.dispose();
    });
  });

  describe("change events", () => {
    beforeEach(() => {
      registry.start();
    });

    it("emits exactly once per real state change", () => {
      const listener = vi.fn();
      registry.onChange(listener);

      mcpServer.setRunning(true);
      mcpServer.setRunning(true); // no-op
      mcpServer.setRunning(false);

      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe("dispose()", () => {
    it("unsubscribes from underlying services and clears listeners", () => {
      registry.start();
      const listener = vi.fn();
      registry.onChange(listener);

      registry.dispose();

      mcpServer.setRunning(true);
      gitHubHealth.emit({ status: "healthy", tokenVersion: 1, checkedAt: 1_000_000 });

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
