import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const ipcUtilsMock = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  getProjectRendererTargets: vi.fn((_projectId: string | null): unknown[] => []),
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
  getProjectRendererTargets: ipcUtilsMock.getProjectRendererTargets,
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
const projectTargeting = vi.hoisted(() => ({
  hasGrant: vi.fn((_identity: unknown): boolean => false),
}));
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed: vi.fn(async () => undefined) })),
  getPluginCapabilityConsentStore: vi.fn(() => projectTargeting),
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
import { flushPluginPushes, resetPluginPushBatcherForTests } from "../pluginPushBatcher.js";
import { PLUGIN_PUSH_MAX_PAYLOAD_BYTES } from "../../../../shared/config/pluginBudgets.js";
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
    broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
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
    pluginDisplayName: (id: string) => id,
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

/**
 * Flush the microtask queue so a subscription's async re-fetch settles. The
 * worktree subscriptions serialise their fetches on a promise chain, which
 * costs a few more hops than a bare fetch.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
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
    await host.onDidChangeActiveWorktree(callback, { debounceMs: 0 });

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
    await host.onDidChangeWorktrees(callback, { debounceMs: 0 });

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
    await host.onDidChangeWorktrees(callback, { debounceMs: 0 });

    emit(h, "worktree-update", { projectPath: ROOT_B });
    await flush();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("createHost debounced onDidChangeWorktrees", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into one trailing callback", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback, { debounceMs: 300 });

    for (let i = 0; i < 5; i++) {
      emit(h, "worktree-update", { projectPath: ROOT_A });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(h.ambientFetch).toHaveBeenCalledTimes(1);
  });

  it("still fires by the burst deadline while updates never go quiet", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const start = performance.now();
    const firedAt: number[] = [];
    await host.onDidChangeWorktrees(() => firedAt.push(performance.now() - start), {
      debounceMs: 300,
    });

    // 3 s of updates every 20 ms: a pure trailing debounce would never fire.
    for (let i = 0; i < 150; i++) {
      emit(h, "worktree-update", { projectPath: ROOT_A });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(firedAt).toEqual([1_200, 2_400]);

    // The last burst started at 2400 ms; once quiet it trails the final event.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(firedAt).toEqual([1_200, 2_400, 3_280]);
  });

  it("keeps the burst deadline when the wall clock jumps backwards", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback, { debounceMs: 300 });

    for (let i = 0; i < 60; i++) {
      emit(h, "worktree-update", { projectPath: ROOT_A });
      if (i === 10) vi.setSystemTime(Date.now() - 60_000);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fetch for a burst disposed before it fires", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    const dispose = await host.onDidChangeWorktrees(callback, { debounceMs: 300 });

    emit(h, "worktree-update", { projectPath: ROOT_A });
    emit(h, "worktree-removed", { projectPath: ROOT_A });
    dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.ambientFetch).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("createHost renderer pushes", () => {
  beforeEach(() => resetPluginPushBatcherForTests());

  it("routes toast, broadcast and panel posts to the bound project's views", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await host.showToast({ message: "hi", type: "info" });
    await host.broadcastToRenderer("ping", { a: 1 });
    await host.postToPanel("stream", { b: 2 }, "panel-1");
    flushPluginPushes();

    expect(ipcUtilsMock.broadcastToRenderer).not.toHaveBeenCalled();
    const targets = ipcUtilsMock.broadcastToProjectRenderers.mock.calls.map((c) => c[0]);
    expect(targets).toEqual([PROJECT_A]);
    expect(ipcUtilsMock.broadcastToProjectRenderers.mock.calls[0][1]).toBe(
      CHANNELS.NOTIFICATION_SHOW_TOAST
    );
    // Plugin pushes resolve their renderers through the batcher at flush time,
    // same scope, once per flush.
    const pushScopes = ipcUtilsMock.getProjectRendererTargets.mock.calls.map((c) => c[0]);
    expect(pushScopes).toEqual([PROJECT_A]);
  });

  it("still broadcasts app-wide when unbound", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.showToast({ message: "hi", type: "info" });
    await host.broadcastToRenderer("ping", { a: 1 });
    flushPluginPushes();

    expect(ipcUtilsMock.broadcastToProjectRenderers).not.toHaveBeenCalled();
    expect(ipcUtilsMock.broadcastToRenderer).toHaveBeenCalledTimes(1);
    expect(ipcUtilsMock.getProjectRendererTargets.mock.calls.map((c) => c[0])).toEqual([null]);
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

  it("forwards each prompt's cancellation signal to the dispatcher (#12279)", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const controller = new AbortController();

    await host.showQuickPick([{ id: "a", label: "A" }], {}, { signal: controller.signal });
    await host.showInputBox({ title: "name" }, { signal: controller.signal });
    await host.showConfirm({ title: "sure?" }, { signal: controller.signal });

    // This is the link that ties a prompt to the lifetime of whatever asked for
    // it — without it the dev worker's retired generation cannot dismiss its own
    // question, and the signal is silently dropped at the factory boundary.
    expect(h.requestPrompt.mock.calls).toHaveLength(3);
    for (const call of h.requestPrompt.mock.calls) {
      expect(call[3]).toBe(controller.signal);
      // The binding must survive alongside the new trailing argument.
      expect(call[2]).toBe(PROJECT_A);
    }
  });

  it("meters each dialog prompt from open to settle, so invokes can leave out user waits", async () => {
    const h = makeHarness();
    const events: string[] = [];
    let answer: (value: unknown) => void = () => {};
    h.requestPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          events.push("requested");
          answer = resolve;
        })
    );
    const trackPromptWait = vi.fn((pluginId: string) => {
      events.push(`open:${pluginId}`);
      return () => events.push("closed");
    });
    const { host } = createHost({ ...h.deps, trackPromptWait }, PLUGIN_ID, BOUND);

    const pending = host.showConfirm({ title: "sure?" });
    await flush();
    expect(events).toEqual([`open:${PLUGIN_ID}`, "requested"]);
    answer(true);
    await expect(pending).resolves.toBe(true);
    expect(events).toEqual([`open:${PLUGIN_ID}`, "requested", "closed"]);

    await host.showQuickPick([{ id: "a", label: "A" }]);
    await host.showInputBox({ title: "name" });
    expect(trackPromptWait).toHaveBeenCalledTimes(3);
  });

  it("leaves the signal undefined when a plugin passes no call options (#12279)", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await host.showConfirm({ title: "sure?" });

    expect(h.requestPrompt.mock.calls[0][3]).toBeUndefined();
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

describe("createHost dispatch with an explicit project (#13119)", () => {
  function unboundWithTargeting(h: Harness, granted: boolean) {
    h.deps.declaredCapabilities = () => new Set(["project:dispatch"]);
    projectTargeting.hasGrant.mockReturnValue(granted);
    return createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
  }

  beforeEach(() => {
    projectTargeting.hasGrant.mockReset();
    projectTargeting.hasGrant.mockReturnValue(false);
  });

  it("routes a granted unbound dispatch to the named project and audits it", async () => {
    const h = makeHarness();
    const host = unboundWithTargeting(h, true);

    await expect(
      host.dispatch("agent.launch", { agentId: "claude" }, { projectId: PROJECT_A })
    ).resolves.toEqual({ ok: true, data: undefined });

    expect(h.sendDispatchToRenderer).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude" },
      PROJECT_A
    );
    expect(projectTargeting.hasGrant).toHaveBeenCalledWith({
      pluginId: PLUGIN_ID,
      capability: "project:dispatch",
      scopeKey: "global",
    });
    expect(h.deps.safeAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: PLUGIN_ID,
        actionId: `dispatch:${PROJECT_A}:agent.launch`,
        channel: "plugin:dispatch-targeted",
        result: "success",
      })
    );
  });

  it("audits a refused action and a missing view as failures", async () => {
    const h = makeHarness();
    const host = unboundWithTargeting(h, true);

    h.sendDispatchToRenderer.mockResolvedValueOnce({
      ok: false,
      error: { code: "RESTRICTED", message: "no" },
    });
    await host.dispatch("app.quit", undefined, { projectId: PROJECT_A });
    h.sendDispatchToRenderer.mockRejectedValueOnce(
      new AppError({ code: "PROJECT_VIEW_UNAVAILABLE", message: "no live renderer" })
    );
    await expect(
      host.dispatch("terminal.focus", undefined, { projectId: PROJECT_A })
    ).rejects.toMatchObject({ code: "PROJECT_VIEW_UNAVAILABLE" });

    const records = vi.mocked(h.deps.safeAppendAudit).mock.calls.map((c) => c[0]);
    expect(records).toEqual([
      expect.objectContaining({ result: "error", errorMessage: "RESTRICTED" }),
      expect.objectContaining({ result: "error", errorMessage: "PROJECT_VIEW_UNAVAILABLE" }),
    ]);
  });

  it("refuses without the switch, before any round-trip and without an audit", async () => {
    const h = makeHarness();
    const host = unboundWithTargeting(h, false);

    await expect(
      host.dispatch("terminal.focus", undefined, { projectId: PROJECT_A })
    ).rejects.toThrow(/PERMISSION_REQUIRED: .*"Allow project targeting"/);
    expect(h.sendDispatchToRenderer).not.toHaveBeenCalled();
    expect(h.deps.safeAppendAudit).not.toHaveBeenCalled();
  });

  it("keeps ambient routing, with no grant lookup, when options carry no project", async () => {
    const h = makeHarness();
    const host = unboundWithTargeting(h, false);

    await host.dispatch("terminal.focus", undefined, {});
    await host.dispatch("terminal.focus", undefined, undefined);

    expect(h.sendDispatchToRenderer).toHaveBeenNthCalledWith(1, "terminal.focus", undefined, null);
    expect(h.sendDispatchToRenderer).toHaveBeenNthCalledWith(2, "terminal.focus", undefined, null);
    expect(projectTargeting.hasGrant).not.toHaveBeenCalled();
  });

  it("rejects malformed options instead of falling back to the focused project", async () => {
    const h = makeHarness();
    const host = unboundWithTargeting(h, true);
    const dispatch = host.dispatch as (a: string, b: unknown, c: unknown) => Promise<unknown>;

    await expect(dispatch("terminal.focus", undefined, "project-a")).rejects.toThrow(
      /options must be an object/
    );
    await expect(dispatch("terminal.focus", undefined, { projectId: 42 })).rejects.toThrow(
      /options\.projectId must be a non-empty string/
    );
    await expect(dispatch("terminal.focus", undefined, { projectId: "  " })).rejects.toThrow(
      /options\.projectId must be a non-empty string/
    );
    expect(h.sendDispatchToRenderer).not.toHaveBeenCalled();
  });

  it("lets a bound host name its own project and refuses any other before the grant", async () => {
    const h = makeHarness();
    projectTargeting.hasGrant.mockReturnValue(true);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await host.dispatch("terminal.focus", undefined, { projectId: PROJECT_A });
    expect(h.sendDispatchToRenderer).toHaveBeenCalledWith("terminal.focus", undefined, PROJECT_A);

    await expect(
      host.dispatch("terminal.focus", undefined, { projectId: "project-other" })
    ).rejects.toThrow(/PERMISSION_REQUIRED: .*bound to its own project/);
    expect(h.sendDispatchToRenderer).toHaveBeenCalledTimes(1);
    expect(projectTargeting.hasGrant).not.toHaveBeenCalled();
  });

  it("returns PLUGIN_UNLOADED before validating options once the plugin is gone", async () => {
    const h = makeHarness();
    const host = unboundWithTargeting(h, true);
    h.plugins.delete(PLUGIN_ID);

    await expect(
      host.dispatch("terminal.focus", undefined, { projectId: PROJECT_A })
    ).resolves.toMatchObject({ ok: false, error: { code: "PLUGIN_UNLOADED" } });
    expect(h.sendDispatchToRenderer).not.toHaveBeenCalled();
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
    await host.onDidChangeAgentState(callback, { debounceMs: 0 });

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
    expect(callback.mock.calls[0][0]).toMatchObject({
      terminalId: "term-a",
      workspaceId: PROJECT_A,
    });
    expect(await host.getAgentState()).toMatchObject({
      state: "waiting",
      terminalId: "term-a",
      workspaceId: PROJECT_A,
    });
  });

  it("drops an unattributable transition for a bound host", async () => {
    const h = makeHarness();
    installPtyForAgentState({});
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();
    await host.onDidChangeAgentState(callback, { debounceMs: 0 });

    events.emit("agent:state-changed", {
      state: "working",
      previousState: "idle",
      timestamp: 1,
    } as never);
    expect(callback).not.toHaveBeenCalled();
  });

  it("drops a bound host's transitions it cannot attribute to its project", async () => {
    const h = makeHarness();
    installPtyForAgentState({ "term-a": PROJECT_A });
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    const callback = vi.fn();
    await host.onDidChangeAgentState(callback, { debounceMs: 0 });

    for (const terminalId of ["", 42, "term-unknown"]) {
      events.emit("agent:state-changed", {
        terminalId,
        state: "working",
        previousState: "idle",
        timestamp: 1,
      } as never);
    }
    serviceRefsMock.getPtyClient.mockReturnValue(null);
    events.emit("agent:state-changed", {
      terminalId: "term-a",
      state: "working",
      previousState: "idle",
      timestamp: 2,
    } as never);

    expect(callback).not.toHaveBeenCalled();
    expect(await host.getAgentState()).toBeNull();
  });

  it("keeps an unbound host observing every project's agents", async () => {
    const h = makeHarness();
    installPtyForAgentState({ "term-b": "project-b" });
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeAgentState(callback, { debounceMs: 0 });

    events.emit("agent:state-changed", {
      terminalId: "term-b",
      state: "working",
      previousState: "idle",
      timestamp: 1,
    } as never);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("tells an unbound host which workspace and terminal each transition came from", async () => {
    const h = makeHarness();
    const scratchId = "6f1c2a4e-1b7d-4c1e-9a55-0d2b8c3e4f10";
    installPtyForAgentState({ "term-a": PROJECT_A, "term-s": scratchId });
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeAgentState(callback, { debounceMs: 0 });

    for (const [terminalId, timestamp] of [
      ["term-a", 1],
      ["term-s", 2],
    ] as const) {
      events.emit("agent:state-changed", {
        terminalId,
        worktreeId: "wt-internal",
        cwd: "/secret/path",
        state: "waiting",
        previousState: "working",
        timestamp,
      } as never);
    }

    expect(callback.mock.calls.map(([s]) => [s.terminalId, s.workspaceId])).toEqual([
      ["term-a", PROJECT_A],
      ["term-s", scratchId],
    ]);
    expect(Object.keys(callback.mock.calls[1][0]).sort()).toEqual([
      "previousState",
      "running",
      "state",
      "terminalId",
      "timestamp",
      "workspaceId",
    ]);
    expect(await host.getAgentState()).toMatchObject({
      terminalId: "term-s",
      workspaceId: scratchId,
    });
  });

  it("delivers an untracked terminal's transition to an unbound host without a workspace id", async () => {
    const h = makeHarness();
    installPtyForAgentState({});
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeAgentState(callback, { debounceMs: 0 });

    events.emit("agent:state-changed", {
      terminalId: "term-gone",
      state: "exited",
      previousState: "working",
      timestamp: 1,
    } as never);

    expect(callback).toHaveBeenCalledTimes(1);
    const snapshot = callback.mock.calls[0][0];
    expect(snapshot.terminalId).toBe("term-gone");
    expect("workspaceId" in snapshot).toBe(false);
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

describe("host identity (#12211)", () => {
  const PROJECT_INSTANCE = `project__${PROJECT_A}__acme.video-manager`;

  it("reports a project plugin's identity without the plugin parsing its own id", () => {
    const { deps } = makeHarness();
    const { host } = createHost(deps, PROJECT_INSTANCE, BOUND);

    // pluginId keeps its documented meaning — the instance key — because
    // transport routing and settings/storage paths are keyed on it.
    expect(host.pluginId).toBe(PROJECT_INSTANCE);
    expect(host.pluginInfo).toEqual({
      instanceId: PROJECT_INSTANCE,
      manifestId: "acme.video-manager",
      origin: "project",
      projectId: PROJECT_A,
      projectRoot: ROOT_A,
    });
  });

  it("reports an app-global plugin as unbound with the id as its manifest id", () => {
    const { deps } = makeHarness();
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    expect(host.pluginInfo).toEqual({
      instanceId: PLUGIN_ID,
      manifestId: PLUGIN_ID,
      origin: "global",
      projectId: null,
      projectRoot: null,
    });
  });

  it("qualifies a bare panel id into the project-scoped runtime kind id", () => {
    const { deps } = makeHarness();
    const { host } = createHost(deps, PROJECT_INSTANCE, BOUND);

    expect(host.panelKindId("overview")).toBe(`project:${PROJECT_A}/acme.video-manager/overview`);
  });

  it("qualifies a bare panel id into the dotted global form for an unbound plugin", () => {
    const { deps } = makeHarness();
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    expect(host.panelKindId("overview")).toBe("acme.overview");
  });

  it("stays readable after the host is revoked — identity is static, not a registration", () => {
    const { deps } = makeHarness();
    const { host, revoke } = createHost(deps, PROJECT_INSTANCE, BOUND);
    revoke();

    expect(host.pluginInfo.manifestId).toBe("acme.video-manager");
    expect(host.panelKindId("overview")).toBe(`project:${PROJECT_A}/acme.video-manager/overview`);
  });

  it("throws on an empty bare id rather than minting an unresolvable kind", () => {
    const { deps } = makeHarness();
    const { host } = createHost(deps, PROJECT_INSTANCE, BOUND);

    expect(() => host.panelKindId("")).toThrow(/bareId must be a non-empty string/);
  });

  it("throws when a project-owned plugin's binding names no project", () => {
    const { deps } = makeHarness();
    // A malformed binding cannot name a project kind — refuse rather than
    // aliasing the project kind onto the global one.
    const { host } = createHost(deps, PROJECT_INSTANCE, UNBOUND_PLUGIN_HOST_BINDING);

    expect(() => host.panelKindId("overview")).toThrow(/cannot qualify panel kind/);
  });
});

describe("createHost settings.open and settings.missingRequired", () => {
  it("opens the plugin's own settings, routed to its own project's renderer", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await host.settings.open("apiKey");
    await host.settings.open();

    expect(h.sendDispatchToRenderer).toHaveBeenNthCalledWith(
      1,
      "plugin.openSettings",
      { pluginId: PLUGIN_ID, key: "apiKey" },
      PROJECT_A
    );
    expect(h.sendDispatchToRenderer).toHaveBeenNthCalledWith(
      2,
      "plugin.openSettings",
      { pluginId: PLUGIN_ID },
      PROJECT_A
    );
  });

  it("stays ambient for an unbound plugin", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.settings.open("apiKey");

    expect(h.sendDispatchToRenderer).toHaveBeenCalledWith(
      "plugin.openSettings",
      { pluginId: PLUGIN_ID, key: "apiKey" },
      null
    );
  });

  it("rejects an empty key, a failed dispatch, and an unloaded plugin", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.settings.open("")).rejects.toThrow(/non-empty string/);
    h.sendDispatchToRenderer.mockResolvedValueOnce({
      ok: false,
      error: { code: "PROJECT_VIEW_UNAVAILABLE", message: "no window" },
    } as never);
    await expect(host.settings.open("apiKey")).rejects.toThrow(/no window/);
    h.plugins.delete(PLUGIN_ID);
    await expect(host.settings.open()).rejects.toThrow(/no longer loaded/);
  });

  it("answers missingRequired against the bound project's root", async () => {
    const h = makeHarness();
    const missingRequiredForHost = vi.fn(async () => ["apiKey"]);
    (h.deps as unknown as { settings: unknown }).settings = { missingRequiredForHost };
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.settings.missingRequired()).resolves.toEqual(["apiKey"]);
    expect(missingRequiredForHost).toHaveBeenCalledWith(PLUGIN_ID, ROOT_A);
  });
});

describe("createHost subscriptions coalesce by default", () => {
  afterEach(() => {
    events.removeAllListeners();
    serviceRefsMock.getPtyClient.mockReset();
    vi.useRealTimers();
  });

  it("coalesces onDidChangeWorktrees with no options into one callback per window", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a" })]));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback);

    for (let i = 0; i < 20; i++) emit(h, "worktree-update", { projectPath: ROOT_A });
    await vi.advanceTimersByTimeAsync(99);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(h.ambientFetch).toHaveBeenCalledTimes(1);
  });

  it("delivers every event for an explicit debounceMs: 0", async () => {
    const h = makeHarness();
    h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a" })]));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback, { debounceMs: 0 });

    for (let i = 0; i < 3; i++) emit(h, "worktree-update", { projectPath: ROOT_A });
    await flush();
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("treats an undefined debounceMs, as the worker bridge forwards it, as the default", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback, { debounceMs: undefined });
    emit(h, "worktree-update", { projectPath: ROOT_A });
    emit(h, "worktree-update", { projectPath: ROOT_A });
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("hands onDidChangeWorktrees what changed since the previous delivery", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback, { debounceMs: 0 });

    h.ambientFetch.mockResolvedValueOnce(
      okFetch([worktree({ id: "wt-a" }), worktree({ id: "wt-b", branch: "b" })])
    );
    emit(h, "worktree-update", { projectPath: ROOT_A });
    await flush();
    expect(callback.mock.calls[0][1]).toEqual({
      added: ["wt-a", "wt-b"],
      removed: [],
      changed: [],
    });

    h.ambientFetch.mockResolvedValueOnce(
      okFetch([worktree({ id: "wt-b", branch: "b2" }), worktree({ id: "wt-c" })])
    );
    emit(h, "worktree-update", { projectPath: ROOT_A });
    await flush();
    expect(callback.mock.calls[1][1]).toEqual({
      added: ["wt-c"],
      removed: ["wt-a"],
      changed: ["wt-b"],
    });

    h.ambientFetch.mockResolvedValueOnce(
      okFetch([worktree({ id: "wt-b", branch: "b2" }), worktree({ id: "wt-c" })])
    );
    emit(h, "worktree-update", { projectPath: ROOT_A });
    await flush();
    expect(callback.mock.calls[2][1]).toEqual({ added: [], removed: [], changed: [] });
  });

  it("describes a coalesced burst by its net change", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a" })]));
    await host.onDidChangeWorktrees(callback);
    emit(h, "worktree-update", { projectPath: ROOT_A });
    await vi.advanceTimersByTimeAsync(100);
    expect(callback.mock.calls[0][1]).toEqual({ added: ["wt-a"], removed: [], changed: [] });

    // wt-b comes and goes inside one window: only the end state is compared.
    h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a" })]));
    emit(h, "worktree-update", { projectPath: ROOT_A });
    emit(h, "worktree-removed", { projectPath: ROOT_A });
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1][1]).toEqual({ added: [], removed: [], changed: [] });
  });

  it("delivers raw events one per event and in order, even when a fetch is slow", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback, { debounceMs: 0 });
    let releaseSlow: (() => void) | undefined;
    h.ambientFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSlow = () => resolve(okFetch([worktree({ id: "wt-old" })]));
        })
    );
    h.ambientFetch.mockResolvedValueOnce(okFetch([worktree({ id: "wt-new" })]));
    emit(h, "worktree-update", { projectPath: ROOT_A });
    emit(h, "worktree-update", { projectPath: ROOT_A });
    await flush();
    expect(callback).not.toHaveBeenCalled();
    releaseSlow?.();
    await flush();
    await flush();
    const ids = callback.mock.calls.map((c) => c[0].map((w: { id: string }) => w.id));
    expect(ids).toEqual([["wt-old"], ["wt-new"]]);
    expect(callback.mock.calls[1][1]).toEqual({
      added: ["wt-new"],
      removed: ["wt-old"],
      changed: [],
    });
  });

  it("coalesces onDidChangeActiveWorktree and reads the worktree active at the end", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeActiveWorktree(callback);

    emit(h, "worktree-activated", { projectPath: ROOT_A });
    emit(h, "worktree-activated", { projectPath: ROOT_A });
    h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-last", isCurrent: true })]));
    emit(h, "worktree-activated", { projectPath: ROOT_A });
    await vi.advanceTimersByTimeAsync(100);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]?.id).toBe("wt-last");
    expect(h.ambientFetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces agent state per terminal and never drops a terminal's final state", async () => {
    vi.useFakeTimers();
    serviceRefsMock.getPtyClient.mockReturnValue({ getTerminalProjectId: vi.fn(() => PROJECT_A) });
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const received: Array<{ state: string; agentId?: string }> = [];
    await host.onDidChangeAgentState((s) => received.push(s));

    const transition = (terminalId: string, state: string, previousState: string, t: number) =>
      events.emit("agent:state-changed", {
        terminalId,
        agentId: `agent-${terminalId}`,
        state,
        previousState,
        timestamp: t,
      } as never);
    transition("term-a", "working", "idle", 1);
    transition("term-b", "working", "idle", 2);
    transition("term-a", "waiting", "working", 3);
    transition("term-a", "idle", "waiting", 4);

    // The cache getAgentState reads is never coalesced.
    expect((await host.getAgentState())?.state).toBe("idle");
    expect(received).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    // One per terminal, latest value, ordered by each terminal's latest transition.
    expect(received.map((s) => [s.agentId, s.state])).toEqual([
      ["agent-term-b", "working"],
      ["agent-term-a", "idle"],
    ]);
  });

  it("keeps the workspace resolved at arrival when the terminal is gone by flush", async () => {
    vi.useFakeTimers();
    const terminalProjects: Record<string, string> = { "term-a": PROJECT_A };
    serviceRefsMock.getPtyClient.mockReturnValue({
      getTerminalProjectId: vi.fn((id: string) => terminalProjects[id] ?? null),
    });
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const received: Array<{ terminalId?: string; workspaceId?: string }> = [];
    await host.onDidChangeAgentState((s) => received.push(s));

    events.emit("agent:state-changed", {
      terminalId: "term-a",
      state: "exited",
      previousState: "working",
      timestamp: 1,
    } as never);
    delete terminalProjects["term-a"];
    await vi.advanceTimersByTimeAsync(100);

    expect(received).toEqual([
      expect.objectContaining({ terminalId: "term-a", workspaceId: PROJECT_A }),
    ]);
    expect(await host.getAgentState()).toMatchObject({ workspaceId: PROJECT_A });
  });

  it("delivers every agent transition for debounceMs: 0", async () => {
    serviceRefsMock.getPtyClient.mockReturnValue({ getTerminalProjectId: vi.fn(() => PROJECT_A) });
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const received: string[] = [];
    await host.onDidChangeAgentState((s) => received.push(s.state), { debounceMs: 0 });
    for (const [state, previousState] of [
      ["working", "idle"],
      ["waiting", "working"],
      ["idle", "waiting"],
    ]) {
      events.emit("agent:state-changed", {
        terminalId: "term-a",
        state,
        previousState,
        timestamp: 1,
      } as never);
    }
    expect(received).toEqual(["working", "waiting", "idle"]);
  });

  it("drops a pending agent-state window when the subscription is disposed", async () => {
    vi.useFakeTimers();
    serviceRefsMock.getPtyClient.mockReturnValue({ getTerminalProjectId: vi.fn(() => PROJECT_A) });
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    const dispose = await host.onDidChangeAgentState(callback);
    events.emit("agent:state-changed", {
      terminalId: "term-a",
      state: "working",
      previousState: "idle",
      timestamp: 1,
    } as never);
    dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("coalesced subscriptions and the plugin's own lifetime", () => {
  afterEach(() => {
    events.removeAllListeners();
    serviceRefsMock.getPtyClient.mockReset();
    vi.useRealTimers();
  });

  /** What unload and activation rollback do: run the tracked cleanups, never the returned disposers. */
  function runAutomaticCleanup(h: Harness): void {
    const list = h.deps.pluginEventCleanups.get(PLUGIN_ID) ?? [];
    h.deps.pluginEventCleanups.delete(PLUGIN_ID);
    for (const dispose of [...list]) dispose();
  }

  function emitAgentTransition(): void {
    events.emit("agent:state-changed", {
      terminalId: "term-a",
      state: "working",
      previousState: "idle",
      timestamp: 1,
    } as never);
  }

  const subscriptions = [
    {
      name: "onDidChangeWorktrees",
      subscribe: (host: ReturnType<typeof createHost>["host"], callback: () => void) =>
        host.onDidChangeWorktrees(callback, { debounceMs: 300 }),
      trigger: (h: Harness) => emit(h, "worktree-update", { projectPath: ROOT_A }),
    },
    {
      name: "onDidChangeActiveWorktree",
      subscribe: (host: ReturnType<typeof createHost>["host"], callback: () => void) =>
        host.onDidChangeActiveWorktree(callback, { debounceMs: 300 }),
      trigger: (h: Harness) => emit(h, "worktree-activated", { projectPath: ROOT_A }),
    },
    {
      name: "onDidChangeAgentState",
      subscribe: (host: ReturnType<typeof createHost>["host"], callback: () => void) =>
        host.onDidChangeAgentState(callback, { debounceMs: 300 }),
      trigger: () => emitAgentTransition(),
    },
  ];

  it.each(subscriptions)(
    "$name: automatic cleanup cancels a queued delivery before a same-id reload",
    async ({ subscribe, trigger }) => {
      vi.useFakeTimers();
      serviceRefsMock.getPtyClient.mockReturnValue({
        getTerminalProjectId: vi.fn(() => PROJECT_A),
      });
      const h = makeHarness();
      h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a", isCurrent: true })]));
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const callback = vi.fn();
      await subscribe(host, callback);

      trigger(h);
      runAutomaticCleanup(h);
      // The same id loads again before the window closes.
      h.plugins.set(PLUGIN_ID, fakePlugin());
      await vi.advanceTimersByTimeAsync(2_000);

      expect(callback).not.toHaveBeenCalled();
      expect(h.ambientFetch).not.toHaveBeenCalled();
      expect(h.deps.pluginEventCleanups.get(PLUGIN_ID)).toBeUndefined();
    }
  );

  it.each(subscriptions)(
    "$name: a queued delivery never reaches a closure a same-id reload replaced",
    async ({ subscribe, trigger }) => {
      vi.useFakeTimers();
      serviceRefsMock.getPtyClient.mockReturnValue({
        getTerminalProjectId: vi.fn(() => PROJECT_A),
      });
      const h = makeHarness();
      h.ambientFetch.mockResolvedValue(okFetch([worktree({ id: "wt-a", isCurrent: true })]));
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const callback = vi.fn();
      await subscribe(host, callback);

      trigger(h);
      // No cleanup ran at all: only the instance identity stands in the way.
      h.plugins.set(PLUGIN_ID, fakePlugin());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(callback).not.toHaveBeenCalled();
    }
  );

  it("drops a worktree delivery whose read resolves after a same-id reload", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeWorktrees(callback, { debounceMs: 0 });
    let release: (() => void) | undefined;
    h.ambientFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(okFetch([worktree({ id: "wt-a" })]));
        })
    );
    emit(h, "worktree-update", { projectPath: ROOT_A });
    await flush();
    h.plugins.set(PLUGIN_ID, fakePlugin());
    release?.();
    await flush();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("createHost push rejections are metered", () => {
  beforeEach(() => resetPluginPushBatcherForTests());

  it("counts an oversize or uncloneable push at the host boundary, not an accepted one", async () => {
    const h = makeHarness();
    const recordPushRejected = vi.fn();
    const deps = { ...h.deps, recordPushRejected } as PluginHostFactoryDeps;
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.broadcastToRenderer("ok", { a: 1 });
    expect(recordPushRejected).not.toHaveBeenCalled();

    const huge = { blob: "x".repeat(PLUGIN_PUSH_MAX_PAYLOAD_BYTES + 1) };
    expect(() => host.broadcastToRenderer("big", huge)).toThrow(/PLUGIN_PAYLOAD_TOO_LARGE/);
    await expect(host.postToPanel("big", huge, "panel-1")).rejects.toThrow(
      /PLUGIN_PAYLOAD_TOO_LARGE/
    );
    await expect(host.postToPanel("fn", { run: () => 1 }, "panel-1")).rejects.toThrow(
      /PLUGIN_PAYLOAD_UNCLONEABLE/
    );
    expect(recordPushRejected).toHaveBeenCalledTimes(3);
    expect(recordPushRejected).toHaveBeenCalledWith(PLUGIN_ID);

    // A host a same-id reload replaced does not count against its successor.
    h.plugins.set(PLUGIN_ID, fakePlugin());
    expect(() => host.broadcastToRenderer("big", huge)).toThrow(/PLUGIN_PAYLOAD_TOO_LARGE/);
    expect(recordPushRejected).toHaveBeenCalledTimes(3);
    flushPluginPushes();
  });
});
