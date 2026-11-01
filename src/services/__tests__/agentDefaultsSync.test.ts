// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefaultsSnapshot } from "@shared/types";

const bootMock = vi.hoisted(() => ({
  getSafeBootPromise: vi.fn(),
}));
vi.mock("@/lib/bootPromise", () => bootMock);

const hostMock = vi.hoisted(() => ({ isRemoteWindow: vi.fn(() => false) }));
vi.mock("@/hooks/useHostPlatform", () => hostMock);

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

const clientMock = vi.hoisted(() => {
  let listener: ((snapshot: AgentDefaultsSnapshot) => void) | null = null;
  return {
    get: vi.fn<() => Promise<AgentDefaultsSnapshot>>(),
    set: vi.fn<() => Promise<AgentDefaultsSnapshot>>(),
    migrateLegacy: vi.fn<(c: AgentDefaultsSnapshot) => Promise<AgentDefaultsSnapshot>>(),
    onChanged: vi.fn((cb: (snapshot: AgentDefaultsSnapshot) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    push: (snapshot: AgentDefaultsSnapshot) => listener?.(snapshot),
  };
});
vi.mock("@/clients/agentDefaultsClient", () => ({ agentDefaultsClient: clientMock }));

import { initAgentDefaultsSync } from "../agentDefaultsSync";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { notifyHostResync, type HydratedSettings } from "@/store/hostResyncSignal";

function boot(agentDefaults?: AgentDefaultsSnapshot) {
  bootMock.getSafeBootPromise.mockResolvedValue({ ok: true, result: { agentDefaults } });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function putLegacy(key: string, state: unknown): void {
  localStorage.setItem(key, JSON.stringify({ state, version: 6 }));
}

function stored(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}

describe("initAgentDefaultsSync (#13345)", () => {
  let dispose: () => void = () => {};

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    hostMock.isRemoteWindow.mockReturnValue(false);
    clientMock.migrateLegacy.mockImplementation(async (candidates) => candidates);
    Object.defineProperty(window, "electron", {
      value: { agentDefaults: {} },
      configurable: true,
      writable: true,
    });
    useAgentPreferencesStore.setState({ defaultAgent: undefined });
    useHelpPanelStore.setState({
      preferredAgentId: null,
      hostAssistantAgentId: null,
      droppedPreferredAgentId: null,
      dismissedDroppedAgentId: null,
      agentSwitchRequest: null,
    });
    useCliAvailabilityStore.setState({ hasRealData: false, lastCheckedAt: null });
  });

  afterEach(() => {
    dispose();
    localStorage.clear();
  });

  it("seeds both mirrors from the host's boot payload", async () => {
    boot({ assistantAgentId: "claude", defaultAgent: "codex" });
    dispose = initAgentDefaultsSync();
    await settle();

    expect(useHelpPanelStore.getState().preferredAgentId).toBe("claude");
    expect(useAgentPreferencesStore.getState().defaultAgent).toBe("codex");
  });

  it("lets a push that beat the boot payload stand", async () => {
    let resolveBoot: (value: unknown) => void = () => {};
    bootMock.getSafeBootPromise.mockReturnValue(new Promise((resolve) => (resolveBoot = resolve)));
    dispose = initAgentDefaultsSync();

    clientMock.push({ assistantAgentId: "codex" });
    resolveBoot({ ok: true, result: { agentDefaults: { assistantAgentId: "claude" } } });
    await settle();

    expect(useHelpPanelStore.getState().preferredAgentId).toBe("codex");
  });

  it("applies a push without writing back or queuing a session switch", async () => {
    boot({});
    dispose = initAgentDefaultsSync();
    await settle();

    clientMock.push({ assistantAgentId: "codex", defaultAgent: "claude" });

    expect(useHelpPanelStore.getState().preferredAgentId).toBe("codex");
    expect(useHelpPanelStore.getState().agentSwitchRequest).toBeNull();
    expect(useAgentPreferencesStore.getState().defaultAgent).toBe("claude");
    expect(clientMock.set).not.toHaveBeenCalled();
  });

  it("moves this machine's values to the host once, then deletes them", async () => {
    putLegacy("help-panel-storage", { width: 400, preferredAgentId: "claude" });
    putLegacy("daintree-agent-preferences", { defaultAgent: "codex" });
    boot({});
    dispose = initAgentDefaultsSync();
    await settle();

    expect(clientMock.migrateLegacy).toHaveBeenCalledWith({
      assistantAgentId: "claude",
      defaultAgent: "codex",
    });
    expect(useHelpPanelStore.getState().preferredAgentId).toBe("claude");
    expect(localStorage.getItem("daintree-agent-preferences")).toBeNull();
    expect(stored("help-panel-storage")).toEqual({ state: { width: 400 }, version: 6 });
  });

  it("takes the host's answer when it already had a value", async () => {
    putLegacy("help-panel-storage", { preferredAgentId: "claude" });
    clientMock.migrateLegacy.mockResolvedValue({ assistantAgentId: "codex" });
    boot({ assistantAgentId: "codex" });
    dispose = initAgentDefaultsSync();
    await settle();

    expect(useHelpPanelStore.getState().preferredAgentId).toBe("codex");
    expect(stored("help-panel-storage")).toEqual({ state: {}, version: 6 });
  });

  it("never sends or deletes this Shell's values from a remote window", async () => {
    hostMock.isRemoteWindow.mockReturnValue(true);
    putLegacy("help-panel-storage", { preferredAgentId: "claude" });
    boot({ assistantAgentId: "codex" });
    dispose = initAgentDefaultsSync();
    await settle();

    expect(clientMock.migrateLegacy).not.toHaveBeenCalled();
    expect(useHelpPanelStore.getState().preferredAgentId).toBe("codex");
    expect(stored("help-panel-storage")).toEqual({
      state: { preferredAgentId: "claude" },
      version: 6,
    });
  });

  it("keeps the legacy values for the next boot when the move fails", async () => {
    putLegacy("daintree-agent-preferences", { defaultAgent: "codex" });
    clientMock.migrateLegacy.mockRejectedValue(new Error("link down"));
    boot({});
    dispose = initAgentDefaultsSync();
    await settle();

    expect(clientMock.migrateLegacy).toHaveBeenCalledWith({ defaultAgent: "codex" });
    expect(localStorage.getItem("daintree-agent-preferences")).not.toBeNull();
  });

  it("keeps the source of a default the host didn't confirm holding", async () => {
    // A host whose store fell back to memory answers without the leaf.
    putLegacy("daintree-agent-preferences", { defaultAgent: "codex" });
    clientMock.migrateLegacy.mockResolvedValue({});
    boot({});
    dispose = initAgentDefaultsSync();
    await settle();

    expect(localStorage.getItem("daintree-agent-preferences")).not.toBeNull();
  });

  it("never sends a fresh remote host this Shell's values", async () => {
    hostMock.isRemoteWindow.mockReturnValue(true);
    putLegacy("help-panel-storage", { preferredAgentId: "claude" });
    putLegacy("daintree-agent-preferences", { defaultAgent: "codex" });
    boot({});
    dispose = initAgentDefaultsSync();
    await settle();

    expect(clientMock.migrateLegacy).not.toHaveBeenCalled();
    expect(useHelpPanelStore.getState().preferredAgentId).toBeNull();
    expect(useAgentPreferencesStore.getState().defaultAgent).toBeUndefined();
    expect(localStorage.getItem("daintree-agent-preferences")).not.toBeNull();
  });

  it("lets a push that lands during migration stand over the migration's reply", async () => {
    putLegacy("help-panel-storage", { preferredAgentId: "claude" });
    let resolveMigration: (snapshot: AgentDefaultsSnapshot) => void = () => {};
    clientMock.migrateLegacy.mockReturnValue(
      new Promise((resolve) => (resolveMigration = resolve))
    );
    boot({});
    dispose = initAgentDefaultsSync();
    await settle();

    clientMock.push({ assistantAgentId: "codex" });
    resolveMigration({ assistantAgentId: "claude" });
    await settle();

    expect(useHelpPanelStore.getState().preferredAgentId).toBe("codex");
  });

  it("cleans up against the host's newest word, not a reply a push overtook", async () => {
    putLegacy("help-panel-storage", { preferredAgentId: "claude" });
    let resolveMigration: (snapshot: AgentDefaultsSnapshot) => void = () => {};
    clientMock.migrateLegacy.mockReturnValue(
      new Promise((resolve) => (resolveMigration = resolve))
    );
    boot({});
    dispose = initAgentDefaultsSync();
    await settle();

    // An import rolled back to "never set" after the host took the value.
    clientMock.push({});
    resolveMigration({ assistantAgentId: "claude" });
    await settle();

    expect(stored("help-panel-storage")).toEqual({
      state: { preferredAgentId: "claude" },
      version: 6,
    });
  });

  it("refetches the host's defaults after a dropped link", async () => {
    boot({ assistantAgentId: "claude" });
    dispose = initAgentDefaultsSync();
    await settle();

    clientMock.get.mockResolvedValue({ assistantAgentId: "codex", defaultAgent: "gemini" });
    notifyHostResync();
    await settle();

    expect(useHelpPanelStore.getState().preferredAgentId).toBe("codex");
    expect(useAgentPreferencesStore.getState().defaultAgent).toBe("gemini");
  });

  it("takes the host's defaults from a fresh session's hydrate answer, and reads an older host's", async () => {
    boot({ assistantAgentId: "claude" });
    dispose = initAgentDefaultsSync();
    await settle();
    const hydrated = (agentDefaults: AgentDefaultsSnapshot | undefined) => ({
      hydrated: Promise.resolve({
        terminalConfig: undefined,
        agentSettings: undefined,
        agentDefaults,
      }),
    });

    notifyHostResync(hydrated({ assistantAgentId: "codex", defaultAgent: "gemini" }));
    await settle();
    expect(clientMock.get).not.toHaveBeenCalled();
    expect(useAgentPreferencesStore.getState().defaultAgent).toBe("gemini");

    clientMock.get.mockResolvedValue({ assistantAgentId: "codex", defaultAgent: "codex" });
    notifyHostResync(hydrated(undefined));
    await settle();
    expect(clientMock.get).toHaveBeenCalledTimes(1);
    expect(useAgentPreferencesStore.getState().defaultAgent).toBe("codex");
  });

  it("drops a hydrate answer that a push overtook while the resync waited", async () => {
    boot({ assistantAgentId: "claude" });
    dispose = initAgentDefaultsSync();
    await settle();
    let answer: (agentDefaults: AgentDefaultsSnapshot) => void = () => {};
    const hydrated = new Promise<HydratedSettings>((resolve) => {
      answer = (agentDefaults) =>
        resolve({ terminalConfig: undefined, agentSettings: undefined, agentDefaults });
    });

    notifyHostResync({ hydrated });
    clientMock.push({ assistantAgentId: "codex", defaultAgent: "codex" });
    answer({ assistantAgentId: "claude", defaultAgent: "gemini" });
    await settle();

    expect(useAgentPreferencesStore.getState().defaultAgent).toBe("codex");
  });

  it("does nothing without the agent defaults bridge", () => {
    Object.defineProperty(window, "electron", { value: {}, configurable: true, writable: true });
    putLegacy("daintree-agent-preferences", { defaultAgent: "codex" });

    dispose = initAgentDefaultsSync();

    expect(clientMock.onChanged).not.toHaveBeenCalled();
    expect(bootMock.getSafeBootPromise).not.toHaveBeenCalled();
  });

  it("re-resolves the assistant agent when the host's CLI availability lands", async () => {
    boot({ assistantAgentId: "claude" });
    dispose = initAgentDefaultsSync();
    await settle();
    expect(useHelpPanelStore.getState().preferredAgentId).toBe("claude");

    useCliAvailabilityStore.setState((state) => ({
      hasRealData: true,
      lastCheckedAt: Date.now(),
      availability: { ...state.availability, claude: "missing" },
    }));

    expect(useHelpPanelStore.getState().preferredAgentId).toBeNull();
    expect(useHelpPanelStore.getState().droppedPreferredAgentId).toBe("claude");
    expect(useHelpPanelStore.getState().hostAssistantAgentId).toBe("claude");
    expect(clientMock.set).not.toHaveBeenCalled();
  });

  it("doesn't drop the host's choice on this machine's startup cache alone", async () => {
    boot({ assistantAgentId: "claude" });
    dispose = initAgentDefaultsSync();
    await settle();

    // The cache can describe whichever host last wrote it.
    useCliAvailabilityStore.setState((state) => ({
      hasRealData: true,
      lastCheckedAt: null,
      availability: { ...state.availability, claude: "missing" },
    }));

    expect(useHelpPanelStore.getState().preferredAgentId).toBe("claude");
    expect(useHelpPanelStore.getState().droppedPreferredAgentId).toBeNull();
  });
});
