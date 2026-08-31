import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * The confused-deputy regression suite (§20.2): two registered projects, B
 * focused, a plugin host bound to A — and nothing the host does may reach B.
 *
 * The per-collaborator tests pin each layer in isolation with the layer below
 * it mocked; this file pins the composition, because the bug being guarded
 * against lives in the seams. `createHost`, the real
 * {@link PluginRendererDispatcher} / {@link PluginUIPromptDispatcher}, the real
 * `broadcastTo*` helpers and the real settings/storage managers all run
 * unmocked over one two-project fixture. Only the process boundaries are
 * faked — `ipcMain`, the `webContents.id → projectId` registry, the focused-view
 * lookup and the project store — so a test that passes here could not pass by
 * agreeing with a mock about which project it meant.
 */

import {
  PROJECT_A,
  PROJECT_B,
  closeProjectViews,
  focusProject,
  lastPayloadTo,
  openProject,
  projectRootOf,
  projectStoreMock,
  recipientIdsOf,
  resetTwoProjectFixture,
  type FakeWebContents,
} from "./twoProjectHarness.js";

/** The stream sink `PluginService` injects into its process manager. */
let processStreamSink: ProcessStreamSink | null = null;

const ipcMainMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
    }),
    removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(handler);
    }),
    handle: vi.fn(),
    removeHandler: vi.fn(),
    _emit: (channel: string, event: unknown, payload: unknown) => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(event, payload);
    },
    _reset: () => listeners.clear(),
  };
});

vi.mock("electron", async () => {
  const harness = await import("./twoProjectHarness.js");
  return {
    app: { getPath: () => "/tmp/daintree-confused-deputy", getVersion: () => "0.0.0" },
    ipcMain: ipcMainMock,
    webContents: { fromId: (id: number) => harness.webContentsFromId(id) },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    clipboard: { readImage: vi.fn(), readText: vi.fn(), writeText: vi.fn() },
    shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
    safeStorage: { isEncryptionAvailable: () => false },
  };
});
vi.mock("../../../window/webContentsRegistry.js", async () => {
  const harness = await import("./twoProjectHarness.js");
  return harness.webContentsRegistryMock();
});
vi.mock("../../../window/windowRef.js", async () => {
  const harness = await import("./twoProjectHarness.js");
  return harness.windowRefMock();
});
vi.mock("../../ProjectStore.js", async () => {
  const harness = await import("./twoProjectHarness.js");
  return { projectStore: harness.projectStoreMock };
});
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => null }));
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

// ── Extra module mocks for the PluginService-level process-stream test ──
// PluginService imports these at module scope; none of them participate in the
// routing decision under test.
vi.mock("../../../store.js", () => ({ store: { get: vi.fn(), set: vi.fn() } }));
vi.mock("../../../../shared/config/panelKindRegistry.js", () => ({
  registerPanelKind: vi.fn(),
  unregisterPluginPanelKinds: vi.fn(),
  onPanelKindRegistered: vi.fn(() => () => {}),
  onPanelKindUnregistered: vi.fn(() => () => {}),
  getPluginPanelKinds: vi.fn(() => []),
}));
vi.mock("../../../../shared/config/toolbarButtonRegistry.js", () => ({
  registerToolbarButton: vi.fn(),
  unregisterPluginToolbarButtons: vi.fn(),
  getAllPluginToolbarButtonConfigs: vi.fn(() => []),
}));
vi.mock("../../pluginMenuRegistry.js", () => ({
  registerPluginMenuItem: vi.fn(),
  unregisterPluginMenuItems: vi.fn(),
  getPluginMenuItems: vi.fn(() => []),
}));
vi.mock("../../PluginMcpSupervisor.js", () => ({
  getPluginMcpSupervisor: () => ({
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    shutdownAll: vi.fn(async () => undefined),
    removeState: vi.fn(),
    list: vi.fn(() => []),
  }),
}));
vi.mock("../../plugin-mcp/instances.js", () => ({
  getPluginMcpConsentService: () => ({ revokeAllForPlugin: vi.fn(() => true) }),
  getPluginMcpRateLimiter: () => ({ dropPlugin: vi.fn() }),
}));
// The real manager, subclassed only to capture the stream sink PluginService
// injects — the sink itself (the routing under test) stays untouched.
vi.mock("../PluginProcessManager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../PluginProcessManager.js")>();
  return {
    ...actual,
    PluginProcessManager: class extends actual.PluginProcessManager {
      constructor(options: ConstructorParameters<typeof actual.PluginProcessManager>[0]) {
        super(options);
        processStreamSink = options.streamSink;
      }
    },
  };
});

import { CHANNELS } from "../../../ipc/channels.js";
import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { PluginRendererDispatcher } from "../PluginRendererDispatcher.js";
import { PluginUIPromptDispatcher } from "../PluginUIPromptDispatcher.js";
import { PluginSettingsManager } from "../PluginSettingsManager.js";
import { PluginStorageManager } from "../PluginStorageManager.js";
import { isAppError } from "../../../utils/errorTypes.js";
import { UNBOUND_PLUGIN_HOST_BINDING } from "../../../../shared/types/plugin.js";
import type { PluginHostApi, PluginHostBinding } from "../../../../shared/types/plugin.js";
import { PluginService } from "../../PluginService.js";
import { PLUGIN_PROCESS_STREAM_CHANNEL } from "../../../../shared/types/ipc/pluginProcess.js";
import type { ProcessStreamSink } from "../PluginProcessManager.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme.project-plugin";

let tmpDir: string;
let dispatcher: PluginRendererDispatcher;
let promptDispatcher: PluginUIPromptDispatcher;
let wcA: FakeWebContents;
let wcB: FakeWebContents;
let settingsManager: PluginSettingsManager;
let storageManager: PluginStorageManager;
let ambientWorktreeFetch: ReturnType<typeof vi.fn>;
let projectWorktreeFetch: ReturnType<typeof vi.fn>;

/** Assert a promise rejected with the frozen `PROJECT_VIEW_UNAVAILABLE` AppError. */
async function expectProjectViewUnavailable(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    (value) => value,
    (e: unknown) => e
  );
  expect(isAppError(error)).toBe(true);
  expect(isAppError(error) && error.code).toBe("PROJECT_VIEW_UNAVAILABLE");
}

function fakePlugin(): LoadedPlugin {
  return {
    // Builtin so the JIT capability-consent prompt is skipped.
    isBuiltin: true,
    manifest: {
      name: PLUGIN_ID,
      displayName: "Project Plugin",
      capabilities: ["agent:input"],
      contributes: { forgeProviders: [], fileDecorationProviders: [], settings: [] },
    },
  } as unknown as LoadedPlugin;
}

/**
 * Host deps wired to the REAL dispatchers and the REAL settings/storage
 * managers, so a `host.dispatch` travels the whole path from the binding to a
 * `webContents.send` and a `host.settings.set` all the way to a file on disk.
 */
function makeHostDeps(): PluginHostFactoryDeps {
  ambientWorktreeFetch = vi.fn(async () => []);
  projectWorktreeFetch = vi.fn(async () => []);
  return {
    plugins: new Map<string, LoadedPlugin>([[PLUGIN_ID, fakePlugin()]]),
    pluginEventCleanups: new Map(),
    pluginActions: new Map(),
    pluginActionHandlers: new Map(),
    pluginActionOwners: new Map(),
    actionValidators: new Map(),
    pluginBadges: new Map(),
    pluginFsWatchers: new Map(),
    broadcaster: { broadcastPluginActions: vi.fn() },
    panelLifecycleBroker: { subscribe: vi.fn(() => () => {}) },
    dispatcher,
    promptDispatcher,
    settings: settingsManager,
    storage: storageManager,
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    declaredCapabilities: () => new Set(["agent:input", "agent:read"]),
    fetchAllWorktreeSnapshots: ambientWorktreeFetch,
    fetchWorktreeSnapshotsForProject: projectWorktreeFetch,
    recordPluginLog: vi.fn(),
    serializePluginBadges: () => ({}),
    pluginDataDir: () => path.join(tmpDir, "plugin-data"),
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [],
    subscribeWorktreeEvent: vi.fn(() => () => {}),
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;
}

function hostBoundTo(binding: PluginHostBinding): PluginHostApi {
  return createHost(makeHostDeps(), PLUGIN_ID, binding).host;
}

/** Answer a pending dispatch as `webContents` would. */
function answerDispatch(webContents: FakeWebContents, result: unknown): void {
  const { requestId } = lastPayloadTo(webContents, CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST);
  ipcMainMock._emit(
    CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
    { sender: { id: webContents.id } },
    { requestId, result }
  );
}

/** Answer a pending UI prompt as `webContents` would. */
function answerPrompt(webContents: FakeWebContents, result: unknown): void {
  const { promptId } = lastPayloadTo(webContents, CHANNELS.PLUGIN_UI_PROMPT_REQUEST);
  ipcMainMock._emit(
    CHANNELS.PLUGIN_UI_PROMPT_RESPONSE,
    { sender: { id: webContents.id } },
    { promptId, result }
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  ipcMainMock._reset();
  resetTwoProjectFixture();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-confused-deputy-"));
  // Two projects, each with its own renderer — and B is the one the user is
  // looking at, so every ambient lookup in the process answers "B".
  wcA = openProject(PROJECT_A, { root: path.join(tmpDir, "alpha") });
  wcB = openProject(PROJECT_B, { root: path.join(tmpDir, "beta") });
  focusProject(PROJECT_B);
  dispatcher = new PluginRendererDispatcher({ isDisposed: () => false });
  promptDispatcher = new PluginUIPromptDispatcher({ isDisposed: () => false });
  settingsManager = new PluginSettingsManager({
    getPluginsRoot: () => path.join(tmpDir, "user-plugins", "plugins"),
    getManifest: () => undefined,
  });
  storageManager = new PluginStorageManager({
    getPluginsRoot: () => path.join(tmpDir, "user-plugins", "plugins"),
    // The ambient worktree — inside B, the focused project.
    getActiveWorktreePath: async () => path.join(projectRootOf(PROJECT_B), "main"),
  });
  processStreamSink = null;
});

afterEach(async () => {
  // Settles every in-flight round-trip and clears its 30s timer.
  dispatcher.dispose();
  promptDispatcher.dispose();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a host bound to A while B is focused", () => {
  let boundToA: PluginHostBinding;

  beforeEach(() => {
    boundToA = { projectId: PROJECT_A, projectRoot: projectRootOf(PROJECT_A) };
  });

  it("dispatches into A's renderer and resolves with A's answer", async () => {
    const host = hostBoundTo(boundToA);

    const promise = host.dispatch("terminal.focus", { pane: 1 });

    expect(recipientIdsOf(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)).toEqual([wcA.id]);
    answerDispatch(wcA, { ok: true, result: "ran-in-a" });
    await expect(promise).resolves.toEqual({ ok: true, result: "ran-in-a" });
  });

  it("rejects PROJECT_VIEW_UNAVAILABLE when A has no renderer, rather than falling back to B", async () => {
    closeProjectViews(PROJECT_A);
    const host = hostBoundTo(boundToA);

    await expectProjectViewUnavailable(host.dispatch("terminal.focus"));
    // The whole point: B is live, focused, and still hears nothing.
    expect(recipientIdsOf(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)).toEqual([]);
    expect(wcB.send).not.toHaveBeenCalled();
  });

  it("prompts in A's renderer and takes A's answer", async () => {
    const host = hostBoundTo(boundToA);

    const promise = host.showConfirm({ title: "Delete branch?" });

    expect(recipientIdsOf(CHANNELS.PLUGIN_UI_PROMPT_REQUEST)).toEqual([wcA.id]);
    answerPrompt(wcA, true);
    await expect(promise).resolves.toBe(true);
  });

  it("rejects a prompt when A has no renderer rather than raising a dialog in B", async () => {
    closeProjectViews(PROJECT_A);
    const host = hostBoundTo(boundToA);

    await expectProjectViewUnavailable(host.showConfirm({ title: "Delete branch?" }));
    await expectProjectViewUnavailable(host.showInputBox({ title: "Branch name" }));
    expect(recipientIdsOf(CHANNELS.PLUGIN_UI_PROMPT_REQUEST)).toEqual([]);
    expect(wcB.send).not.toHaveBeenCalled();
  });

  it("routes toasts and panel posts to A's renderer only", async () => {
    const host = hostBoundTo(boundToA);

    await host.showToast({ message: "done", type: "info" });
    await host.broadcastToRenderer("ping", { n: 1 });
    await host.postToPanel("stream", { n: 2 }, "panel-1");

    // The real broadcastToProjectRenderers over the real project→view map:
    // delivery, not just the project id the host asked for.
    expect(recipientIdsOf(CHANNELS.NOTIFICATION_SHOW_TOAST)).toEqual([wcA.id]);
    // Both plugin pushes ride the `plugin:{id}:{channel}` transport the
    // process stream also uses.
    expect(recipientIdsOf(`plugin:${PLUGIN_ID}:ping`)).toEqual([wcA.id]);
    expect(recipientIdsOf(`plugin:${PLUGIN_ID}:stream`)).toEqual([wcA.id]);
  });

  it("degrades the catalog to empty and still rejects dispatch when A's renderer is gone", async () => {
    closeProjectViews(PROJECT_A);
    const host = hostBoundTo(boundToA);

    // Documented as never throwing — a bound host with no view is the
    // catalog's "no renderer available" case, not an error.
    expect(await host.actions.list()).toEqual([]);
    expect(await host.actions.get("terminal.focus")).toBeNull();
    expect(await host.actions.canDispatch("terminal.focus")).toBe("restricted");
    // …while the write path stays loud.
    await expectProjectViewUnavailable(host.dispatch("terminal.focus"));

    expect(recipientIdsOf(CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST)).toEqual([]);
    expect(recipientIdsOf(CHANNELS.PLUGIN_ACTIONS_GET_REQUEST)).toEqual([]);
    expect(wcB.send).not.toHaveBeenCalled();
  });

  it("reads the catalog from A while B is focused", async () => {
    const host = hostBoundTo(boundToA);

    const promise = host.actions.list();
    expect(recipientIdsOf(CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST)).toEqual([wcA.id]);
    const { requestId } = lastPayloadTo(wcA, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST);
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
      { sender: { id: wcA.id } },
      { requestId, entries: [{ id: "a-only" }] }
    );

    await expect(promise).resolves.toEqual([{ id: "a-only" }]);
  });

  it("reaches A's cached view rather than B's visible one", async () => {
    // A evicted to a cached (CPU-throttled but live) renderer; B visible.
    closeProjectViews(PROJECT_A);
    const cachedA = openProject(PROJECT_A, { root: projectRootOf(PROJECT_A), cached: true });
    const host = hostBoundTo(boundToA);

    const dispatched = host.dispatch("terminal.focus");
    const confirmed = host.showConfirm({ title: "Sure?" });

    expect(recipientIdsOf(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)).toEqual([cachedA.id]);
    expect(recipientIdsOf(CHANNELS.PLUGIN_UI_PROMPT_REQUEST)).toEqual([cachedA.id]);

    answerDispatch(cachedA, { ok: true });
    answerPrompt(cachedA, false);
    await expect(dispatched).resolves.toEqual({ ok: true });
    await expect(confirmed).resolves.toBe(false);
  });
});

describe("a malformed binding fails closed", () => {
  it("treats an empty-string project id as bound-and-unresolvable, never as ambient", async () => {
    // `== null` is the gate, not truthiness: a supplied-but-empty id is a
    // caller bug, and taking the ambient path would hand this host B.
    const host = hostBoundTo({ projectId: "", projectRoot: "" });

    await expectProjectViewUnavailable(host.dispatch("terminal.focus"));
    await expectProjectViewUnavailable(host.showConfirm({ title: "Sure?" }));
    expect(await host.actions.list()).toEqual([]);

    await host.showToast({ message: "done", type: "info" });

    // Nothing anywhere — not A's view, and above all not focused B's.
    expect(wcA.send).not.toHaveBeenCalled();
    expect(wcB.send).not.toHaveBeenCalled();
  });

  it("does not widen a bound host with a null root into the focused project", async () => {
    const host = hostBoundTo({ projectId: PROJECT_A, projectRoot: null });

    // The renderer surfaces still resolve by project id…
    const promise = host.dispatch("terminal.focus");
    expect(recipientIdsOf(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)).toEqual([wcA.id]);
    answerDispatch(wcA, { ok: true });
    await promise;

    // …and the worktree surface, which has no id-keyed lookup, degrades to
    // empty WITHOUT reading either the ambient set or the per-project one.
    expect(await host.getWorktrees()).toEqual([]);
    expect(ambientWorktreeFetch).not.toHaveBeenCalled();
    expect(projectWorktreeFetch).not.toHaveBeenCalled();
  });
});

describe("an unbound host keeps its ambient behaviour", () => {
  it("dispatches into the focused project's renderer", async () => {
    const host = hostBoundTo(UNBOUND_PLUGIN_HOST_BINDING);

    const promise = host.dispatch("terminal.focus");

    expect(recipientIdsOf(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)).toEqual([wcB.id]);
    answerDispatch(wcB, { ok: true, result: "ran-in-focus" });
    await expect(promise).resolves.toEqual({ ok: true, result: "ran-in-focus" });
  });

  it("prompts in the focused project's renderer", async () => {
    const host = hostBoundTo(UNBOUND_PLUGIN_HOST_BINDING);

    const promise = host.showConfirm({ title: "Sure?" });

    expect(recipientIdsOf(CHANNELS.PLUGIN_UI_PROMPT_REQUEST)).toEqual([wcB.id]);
    answerPrompt(wcB, true);
    await expect(promise).resolves.toBe(true);
  });

  it("still broadcasts app-wide, reaching both projects' renderers", async () => {
    const host = hostBoundTo(UNBOUND_PLUGIN_HOST_BINDING);

    await host.showToast({ message: "update available", type: "info" });

    expect(recipientIdsOf(CHANNELS.NOTIFICATION_SHOW_TOAST)).toEqual(
      [wcA.id, wcB.id].sort((a, b) => a - b)
    );
  });

  it("follows focus when it moves, unlike a bound host", async () => {
    const host = hostBoundTo(UNBOUND_PLUGIN_HOST_BINDING);

    focusProject(PROJECT_A);
    const promise = host.dispatch("terminal.focus");

    expect(recipientIdsOf(CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST)).toEqual([wcA.id]);
    answerDispatch(wcA, { ok: true });
    await promise;
  });
});

describe("settings and storage roots", () => {
  async function exists(candidate: string): Promise<boolean> {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  }

  it("writes a project-scoped setting into A's tree while B is the active project", async () => {
    const manager = settingsManager;
    const filePath = manager.resolveSettingsFilePath(
      PLUGIN_ID,
      "project",
      projectRootOf(PROJECT_A)
    );
    expect(filePath).toBe(
      path.join(projectRootOf(PROJECT_A), ".daintree", "plugin-settings", `${PLUGIN_ID}.json`)
    );

    await manager.getOrCreateSettingsStore(PLUGIN_ID, "project", filePath!).set("token", "a-value");

    // The file is on disk under A, and B's tree was never touched — the §20.2
    // "Settings write" row, asserted against the filesystem rather than a path
    // string.
    expect(await exists(filePath!)).toBe(true);
    expect(await exists(path.join(projectRootOf(PROJECT_B), ".daintree"))).toBe(false);
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
  });

  it("writes project-scoped storage into A's tree, and a bound worktree never becomes the project target", async () => {
    const manager = storageManager;
    const projectFile = await manager.resolveStorageFilePath(PLUGIN_ID, "project", {
      projectRoot: projectRootOf(PROJECT_A),
      // Deliberately paired with a worktree inside B: the two members of
      // ExplicitStorageTarget are independent, so this must not leak into the
      // project-scope answer.
      worktreePath: path.join(projectRootOf(PROJECT_B), "main"),
    });
    expect(projectFile).toBe(
      path.join(projectRootOf(PROJECT_A), ".daintree", "plugin-storage", `${PLUGIN_ID}.json`)
    );

    await manager.getOrCreateStorageStore(PLUGIN_ID, "project", projectFile!).set("cursor", 7);

    expect(await exists(projectFile!)).toBe(true);
    expect(await exists(path.join(projectRootOf(PROJECT_B), ".daintree"))).toBe(false);
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
  });

  it("writes nothing anywhere when the supplied root is an empty string", async () => {
    const settings = settingsManager;
    const storage = storageManager;

    // Fails closed rather than resolving to focused B — the same `== null`
    // rule the renderer targeting uses, on the persistence side.
    expect(settings.resolveSettingsFilePath(PLUGIN_ID, "project", "")).toBeUndefined();
    expect(
      await storage.resolveStorageFilePath(PLUGIN_ID, "project", { projectRoot: "" })
    ).toBeUndefined();
    expect(
      await storage.resolveStorageFilePath(PLUGIN_ID, "worktree", { worktreePath: "" })
    ).toBeUndefined();

    expect(await exists(path.join(projectRootOf(PROJECT_B), ".daintree"))).toBe(false);
    expect(await exists(path.join(projectRootOf(PROJECT_A), ".daintree"))).toBe(false);
  });

  it("keeps A's and B's stores distinct for the same plugin and scope", async () => {
    const manager = settingsManager;
    const aPath = manager.resolveSettingsFilePath(PLUGIN_ID, "project", projectRootOf(PROJECT_A))!;
    const bPath = manager.resolveSettingsFilePath(PLUGIN_ID, "project", projectRootOf(PROJECT_B))!;

    await manager.getOrCreateSettingsStore(PLUGIN_ID, "project", aPath).set("token", "a-value");
    await manager.getOrCreateSettingsStore(PLUGIN_ID, "project", bPath).set("token", "b-value");

    expect(
      await manager.getOrCreateSettingsStore(PLUGIN_ID, "project", aPath).get<string>("token")
    ).toBe("a-value");
    expect(JSON.parse(await fs.readFile(bPath, "utf8"))).toEqual({ token: "b-value" });
  });

  it("writes project-scoped settings and storage into A's tree, never focused B's", async () => {
    // The persistence half of the confused deputy. `createHost` hands
    // `binding.projectRoot` to both resolvers, so a host bound to A writes
    // under A even while B is the focused project. Before that wiring these
    // two calls landed in B's tree.
    const host = hostBoundTo({ projectId: PROJECT_A, projectRoot: projectRootOf(PROJECT_A) });

    await host.settings.set("token", "written-by-a", "project");
    await host.storage.set("cursor", 7, "project");

    const settingsIn = (project: string): string =>
      path.join(projectRootOf(project), ".daintree", "plugin-settings", `${PLUGIN_ID}.json`);
    const storageIn = (project: string): string =>
      path.join(projectRootOf(project), ".daintree", "plugin-storage", `${PLUGIN_ID}.json`);

    expect(JSON.parse(await fs.readFile(settingsIn(PROJECT_A), "utf8"))).toEqual({
      token: "written-by-a",
    });
    expect(JSON.parse(await fs.readFile(storageIn(PROJECT_A), "utf8"))).toEqual({ cursor: 7 });
    expect(await exists(path.join(projectRootOf(PROJECT_B), ".daintree"))).toBe(false);
  });

  it("fails closed for a malformed bound-but-rootless binding rather than writing into B", async () => {
    // A binding that names a project but carries no root is a loader bug. The
    // host resolves it to "", which both managers reject — the ambient
    // fallback would silently target focused B.
    const host = hostBoundTo({ projectId: PROJECT_A, projectRoot: null });

    await expect(host.settings.set("token", "nowhere", "project")).rejects.toThrow();
    await expect(host.storage.set("cursor", 7, "project")).rejects.toThrow();

    expect(await exists(path.join(projectRootOf(PROJECT_B), ".daintree"))).toBe(false);
    expect(await exists(path.join(projectRootOf(PROJECT_A), ".daintree"))).toBe(false);
  });
});

describe("a bound plugin's process output", () => {
  const services: PluginService[] = [];

  afterEach(() => {
    // Settles the init gate and drops registry subscriptions; the stream sink
    // is invoked directly, so nothing is left running.
    for (const service of services.splice(0)) service.dispose();
  });

  /**
   * Reach `PluginService`'s own routing: it looks the plugin's binding up in
   * `hostBindings` when a managed process emits, because one process manager is
   * shared by every plugin. Registering the binding goes through the private
   * `createHost`, which is the only writer of that map.
   */
  function serviceBoundTo(binding: PluginHostBinding): void {
    const service = new PluginService(path.join(tmpDir, "plugins"), "0.0.0");
    services.push(service);
    const internals = service as unknown as {
      plugins: Map<string, LoadedPlugin>;
      createHost: (pluginId: string, binding: PluginHostBinding) => unknown;
      getProcessManager: () => unknown;
    };
    internals.plugins.set(PLUGIN_ID, fakePlugin());
    internals.createHost(PLUGIN_ID, binding);
    internals.getProcessManager();
  }

  /** One of each stream kind a managed process emits over the sink. */
  function emitProcessStream(): void {
    if (!processStreamSink) throw new Error("process stream sink was never captured");
    processStreamSink(PLUGIN_ID, { kind: "stdout", id: "proc-1", chunk: "out" }, "panel-1");
    processStreamSink(PLUGIN_ID, { kind: "stderr", id: "proc-1", chunk: "err" }, "panel-1");
    processStreamSink(
      PLUGIN_ID,
      { kind: "exit", id: "proc-1", exitCode: 0, signal: null },
      "panel-1"
    );
  }

  const streamChannel = `plugin:${PLUGIN_ID}:${PLUGIN_PROCESS_STREAM_CHANNEL}`;

  it("reaches only its own project's renderer, not the focused one", () => {
    serviceBoundTo({ projectId: PROJECT_A, projectRoot: projectRootOf(PROJECT_A) });

    emitProcessStream();

    // This was an app-wide broadcast before the binding landed: B, the focused
    // project, would have received another project's process output.
    expect(recipientIdsOf(streamChannel)).toEqual([wcA.id]);
    expect(wcB.send).not.toHaveBeenCalled();
  });

  it("still reaches every renderer when the plugin is unbound", () => {
    serviceBoundTo(UNBOUND_PLUGIN_HOST_BINDING);

    emitProcessStream();

    expect(recipientIdsOf(streamChannel)).toEqual([wcA.id, wcB.id].sort((a, b) => a - b));
  });

  it("reaches nobody when the binding carries an empty project id", () => {
    serviceBoundTo({ projectId: "", projectRoot: "" });

    emitProcessStream();

    expect(recipientIdsOf(streamChannel)).toEqual([]);
  });
});
