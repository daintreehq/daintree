import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));

vi.mock("electron-store", async () => {
  const conf = await import("conf");
  return { default: conf.default };
});

vi.mock("../../utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)({}, ...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../menu.js", () => ({
  createApplicationMenu: vi.fn(),
}));

vi.mock("../../../services/AgentHelpService.js", () => ({
  AgentHelpService: class {
    getHelp = vi.fn();
  },
}));

import { CHANNELS } from "../../channels.js";
import { registerAiHandlers } from "../ai.js";
import { _resetStoreInstance, initializeStore, store } from "../../../store.js";
import { getUserRegistry, setUserRegistry } from "../../../../shared/config/agentRegistry.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("APP_RELOAD_CONFIG against a real config.json", () => {
  let tempDir: string;
  let configPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-reload-config-"));
    configPath = path.join(tempDir, "config.json");
    _resetStoreInstance();
    initializeStore({
      defaults: { _schemaVersion: 0, agentSettings: { agents: {} }, userAgentRegistry: {} },
      cwd: tempDir,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    cleanup = registerAiHandlers({} as never);
  });

  afterEach(() => {
    cleanup();
    setUserRegistry({});
    _resetStoreInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function editConfigOnDisk(mutate: (config: Record<string, unknown>) => void): void {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    mutate(config);
    fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  }

  it("serves agent settings edited on disk after a reload", async () => {
    const getSettings = getInvokeHandler(CHANNELS.AGENT_SETTINGS_GET);
    expect(await getSettings()).toEqual({ agents: {} });

    const account = {
      id: "account-1",
      name: "Test",
      configDir: path.join(tempDir, ".claude-test"),
    };
    editConfigOnDisk((config) => {
      config.agentSettings = { agents: { claude: { accounts: [account] } } };
    });

    await getInvokeHandler(CHANNELS.APP_RELOAD_CONFIG)();

    expect(await getSettings()).toEqual({ agents: { claude: { accounts: [account] } } });
  });

  it("keeps an on-disk edit when a settings write follows the reload", async () => {
    expect(store.get("agentSettings")).toEqual({ agents: {} });

    const account = {
      id: "account-1",
      name: "Test",
      configDir: path.join(tempDir, ".claude-test"),
    };
    editConfigOnDisk((config) => {
      config.agentSettings = { agents: { claude: { accounts: [account] } } };
    });

    await getInvokeHandler(CHANNELS.APP_RELOAD_CONFIG)();
    store.set("_schemaVersion", 1);

    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(onDisk.agentSettings).toEqual({ agents: { claude: { accounts: [account] } } });
  });

  it("loads a hand-edited user agent registry on reload", async () => {
    expect(store.get("userAgentRegistry")).toEqual({});

    const agent = {
      id: "my-agent",
      name: "My Agent",
      command: "my-agent",
      color: "#123456",
      iconId: "terminal",
      supportsContextInjection: false,
    };
    editConfigOnDisk((config) => {
      config.userAgentRegistry = { [agent.id]: agent };
    });

    await getInvokeHandler(CHANNELS.APP_RELOAD_CONFIG)();

    expect(getUserRegistry()).toEqual({ [agent.id]: agent });
  });
});
