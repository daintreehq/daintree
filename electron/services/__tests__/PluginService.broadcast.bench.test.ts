// Benchmark for plugin contribution broadcasting at startup.
// Prints metrics with PLUGIN_BROADCAST_BENCH=1; the assertions pin the batched shape:
// initialize() over the four real builtins plus N fixture plugins sends one
// `broadcastToRenderer` snapshot per contribution channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { performance } from "perf_hooks";

const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});

vi.mock("electron", () => ({
  app: { getVersion: vi.fn(() => "0.0.0"), getPath: vi.fn(() => "/tmp/daintree-bench") },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  setMainWindow: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getProjectById: vi.fn(() => null),
  },
}));
vi.mock("../PluginMcpSupervisor.js", () => ({
  getPluginMcpSupervisor: () => ({
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    shutdownAll: vi.fn(async () => undefined),
    list: vi.fn(() => []),
  }),
}));

import { PluginService, pluginService } from "../PluginService.js";
import { clearPanelKindRegistry } from "../../../shared/config/panelKindRegistry.js";
import { clearToolbarButtonRegistry } from "../../../shared/config/toolbarButtonRegistry.js";
import { clearPluginKeybindingRegistry } from "../pluginKeybindingRegistry.js";
import { clearPluginContextMenuRegistry } from "../pluginContextMenuRegistry.js";
import { clearPluginMenuRegistry } from "../pluginMenuRegistry.js";
import { clearForgeProviderRegistry } from "../forgeProviderRegistry.js";
import {
  clearFileDecorationImplRegistry,
  clearFileDecorationRegistry,
} from "../fileDecorationRegistry.js";

const REPORT = process.env.PLUGIN_BROADCAST_BENCH === "1";
const BUILTIN_ROOT = path.resolve(__dirname, "../../../plugins/builtin");
const FIXTURE_PLUGINS = 20;

let tmpDir: string;
const services: PluginService[] = [];

// The module singleton subscribes to the shared panel-kind registry at import;
// production has exactly one service, so the bench must too.
pluginService.dispose();

function report(label: string, metrics: Record<string, number | string>): void {
  if (!REPORT) return;
  process.stdout.write(`[plugin-broadcast-bench] ${label} ${JSON.stringify(metrics)}\n`);
}

function eventCalls(): Array<{ name: string; bytes: number }> {
  return broadcastToRendererMock.mock.calls.map((call) => {
    const envelope = call[1] as { name: string };
    return { name: envelope?.name ?? String(call[0]), bytes: JSON.stringify(call[1]).length };
  });
}

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function makeService(pluginsRoot: string, builtinRoot?: string): PluginService {
  const service = new PluginService(pluginsRoot, "0.0.0", {
    builtinPluginsRoot: builtinRoot ?? path.join(tmpDir, "no-builtins"),
    globalConfigDir: path.join(tmpDir, "config"),
    blocklistService: {
      getBlocklist: async () => null,
      getStartupBlocklist: async () => ({ blocklist: null, refreshed: null }),
    } as never,
  });
  services.push(service);
  return service;
}

async function writeFixturePlugin(root: string, index: number): Promise<void> {
  const name = `acme.fixture-${index}`;
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const commands = Array.from({ length: 3 }, (_, i) => ({
    id: `cmd-${i}`,
    title: `Command ${i}`,
    description: `Fixture command ${i} of plugin ${index}`,
    category: "Fixture",
    kind: "command",
    danger: "safe",
    inputSchema: { type: "object", properties: { target: { type: "string" } } },
  }));
  await fs.writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      contributes: {
        commands,
        panels: [{ id: "viewer", name: `Viewer ${index}`, iconId: "eye", color: "#0af" }],
        toolbarButtons: [
          { id: "btn", label: `Button ${index}`, iconId: "eye", actionId: `${name}.cmd-0` },
        ],
        keybindings: [{ actionId: `${name}.cmd-1`, combo: `Cmd+Alt+${index % 10}` }],
        contextMenus: [{ actionId: `${name}.cmd-2`, location: "worktree", label: "Fixture" }],
      },
    })
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-bench-"));
  storeMock._state.clear();
  broadcastToRendererMock.mockClear();
});

afterEach(async () => {
  await drain();
  for (const service of services.splice(0)) service.dispose();
  clearPanelKindRegistry();
  clearToolbarButtonRegistry();
  clearPluginKeybindingRegistry();
  clearPluginContextMenuRegistry();
  clearPluginMenuRegistry();
  clearForgeProviderRegistry();
  clearFileDecorationRegistry();
  clearFileDecorationImplRegistry();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("plugin broadcast benchmark", () => {
  it(`initialize() with 4 builtins + ${FIXTURE_PLUGINS} fixtures sends one snapshot per channel`, async () => {
    const root = path.join(tmpDir, "user");
    for (let i = 0; i < FIXTURE_PLUGINS; i++) await writeFixturePlugin(root, i);
    const service = makeService(root, BUILTIN_ROOT);

    const t0 = performance.now();
    await service.initialize();
    await drain();
    const initMs = performance.now() - t0;

    const calls = eventCalls();
    const perChannel: Record<string, number> = {};
    for (const c of calls) perChannel[c.name] = (perChannel[c.name] ?? 0) + 1;
    const bytes = calls.reduce((sum, c) => sum + c.bytes, 0);
    report("initialize", { total: calls.length, bytes, initMs, ...perChannel });

    expect(service.listPlugins()).toHaveLength(4 + FIXTURE_PLUGINS);
    const contributionChannels = [
      "plugin:actions-changed",
      "plugin:panel-kinds-changed",
      "plugin:toolbar-buttons-changed",
      "plugin:keybindings-changed",
      "plugin:context-menu-items-changed",
    ];
    for (const name of contributionChannels) expect(perChannel[name]).toBe(1);

    const lastPayload = (name: string) =>
      (
        broadcastToRendererMock.mock.calls.filter((call) => call[1]?.name === name).at(-1)?.[1] as {
          payload: Record<string, Array<{ id?: string; pluginId?: string; extensionId?: string }>>;
        }
      ).payload;
    const last = `acme.fixture-${FIXTURE_PLUGINS - 1}`;
    expect(lastPayload("plugin:actions-changed").actions?.map((a) => a.id)).toEqual(
      expect.arrayContaining(["acme.fixture-0.cmd-0", `${last}.cmd-2`])
    );
    expect(lastPayload("plugin:panel-kinds-changed").kinds?.map((k) => k.extensionId)).toEqual(
      expect.arrayContaining(["acme.fixture-0", last])
    );
    for (const [name, key] of [
      ["plugin:toolbar-buttons-changed", "buttons"],
      ["plugin:keybindings-changed", "keybindings"],
      ["plugin:context-menu-items-changed", "items"],
    ] as const) {
      expect(lastPayload(name)[key]).toHaveLength(FIXTURE_PLUGINS);
    }
  });
});
