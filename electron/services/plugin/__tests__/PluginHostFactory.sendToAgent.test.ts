import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const consentMock = vi.hoisted(() => ({
  ensureAllowed: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: vi.fn(() => null) }));
vi.mock("../../forgeProviderRegistry.js", () => ({
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
}));
vi.mock("../../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn(() => false),
}));
vi.mock("../../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: vi.fn(() => ({ append: vi.fn(), getRecords: vi.fn(() => []) })),
}));
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => consentMock),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { AppError } from "../../../utils/errorTypes.js";
import { UNBOUND_PLUGIN_HOST_BINDING } from "../../../../shared/types/plugin.js";
import type { PluginAgentPane, PluginHostBinding } from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";
const PROJECT_A = "project-a";
const BOUND: PluginHostBinding = {
  projectId: PROJECT_A,
  projectRoot: path.join(path.sep, "repos", "alpha"),
};

const PANE: PluginAgentPane = {
  terminalId: "t-1",
  title: "Claude: auth",
  agentId: "claude",
  worktree: { id: "wt-1", name: "main" },
  isFocused: true,
  canDraft: true,
};

function makeHarness(
  capabilities: string[] = ["agent:input", "agent:read"],
  displayName = "Acme Board"
) {
  const plugin = {
    // Not builtin, so the just-in-time consent gate actually runs.
    isBuiltin: false,
    binding: BOUND,
    manifest: { name: PLUGIN_ID, displayName: "Acme Board", capabilities },
  } as unknown as LoadedPlugin;
  const plugins = new Map<string, LoadedPlugin>([[PLUGIN_ID, plugin]]);
  const requestPrompt = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
    status: "drafted",
    terminalId: "t-1",
  }));
  const sendAgentsListToRenderer = vi.fn(
    async (..._args: unknown[]): Promise<PluginAgentPane[]> => [PANE]
  );
  const deps = {
    plugins,
    pluginEventCleanups: new Map(),
    pluginActions: new Map(),
    pluginActionHandlers: new Map(),
    pluginActionOwners: new Map(),
    actionValidators: new Map(),
    pluginBadges: new Map(),
    pluginFsWatchers: new Map(),
    broadcaster: { broadcastPluginActions: vi.fn() },
    panelLifecycleBroker: { subscribe: vi.fn(() => () => {}) },
    dispatcher: { sendAgentsListToRenderer },
    promptDispatcher: { requestPrompt },
    settings: {},
    storage: {},
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    declaredCapabilities: () => new Set(capabilities),
    fetchWorktreeSnapshotsResult: vi.fn(),
    fetchWorktreeSnapshotsForProjectResult: vi.fn(),
    recordPluginLog: vi.fn(),
    serializePluginBadges: () => ({}),
    pluginDisplayName: () => displayName,
    pluginDataDir: () => path.join(path.sep, "tmp", "data"),
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [],
    subscribeWorktreeEvent: vi.fn(() => () => {}),
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;
  return { deps, plugins, requestPrompt, sendAgentsListToRenderer };
}

beforeEach(() => {
  vi.clearAllMocks();
  consentMock.ensureAllowed.mockImplementation(async () => undefined);
});

describe("host.sendToAgent", () => {
  it("asks the bound project's renderer, with the plugin's own name as the source", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    const result = await host.sendToAgent("Card body", { title: "Fix login", worktreeId: "wt-1" });

    expect(result).toEqual({ status: "drafted", terminalId: "t-1" });
    expect(h.requestPrompt).toHaveBeenCalledWith(
      PLUGIN_ID,
      {
        kind: "sendToAgent",
        request: {
          text: "Card body",
          title: "Fix login",
          worktreeId: "wt-1",
          sourceLabel: "Acme Board",
        },
      },
      PROJECT_A,
      undefined
    );
    expect(consentMock.ensureAllowed).toHaveBeenCalledWith(
      PLUGIN_ID,
      "Acme Board",
      "agent:input",
      ["agent:input", "agent:read"],
      PROJECT_A
    );
  });

  it("holds an unbounded display name to one clean line before it reaches a draft", async () => {
    const h = makeHarness(undefined, `Acme\r\u001b]0;owned\u0007\u009b Board${"!".repeat(300)}`);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await host.sendToAgent("x");
    const [, params] = h.requestPrompt.mock.calls[0]!;
    const label = (params as { request: { sourceLabel: string } }).request.sourceLabel;
    expect(label.startsWith("Acme ]0;owned")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(80);
    const printable = [...label].every((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    });
    expect(printable).toBe(true);
  });

  it("rejects PERMISSION_REQUIRED without agent:input, before any prompt", async () => {
    const h = makeHarness(["agent:read"]);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(host.sendToAgent("x")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    expect(h.requestPrompt).not.toHaveBeenCalled();
  });

  it("propagates a consent denial and drafts nothing", async () => {
    consentMock.ensureAllowed.mockRejectedValue(new Error("PERMISSION_REQUIRED: denied"));
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(host.sendToAgent("x")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(h.requestPrompt).not.toHaveBeenCalled();
  });

  it.each<[string, string, unknown]>([
    ["blank text", "   ", undefined],
    ["over-long text", "x".repeat(32_769), undefined],
    ["an over-long title", "x", { title: "t".repeat(121) }],
    ["a non-string title", "x", { title: 5 }],
    ["an empty terminalId", "x", { terminalId: "" }],
    ["a non-object options", "x", "t-1"],
  ])("validates %s before asking for consent", async (_name, text, options) => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(host.sendToAgent(text, options as never)).rejects.toThrow(/sendToAgent/);
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    expect(h.requestPrompt).not.toHaveBeenCalled();
  });

  it("forwards a named target and a caller signal", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const controller = new AbortController();
    await host.sendToAgent("x", { terminalId: "t-9" }, { signal: controller.signal });
    const [, params, , signal] = h.requestPrompt.mock.calls[0]!;
    expect(params).toMatchObject({ request: { terminalId: "t-9" } });
    expect(signal).toBe(controller.signal);
  });

  it("refuses as project-unavailable when the project has no view", async () => {
    const h = makeHarness();
    h.requestPrompt.mockRejectedValue(
      new AppError({ code: "PROJECT_VIEW_UNAVAILABLE", message: "no view" })
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(host.sendToAgent("x")).resolves.toEqual({
      status: "refused",
      reason: "project-unavailable",
    });
  });

  it.each<[string, unknown, unknown]>([
    ["a dismissal", { status: "cancelled" }, { status: "cancelled" }],
    [
      "a refusal",
      { status: "refused", reason: "input-locked" },
      { status: "refused", reason: "input-locked" },
    ],
    [
      "a refusal naming a created worktree",
      { status: "refused", reason: "launch-failed", worktreeId: "wt-new", extra: 1 },
      { status: "refused", reason: "launch-failed", worktreeId: "wt-new" },
    ],
    ["an unknown refusal reason", { status: "refused", reason: "bogus" }, { status: "cancelled" }],
    ["a malformed answer", "drafted", { status: "cancelled" }],
  ])("normalises %s from the renderer", async (_name, answer, expected) => {
    const h = makeHarness();
    h.requestPrompt.mockResolvedValue(answer);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(host.sendToAgent("x")).resolves.toEqual(expected);
  });

  it("resolves cancelled once the plugin is unloaded", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    h.plugins.delete(PLUGIN_ID);
    await expect(host.sendToAgent("x")).resolves.toEqual({ status: "cancelled" });
    expect(h.requestPrompt).not.toHaveBeenCalled();
  });
});

describe("host.agents.list", () => {
  it("reads the bound project's renderer and nothing else", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(host.agents.list()).resolves.toEqual([PANE]);
    expect(h.sendAgentsListToRenderer).toHaveBeenCalledWith(PROJECT_A);
  });

  it("stays ambient for an unbound plugin", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await host.agents.list();
    expect(h.sendAgentsListToRenderer).toHaveBeenCalledWith(null);
  });

  it("requires agent:read", async () => {
    const h = makeHarness(["agent:input"]);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(host.agents.list()).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(h.sendAgentsListToRenderer).not.toHaveBeenCalled();
  });

  it("answers [] when the project has no view", async () => {
    const h = makeHarness();
    h.sendAgentsListToRenderer.mockRejectedValue(
      new AppError({ code: "PROJECT_VIEW_UNAVAILABLE", message: "no view" })
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(host.agents.list()).resolves.toEqual([]);
  });
});
