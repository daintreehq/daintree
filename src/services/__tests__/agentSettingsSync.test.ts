// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "@shared/types";
import type { ProjectViewLifecyclePhase } from "@/lib/viewCacheState";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

const lifecycle = vi.hoisted(() => {
  const listeners = new Set<(phase: ProjectViewLifecyclePhase) => void>();
  return {
    subscribeProjectViewLifecycle: vi.fn((listener: (phase: ProjectViewLifecyclePhase) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit: (phase: ProjectViewLifecyclePhase) => listeners.forEach((listener) => listener(phase)),
  };
});
vi.mock("@/lib/viewCacheState", () => lifecycle);

const store = vi.hoisted(() => ({ applySaved: vi.fn(), refresh: vi.fn() }));
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => store },
}));

const bridge = vi.hoisted(() => {
  let listener: ((settings: AgentSettings) => void) | null = null;
  return {
    get: vi.fn(),
    onChanged: vi.fn((cb: (settings: AgentSettings) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    push: (settings: AgentSettings) => listener?.(settings),
    hasListener: () => listener !== null,
  };
});

import { agentSettingsClient } from "@/clients/agentSettingsClient";
import { notifyHostResync } from "@/store/hostResyncSignal";
import { initAgentSettingsSync } from "../agentSettingsSync";

const saved: AgentSettings = { agents: { claude: { customFlags: "--new" } } };

describe("initAgentSettingsSync (#14700)", () => {
  let dispose: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    store.refresh.mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      value: { agentSettings: bridge },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    dispose();
    agentSettingsClient.invalidate();
  });

  it("applies each saved change after dropping the client's cached copy", async () => {
    bridge.get.mockResolvedValueOnce({ agents: {} }).mockResolvedValueOnce(saved);
    await agentSettingsClient.get();
    dispose = initAgentSettingsSync();
    // A launch reacting to the change reads through the client straight away.
    let readDuringApply: Promise<unknown> | undefined;
    store.applySaved.mockImplementationOnce(() => {
      readDuringApply = agentSettingsClient.get();
    });

    bridge.push(saved);

    expect(store.applySaved).toHaveBeenCalledWith(saved);
    await expect(readDuringApply).resolves.toBe(saved);
  });

  it("reads again after a host resync and when a cached view returns", () => {
    dispose = initAgentSettingsSync();

    notifyHostResync();
    lifecycle.emit("cached");
    lifecycle.emit("active");

    expect(store.refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps what it had when the host can't be read", async () => {
    store.refresh.mockRejectedValueOnce(new Error("link down"));
    dispose = initAgentSettingsSync();

    notifyHostResync();
    await Promise.resolve();

    expect(store.applySaved).not.toHaveBeenCalled();
  });

  it("stops listening on dispose", () => {
    dispose = initAgentSettingsSync();
    dispose();

    expect(bridge.hasListener()).toBe(false);
    notifyHostResync();
    lifecycle.emit("active");
    expect(store.refresh).not.toHaveBeenCalled();
  });
});
