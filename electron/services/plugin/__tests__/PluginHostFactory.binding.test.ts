import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const ipcUtilsMock = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
const serviceRefsMock = vi.hoisted(() => ({
  getPtyClient: vi.fn((): unknown => null),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: ipcUtilsMock.broadcastToRenderer,
  broadcastToProjectRenderers: ipcUtilsMock.broadcastToProjectRenderers,
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: serviceRefsMock.getPtyClient,
}));
vi.mock("../../forgeProviderRegistry.js", () => ({
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
}));
vi.mock("../../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((scope: string, pattern: string) => scope === pattern),
}));
vi.mock("../../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: vi.fn(() => ({ append: vi.fn(), getRecords: vi.fn(() => []) })),
}));
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed: vi.fn(async () => undefined) })),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import {
  createHost,
  type PluginHostFactoryDeps,
  type PluginWorktreeSnapshotFetchResult,
} from "../PluginHostFactory.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { events } from "../../events.js";
import { AppError } from "../../../utils/errorTypes.js";
import { UNBOUND_PLUGIN_HOST_BINDING } from "../../../../shared/types/plugin.js";
import type { PluginHostBinding } from "../../../../shared/types/plugin.js";
import type { WorktreeSnapshot } from "../../../../shared/types/workspace-host.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";

/** An available, project-scoped read — the shape the factory deps now return. */
const okFetch = (
  snapshots: WorktreeSnapshot[],
  projectId = PROJECT_A
): PluginWorktreeSnapshotFetchResult => ({ status: "ok", projectId, snapshots });
const PROJECT_A = "project-a";
const ROOT_A = path.join(path.sep, "repos", "alpha");
const ROOT_B = path.join(path.sep, "repos", "beta");

const BOUND: PluginHostBinding = { projectId: PROJECT_A, projectRoot: ROOT_A };

function worktree(overrides: Partial<WorktreeSnapshot>): WorktreeSnapshot {
  return {
    id: "wt-1",
    path: path.join(ROOT_A, "main"),
    branch: "main",
    isCurrent: false,
    worktreeChanges: { changes: [] },
    ...overrides,
  } as unknown as WorktreeSnapshot;
}

function fakePlugin(): LoadedPlugin {
  return {
    // Builtin so the JIT capability-consent prompt is skipped in these tests.
    isBuiltin: true,
    manifest: {
      name: PLUGIN_ID,
      displayName: "Acme",
      capabilities: ["agent:input"],
      contributes: { forgeProviders: [], fileDecorationProviders: [] },
    },
  } as unknown as LoadedPlugin;
}

type WorktreeHandler = (payload?: { projectPath?: string }) => void;

interface Harness {
  deps: PluginHostFactoryDeps;
  plugins: Map<string, LoadedPlugin>;
  ambientFetch: ReturnType<typeof vi.fn>;
  projectFetch: ReturnType<typeof vi.fn>;
  recordPluginLog: ReturnType<typeof vi.fn>;
  sendDispatchToRenderer: ReturnType<typeof vi.fn>;
  sendActionsListToRenderer: ReturnType<typeof vi.fn>;
  sendActionsGetToRenderer: ReturnType<typeof vi.fn>;
  requestPrompt: ReturnType<typeof vi.fn>;
  handlers: Map<string, WorktreeHandler[]>;
}

function makeHarness(): Harness {
  const plugins = new Map<string, LoadedPlugin>([[PLUGIN_ID, fakePlugin()]]);
  const handlers = new Map<string, WorktreeHandler[]>();

  const ambientFetch = vi.fn(async (): Promise<PluginWorktreeSnapshotFetchResult> => okFetch([]));
  const projectFetch = vi.fn(async (): Promise<PluginWorktreeSnapshotFetchResult> => okFetch([]));
  const recordPluginLog = vi.fn();
  const sendDispatchToRenderer = vi.fn(async () => ({ ok: true, data: undefined }));
  const sendActionsListToRenderer = vi.fn(async () => []);
  const sendActionsGetToRenderer = vi.fn(async () => null);
  const requestPrompt = vi.fn(async () => undefined);

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
    dispatcher: {
      sendDispatchToRenderer,
      sendActionsListToRenderer,
      sendActionsGetToRenderer,
    },
    promptDispatcher: { requestPrompt },
    settings: {},
    storage: {},
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    declaredCapabilities: () => new Set(["agent:input", "agent:read"]),
    fetchWorktreeSnapshotsResult: ambientFetch,
    fetchWorktreeSnapshotsForProjectResult: projectFetch,
    recordPluginLog,
    serializePluginBadges: () => ({}),
    pluginDataDir: () => path.join(path.sep, "tmp", "data"),
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [],
    subscribeWorktreeEvent: vi.fn((_pluginId: string, event: string, handler: WorktreeHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    }),
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;

  return {
    deps,
    plugins,
    ambientFetch,
    projectFetch,
    recordPluginLog,
    sendDispatchToRenderer,
    sendActionsListToRenderer,
    sendActionsGetToRenderer,
    requestPrompt,
    handlers,
  };
}

function emit(h: Harness, event: string, payload?: { projectPath?: string }): void {
  for (const handler of h.handlers.get(event) ?? []) handler(payload);
}

/** Flush the microtask queue so a subscription's async re-fetch settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceRefsMock.getPtyClient.mockReturnValue(null);
});

describe("createHost worktree surfaces", () => {
  it("reads the bound project's worktrees, never the focus-resolved set", async () => {
    const h = makeHarness();
    h.projectFetch.mockResolvedValue(
      okFetch([worktree({ id: "wt-a", isCurrent: true, path: path.join(ROOT_A, "feature") })])
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect((await host.getActiveWorktree())?.id).toBe("wt-a");
    expect((await host.getWorktrees()).map((w) => w.id)).toEqual(["wt-a"]);
    expect(await host.getWorktreeStatus(path.join(ROOT_A, "feature"))).not.toBeNull();

    expect(h.ambientFetch).not.toHaveBeenCalled();
    expect(h.projectFetch).toHaveBeenCalledWith(PROJECT_A, ROOT_A);
  });

  it("leaves the unbound path on the ambient read", async () => {
    const h = makeHarness();
    h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-focus", isCurrent: true })]));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    expect((await host.getActiveWorktree())?.id).toBe("wt-focus");
    expect(h.projectFetch).not.toHaveBeenCalled();
    expect(h.ambientFetch).toHaveBeenCalled();
  });

  it("fails closed rather than widening when a binding has no root", async () => {
    const h = makeHarness();
    h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-focus", isCurrent: true })]));
    const { host } = createHost(h.deps, PLUGIN_ID, { projectId: PROJECT_A, projectRoot: null });

    expect(await host.getActiveWorktree()).toBeNull();
    expect(await host.getWorktrees()).toEqual([]);
    expect(h.ambientFetch).not.toHaveBeenCalled();
    expect(h.projectFetch).not.toHaveBeenCalled();
  });

  it("degrades every worktree surface once the bound project is gone", async () => {
    const h = makeHarness();
    h.projectFetch.mockResolvedValue({ status: "unavailable", reason: "project-unavailable" });
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.getActiveWorktree()).toBeNull();
    expect(await host.getWorktrees()).toEqual([]);
    expect(await host.getWorktreeStatus(path.join(ROOT_A, "feature"))).toBeNull();
    expect(await host.getWorktreesResult()).toEqual({
      status: "unavailable",
      reason: "project-unavailable",
    });
  });

  it("names the project a successful read describes", async () => {
    const h = makeHarness();
    h.projectFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a", isCurrent: true })]));
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.getWorktreesResult()).toEqual({
      status: "ok",
      projectId: PROJECT_A,
      worktrees: [expect.objectContaining({ id: "wt-a" })],
    });
  });

  it("reports an authoritative empty project, not an unavailable one", async () => {
    const h = makeHarness();
    h.projectFetch.mockResolvedValue(okFetch([]));
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    // The distinction #12174 exists for: this project really has no worktrees,
    // and says so, while the legacy surface still answers the ambiguous [].
    expect(await host.getWorktreesResult()).toEqual({
      status: "ok",
      projectId: PROJECT_A,
      worktrees: [],
    });
    expect(await host.getWorktrees()).toEqual([]);
    expect(await host.getActiveWorktree()).toBeNull();
  });

  it("reports project-unavailable for a rootless binding without reading anything", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, { projectId: PROJECT_A, projectRoot: null });

    expect(await host.getWorktreesResult()).toEqual({
      status: "unavailable",
      reason: "project-unavailable",
    });
    expect(h.ambientFetch).not.toHaveBeenCalled();
    expect(h.projectFetch).not.toHaveBeenCalled();
  });

  it("passes a closed project's unavailability through instead of flattening it", async () => {
    const h = makeHarness();
    h.projectFetch.mockResolvedValue({ status: "unavailable", reason: "project-unavailable" });
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.getWorktreesResult()).toEqual({
      status: "unavailable",
      reason: "project-unavailable",
    });
    expect(await host.getWorktrees()).toEqual([]);
  });

  it("reports plugin-unloaded before it reads anything", async () => {
    const h = makeHarness();
    h.plugins.delete(PLUGIN_ID);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.getWorktreesResult()).toEqual({
      status: "unavailable",
      reason: "plugin-unloaded",
    });
    expect(h.projectFetch).not.toHaveBeenCalled();
  });

  it("discards snapshots that arrive after the plugin unloaded", async () => {
    const h = makeHarness();
    let release: (value: PluginWorktreeSnapshotFetchResult) => void = () => {};
    h.projectFetch.mockReturnValue(
      new Promise<PluginWorktreeSnapshotFetchResult>((resolve) => {
        release = resolve;
      })
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    const pending = host.getWorktreesResult();
    h.plugins.delete(PLUGIN_ID);
    release(okFetch([worktree({ id: "wt-a", isCurrent: true })]));

    expect(await pending).toEqual({ status: "unavailable", reason: "plugin-unloaded" });
  });

  it("refuses a successful read that names another project", async () => {
    const h = makeHarness();
    // The confused deputy arriving through the new shape: a dependency that
    // answered for B must not be relabelled as A's.
    h.projectFetch.mockResolvedValue(
      okFetch([worktree({ id: "wt-b", isCurrent: true })], "project-b")
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.getWorktreesResult()).toEqual({
      status: "unavailable",
      reason: "project-unavailable",
    });
    expect(await host.getWorktrees()).toEqual([]);
  });

  it("keeps a foreign-project answer out of getWorktreeStatus, not just the getters", async () => {
    const h = makeHarness();
    // The refusal lives in the shared fetch, so every surface downstream of it
    // fails closed — a getter-only guard would let B's status through here.
    const foreign = path.join(ROOT_B, "feature");
    h.projectFetch.mockResolvedValue(
      okFetch([worktree({ id: "wt-b", isCurrent: true, path: foreign })], "project-b")
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.getWorktreeStatus(foreign)).toBeNull();
    expect(await host.getActiveWorktree()).toBeNull();
    expect(await host.getWorktrees()).toEqual([]);
  });

  it("treats a same-id reload as unloaded, not as the same plugin", async () => {
    const h = makeHarness();
    let release: (value: PluginWorktreeSnapshotFetchResult) => void = () => {};
    h.projectFetch.mockReturnValue(
      new Promise<PluginWorktreeSnapshotFetchResult>((resolve) => {
        release = resolve;
      })
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    const pending = host.getWorktreesResult();
    // Identity, not membership: the id is still in the map, but it now names a
    // different instance, so this host's read belongs to the previous one.
    h.plugins.set(PLUGIN_ID, fakePlugin());
    release(okFetch([worktree({ id: "wt-a", isCurrent: true })]));

    expect(await pending).toEqual({ status: "unavailable", reason: "plugin-unloaded" });
  });

  it("answers fetch-failed rather than rejecting when the read throws", async () => {
    const h = makeHarness();
    h.projectFetch.mockRejectedValue(new Error("dependency blew up"));
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.getWorktreesResult()).toEqual({
      status: "unavailable",
      reason: "fetch-failed",
    });
    expect(await host.getWorktrees()).toEqual([]);
  });

  it("answers fetch-failed when projecting a malformed snapshot throws", async () => {
    const h = makeHarness();
    // `worktreeChanges` present but with no `changes` array — toPluginWorktree
    // Snapshot iterates it and throws. The projection sits inside the boundary,
    // so this is data, not a rejection into whatever timer called it.
    h.projectFetch.mockResolvedValue(
      okFetch([
        {
          ...worktree({ id: "wt-a", isCurrent: true }),
          worktreeChanges: {} as never,
        },
      ])
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.getWorktreesResult()).toEqual({
      status: "unavailable",
      reason: "fetch-failed",
    });
    expect(await host.getWorktrees()).toEqual([]);
    expect(await host.getActiveWorktree()).toBeNull();
  });

  it("names the focus-resolved project on the unbound path", async () => {
    const h = makeHarness();
    // Mid-switch the focused view can still be the outgoing project's, so an
    // unbound host is told which project its populated list actually belongs to.
    h.ambientFetch.mockResolvedValue(
      okFetch([worktree({ id: "wt-outgoing", isCurrent: true })], "project-outgoing")
    );
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    expect(await host.getWorktreesResult()).toEqual({
      status: "ok",
      projectId: "project-outgoing",
      worktrees: [expect.objectContaining({ id: "wt-outgoing" })],
    });
  });
});

describe("createHost worktree subscriptions", () => {
  it("fires onDidChangeActiveWorktree only for the bound project", async () => {
    const h = makeHarness();
    h.projectFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a", isCurrent: true })]));
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();
    await host.onDidChangeActiveWorktree(callback);

    emit(h, "worktree-activated", { projectPath: ROOT_B });
    await flush();
    expect(callback).not.toHaveBeenCalled();

    emit(h, "worktree-activated", { projectPath: ROOT_A });
    await flush();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]?.id).toBe("wt-a");
  });

  it("fires onDidChangeWorktrees only for the bound project", async () => {
    const h = makeHarness();
    h.projectFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a" })]));
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback);

    emit(h, "worktree-update", { projectPath: ROOT_B });
    emit(h, "worktree-removed", { projectPath: ROOT_B });
    await flush();
    expect(callback).not.toHaveBeenCalled();

    emit(h, "worktree-update", { projectPath: ROOT_A });
    await flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("keeps an unbound subscription firing for every project", async () => {
    const h = makeHarness();
    h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-focus" })]));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback);

    emit(h, "worktree-update", { projectPath: ROOT_B });
    await flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("createHost renderer pushes", () => {
  it("routes toast, broadcast and panel posts to the bound project's views", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await host.showToast({ message: "hi", type: "info" });
    await host.broadcastToRenderer("ping", { a: 1 });
    await host.postToPanel("stream", { b: 2 }, "panel-1");

    expect(ipcUtilsMock.broadcastToRenderer).not.toHaveBeenCalled();
    const targets = ipcUtilsMock.broadcastToProjectRenderers.mock.calls.map((c) => c[0]);
    expect(targets).toEqual([PROJECT_A, PROJECT_A, PROJECT_A]);
    expect(ipcUtilsMock.broadcastToProjectRenderers.mock.calls[0][1]).toBe(
      CHANNELS.NOTIFICATION_SHOW_TOAST
    );
  });

  it("still broadcasts app-wide when unbound", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.showToast({ message: "hi", type: "info" });
    await host.broadcastToRenderer("ping", { a: 1 });

    expect(ipcUtilsMock.broadcastToProjectRenderers).not.toHaveBeenCalled();
    expect(ipcUtilsMock.broadcastToRenderer).toHaveBeenCalledTimes(2);
  });
});

describe("createHost dispatch, catalog and prompts", () => {
  it("hands the bound project id to every renderer round-trip", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await host.dispatch("terminal.focus");
    await host.actions.list();
    await host.actions.get("terminal.focus");
    await host.showInputBox({ title: "name" });
    await host.showConfirm({ title: "sure?" });

    expect(h.sendDispatchToRenderer).toHaveBeenCalledWith("terminal.focus", undefined, PROJECT_A);
    expect(h.sendActionsListToRenderer).toHaveBeenCalledWith(PROJECT_A);
    expect(h.sendActionsGetToRenderer).toHaveBeenCalledWith("terminal.focus", PROJECT_A);
    for (const call of h.requestPrompt.mock.calls) expect(call[2]).toBe(PROJECT_A);
  });

  it("passes null through when unbound so the dispatchers stay ambient", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.dispatch("terminal.focus");
    await host.actions.list();
    await host.showInputBox({ title: "name" });

    expect(h.sendDispatchToRenderer).toHaveBeenCalledWith("terminal.focus", undefined, null);
    expect(h.sendActionsListToRenderer).toHaveBeenCalledWith(null);
    expect(h.requestPrompt.mock.calls[0][2]).toBeNull();
  });

  it("keeps the catalog's never-throws contract when the bound view is gone", async () => {
    const h = makeHarness();
    const unavailable = new AppError({
      code: "PROJECT_VIEW_UNAVAILABLE",
      message: "no live renderer",
    });
    h.sendActionsListToRenderer.mockRejectedValue(unavailable);
    h.sendActionsGetToRenderer.mockRejectedValue(unavailable);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(await host.actions.list()).toEqual([]);
    expect(await host.actions.get("terminal.focus")).toBeNull();
    expect(await host.actions.canDispatch("terminal.focus")).toBe("restricted");
  });

  it("still surfaces an unrelated catalog failure", async () => {
    const h = makeHarness();
    h.sendActionsListToRenderer.mockRejectedValue(new Error("boom"));
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.actions.list()).rejects.toThrow("boom");
  });

  it("propagates a bound dispatch rejection rather than retargeting", async () => {
    const h = makeHarness();
    h.sendDispatchToRenderer.mockRejectedValue(
      new AppError({ code: "PROJECT_VIEW_UNAVAILABLE", message: "no live renderer" })
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.dispatch("terminal.focus")).rejects.toMatchObject({
      code: "PROJECT_VIEW_UNAVAILABLE",
    });
  });
});

describe("createHost sendToActiveAgent", () => {
  function installPty(terminals: Array<Record<string, unknown>>, activeProjectId: string | null) {
    const client = {
      getAllTerminalsAsync: vi.fn(async () => terminals),
      getActiveProjectId: vi.fn(() => activeProjectId),
      stage: vi.fn(),
      submit: vi.fn(),
    };
    serviceRefsMock.getPtyClient.mockReturnValue(client);
    return client;
  }

  const agentTerminal = (id: string, projectId: string) => ({
    id,
    projectId,
    launchAgentId: "claude",
    hasPty: true,
    agentState: "waiting",
    activityTier: "active",
    lastOutputTime: 1,
  });

  it("reaches only the bound project's agent", async () => {
    const h = makeHarness();
    const pty = installPty(
      [agentTerminal("term-b", "project-b"), agentTerminal("term-a", PROJECT_A)],
      "project-b"
    );
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await host.sendToActiveAgent("hello");

    expect(pty.stage).toHaveBeenCalledWith("term-a", "hello");
    expect(pty.getActiveProjectId).not.toHaveBeenCalled();
  });

  it("no-ops with a warning when the bound project has no agent", async () => {
    const h = makeHarness();
    const pty = installPty([agentTerminal("term-b", "project-b")], "project-b");
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.sendToActiveAgent("hello")).resolves.toBeUndefined();

    expect(pty.stage).not.toHaveBeenCalled();
    expect(pty.submit).not.toHaveBeenCalled();
    expect(h.recordPluginLog).toHaveBeenCalledWith(
      expect.anything(),
      PLUGIN_ID,
      "warn",
      expect.stringContaining("no agent terminal")
    );
  });

  it("still throws NO_ACTIVE_AGENT for an unbound host with no agent", async () => {
    const h = makeHarness();
    installPty([], null);
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await expect(host.sendToActiveAgent("hello")).rejects.toThrow("NO_ACTIVE_AGENT");
  });

  it("keeps the unbound host on the pty host's focused project", async () => {
    const h = makeHarness();
    const pty = installPty(
      [agentTerminal("term-b", "project-b"), agentTerminal("term-a", PROJECT_A)],
      "project-b"
    );
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.sendToActiveAgent("hello", { submit: true });

    expect(pty.submit).toHaveBeenCalledWith("term-b", "hello");
  });
});

describe("createHost onDidChangeAgentState", () => {
  function installPtyForAgentState(terminalProjects: Record<string, string>) {
    serviceRefsMock.getPtyClient.mockReturnValue({
      getTerminalProjectId: vi.fn((id: string) => terminalProjects[id] ?? null),
    });
  }

  it("delivers only the bound project's agent transitions", async () => {
    const h = makeHarness();
    installPtyForAgentState({ "term-a": PROJECT_A, "term-b": "project-b" });
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();
    await host.onDidChangeAgentState(callback);

    events.emit("agent:state-changed", {
      terminalId: "term-b",
      state: "working",
      previousState: "idle",
      timestamp: 1,
    } as never);
    expect(callback).not.toHaveBeenCalled();
    expect(await host.getAgentState()).toBeNull();

    events.emit("agent:state-changed", {
      terminalId: "term-a",
      state: "waiting",
      previousState: "working",
      timestamp: 2,
    } as never);
    expect(callback).toHaveBeenCalledTimes(1);
    expect((await host.getAgentState())?.state).toBe("waiting");
  });

  it("drops an unattributable transition for a bound host", async () => {
    const h = makeHarness();
    installPtyForAgentState({});
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();
    await host.onDidChangeAgentState(callback);

    events.emit("agent:state-changed", {
      state: "working",
      previousState: "idle",
      timestamp: 1,
    } as never);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps an unbound host observing every project's agents", async () => {
    const h = makeHarness();
    installPtyForAgentState({ "term-b": "project-b" });
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeAgentState(callback);

    events.emit("agent:state-changed", {
      terminalId: "term-b",
      state: "working",
      previousState: "idle",
      timestamp: 1,
    } as never);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("createHost onDidWake (#12175)", () => {
  const WAKE = { sleepDuration: 42_000, timestamp: 1234 };

  // Subscriptions live on the module-level bus, so a listener left behind by
  // one case would still be attached when the next emits. Spies are restored
  // here too: this file's `beforeEach` only clears mocks, so a console spy
  // would otherwise stay installed for every later test.
  afterEach(() => {
    events.removeAllListeners();
    vi.restoreAllMocks();
  });

  it("delivers a frozen wake to a project-bound host", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const received: unknown[] = [];
    await host.onDidWake((event) => received.push(event));

    events.emit("sys:wake", WAKE);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(WAKE);
    // Frozen so a plugin that mutates the event fails here, not in the wild.
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it("delivers to a bound host regardless of which project woke — a wake is machine-scoped", async () => {
    const h = makeHarness();
    const boundHost = createHost(h.deps, PLUGIN_ID, BOUND).host;
    const unboundHost = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
    const boundCb = vi.fn();
    const unboundCb = vi.fn();
    await boundHost.onDidWake(boundCb);
    await unboundHost.onDidWake(unboundCb);

    events.emit("sys:wake", WAKE);

    // Unlike agent state, there is no project filter: the blurred, non-current
    // project is exactly the one whose plugin state went stale over the sleep.
    expect(boundCb).toHaveBeenCalledTimes(1);
    expect(unboundCb).toHaveBeenCalledTimes(1);
  });

  it("requires no capability", async () => {
    const h = makeHarness();
    h.deps.declaredCapabilities = () => new Set();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();

    await expect(host.onDidWake(callback)).resolves.toBeTypeOf("function");
    events.emit("sys:wake", WAKE);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not replay a wake that happened before the subscription", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    events.emit("sys:wake", WAKE);
    const callback = vi.fn();
    await host.onDidWake(callback);

    // A pulse has no resting state; replaying it would make a stale wake look
    // fresh and trigger a duplicate reconciliation pass.
    expect(callback).not.toHaveBeenCalled();
  });

  it("stops delivering once the disposer runs", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();
    const dispose = await host.onDidWake(callback);

    dispose();
    dispose();
    events.emit("sys:wake", WAKE);

    expect(callback).not.toHaveBeenCalled();
  });

  it("falls silent once the plugin is unloaded, without needing its disposer", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();
    await host.onDidWake(callback);

    h.deps.plugins.delete(PLUGIN_ID);
    events.emit("sys:wake", WAKE);

    expect(callback).not.toHaveBeenCalled();
  });

  it("registers its teardown in pluginEventCleanups and clears it on dispose", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const dispose = await host.onDidWake(vi.fn());

    // The membership guard alone would keep the "unloaded" test above green
    // even if the subscription stopped being tracked — at which point a
    // same-id reload would revive the stale listener. Assert the tracking.
    expect(h.deps.pluginEventCleanups.get(PLUGIN_ID)).toHaveLength(1);

    dispose();

    expect(h.deps.pluginEventCleanups.get(PLUGIN_ID)).toBeUndefined();
  });

  it("keeps delivering to a sibling listener when one throws", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    const thrower = vi.fn(() => {
      throw new Error("plugin boom");
    });
    await host.onDidWake(thrower);
    await host.onDidWake(healthy);

    events.emit("sys:wake", WAKE);

    // Assert the thrower ran: without it, a first subscription that silently
    // never registered would leave this test green.
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("quarantines a listener that throws on three consecutive wakes", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const callback = vi.fn(() => {
      throw new Error("plugin boom");
    });
    await host.onDidWake(callback);

    for (let i = 0; i < 4; i++) events.emit("sys:wake", WAKE);

    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("throws once the host is revoked", async () => {
    const h = makeHarness();
    const { host, revoke } = createHost(h.deps, PLUGIN_ID, BOUND);
    revoke();

    expect(() => host.onDidWake(vi.fn())).toThrow(/onDidWake/);
  });
});
