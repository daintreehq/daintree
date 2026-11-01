// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefaultsSnapshot, AgentSettings, TerminalConfig } from "@shared/types";
import type { HydrateResult } from "@shared/types/ipc/app";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";

const bootMock = vi.hoisted(() => ({ getSafeBootPromise: vi.fn() }));
vi.mock("@/lib/bootPromise", () => bootMock);
vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => true,
  isRemoteHostSupported: () => true,
  isEitherRemoteRoleSupported: () => true,
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/store/pluginRuntimeStore", () => ({
  usePluginRuntimeStore: { getState: () => ({ refresh: vi.fn() }) },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      panelsById: {},
      panelIds: [],
      watchedPanels: new Set<string>(),
      updateAgentState: vi.fn(),
      setRuntimeStatus: vi.fn(),
    }),
  },
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  createTerminalPaintPlane: () => ({ setAgentState: vi.fn(), reportLost: vi.fn() }),
}));
vi.mock("@/store/slices/panelRegistry/helpers", () => ({
  deriveRuntimeStatus: () => "running",
}));

import { _resetHostConnectionSyncForTesting, resyncFromHost } from "../useHostConnection";
import {
  __resetTerminalConfigSyncForTests,
  initTerminalConfigSync,
} from "@/services/terminalConfigSync";
import { initAgentSettingsSync } from "@/services/agentSettingsSync";
import { initAgentDefaultsSync } from "@/services/agentDefaultsSync";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { cleanupAgentSettingsStore, useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";

const LEASE: DriveLeaseView = {
  projectId: "proj-1",
  holder: null,
  drivingHere: true,
  isHolderEndpoint: false,
  viewerIsHostLocal: false,
};

const BOOT_SETTINGS = {
  terminalConfig: { scrollbackLines: 1000 } as TerminalConfig,
  agentDefaults: { defaultAgent: "claude" } as AgentDefaultsSnapshot,
};

const HYDRATED = {
  terminalConfig: { scrollbackLines: 5000 } as TerminalConfig,
  agentSettings: { agents: { claude: { customFlags: "--hydrated" } } } as AgentSettings,
  agentDefaults: { defaultAgent: "codex" } as AgentDefaultsSnapshot,
};

const READ = {
  terminalConfig: { scrollbackLines: 3000 } as TerminalConfig,
  agentSettings: { agents: { claude: { customFlags: "--read" } } } as AgentSettings,
  agentDefaults: { defaultAgent: "gemini" } as AgentDefaultsSnapshot,
};

function settingsBridge<T>(value: T) {
  return { get: vi.fn(async () => value), onChanged: vi.fn(() => () => {}) };
}

function installElectron() {
  const electron = {
    driveLease: {
      get: vi.fn(async () => LEASE),
      onEvent: vi.fn(() => () => {}),
    },
    worktree: { refresh: vi.fn(async () => undefined) },
    worktreePort: { request: vi.fn(async () => undefined) },
    terminal: {
      getForProject: vi.fn(async (): Promise<unknown[]> => []),
      reconnectBulk: vi.fn(async () => ({})),
    },
    app: {
      hydrate: vi.fn(
        async () =>
          ({
            ...HYDRATED,
            appState: { terminals: [] },
            project: { id: "proj-1", path: "/repo" },
            workspaceId: "proj-1",
            draftInputs: {},
          }) as unknown as HydrateResult
      ),
    },
    terminalConfig: settingsBridge(READ.terminalConfig),
    agentSettings: settingsBridge(READ.agentSettings),
    agentDefaults: {
      ...settingsBridge(READ.agentDefaults),
      set: vi.fn(),
      migrateLegacy: vi.fn(),
    },
  };
  Object.defineProperty(window, "electron", {
    value: electron,
    writable: true,
    configurable: true,
  });
  return electron;
}

function settingsGets(electron: ReturnType<typeof installElectron>) {
  return [electron.terminalConfig.get, electron.agentSettings.get, electron.agentDefaults.get];
}

function applied() {
  return {
    scrollbackLines: useScrollbackStore.getState().scrollbackLines,
    customFlags: useAgentSettingsStore.getState().settings?.agents.claude?.customFlags,
    defaultAgent: useAgentPreferencesStore.getState().defaultAgent,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeAll(async () => {
  await import("@/utils/stateHydration/statePatcher");
});

describe("settings after a host resync (#15899)", () => {
  let disposers: Array<() => void> = [];

  beforeEach(async () => {
    _resetHostConnectionSyncForTesting();
    __resetTerminalConfigSyncForTests();
    cleanupAgentSettingsStore();
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    window.__DAINTREE_INITIAL_PROJECT__ = { id: "proj-1" };
    bootMock.getSafeBootPromise.mockResolvedValue({ ok: true, result: BOOT_SETTINGS });
  });

  afterEach(() => {
    for (const dispose of disposers) dispose();
    disposers = [];
    _resetHostConnectionSyncForTesting();
  });

  async function startSyncs(electron: ReturnType<typeof installElectron>) {
    disposers = [initTerminalConfigSync(), initAgentSettingsSync(), initAgentDefaultsSync()];
    await vi.waitFor(() => expect(applied().defaultAgent).toBe("claude"));
    expect(applied().scrollbackLines).toBe(1000);
    for (const get of settingsGets(electron)) get.mockClear();
  }

  it("takes a fresh session's settings from its hydrate answer without asking again", async () => {
    const electron = installElectron();
    await startSyncs(electron);

    await resyncFromHost({ freshSession: true });
    await vi.waitFor(() =>
      expect(applied()).toEqual({
        scrollbackLines: 5000,
        customFlags: "--hydrated",
        defaultAgent: "codex",
      })
    );
    await flush();

    expect(electron.app.hydrate).toHaveBeenCalledTimes(1);
    for (const get of settingsGets(electron)) expect(get).not.toHaveBeenCalled();
  });

  it("reads each setting on a resumed session, which hydrates nothing", async () => {
    const electron = installElectron();
    await startSyncs(electron);

    await resyncFromHost();
    await vi.waitFor(() =>
      expect(applied()).toEqual({
        scrollbackLines: 3000,
        customFlags: "--read",
        defaultAgent: "gemini",
      })
    );

    expect(electron.app.hydrate).not.toHaveBeenCalled();
    for (const get of settingsGets(electron)) expect(get).toHaveBeenCalledTimes(1);
  });

  it("reads each setting when a fresh session's hydrate fails", async () => {
    const electron = installElectron();
    electron.app.hydrate.mockRejectedValueOnce(new Error("link dropped"));
    await startSyncs(electron);

    await resyncFromHost({ freshSession: true });
    await vi.waitFor(() =>
      expect(applied()).toEqual({
        scrollbackLines: 3000,
        customFlags: "--read",
        defaultAgent: "gemini",
      })
    );

    expect(electron.app.hydrate).toHaveBeenCalledTimes(1);
    for (const get of settingsGets(electron)) expect(get).toHaveBeenCalledTimes(1);
  });
});
