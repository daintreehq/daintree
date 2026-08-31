import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markAuditedHandlerFailure } from "../../../utils/pluginAuditMarker.js";

const mockDispatchHandler = vi.fn();
const mockListPlugins = vi.fn();
const mockSetEnabled = vi.fn();
const mockInstallPlugin = vi.fn();
const mockUninstallPlugin = vi.fn();
const mockCheckForUpdate = vi.fn();
const mockListPluginActions = vi.fn();
const mockRegisterPluginAction = vi.fn();
const mockUnregisterPluginAction = vi.fn();
const mockActivatePluginForView = vi.fn();
const mockGetActiveWorktreeIdForWindow =
  vi.fn<(windowId: number | undefined) => Promise<string | null>>();
const mockGetProjectForWebContents = vi.fn<(webContentsId: number) => string | null>();
const mockGetWindowForWebContents = vi.fn<(wc: { id: number }) => { id: number } | null>();
const mockIsCachedViewWebContents = vi.fn<(webContentsId: number) => boolean>();
const mockListProjectPlugins = vi.fn();
const mockSetProjectPluginTrust = vi.fn();
const mockActivateStagedProjectPlugin = vi.fn();
const mockReloadProjectPlugins = vi.fn();

// plugin:invoke resolves the sender's project/worktree through the registry
// (#11297). Mocked so a test can register a sender without standing up a real
// BrowserWindow; unregistered senders fall through to null, which is what the
// pre-existing null-context assertions below rely on.
// Spread the real module rather than replacing it: a bare factory would drop
// every other export, so any transitive importer reaching for one gets
// `undefined` and fails far from here.
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getProjectForWebContents: (...args: [number]) => mockGetProjectForWebContents(...args),
  getWindowForWebContents: (...args: [{ id: number }]) => mockGetWindowForWebContents(...args),
  isCachedViewWebContents: (...args: [number]) => mockIsCachedViewWebContents(...args),
}));

const { mockGetPluginRecipes, mockRecordPluginRecipeUse, mockUpdatePluginRecipeMetadata } =
  vi.hoisted(() => ({
    mockGetPluginRecipes: vi.fn(() => [] as unknown[]),
    mockRecordPluginRecipeUse: vi.fn(),
    mockUpdatePluginRecipeMetadata: vi.fn(),
  }));

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: {
    listPlugins: (...args: unknown[]) => mockListPlugins(...args),
    setEnabled: (...args: unknown[]) => mockSetEnabled(...args),
    installPlugin: (...args: unknown[]) => mockInstallPlugin(...args),
    uninstallPlugin: (...args: unknown[]) => mockUninstallPlugin(...args),
    checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
    dispatchHandler: (...args: unknown[]) => mockDispatchHandler(...args),
    listPluginActions: (...args: unknown[]) => mockListPluginActions(...args),
    registerPluginAction: (...args: unknown[]) => mockRegisterPluginAction(...args),
    unregisterPluginAction: (...args: unknown[]) => mockUnregisterPluginAction(...args),
    activatePluginForView: (...args: unknown[]) => mockActivatePluginForView(...args),
    getActiveWorktreeIdForWindow: (windowId: number | undefined) =>
      mockGetActiveWorktreeIdForWindow(windowId),
    // No-op for tests that don't care about implicit activation; the IPC
    // handler awaits it before resolving the impl set.
    activatePluginsForFileDecorationScope: vi.fn().mockResolvedValue(undefined),
    // The three pull handlers (getActions / getPanelKinds / toolbarButtons)
    // await waitForInit() so a renderer that mounts before startup activation
    // settles still gets a populated snapshot — resolved-immediately in tests
    // since we don't exercise the gate here.
    waitForInit: vi.fn().mockResolvedValue(undefined),
    getPluginRecipes: () => mockGetPluginRecipes(),
    recordPluginRecipeUse: (recipeId: string, timestamp: number) =>
      mockRecordPluginRecipeUse(recipeId, timestamp),
    updatePluginRecipeMetadata: (recipeId: string, updates: unknown) =>
      mockUpdatePluginRecipeMetadata(recipeId, updates),
    listProjectPlugins: (...args: unknown[]) => mockListProjectPlugins(...args),
    setProjectPluginTrust: (...args: unknown[]) => mockSetProjectPluginTrust(...args),
    activateStagedProjectPlugin: (...args: unknown[]) => mockActivateStagedProjectPlugin(...args),
    reloadProjectPlugins: (...args: unknown[]) => mockReloadProjectPlugins(...args),
  },
}));

const mockGetPluginToolbarButtonIds = vi.fn();
const mockGetToolbarButtonConfig = vi.fn();
vi.mock("../../../../shared/config/toolbarButtonRegistry.js", () => ({
  getPluginToolbarButtonIds: (...args: unknown[]) => mockGetPluginToolbarButtonIds(...args),
  getToolbarButtonConfig: (...args: unknown[]) => mockGetToolbarButtonConfig(...args),
}));

const mockGetPluginMenuItems = vi.fn();
vi.mock("../../../services/pluginMenuRegistry.js", () => ({
  getPluginMenuItems: (...args: unknown[]) => mockGetPluginMenuItems(...args),
}));

const mockGetPluginContextMenuItems = vi.fn();
vi.mock("../../../services/pluginContextMenuRegistry.js", () => ({
  getPluginContextMenuItems: (...args: unknown[]) => mockGetPluginContextMenuItems(...args),
}));

const mockGetRegisteredForgeProviders = vi.fn();
vi.mock("../../../services/forgeProviderRegistry.js", () => ({
  getRegisteredForgeProviders: (...args: unknown[]) => mockGetRegisteredForgeProviders(...args),
}));

const mockGetFileDecorationImpls = vi.fn();
vi.mock("../../../services/fileDecorationRegistry.js", () => ({
  getFileDecorationImpls: (...args: unknown[]) => mockGetFileDecorationImpls(...args),
}));

const mockAuditAppend = vi.fn();
const mockAuditClear = vi.fn();
vi.mock("../../../services/PluginActionAuditService.js", () => ({
  getPluginActionAuditService: () => ({ append: mockAuditAppend, clear: mockAuditClear }),
}));

const mockIpcMainHandle = vi.fn();
const mockIpcMainRemoveHandler = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockGetFocusedWindow = vi.fn();
const mockNetFetch = vi.fn();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => mockIpcMainHandle(...args),
    removeHandler: (...args: unknown[]) => mockIpcMainRemoveHandler(...args),
  },
  dialog: {
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args),
  },
  BrowserWindow: {
    getFocusedWindow: (...args: unknown[]) => mockGetFocusedWindow(...args),
  },
  net: {
    fetch: (...args: unknown[]) => mockNetFetch(...args),
  },
}));

import { registerPluginHandlers } from "../plugin.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../ipcGuard.js";
import { PluginInvokeOwnershipError } from "../../../services/plugin/PluginInvokeErrors.js";
import { pluginInstallJobs } from "../../../services/plugin/PluginInstallJobRegistry.js";
import {
  clearAllPluginContributionScopes,
  setPluginContributionScope,
} from "../../../services/plugin/PluginContributionBroadcaster.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPluginToolbarButtonIds.mockReturnValue([]);
  mockGetToolbarButtonConfig.mockReturnValue(undefined);
  mockGetPluginMenuItems.mockReturnValue([]);
  mockGetPluginContextMenuItems.mockReturnValue([]);
  mockListPluginActions.mockReturnValue([]);
  mockGetRegisteredForgeProviders.mockReturnValue([]);
  mockGetFileDecorationImpls.mockReturnValue([]);
  mockGetFocusedWindow.mockReturnValue(null);
  mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  mockInstallPlugin.mockResolvedValue({ status: "installed", pluginId: "acme.my-plugin" });
  mockNetFetch.mockReset();
  // Default: the sender is not a registered project view, so plugin:invoke
  // resolves a null project / no window — the pre-#11297 context shape.
  mockGetProjectForWebContents.mockReturnValue(null);
  mockGetWindowForWebContents.mockReturnValue(null);
  mockIsCachedViewWebContents.mockReturnValue(false);
  mockGetActiveWorktreeIdForWindow.mockResolvedValue(null);
  clearAllPluginContributionScopes();
  _resetIpcGuardForTesting();
  markIpcSecurityReady();
});

describe("registerPluginHandlers", () => {
  it("registers handlers for all plugin channels", () => {
    registerPluginHandlers();
    expect(mockIpcMainHandle).toHaveBeenCalledTimes(47);
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:list", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:recipes-get", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:recipe-record-use",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:recipe-metadata-update",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:report-panel-lifecycle",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:install", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:set-enabled", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:install-from-file",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:install-from-path",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:install-from-url", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:uninstall", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:check-for-update", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:invoke", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:toolbar-buttons", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:keybindings", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:context-menu-items",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:validate-action-ids",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:actions-get", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:actions-register", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:actions-unregister",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:panel-kinds-get", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:activate-for-view",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:agents-get", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:forge-providers-get",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:file-decorations-get",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:get-audit-records",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:get-audit-config", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:clear-audit-log", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:set-audit-enabled",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:set-audit-max-records",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:export-audit-log", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:get-diagnostics-snapshot",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:settings-get-values",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:settings-set-value",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:settings-delete-value",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:settings-reveal-secret",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:bg-update-check-settings-get",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:bg-update-check-settings-set",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:bg-update-check-latest",
      expect.any(Function)
    );
    // The renderer-side menu-items IPC surface was removed (#10465) — the native
    // app menu is the wired surface. Guard against accidental re-introduction.
    expect(mockIpcMainHandle).not.toHaveBeenCalledWith("plugin:menu-items", expect.any(Function));
  });

  it("throws before registering any handler when invoked before enforceIpcSenderValidation", () => {
    _resetIpcGuardForTesting();
    expect(() => registerPluginHandlers()).toThrow(
      /registered before enforceIpcSenderValidation\(\) was called/
    );
    expect(mockIpcMainHandle).not.toHaveBeenCalledWith("plugin:invoke", expect.any(Function));
  });

  it("cleanup removes all handlers", () => {
    const cleanup = registerPluginHandlers();
    cleanup();
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:list");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:install-from-path");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:invoke");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:toolbar-buttons");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:validate-action-ids");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:actions-get");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:actions-register");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:actions-unregister");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:panel-kinds-get");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:agents-get");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:forge-providers-get");
  });

  it("PLUGIN_LIST handler delegates to pluginService.listPlugins", async () => {
    const plugins = [{ manifest: { name: "test" } }];
    mockListPlugins.mockReturnValue(plugins);

    registerPluginHandlers();
    const listHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:list"
    )![1] as (...args: unknown[]) => unknown;

    const result = await listHandler();
    expect(result).toBe(plugins);
  });

  it("PLUGIN_SET_ENABLED handler delegates to pluginService.setEnabled", async () => {
    registerPluginHandlers();
    const setEnabledHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:set-enabled"
    )![1] as (...args: unknown[]) => unknown;

    await setEnabledHandler({}, "acme.my-plugin", false);
    expect(mockSetEnabled).toHaveBeenCalledWith("acme.my-plugin", false);
  });

  it("PLUGIN_LIST answers only after waitForInit() resolves", async () => {
    const { pluginService } = await import("../../../services/PluginService.js");
    const waitForInit = vi.mocked(pluginService.waitForInit);
    let releaseGate: () => void = () => {};
    waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    registerPluginHandlers();
    const listHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:list"
    )![1] as (...args: unknown[]) => unknown;
    const inFlight = listHandler() as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    expect(mockListPlugins).not.toHaveBeenCalled();
    releaseGate();
    await inFlight;
    expect(mockListPlugins).toHaveBeenCalledTimes(1);
  });

  it("PLUGIN_SET_ENABLED applies only after waitForInit() resolves", async () => {
    const { pluginService } = await import("../../../services/PluginService.js");
    const waitForInit = vi.mocked(pluginService.waitForInit);
    let releaseGate: () => void = () => {};
    waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    registerPluginHandlers();
    const setEnabledHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:set-enabled"
    )![1] as (...args: unknown[]) => unknown;
    const inFlight = setEnabledHandler({}, "daintree.github", true) as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSetEnabled).not.toHaveBeenCalled();
    releaseGate();
    await inFlight;
    expect(mockSetEnabled).toHaveBeenCalledWith("daintree.github", true);
  });

  function getHandler(channel: string) {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  it("PLUGIN_ACTIVATE_FOR_VIEW resolves on success and throws the cause on failure (#10618)", async () => {
    const handler = getHandler("plugin:activate-for-view");

    // Success: the handler resolves undefined (#6020 — IPC handlers return void
    // on success rather than an { ok } envelope) so the renderer proceeds to
    // import. A plain activation must NOT ask for a recovery generation (#11728)
    // — that would mint a second module namespace on every first mount.
    mockActivatePluginForView.mockResolvedValueOnce({ ok: true });
    await expect(handler({}, "acme.demo.viewer")).resolves.toBeUndefined();
    // The behavioral half — the kind is forwarded and recovery is NOT requested.
    // Asserted as "falsy" rather than literal `false` so normalizing to
    // `undefined` stays green: what matters is that a first mount can't burn a
    // second module namespace, not which falsy value expresses that.
    expect(mockActivatePluginForView.mock.calls[0]![0]).toBe("acme.demo.viewer");
    expect(mockActivatePluginForView.mock.calls[0]![1]).toBeFalsy();

    // Failure: the handler throws so the IPC call rejects and the renderer's
    // PluginViewHost surfaces the real activation cause. The thrown message
    // carries the underlying error text.
    mockActivatePluginForView.mockResolvedValueOnce({ ok: false, error: "activate-boom" });
    await expect(handler({}, "acme.demo.viewer")).rejects.toThrow(/activate-boom/);
  });

  it("PLUGIN_ACTIVATE_FOR_VIEW forwards a recovery request and returns the minted path (#11728)", async () => {
    const handler = getHandler("plugin:activate-for-view");

    // The renderer's retry-after-import-failure path. Only main may build the
    // replacement URL, so the handler's job is to forward the request and hand
    // back whatever the service minted — unchanged.
    mockActivatePluginForView.mockResolvedValueOnce({
      ok: true,
      recoveryComponentPath: "plugin://acme.demo/__dtv-9/dist/view.js",
    });
    await expect(handler({}, "acme.demo.viewer", true)).resolves.toBe(
      "plugin://acme.demo/__dtv-9/dist/view.js"
    );
    expect(mockActivatePluginForView).toHaveBeenCalledWith("acme.demo.viewer", true);

    // A recovery request the service declines (PTY panel, view-less kind) still
    // resolves — the renderer falls back to the path it already has.
    mockActivatePluginForView.mockResolvedValueOnce({ ok: true });
    await expect(handler({}, "acme.demo.viewer", true)).resolves.toBeUndefined();

    // Only a real `true` requests recovery. A truthy non-boolean arriving over
    // IPC must not mint a namespace, so the flag is compared by identity rather
    // than coerced.
    mockActivatePluginForView.mockResolvedValueOnce({ ok: true });
    await handler({}, "acme.demo.viewer", "yes");
    expect(mockActivatePluginForView.mock.calls.at(-1)![1]).toBe(false);
  });

  it("PLUGIN_INSTALL_FROM_FILE returns cancelled when the picker is dismissed", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handler = getHandler("plugin:install-from-file");
    const result = await handler({ sender: { id: 1 } });
    expect(result).toEqual({ status: "cancelled" });
  });

  it("PLUGIN_INSTALL_FROM_FILE filters the picker to .dntr archives", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handler = getHandler("plugin:install-from-file");
    await handler({ sender: { id: 1 } });
    const opts = mockShowOpenDialog.mock.calls[0]![0] as {
      filters: Array<{ extensions: string[] }>;
    };
    expect(opts.filters[0]!.extensions).toEqual(["dntr"]);
  });

  it("PLUGIN_INSTALL_FROM_FILE routes the picked file through the path validator + installer", async () => {
    const file = join(tmpdir(), `plugin-picked-${process.pid}.dntr`);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
    mockInstallPlugin.mockResolvedValue({ status: "installed", pluginId: "acme.picked" });
    try {
      const handler = getHandler("plugin:install-from-file");
      const result = await handler({ sender: { id: 1 } });
      expect(mockInstallPlugin).toHaveBeenCalledWith(file);
      expect(result).toEqual({ status: "installed", pluginId: "acme.picked" });
    } finally {
      await rm(file, { force: true });
    }
  });

  it("PLUGIN_INSTALL_FROM_FILE rejects a picked non-.dntr file via the shared validator", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/tmp/not-a-plugin.txt"] });
    const handler = getHandler("plugin:install-from-file");
    const result = await handler({ sender: { id: 1 } });
    expect(result).toEqual({
      status: "failed",
      errors: [{ code: "archive_invalid", message: "Only .dntr files can be installed" }],
    });
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_PICK_PATH returns the chosen directory path", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/Users/x/notes"] });
    const handler = getHandler("plugin:pick-path");
    const result = await handler({ sender: { id: 1 } }, "acme.notes", { kind: "directory" });
    expect(result).toBe("/Users/x/notes");
    const opts = mockShowOpenDialog.mock.calls[0]![0] as { properties: string[] };
    expect(opts.properties).toEqual(["openDirectory"]);
  });

  it("PLUGIN_PICK_PATH returns null when the picker is dismissed", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handler = getHandler("plugin:pick-path");
    const result = await handler({ sender: { id: 1 } }, "acme.notes", { kind: "file" });
    expect(result).toBeNull();
  });

  it("PLUGIN_PICK_PATH passes file filters and openFile for a file pick", async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handler = getHandler("plugin:pick-path");
    await handler({ sender: { id: 1 } }, "acme.notes", {
      kind: "file",
      filters: [{ name: "Docs", extensions: ["json", "md"] }],
    });
    const opts = mockShowOpenDialog.mock.calls[0]![0] as {
      properties: string[];
      filters: Array<{ extensions: string[] }>;
    };
    expect(opts.properties).toEqual(["openFile"]);
    expect(opts.filters[0]!.extensions).toEqual(["json", "md"]);
  });

  it("PLUGIN_PICK_PATH rejects an invalid pluginId", async () => {
    const handler = getHandler("plugin:pick-path");
    await expect(
      handler({ sender: { id: 1 } }, "not a scoped name", { kind: "directory" })
    ).rejects.toThrow(/scoped plugin name/);
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
  });

  it("PLUGIN_PATH_EXISTS resolves true for an existing path and false for a missing one", async () => {
    const handler = getHandler("plugin:path-exists");
    const present = join(tmpdir(), `plugin-path-exists-${process.pid}.tmp`);
    await writeFile(present, "x");
    try {
      await expect(handler({ sender: { id: 1 } }, "acme.notes", present)).resolves.toBe(true);
      await expect(
        handler({ sender: { id: 1 } }, "acme.notes", join(tmpdir(), "definitely-missing-xyz"))
      ).resolves.toBe(false);
    } finally {
      await rm(present, { force: true });
    }
  });

  it("PLUGIN_PATH_EXISTS resolves false for a non-absolute path instead of throwing", async () => {
    const handler = getHandler("plugin:path-exists");
    await expect(handler({ sender: { id: 1 } }, "acme.notes", "relative/path")).resolves.toBe(
      false
    );
  });

  it("PLUGIN_INSTALL_FROM_URL rejects an empty URL without claiming not-implemented", async () => {
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "  ");
    expect(result).toEqual({ status: "invalid-url" });
  });

  // --- Install-from-URL bounded fetch (F24) ---

  function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  function mockResponse(opts: {
    ok?: boolean;
    status?: number;
    headers?: Record<string, string>;
    body?: ReadableStream<Uint8Array> | null;
  }) {
    const headerMap = new Map<string, string>(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      // Honor an explicit `body: null`; only default when the key is absent.
      body: "body" in opts ? opts.body : streamFromChunks([new Uint8Array([1, 2, 3])]),
    };
  }

  function abortError(name: "AbortError" | "TimeoutError" = "AbortError"): DOMException {
    return new DOMException("The operation was aborted", name);
  }

  it("PLUGIN_INSTALL_FROM_URL installs a zip archive and passes url provenance", async () => {
    mockNetFetch.mockResolvedValue(
      mockResponse({ headers: { "content-type": "application/zip" } })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "https://example.com/p.dntr");
    expect(result).toEqual({ status: "installed", pluginId: "acme.my-plugin" });
    expect(mockInstallPlugin).toHaveBeenCalledTimes(1);
    const [archivePath, opts] = mockInstallPlugin.mock.calls[0] as [string, unknown];
    expect(archivePath).toMatch(/daintree-plugin-.*\.dntr$/);
    expect(opts).toEqual({ source: "url", originalUrl: "https://example.com/p.dntr" });
  });

  it("PLUGIN_INSTALL_FROM_URL accepts application/x-dntr content type", async () => {
    mockNetFetch.mockResolvedValue(
      mockResponse({ headers: { "content-type": "application/x-dntr" } })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "https://example.com/download");
    expect(result).toEqual({ status: "installed", pluginId: "acme.my-plugin" });
  });

  // The accepted MIME set is shared with the update-check flow (T4) so a server
  // that passes one path's gate passes the other's too. octet-stream / x-zip
  // are accepted on their own MIME now — no `.dntr` suffix needed.
  it.each(["application/octet-stream", "application/x-zip", "application/x-dntr"])(
    "PLUGIN_INSTALL_FROM_URL accepts the shared archive content type %s on a non-.dntr URL",
    async (contentType) => {
      mockNetFetch.mockResolvedValue(mockResponse({ headers: { "content-type": contentType } }));
      const handler = getHandler("plugin:install-from-url");
      const result = await handler({ sender: { id: 1 } }, "https://example.com/download");
      expect(result).toEqual({ status: "installed", pluginId: "acme.my-plugin" });
    }
  );

  it("PLUGIN_INSTALL_FROM_URL falls back to the .dntr suffix for an unrecognised MIME", async () => {
    mockNetFetch.mockResolvedValue(mockResponse({ headers: { "content-type": "text/html" } }));
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "https://example.com/p.dntr");
    expect(result).toEqual({ status: "installed", pluginId: "acme.my-plugin" });
  });

  it("PLUGIN_INSTALL_FROM_URL accepts application/zip with a charset parameter", async () => {
    mockNetFetch.mockResolvedValue(
      mockResponse({ headers: { "content-type": "application/zip; charset=utf-8" } })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "https://example.com/download");
    expect(result).toEqual({ status: "installed", pluginId: "acme.my-plugin" });
  });

  it("PLUGIN_INSTALL_FROM_URL rejects a near-miss MIME like application/zipper", async () => {
    mockNetFetch.mockResolvedValue(
      mockResponse({ headers: { "content-type": "application/zipper" } })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/download")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("content_type_rejected");
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_URL returns fetch_failed when the response has no body", async () => {
    mockNetFetch.mockResolvedValue(
      mockResponse({ headers: { "content-type": "application/zip" }, body: null })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("fetch_failed");
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_URL accepts a stream of exactly the 30 MB cap", async () => {
    const atCap = new Uint8Array(30 * 1024 * 1024);
    mockNetFetch.mockResolvedValue(
      mockResponse({
        headers: { "content-type": "application/zip" },
        body: streamFromChunks([atCap]),
      })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "https://example.com/p.dntr");
    expect(result).toEqual({ status: "installed", pluginId: "acme.my-plugin" });
    // Writing the full 30 MB to a real temp file and hashing it back is slow on
    // Windows CI (disk + Defender), so this boundary case gets a wider timeout.
  }, 60_000);

  it("PLUGIN_INSTALL_FROM_URL aborts a stream one byte over the cap", async () => {
    const overCap = new Uint8Array(30 * 1024 * 1024 + 1);
    mockNetFetch.mockResolvedValue(
      mockResponse({
        headers: { "content-type": "application/zip" },
        body: streamFromChunks([overCap]),
      })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("size_exceeded");
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_URL rejects an unknown MIME with no .dntr suffix", async () => {
    mockNetFetch.mockResolvedValue(mockResponse({ headers: { "content-type": "text/html" } }));
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "https://example.com/oops");
    expect(result).toEqual({
      status: "failed",
      errors: [{ code: "content_type_rejected", message: expect.any(String) }],
    });
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_URL returns fetch_failed on a non-2xx response", async () => {
    mockNetFetch.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("fetch_failed");
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_URL returns fetch_failed on a network error", async () => {
    mockNetFetch.mockRejectedValue(new Error("ENOTFOUND"));
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("fetch_failed");
  });

  it("PLUGIN_INSTALL_FROM_URL returns fetch_timeout when the request aborts", async () => {
    mockNetFetch.mockRejectedValue(abortError("AbortError"));
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("fetch_timeout");
  });

  it("PLUGIN_INSTALL_FROM_URL rejects when Content-Length exceeds the cap", async () => {
    mockNetFetch.mockResolvedValue(
      mockResponse({
        headers: {
          "content-type": "application/zip",
          "content-length": String(31 * 1024 * 1024),
        },
      })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("size_exceeded");
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_URL aborts mid-stream when bytes exceed the cap", async () => {
    const oversized = new Uint8Array(31 * 1024 * 1024);
    mockNetFetch.mockResolvedValue(
      mockResponse({
        headers: { "content-type": "application/zip" },
        body: streamFromChunks([oversized]),
      })
    );
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("size_exceeded");
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_URL rejects a non-http(s) scheme as invalid-url", async () => {
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "file:///etc/passwd");
    expect(result).toEqual({ status: "invalid-url" });
    expect(mockNetFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1/p.dntr",
    "https://localhost/p.dntr",
    "http://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/p.dntr",
    "http://[::1]/p.dntr",
    "https://10.0.0.5/p.dntr",
  ])("PLUGIN_INSTALL_FROM_URL rejects private/loopback host %s as invalid-url", async (url) => {
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, url);
    expect(result).toEqual({ status: "invalid-url" });
    expect(mockNetFetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:pass@example.com/p.dntr",
    "https://:pass@example.com/p.dntr",
    "https://user@example.com/p.dntr",
  ])(
    "PLUGIN_INSTALL_FROM_URL rejects an embedded-credentials URL %s as invalid-url",
    async (url) => {
      const handler = getHandler("plugin:install-from-url");
      const result = await handler({ sender: { id: 1 } }, url);
      expect(result).toEqual({ status: "invalid-url" });
      // Never fetched, so the credentials are never sent or persisted as
      // installer originalUrl provenance.
      expect(mockNetFetch).not.toHaveBeenCalled();
      expect(mockInstallPlugin).not.toHaveBeenCalled();
    }
  );

  it("PLUGIN_INSTALL_FROM_URL follows a public→public redirect and revalidates each hop", async () => {
    // First hop 302s to another public host; the second hop serves the archive.
    mockNetFetch
      .mockResolvedValueOnce(
        mockResponse({ status: 302, headers: { location: "https://cdn.example.net/p.dntr" } })
      )
      .mockResolvedValueOnce(mockResponse({ headers: { "content-type": "application/zip" } }));
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "https://example.com/p.dntr");
    expect(result).toEqual({ status: "installed", pluginId: "acme.my-plugin" });
    expect(mockNetFetch).toHaveBeenCalledTimes(2);
    // Redirects are followed manually so each hop can be revalidated.
    for (const call of mockNetFetch.mock.calls) {
      expect((call[1] as { redirect?: string }).redirect).toBe("manual");
    }
  });

  it.each([
    "http://127.0.0.1/p.dntr",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/p.dntr",
    "https://localhost/p.dntr",
  ])(
    "PLUGIN_INSTALL_FROM_URL rejects a redirect to a private host %s (SSRF)",
    async (privateTarget) => {
      mockNetFetch.mockResolvedValueOnce(
        mockResponse({ status: 302, headers: { location: privateTarget } })
      );
      const handler = getHandler("plugin:install-from-url");
      const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
        status: string;
        errors: Array<{ code: string }>;
      };
      expect(result.status).toBe("failed");
      expect(result.errors[0]!.code).toBe("fetch_failed");
      // The first hop was fetched but the private redirect target never was.
      expect(mockNetFetch).toHaveBeenCalledTimes(1);
      expect(mockInstallPlugin).not.toHaveBeenCalled();
    }
  );

  it("PLUGIN_INSTALL_FROM_URL rejects a redirect chain that exceeds the hop cap", async () => {
    // Every hop redirects to another public host — the guard caps the chain.
    mockNetFetch.mockImplementation(() =>
      Promise.resolve(
        mockResponse({ status: 302, headers: { location: "https://example.org/next.dntr" } })
      )
    );
    const handler = getHandler("plugin:install-from-url");
    const result = (await handler({ sender: { id: 1 } }, "https://example.com/p.dntr")) as {
      status: string;
      errors: Array<{ code: string }>;
    };
    expect(result.status).toBe("failed");
    expect(result.errors[0]!.code).toBe("fetch_failed");
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_URL propagates an installPlugin failure", async () => {
    mockNetFetch.mockResolvedValue(
      mockResponse({ headers: { "content-type": "application/zip" } })
    );
    mockInstallPlugin.mockResolvedValue({
      status: "failed",
      errors: [{ code: "manifest_invalid", message: "bad manifest" }],
    });
    const handler = getHandler("plugin:install-from-url");
    const result = await handler({ sender: { id: 1 } }, "https://example.com/p.dntr");
    expect(result).toEqual({
      status: "failed",
      errors: [{ code: "manifest_invalid", message: "bad manifest" }],
    });
  });

  it("PLUGIN_INSTALL_FROM_PATH rejects an empty path without touching the installer", async () => {
    const handler = getHandler("plugin:install-from-path");
    const result = await handler({ sender: { id: 1 } }, "");
    expect(result).toEqual({
      status: "failed",
      errors: [{ code: "archive_invalid", message: expect.any(String) }],
    });
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_PATH rejects a relative path", async () => {
    const handler = getHandler("plugin:install-from-path");
    const result = await handler({ sender: { id: 1 } }, "relative/plugin.dntr");
    expect(result).toMatchObject({ status: "failed", errors: [{ code: "archive_invalid" }] });
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_PATH rejects a non-.dntr extension", async () => {
    const handler = getHandler("plugin:install-from-path");
    const result = await handler({ sender: { id: 1 } }, "/tmp/not-a-plugin.txt");
    expect(result).toEqual({
      status: "failed",
      errors: [{ code: "archive_invalid", message: "Only .dntr files can be installed" }],
    });
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_PATH fails when the file can't be read", async () => {
    const handler = getHandler("plugin:install-from-path");
    const result = await handler({ sender: { id: 1 } }, "/tmp/does-not-exist-9295.dntr");
    expect(result).toMatchObject({ status: "failed", errors: [{ code: "archive_invalid" }] });
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL_FROM_PATH rejects a file without the ZIP magic bytes", async () => {
    const file = join(tmpdir(), `plugin-bad-magic-${process.pid}.dntr`);
    await writeFile(file, Buffer.from("not a zip"));
    try {
      const handler = getHandler("plugin:install-from-path");
      const result = await handler({ sender: { id: 1 } }, file);
      expect(result).toMatchObject({ status: "failed", errors: [{ code: "archive_invalid" }] });
      expect(mockInstallPlugin).not.toHaveBeenCalled();
    } finally {
      await rm(file, { force: true });
    }
  });

  it("PLUGIN_INSTALL_FROM_PATH delegates to installPlugin for a valid .dntr archive", async () => {
    const file = join(tmpdir(), `plugin-good-magic-${process.pid}.dntr`);
    // ZIP local-file-header signature + filler so the 4-byte read succeeds.
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    mockInstallPlugin.mockResolvedValue({ status: "installed", pluginId: "acme.dropped" });
    try {
      const handler = getHandler("plugin:install-from-path");
      const result = await handler({ sender: { id: 1 } }, file);
      expect(mockInstallPlugin).toHaveBeenCalledWith(file);
      expect(result).toEqual({ status: "installed", pluginId: "acme.dropped" });
    } finally {
      await rm(file, { force: true });
    }
  });

  it("PLUGIN_INSTALL_FROM_PATH accepts an uppercase .DNTR extension", async () => {
    const file = join(tmpdir(), `plugin-upper-${process.pid}.DNTR`);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    mockInstallPlugin.mockResolvedValue({ status: "installed", pluginId: "acme.upper" });
    try {
      const handler = getHandler("plugin:install-from-path");
      const result = await handler({ sender: { id: 1 } }, file);
      expect(mockInstallPlugin).toHaveBeenCalledWith(file);
      expect(result).toEqual({ status: "installed", pluginId: "acme.upper" });
    } finally {
      await rm(file, { force: true });
    }
  });

  // The `install` op shares handleInstallFromPath's trust gate (absolute +
  // .dntr + ZIP-magic header sniff) so both entry points validate identically.
  it("PLUGIN_INSTALL rejects a relative path without touching the installer", async () => {
    const handler = getHandler("plugin:install");
    const result = await handler({}, "relative/plugin.dntr");
    expect(result).toMatchObject({ status: "failed", errors: [{ code: "archive_invalid" }] });
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL rejects a non-.dntr extension", async () => {
    const handler = getHandler("plugin:install");
    const result = await handler({}, "/tmp/not-a-plugin.txt");
    expect(result).toEqual({
      status: "failed",
      errors: [{ code: "archive_invalid", message: "Only .dntr files can be installed" }],
    });
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_INSTALL rejects a file without the ZIP magic bytes", async () => {
    const file = join(tmpdir(), `plugin-install-bad-magic-${process.pid}.dntr`);
    await writeFile(file, Buffer.from("not a zip"));
    try {
      const handler = getHandler("plugin:install");
      const result = await handler({}, file);
      expect(result).toMatchObject({ status: "failed", errors: [{ code: "archive_invalid" }] });
      expect(mockInstallPlugin).not.toHaveBeenCalled();
    } finally {
      await rm(file, { force: true });
    }
  });

  it("PLUGIN_INSTALL delegates to installPlugin for a valid .dntr archive", async () => {
    const file = join(tmpdir(), `plugin-install-good-magic-${process.pid}.dntr`);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    mockInstallPlugin.mockResolvedValue({ status: "installed", pluginId: "acme.installed" });
    try {
      const handler = getHandler("plugin:install");
      const result = await handler({}, file, { source: "file" });
      expect(mockInstallPlugin).toHaveBeenCalledWith(file, { source: "file" });
      expect(result).toEqual({ status: "installed", pluginId: "acme.installed" });
    } finally {
      await rm(file, { force: true });
    }
  });

  it("PLUGIN_UNINSTALL delegates to pluginService.uninstallPlugin", async () => {
    const handler = getHandler("plugin:uninstall");
    await handler({}, "acme.my-plugin");
    expect(mockUninstallPlugin).toHaveBeenCalledWith("acme.my-plugin", undefined);
  });

  it("PLUGIN_UNINSTALL forwards the deleteSettings flag", async () => {
    const handler = getHandler("plugin:uninstall");
    await handler({}, "acme.my-plugin", true);
    expect(mockUninstallPlugin).toHaveBeenCalledWith("acme.my-plugin", true);
  });

  it("PLUGIN_UNINSTALL throws on an empty id without unloading anything", async () => {
    const handler = getHandler("plugin:uninstall");
    await expect(handler({}, "")).rejects.toThrow(/non-empty string/);
    expect(mockUninstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_UNINSTALL rejects a path-traversal id without touching the service", async () => {
    const handler = getHandler("plugin:uninstall");
    await expect(handler({}, "../../../etc")).rejects.toThrow(/scoped plugin name/);
    await expect(handler({}, "no-dot")).rejects.toThrow(/scoped plugin name/);
    expect(mockUninstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_UNINSTALL rejects a non-boolean deleteSettings", async () => {
    const handler = getHandler("plugin:uninstall");
    await expect(handler({}, "acme.my-plugin", "true")).rejects.toThrow(/must be a boolean/);
    expect(mockUninstallPlugin).not.toHaveBeenCalled();
  });

  it("PLUGIN_CHECK_FOR_UPDATE delegates to pluginService.checkForUpdate and returns the result", async () => {
    mockCheckForUpdate.mockResolvedValue({
      status: "available",
      name: "acme.my-plugin",
      version: "2.0.0",
      capabilities: ["network:fetch"],
    });
    const handler = getHandler("plugin:check-for-update");
    const result = await handler({}, "acme.my-plugin");
    expect(mockCheckForUpdate).toHaveBeenCalledWith("acme.my-plugin");
    expect(result).toEqual({
      status: "available",
      name: "acme.my-plugin",
      version: "2.0.0",
      capabilities: ["network:fetch"],
    });
  });

  it("PLUGIN_CHECK_FOR_UPDATE returns invalid-id for an empty id without delegating", async () => {
    const handler = getHandler("plugin:check-for-update");
    const result = await handler({}, "");
    expect(result).toEqual({ status: "invalid-id" });
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it("PLUGIN_INVOKE handler delegates to pluginService.dispatchHandler for trusted senders", async () => {
    mockDispatchHandler.mockResolvedValue({ data: "hello" });

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 33 },
    };
    const result = await invokeHandler(trustedEvent, "acme.my-plugin", "get-data", "arg1", "arg2");
    expect(mockDispatchHandler).toHaveBeenCalledWith(
      "acme.my-plugin",
      "get-data",
      {
        projectId: null,
        worktreeId: null,
        webContentsId: 33,
        pluginId: "acme.my-plugin",
      },
      ["arg1", "arg2"]
    );
    expect(result).toEqual({ data: "hello" });
    // Successful invokes are intentionally not audited — they would be
    // high-frequency and overwhelm the ring buffer (#9240).
    expect(mockAuditAppend).not.toHaveBeenCalled();
  });

  it("PLUGIN_INVOKE handler builds ctx with webContentsId from event.sender.id", async () => {
    mockDispatchHandler.mockResolvedValue(undefined);

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 7 },
    };
    await invokeHandler(trustedEvent, "acme.my-plugin", "get-data");
    const ctxArg = mockDispatchHandler.mock.calls[0][2];
    expect(ctxArg).toEqual({
      projectId: null,
      worktreeId: null,
      webContentsId: 7,
      pluginId: "acme.my-plugin",
    });
  });

  // ── #11297: plugin:invoke carries the sender's real project/worktree ──

  function getInvokeHandler(): (...args: unknown[]) => unknown {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === "plugin:invoke")![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  const trustedSender = (id: number) => ({
    senderFrame: { url: "app://daintree/" },
    sender: { id },
  });

  it("PLUGIN_INVOKE resolves the sender's project and active worktree into ctx", async () => {
    mockDispatchHandler.mockResolvedValue(undefined);
    mockGetProjectForWebContents.mockReturnValue("proj-a");
    mockGetWindowForWebContents.mockReturnValue({ id: 42 });
    mockGetActiveWorktreeIdForWindow.mockResolvedValue("wt-a");

    await getInvokeHandler()(trustedSender(7), "acme.my-plugin", "get-data");

    expect(mockGetActiveWorktreeIdForWindow).toHaveBeenCalledWith(42);
    expect(mockDispatchHandler.mock.calls[0][2]).toEqual({
      projectId: "proj-a",
      worktreeId: "wt-a",
      webContentsId: 7,
      pluginId: "acme.my-plugin",
    });
  });

  it("PLUGIN_INVOKE yields a null worktree when the sender has no window", async () => {
    mockDispatchHandler.mockResolvedValue(undefined);
    mockGetProjectForWebContents.mockReturnValue("proj-a");
    mockGetWindowForWebContents.mockReturnValue(null);

    await getInvokeHandler()(trustedSender(7), "acme.my-plugin", "get-data");

    // Never a guessed window: without one there is nothing to scope to, so the
    // workspace is not consulted at all rather than widening to an aggregate.
    expect(mockGetActiveWorktreeIdForWindow).not.toHaveBeenCalled();
    expect(mockDispatchHandler.mock.calls[0][2]).toMatchObject({
      projectId: "proj-a",
      worktreeId: null,
    });
  });

  it("PLUGIN_INVOKE nulls the worktree when the sender's project rebinds mid-lookup", async () => {
    mockDispatchHandler.mockResolvedValue(undefined);
    mockGetWindowForWebContents.mockReturnValue({ id: 42 });
    mockGetProjectForWebContents.mockReturnValue("proj-a");

    // Hold the worktree lookup open so the rebind provably lands *during* the
    // await. Flipping the registry between two synchronous calls would pass
    // even if both ran before the lookup started, leaving the real race open.
    let releaseLookup!: (id: string) => void;
    mockGetActiveWorktreeIdForWindow.mockReturnValue(
      new Promise<string>((resolve) => {
        releaseLookup = resolve;
      })
    );

    const pending = getInvokeHandler()(trustedSender(7), "acme.my-plugin", "get-data");
    await Promise.resolve();
    // The window moved to proj-b while the lookup was in flight, so the
    // worktree it returns is proj-b's. Pairing it with the pinned proj-a would
    // recreate exactly the cross-project mismatch #11297 is about.
    mockGetProjectForWebContents.mockReturnValue("proj-b");
    releaseLookup("wt-b");
    await pending;

    expect(mockDispatchHandler.mock.calls[0][2]).toEqual({
      projectId: "proj-a",
      worktreeId: null,
      webContentsId: 7,
      pluginId: "acme.my-plugin",
    });
  });

  it("PLUGIN_INVOKE never gives an unbound sender a worktree", async () => {
    // A sender with no project binding has no project to speak for, so a
    // window-keyed worktree would attach another project's state to a context
    // whose projectId is null. Null is an identity here, not a wildcard.
    mockDispatchHandler.mockResolvedValue(undefined);
    mockGetProjectForWebContents.mockReturnValue(null);
    mockGetWindowForWebContents.mockReturnValue({ id: 42 });
    mockGetActiveWorktreeIdForWindow.mockResolvedValue("wt-somebody-elses");

    await getInvokeHandler()(trustedSender(7), "acme.my-plugin", "get-data");

    expect(mockDispatchHandler.mock.calls[0][2]).toEqual({
      projectId: null,
      worktreeId: null,
      webContentsId: 7,
      pluginId: "acme.my-plugin",
    });
    // Resolved to no window, so the workspace is never even asked.
    expect(mockGetActiveWorktreeIdForWindow).not.toHaveBeenCalled();
  });

  it("PLUGIN_INVOKE never gives a cached background view a worktree", async () => {
    // A deactivated project view stays registered to its own project while its
    // window displays another, so the window's binding does not speak for it.
    mockDispatchHandler.mockResolvedValue(undefined);
    mockGetProjectForWebContents.mockReturnValue("proj-a");
    mockGetWindowForWebContents.mockReturnValue({ id: 42 });
    mockIsCachedViewWebContents.mockReturnValue(true);
    mockGetActiveWorktreeIdForWindow.mockResolvedValue("wt-b");

    await getInvokeHandler()(trustedSender(7), "acme.my-plugin", "get-data");

    expect(mockDispatchHandler.mock.calls[0][2]).toMatchObject({
      projectId: "proj-a",
      worktreeId: null,
    });
    // A cached view resolves to no window, so the workspace is never asked.
    expect(mockGetActiveWorktreeIdForWindow).not.toHaveBeenCalled();
  });

  it("PLUGIN_INVOKE handler propagates errors from dispatchHandler", async () => {
    mockDispatchHandler.mockRejectedValue(new Error("No plugin handler registered for x:y"));

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 1 },
    };
    await expect(invokeHandler(trustedEvent, "x", "y")).rejects.toThrow(
      "No plugin handler registered for x:y"
    );
  });

  it("PLUGIN_INVOKE handler audits dispatch failures (#9240)", async () => {
    mockDispatchHandler.mockRejectedValue(new Error("No plugin handler registered for x:y"));

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 1 },
    };
    await expect(invokeHandler(trustedEvent, "x", "y", "arg1")).rejects.toThrow();
    expect(mockAuditAppend).toHaveBeenCalledTimes(1);
    const record = mockAuditAppend.mock.calls[0][0];
    expect(record).toMatchObject({
      pluginId: "x",
      actionId: "y",
      recordType: "ipc-invoke",
      channel: "plugin:invoke",
      result: "error",
    });
    expect(typeof record.errorMessage).toBe("string");
    expect(record.errorMessage).toContain("No plugin handler registered");
    expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof record.durationMs).toBe("number");
  });

  it("PLUGIN_INVOKE does not re-audit a failure already recorded at the dispatch boundary (#10463)", async () => {
    // dispatchHandler now audits handler throws itself and marks the error.
    // The outer handler must skip its own append to avoid a double record,
    // while still rethrowing so the renderer sees the failure.
    const marked = new Error("handler exploded");
    markAuditedHandlerFailure(marked);
    mockDispatchHandler.mockRejectedValue(marked);

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 1 },
    };
    await expect(invokeHandler(trustedEvent, "p", "ch", "arg1")).rejects.toBe(marked);
    expect(mockAuditAppend).not.toHaveBeenCalled();
  });

  it("PLUGIN_INVOKE audits an ownership rejection as restricted with a forensic hash (#10462)", async () => {
    // A trusted sender that targets an unloaded pluginId is a denied
    // invocation, not a handler failure — it must be classified "restricted"
    // (grouping with the untrusted-sender path) while still hashing the args,
    // since the frame already passed the origin-trust check.
    mockDispatchHandler.mockRejectedValue(
      new PluginInvokeOwnershipError("acme.missing", "get-data")
    );

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 5 },
    };
    await expect(invokeHandler(trustedEvent, "acme.missing", "get-data", "arg1")).rejects.toThrow(
      'plugin:invoke rejected: plugin "acme.missing" is not loaded'
    );
    expect(mockAuditAppend).toHaveBeenCalledTimes(1);
    const record = mockAuditAppend.mock.calls[0][0];
    expect(record).toMatchObject({
      pluginId: "acme.missing",
      actionId: "get-data",
      recordType: "ipc-invoke",
      channel: "plugin:invoke",
      result: "restricted",
    });
    // Sender was trusted, so unlike the untrusted-URL path the args ARE hashed.
    expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PLUGIN_INVOKE keeps a genuine dispatch error classified as error, not restricted (#10462)", async () => {
    // Regression guard: only ownership rejections become "restricted" — an
    // ordinary handler failure for a loaded plugin must stay "error".
    mockDispatchHandler.mockRejectedValue(new Error("handler exploded"));

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 6 },
    };
    await expect(invokeHandler(trustedEvent, "acme.loaded", "get-data", "arg1")).rejects.toThrow(
      "handler exploded"
    );
    expect(mockAuditAppend.mock.calls[0][0]).toMatchObject({ result: "error" });
  });

  it("PLUGIN_INVOKE audit hash discriminates by arg content (#9240)", async () => {
    // The whole point of the hash on `ipc-invoke` records is forensic
    // grouping: distinct args MUST produce distinct hashes, otherwise the
    // hash is just a constant marker and adds no value over the recordType.
    // A summary-based hash collapses arrays to a constant and would fail
    // this assertion — `stableArgsSha256` is the right primitive.
    mockDispatchHandler.mockRejectedValue(new Error("boom"));

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 1 },
    };
    await expect(invokeHandler(trustedEvent, "p", "ch", "arg-A")).rejects.toThrow();
    await expect(invokeHandler(trustedEvent, "p", "ch", "arg-B")).rejects.toThrow();
    await expect(invokeHandler(trustedEvent, "p", "ch", "arg-A")).rejects.toThrow();
    expect(mockAuditAppend).toHaveBeenCalledTimes(3);
    const hashes = mockAuditAppend.mock.calls.map((c) => c[0].argsHash as string);
    // Same args → same hash; different args → different hash.
    expect(hashes[0]).toBe(hashes[2]);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("PLUGIN_INVOKE caps the audited URL on untrusted-sender rejection (#9240)", async () => {
    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    // A long attacker-controlled URL must not pollute the persistent audit
    // log with arbitrary content; cap it before it enters errorMessage.
    const longUrl = `https://evil.test/${"x".repeat(2000)}`;
    const untrustedEvent = { senderFrame: { url: longUrl }, sender: { id: 1 } };
    await expect(invokeHandler(untrustedEvent, "p", "ch")).rejects.toThrow(
      "plugin:invoke rejected: untrusted sender"
    );
    expect(mockAuditAppend).toHaveBeenCalledTimes(1);
    const record = mockAuditAppend.mock.calls[0][0];
    expect(record.result).toBe("restricted");
    // 200 chars URL cap + the "untrusted sender (url=...)" wrapping is small,
    // so the whole errorMessage should stay well under ~300 chars.
    expect(record.errorMessage.length).toBeLessThan(300);
    expect(record.errorMessage).toContain("https://evil.test/");
  });

  it("PLUGIN_INVOKE handler still rethrows when audit append throws", async () => {
    mockDispatchHandler.mockRejectedValue(new Error("dispatch failed"));
    mockAuditAppend.mockImplementationOnce(() => {
      throw new Error("audit broken");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 1 },
    };
    // The original dispatch error must surface — never the audit error.
    await expect(invokeHandler(trustedEvent, "x", "y")).rejects.toThrow("dispatch failed");
    errSpy.mockRestore();
  });

  it("PLUGIN_INVOKE handler rejects untrusted senders and does not dispatch", async () => {
    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const untrustedEvent = {
      senderFrame: { url: "https://evil.com/attack.html" },
      sender: { id: 1 },
    };
    await expect(
      invokeHandler(untrustedEvent, "acme.my-plugin", "get-data", "arg1")
    ).rejects.toThrow("plugin:invoke rejected: untrusted sender");
    expect(mockDispatchHandler).not.toHaveBeenCalled();
    // Untrusted-sender rejection still writes an audit row (#9240 / #8442
    // audit-even-when-silenced) so a forensic record of the attempted invoke
    // survives even though the dispatch never ran.
    expect(mockAuditAppend).toHaveBeenCalledTimes(1);
    const record = mockAuditAppend.mock.calls[0][0];
    expect(record).toMatchObject({
      pluginId: "acme.my-plugin",
      actionId: "get-data",
      recordType: "ipc-invoke",
      channel: "plugin:invoke",
      result: "restricted",
      // Args are attacker-controlled and unvalidated — no hash.
      argsHash: "",
    });
    expect(record.errorMessage).toContain("untrusted sender");
    expect(record.errorMessage).toContain("https://evil.com");
  });

  it("PLUGIN_INVOKE handler rejects when senderFrame is missing and does not dispatch", async () => {
    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const nullFrameEvent = { senderFrame: null, sender: { id: 1 } };
    await expect(invokeHandler(nullFrameEvent, "acme.my-plugin", "get-data")).rejects.toThrow(
      "plugin:invoke rejected: untrusted sender"
    );
    expect(mockDispatchHandler).not.toHaveBeenCalled();
    // Missing-frame is also recorded as a restricted invoke.
    expect(mockAuditAppend).toHaveBeenCalledTimes(1);
    expect(mockAuditAppend.mock.calls[0][0]).toMatchObject({
      recordType: "ipc-invoke",
      result: "restricted",
      pluginId: "acme.my-plugin",
      actionId: "get-data",
    });
  });

  it("PLUGIN_INVOKE handler rejects invalid args before dispatchHandler runs", async () => {
    mockDispatchHandler.mockRejectedValue(
      new Error('Invalid arguments for plugin action "acme.ping": /name must be string')
    );

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 1 },
    };
    await expect(invokeHandler(trustedEvent, "acme.plugin", "acme.ping", 42)).rejects.toThrow(
      "Invalid arguments for plugin action"
    );

    expect(mockDispatchHandler).toHaveBeenCalledTimes(1);
  });

  it("PLUGIN_CLEAR_AUDIT_LOG clears the log for a trusted first-party sender", async () => {
    const handler = getHandler("plugin:clear-audit-log");
    await handler({ senderFrame: { url: "app://daintree/" }, sender: { id: 1 } });
    expect(mockAuditClear).toHaveBeenCalledTimes(1);
    // A trusted clear is the legitimate path — no restricted record is written.
    expect(mockAuditAppend).not.toHaveBeenCalled();
  });

  it("PLUGIN_CLEAR_AUDIT_LOG rejects an untrusted sender and leaves the log intact", async () => {
    const handler = getHandler("plugin:clear-audit-log");
    await expect(
      handler({ senderFrame: { url: "https://evil.com/attack.html" }, sender: { id: 1 } })
    ).rejects.toThrow("untrusted sender");
    // The forensic trail must survive the rejected wipe...
    expect(mockAuditClear).not.toHaveBeenCalled();
    // ...and the attempt itself is recorded as a restricted ipc-invoke.
    expect(mockAuditAppend).toHaveBeenCalledTimes(1);
    const record = mockAuditAppend.mock.calls[0]![0];
    expect(record).toMatchObject({
      recordType: "ipc-invoke",
      channel: "plugin:clear-audit-log",
      result: "restricted",
    });
    expect(record.errorMessage).toContain("untrusted sender");
    // The attacker-controlled URL is captured (capped) for forensics.
    expect(record.errorMessage).toContain("evil.com");
  });

  it("PLUGIN_CLEAR_AUDIT_LOG rejects when senderFrame is missing and does not clear", async () => {
    const handler = getHandler("plugin:clear-audit-log");
    await expect(handler({ senderFrame: null, sender: { id: 1 } })).rejects.toThrow(
      "untrusted sender"
    );
    expect(mockAuditClear).not.toHaveBeenCalled();
    expect(mockAuditAppend).toHaveBeenCalledTimes(1);
  });
});

describe("PLUGIN_VALIDATE_ACTION_IDS handler", () => {
  function getValidateHandler() {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:validate-action-ids"
    )![1] as (event: unknown, actionIds: string[]) => Promise<void>;
  }

  it("does nothing when there are no plugin contributions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.a", "action.b"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not warn when every toolbar button actionId is known", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.my.button"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.my.button",
      label: "My Button",
      iconId: "icon",
      actionId: "action.known",
      priority: 3,
      pluginId: "acme.my-plugin",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.known", "action.other"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns with the exact message when a toolbar button actionId is unknown", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.my.button"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.my.button",
      label: "My Button",
      iconId: "icon",
      actionId: "action.missing",
      priority: 3,
      pluginId: "acme.my-plugin",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.known"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Plugin] Unknown actionId "action.missing" on toolbar button "plugin.my.button" (plugin: acme.my-plugin)'
    );
    warn.mockRestore();
  });

  it("warns with the exact message when a menu item actionId is unknown", async () => {
    mockGetPluginMenuItems.mockReturnValue([
      {
        pluginId: "acme.my-plugin",
        item: {
          label: "Do Thing",
          actionId: "action.missing",
          location: "view",
        },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.known"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Plugin] Unknown actionId "action.missing" on menu item "Do Thing" (plugin: acme.my-plugin)'
    );
    warn.mockRestore();
  });

  it("warns only for unknown actionIds when contributions are mixed", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.a", "plugin.b"]);
    mockGetToolbarButtonConfig.mockImplementation((id: string) => {
      if (id === "plugin.a") {
        return {
          id: "plugin.a",
          label: "A",
          iconId: "i",
          actionId: "action.ok",
          priority: 3,
          pluginId: "p1",
        };
      }
      return {
        id: "plugin.b",
        label: "B",
        iconId: "i",
        actionId: "action.bad",
        priority: 3,
        pluginId: "p2",
      };
    });
    mockGetPluginMenuItems.mockReturnValue([
      {
        pluginId: "p3",
        item: { label: "Menu OK", actionId: "action.ok", location: "view" },
      },
      {
        pluginId: "p4",
        item: { label: "Menu Bad", actionId: "action.bad2", location: "view" },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.ok"]);
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((c) => c[0] as string).join("\n");
    expect(messages).toContain("action.bad");
    expect(messages).toContain("action.bad2");
    expect(messages).not.toContain("action.ok");
    warn.mockRestore();
  });

  it("skips toolbar button ids with no config", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.orphan"]);
    mockGetToolbarButtonConfig.mockReturnValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await expect(handler({}, [])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("resolves without throwing when warnings are emitted", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.a"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.a",
      label: "A",
      iconId: "i",
      actionId: "action.missing",
      priority: 3,
      pluginId: "p1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await expect(handler({}, [])).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["string", "action.a"],
    ["object", { a: 1 }],
  ])("does not warn when payload is a non-array (%s)", async (_label, payload) => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.a"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.a",
      label: "A",
      iconId: "i",
      actionId: "action.missing",
      priority: 3,
      pluginId: "p1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await expect(handler({}, payload as unknown as string[])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("recognises plugin-registered actionIds from pluginService.listPluginActions", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.btn"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.btn",
      label: "Btn",
      iconId: "i",
      actionId: "acme.my-plugin.doThing",
      priority: 3,
      pluginId: "acme.my-plugin",
    });
    mockGetPluginMenuItems.mockReturnValue([
      {
        pluginId: "acme.my-plugin",
        item: { label: "Do", actionId: "acme.my-plugin.other", location: "terminal" },
      },
    ]);
    mockListPluginActions.mockReturnValue([
      { pluginId: "acme.my-plugin", id: "acme.my-plugin.doThing" },
      { pluginId: "acme.my-plugin", id: "acme.my-plugin.other" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["terminal.list"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("validates on every invocation", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.a"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.a",
      label: "A",
      iconId: "i",
      actionId: "action.missing",
      priority: 3,
      pluginId: "p1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, []);
    await handler({}, []);
    await handler({}, []);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("PLUGIN_ACTIONS_GET / REGISTER / UNREGISTER handlers", () => {
  function getHandler(channel: string) {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  it("PLUGIN_ACTIONS_GET returns the list from pluginService", async () => {
    const actions = [
      {
        pluginId: "acme.my-plugin",
        id: "acme.my-plugin.doThing",
        title: "Do Thing",
        description: "Does a thing",
        category: "plugin",
        kind: "command",
        danger: "safe",
      },
    ];
    mockListPluginActions.mockReturnValue(actions);
    const handler = getHandler("plugin:actions-get");
    const result = await handler({ sender: { id: 1 } });
    expect(result).toEqual(actions);
  });

  it("PLUGIN_ACTIONS_REGISTER delegates to pluginService.registerPluginAction", async () => {
    const handler = getHandler("plugin:actions-register");
    const contribution = {
      id: "acme.my-plugin.doThing",
      title: "Do Thing",
      description: "Does a thing",
      category: "plugin",
      kind: "command",
      danger: "safe",
    };
    await handler({}, "acme.my-plugin", contribution);
    expect(mockRegisterPluginAction).toHaveBeenCalledWith("acme.my-plugin", contribution);
  });

  it("PLUGIN_ACTIONS_REGISTER propagates errors from pluginService", async () => {
    mockRegisterPluginAction.mockImplementation(() => {
      throw new Error('Plugin action "bad.id" is invalid');
    });
    const handler = getHandler("plugin:actions-register");
    await expect(handler({}, "acme.my-plugin", { id: "bad.id" })).rejects.toThrow(/Plugin action/);
  });

  it("PLUGIN_ACTIONS_UNREGISTER delegates to pluginService.unregisterPluginAction", async () => {
    const handler = getHandler("plugin:actions-unregister");
    await handler({}, "acme.my-plugin", "acme.my-plugin.doThing");
    expect(mockUnregisterPluginAction).toHaveBeenCalledWith(
      "acme.my-plugin",
      "acme.my-plugin.doThing"
    );
  });
});

describe("pull handlers wait for PluginService init (#9285)", () => {
  function getHandler(channel: string) {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  it("PLUGIN_ACTIONS_GET reads the registry only after waitForInit() resolves", async () => {
    const { pluginService } = await import("../../../services/PluginService.js");
    const waitForInit = vi.mocked(pluginService.waitForInit);
    let releaseGate: () => void = () => {};
    waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    const handler = getHandler("plugin:actions-get");
    const inFlight = handler({ sender: { id: 1 } }) as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    expect(mockListPluginActions).not.toHaveBeenCalled();
    releaseGate();
    await inFlight;
    expect(mockListPluginActions).toHaveBeenCalledTimes(1);
  });

  it("PLUGIN_TOOLBAR_BUTTONS reads the registry only after waitForInit() resolves", async () => {
    const { pluginService } = await import("../../../services/PluginService.js");
    const waitForInit = vi.mocked(pluginService.waitForInit);
    let releaseGate: () => void = () => {};
    waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    const handler = getHandler("plugin:toolbar-buttons");
    const inFlight = handler({ sender: { id: 1 } }) as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    expect(mockGetPluginToolbarButtonIds).not.toHaveBeenCalled();
    releaseGate();
    await inFlight;
    expect(mockGetPluginToolbarButtonIds).toHaveBeenCalledTimes(1);
  });

  it("PLUGIN_PANEL_KINDS_GET reads the registry only after waitForInit() resolves", async () => {
    const { pluginService } = await import("../../../services/PluginService.js");
    const waitForInit = vi.mocked(pluginService.waitForInit);
    let releaseGate: () => void = () => {};
    waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    const handler = getHandler("plugin:panel-kinds-get");
    const inFlight = handler({ sender: { id: 1 } }) as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    // `handlePanelKindsGet` reads from the panelKindRegistry, which is mocked
    // separately at module load; the call we can observe through `pluginService`
    // here is the gate itself. Assert the inFlight promise has not resolved yet.
    let resolved = false;
    void inFlight.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    releaseGate();
    await inFlight;
    expect(resolved).toBe(true);
  });

  it("PLUGIN_CONTEXT_MENU_ITEMS reads the registry only after waitForInit() resolves", async () => {
    const { pluginService } = await import("../../../services/PluginService.js");
    const waitForInit = vi.mocked(pluginService.waitForInit);
    let releaseGate: () => void = () => {};
    waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    const handler = getHandler("plugin:context-menu-items");
    const inFlight = handler({ sender: { id: 1 } }) as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    expect(mockGetPluginContextMenuItems).not.toHaveBeenCalled();
    releaseGate();
    await inFlight;
    expect(mockGetPluginContextMenuItems).toHaveBeenCalledTimes(1);
  });

  it("PLUGIN_CONTEXT_MENU_ITEMS resolves to the registry's items after init", async () => {
    const items = [
      {
        pluginId: "acme.my-plugin",
        item: { label: "Do Thing", actionId: "x.y", location: "worktree" },
      },
    ];
    mockGetPluginContextMenuItems.mockReturnValue(items);
    const handler = getHandler("plugin:context-menu-items");
    const result = await (handler({ sender: { id: 1 } }) as Promise<unknown>);
    expect(result).toEqual(items);
  });
});

describe("pull handlers scope contributions to the sender's project", () => {
  const GLOBAL_PLUGIN = "acme.global";
  const LOCAL_A = "acme.local-a";
  const LOCAL_B = "acme.local-b";

  function getHandler(channel: string) {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  const globalAction = { pluginId: GLOBAL_PLUGIN, id: "acme.global.a", title: "G" };
  const localAAction = { pluginId: LOCAL_A, id: "acme.local-a.a", title: "A" };
  const localBAction = { pluginId: LOCAL_B, id: "acme.local-b.a", title: "B" };

  beforeEach(() => {
    mockListPluginActions.mockReturnValue([globalAction, localAAction, localBAction]);
    mockGetPluginContextMenuItems.mockReturnValue([
      { pluginId: GLOBAL_PLUGIN, item: { label: "G", actionId: "x", location: "worktree" } },
      { pluginId: LOCAL_A, item: { label: "A", actionId: "x", location: "worktree" } },
      { pluginId: LOCAL_B, item: { label: "B", actionId: "x", location: "worktree" } },
    ]);
    mockGetPluginToolbarButtonIds.mockReturnValue(["g.btn", "a.btn", "b.btn"]);
    mockGetToolbarButtonConfig.mockImplementation((id: string) => {
      if (id === "g.btn") return { id, pluginId: GLOBAL_PLUGIN, actionId: "x" };
      if (id === "a.btn") return { id, pluginId: LOCAL_A, actionId: "x" };
      return { id, pluginId: LOCAL_B, actionId: "x" };
    });
  });

  it("returns everything unchanged while no plugin is project-scoped", async () => {
    mockGetProjectForWebContents.mockReturnValue("project-a");
    const result = await getHandler("plugin:actions-get")({ sender: { id: 1 } });
    expect(result).toEqual([globalAction, localAAction, localBAction]);
  });

  it("narrows actions, toolbar buttons and context-menu items to global plus the sender's project", async () => {
    setPluginContributionScope(LOCAL_A, "project-a");
    setPluginContributionScope(LOCAL_B, "project-b");
    mockGetProjectForWebContents.mockReturnValue("project-a");

    expect(await getHandler("plugin:actions-get")({ sender: { id: 1 } })).toEqual([
      globalAction,
      localAAction,
    ]);
    expect(
      (
        (await getHandler("plugin:toolbar-buttons")({ sender: { id: 1 } })) as Array<{ id: string }>
      ).map((b) => b.id)
    ).toEqual(["g.btn", "a.btn"]);
    expect(
      (
        (await getHandler("plugin:context-menu-items")({ sender: { id: 1 } })) as Array<{
          pluginId: string;
        }>
      ).map((e) => e.pluginId)
    ).toEqual([GLOBAL_PLUGIN, LOCAL_A]);
  });

  it("gives a sender with no project binding the global contributions only", async () => {
    setPluginContributionScope(LOCAL_A, "project-a");
    setPluginContributionScope(LOCAL_B, "project-b");
    mockGetProjectForWebContents.mockReturnValue(null);

    expect(await getHandler("plugin:actions-get")({ sender: { id: 1 } })).toEqual([globalAction]);
  });

  it("fails closed on an empty-string project id rather than serving every project", async () => {
    setPluginContributionScope(LOCAL_A, "project-a");
    setPluginContributionScope(LOCAL_B, "project-b");
    mockGetProjectForWebContents.mockReturnValue("");

    expect(await getHandler("plugin:actions-get")({ sender: { id: 1 } })).toEqual([globalAction]);
  });
});

describe("PLUGIN_FORGE_PROVIDERS_GET handler", () => {
  function getHandler() {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:forge-providers-get"
    )![1] as (...args: unknown[]) => unknown;
  }

  it("returns the list from getRegisteredForgeProviders", async () => {
    const providers = [
      {
        pluginId: "acme.github-plugin",
        contribution: {
          id: "github",
          name: "GitHub",
          matches: ["github.com"],
        },
      },
    ];
    mockGetRegisteredForgeProviders.mockReturnValue(providers);
    const handler = getHandler();
    const result = await handler({ sender: { id: 1 } });
    expect(result).toEqual(providers);
  });

  it("returns an empty array when no providers are registered", async () => {
    mockGetRegisteredForgeProviders.mockReturnValue([]);
    const handler = getHandler();
    const result = await handler({ sender: { id: 1 } });
    expect(result).toEqual([]);
  });

  it("reads the registry only after waitForInit() resolves", async () => {
    const { pluginService } = await import("../../../services/PluginService.js");
    const waitForInit = vi.mocked(pluginService.waitForInit);
    let releaseGate: () => void = () => {};
    waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    mockGetRegisteredForgeProviders.mockReturnValue([]);
    const handler = getHandler();
    const inFlight = handler({ sender: { id: 1 } }) as Promise<unknown>;
    await Promise.resolve();
    await Promise.resolve();
    expect(mockGetRegisteredForgeProviders).not.toHaveBeenCalled();
    releaseGate();
    await inFlight;
    expect(mockGetRegisteredForgeProviders).toHaveBeenCalledTimes(1);
  });
});

describe("PLUGIN_FILE_DECORATIONS_GET handler", () => {
  function getHandler() {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:file-decorations-get"
    )![1] as (...args: unknown[]) => unknown;
  }

  it("returns {} when no impl matches the scope", async () => {
    mockGetFileDecorationImpls.mockReturnValue([]);
    const handler = getHandler();
    expect(await handler({}, "worktree-diff:/r", ["a.ts"])).toEqual({});
  });

  it("returns {} for empty scope or empty paths without calling the registry", async () => {
    const handler = getHandler();
    expect(await handler({}, "", ["a.ts"])).toEqual({});
    expect(await handler({}, "worktree-diff:/r", [])).toEqual({});
    expect(mockGetFileDecorationImpls).not.toHaveBeenCalled();
  });

  it("merges providers first-writer-wins per field, in load order", async () => {
    const first = {
      pluginId: "p.one",
      contributionId: "d",
      impl: {
        provideDecorations: vi.fn().mockResolvedValue({
          "a.ts": { badge: "1", color: "text-status-warning" },
        }),
      },
    };
    const second = {
      pluginId: "p.two",
      contributionId: "d",
      impl: {
        provideDecorations: vi.fn().mockResolvedValue({
          "a.ts": { badge: "9", tooltip: "from second" },
          "b.ts": { badge: "2" },
        }),
      },
    };
    mockGetFileDecorationImpls.mockReturnValue([first, second]);
    const handler = getHandler();
    const result = await handler({}, "worktree-diff:/r", ["a.ts", "b.ts"]);
    expect(result).toEqual({
      "a.ts": { badge: "1", color: "text-status-warning", tooltip: "from second" },
      "b.ts": { badge: "2" },
    });
  });

  it("deduplicates requested paths before invoking impls", async () => {
    const provide = vi.fn().mockResolvedValue({});
    mockGetFileDecorationImpls.mockReturnValue([
      { pluginId: "p", contributionId: "d", impl: { provideDecorations: provide } },
    ]);
    const handler = getHandler();
    await handler({}, "s:1", ["a.ts", "a.ts", "b.ts"]);
    expect(provide).toHaveBeenCalledWith("s:1", ["a.ts", "b.ts"]);
  });

  it("skips a rejecting provider without dropping a healthy one's results", async () => {
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p.bad",
        contributionId: "d",
        impl: { provideDecorations: vi.fn().mockRejectedValue(new Error("boom")) },
      },
      {
        pluginId: "p.good",
        contributionId: "d",
        impl: {
          provideDecorations: vi.fn().mockResolvedValue({ "a.ts": { badge: "3" } }),
        },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getHandler();
    expect(await handler({}, "s:1", ["a.ts"])).toEqual({ "a.ts": { badge: "3" } });
    warn.mockRestore();
  });

  it("audits a rejecting provider (#9240)", async () => {
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p.bad",
        contributionId: "deco",
        impl: { provideDecorations: vi.fn().mockRejectedValue(new Error("boom")) },
      },
      {
        pluginId: "p.good",
        contributionId: "deco",
        impl: {
          provideDecorations: vi.fn().mockResolvedValue({ "a.ts": { badge: "3" } }),
        },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getHandler();
    await handler({}, "worktree-diff:/r", ["a.ts"]);
    // Healthy provider is not audited; only the rejecting one is.
    expect(mockAuditAppend).toHaveBeenCalledTimes(1);
    const record = mockAuditAppend.mock.calls[0][0];
    expect(record).toMatchObject({
      pluginId: "p.bad",
      actionId: "deco",
      recordType: "decoration-failure",
      result: "error",
      failureMode: "rejected",
      scope: "worktree-diff:/r",
      contributionId: "deco",
      argsHash: "",
    });
    expect(record.errorMessage).toContain("boom");
    expect(typeof record.durationMs).toBe("number");
    warn.mockRestore();
  });

  it("audits a provider that times out (#9240)", async () => {
    vi.useFakeTimers();
    try {
      mockGetFileDecorationImpls.mockReturnValue([
        {
          pluginId: "p.hang",
          contributionId: "deco",
          impl: { provideDecorations: vi.fn().mockReturnValue(new Promise(() => {})) },
        },
        {
          pluginId: "p.good",
          contributionId: "deco",
          impl: {
            provideDecorations: vi.fn().mockResolvedValue({ "a.ts": { badge: "4" } }),
          },
        },
      ]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handler = getHandler();
      const promise = handler({}, "worktree-diff:/r", ["a.ts"]) as Promise<unknown>;
      await vi.advanceTimersByTimeAsync(3000);
      await promise;
      expect(mockAuditAppend).toHaveBeenCalledTimes(1);
      const record = mockAuditAppend.mock.calls[0][0];
      expect(record).toMatchObject({
        pluginId: "p.hang",
        actionId: "deco",
        recordType: "decoration-failure",
        result: "error",
        failureMode: "timeout",
        scope: "worktree-diff:/r",
        contributionId: "deco",
      });
      expect(record.errorMessage).toMatch(/timed out after 3000ms/);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not audit successful decoration settles (#9240)", async () => {
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p.good",
        contributionId: "deco",
        impl: {
          provideDecorations: vi.fn().mockResolvedValue({ "a.ts": { badge: "1" } }),
        },
      },
    ]);
    const handler = getHandler();
    await handler({}, "worktree-diff:/r", ["a.ts"]);
    expect(mockAuditAppend).not.toHaveBeenCalled();
  });

  it("audited durationMs reflects per-provider settle time, not slowest-provider wall-clock (#9240)", async () => {
    // A provider that rejects immediately and another that hangs until the
    // timeout must produce audit records with *different* durationMs values,
    // proving the time is captured at each provider's settle moment rather
    // than after `Promise.allSettled` returns.
    vi.useFakeTimers();
    try {
      mockGetFileDecorationImpls.mockReturnValue([
        {
          pluginId: "p.fast-fail",
          contributionId: "deco",
          impl: {
            provideDecorations: vi.fn().mockRejectedValue(new Error("immediate reject")),
          },
        },
        {
          pluginId: "p.hang",
          contributionId: "deco",
          impl: { provideDecorations: vi.fn().mockReturnValue(new Promise(() => {})) },
        },
      ]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handler = getHandler();
      const promise = handler({}, "s:1", ["a.ts"]) as Promise<unknown>;
      await vi.advanceTimersByTimeAsync(3000);
      await promise;
      expect(mockAuditAppend).toHaveBeenCalledTimes(2);
      const recordsByPlugin = new Map<string, { durationMs: number }>();
      for (const call of mockAuditAppend.mock.calls) {
        recordsByPlugin.set(call[0].pluginId, call[0]);
      }
      const fast = recordsByPlugin.get("p.fast-fail")!;
      const slow = recordsByPlugin.get("p.hang")!;
      // The rejecting provider settles immediately (microtask after the
      // race is constructed); the hanging one settles when the 3000ms
      // timer fires. Allow some slack for the test scheduler.
      expect(fast.durationMs).toBeLessThan(slow.durationMs);
      expect(fast.durationMs).toBeLessThan(100);
      expect(slow.durationMs).toBeGreaterThanOrEqual(3000);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits paths whose merged decoration has no fields", async () => {
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p",
        contributionId: "d",
        impl: { provideDecorations: vi.fn().mockResolvedValue({ "a.ts": {} }) },
      },
    ]);
    const handler = getHandler();
    expect(await handler({}, "s:1", ["a.ts"])).toEqual({});
  });

  // Issue #9953: the renderer reads `decoration.url` as the click target
  // for the review-thread badge. The IPC merge must forward it — the prior
  // implementation only copied badge/tooltip/color and silently dropped
  // `url`, so the bugfix would have been non-functional in production.
  it("forwards decoration.url through the IPC boundary", async () => {
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p",
        contributionId: "d",
        impl: {
          provideDecorations: vi.fn().mockResolvedValue({
            "a.ts": {
              badge: "3",
              tooltip: "3 unresolved review comments",
              color: "text-status-warning",
              url: "https://github.com/owner/repo/pull/42/files#diff-abc",
            },
          }),
        },
      },
    ]);
    const handler = getHandler();
    const result = (await handler({}, "worktree-diff:/r", ["a.ts"])) as Record<
      string,
      { badge?: string; tooltip?: string; color?: string; url?: string }
    >;
    expect(result["a.ts"]).toEqual({
      badge: "3",
      tooltip: "3 unresolved review comments",
      color: "text-status-warning",
      url: "https://github.com/owner/repo/pull/42/files#diff-abc",
    });
  });

  it("preserves a url-only decoration through the empty-field cleanup", async () => {
    // A future provider may ship a deep-link with no badge/tooltip/color
    // (e.g. a "view related CI run" decoration). The cleanup must not
    // delete it just because the visual fields are absent.
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p",
        contributionId: "d",
        impl: {
          provideDecorations: vi.fn().mockResolvedValue({
            "a.ts": { url: "https://example.test/run/42" },
          }),
        },
      },
    ]);
    const handler = getHandler();
    expect(await handler({}, "s:1", ["a.ts"])).toEqual({
      "a.ts": { url: "https://example.test/run/42" },
    });
  });

  it("drops an empty-string url so a later provider can fill it", async () => {
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p.first",
        contributionId: "d",
        impl: { provideDecorations: vi.fn().mockResolvedValue({ "a.ts": { url: "" } }) },
      },
      {
        pluginId: "p.second",
        contributionId: "d",
        impl: {
          provideDecorations: vi.fn().mockResolvedValue({
            "a.ts": { url: "https://example.test/replacement" },
          }),
        },
      },
    ]);
    const handler = getHandler();
    expect(await handler({}, "s:1", ["a.ts"])).toEqual({
      "a.ts": { url: "https://example.test/replacement" },
    });
  });

  it("treats an empty-string field as absent so a later provider can fill it", async () => {
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p.first",
        contributionId: "d",
        impl: { provideDecorations: vi.fn().mockResolvedValue({ "a.ts": { badge: "" } }) },
      },
      {
        pluginId: "p.second",
        contributionId: "d",
        impl: { provideDecorations: vi.fn().mockResolvedValue({ "a.ts": { badge: "7" } }) },
      },
    ]);
    const handler = getHandler();
    expect(await handler({}, "s:1", ["a.ts"])).toEqual({ "a.ts": { badge: "7" } });
  });

  it("drops decorations for paths the caller did not request", async () => {
    mockGetFileDecorationImpls.mockReturnValue([
      {
        pluginId: "p",
        contributionId: "d",
        impl: {
          provideDecorations: vi.fn().mockResolvedValue({
            "requested.ts": { badge: "1" },
            "not-requested.ts": { badge: "9" },
          }),
        },
      },
    ]);
    const handler = getHandler();
    expect(await handler({}, "s:1", ["requested.ts"])).toEqual({
      "requested.ts": { badge: "1" },
    });
  });

  it("skips a provider that never settles and still returns the healthy one", async () => {
    vi.useFakeTimers();
    try {
      mockGetFileDecorationImpls.mockReturnValue([
        {
          pluginId: "p.hang",
          contributionId: "d",
          impl: { provideDecorations: vi.fn().mockReturnValue(new Promise(() => {})) },
        },
        {
          pluginId: "p.good",
          contributionId: "d",
          impl: {
            provideDecorations: vi.fn().mockResolvedValue({ "a.ts": { badge: "4" } }),
          },
        },
      ]);
      const handler = getHandler();
      const promise = handler({}, "s:1", ["a.ts"]) as Promise<unknown>;
      await vi.advanceTimersByTimeAsync(3000);
      expect(await promise).toEqual({ "a.ts": { badge: "4" } });
    } finally {
      vi.useRealTimers();
    }
  });
});

// #11302: install progress + cancellation. The handler layer owns job
// registration and the targeted progress push; the registry owns the state
// machine (covered separately). These assert the seam between them.
describe("plugin install jobs (#11302)", () => {
  // Must be UUID-shaped: the handler rejects anything else before registering.
  const JOB_ID = "3f1c9a20-7d44-4e1b-9c88-0a5b6d2e4f77";

  function getHandler(channel: string) {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  afterEach(() => {
    pluginInstallJobs.end(JOB_ID);
  });

  it("registers a cancel op alongside the install ops", () => {
    registerPluginHandlers();
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:cancel-install", expect.any(Function));
  });

  it("threads the jobId into installPlugin so the installer can find its signal", async () => {
    const file = join(tmpdir(), `plugin-job-${process.pid}.dntr`);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    mockInstallPlugin.mockResolvedValue({ status: "installed", pluginId: "acme.job" });
    try {
      const handler = getHandler("plugin:install-from-path");
      await handler({ sender: { id: 1 } }, file, JOB_ID);
      expect(mockInstallPlugin).toHaveBeenCalledWith(file, { jobId: JOB_ID });
    } finally {
      await rm(file, { force: true });
    }
  });

  it("registers the job for the duration of the install and drops it afterwards", async () => {
    const file = join(tmpdir(), `plugin-job-live-${process.pid}.dntr`);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    let signalDuringInstall: AbortSignal | undefined;
    mockInstallPlugin.mockImplementation(() => {
      signalDuringInstall = pluginInstallJobs.signal(JOB_ID);
      return Promise.resolve({ status: "installed", pluginId: "acme.job" });
    });
    try {
      const handler = getHandler("plugin:install-from-path");
      await handler({ sender: { id: 1 } }, file, JOB_ID);
      // Live while the install runs...
      expect(signalDuringInstall).toBeDefined();
      // ...and reaped by the handler's finally, so nothing leaks between installs.
      expect(pluginInstallJobs.signal(JOB_ID)).toBeUndefined();
    } finally {
      await rm(file, { force: true });
    }
  });

  it("ignores a malformed jobId rather than registering it", async () => {
    const file = join(tmpdir(), `plugin-job-bad-${process.pid}.dntr`);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const BAD_ID = "../../etc/passwd";
    // Inspect DURING the install: the wrapper's `finally` reaps the record
    // either way, so checking after the handler returns would pass even if the
    // malformed id had been accepted.
    let registeredDuringInstall: AbortSignal | undefined;
    let optsDuringInstall: unknown;
    mockInstallPlugin.mockImplementation((_p: string, opts: unknown) => {
      registeredDuringInstall = pluginInstallJobs.signal(BAD_ID);
      optsDuringInstall = opts;
      return Promise.resolve({ status: "installed", pluginId: "acme.job" });
    });
    try {
      const handler = getHandler("plugin:install-from-path");
      // Not UUID-shaped: a compromised renderer must not be able to push
      // arbitrary strings into the registry or the progress payload.
      await handler({ sender: { id: 1 } }, file, BAD_ID);
      expect(registeredDuringInstall).toBeUndefined();
      // ...and the rejected id must not reach the installer either.
      expect(optsDuringInstall).toBeUndefined();
    } finally {
      await rm(file, { force: true });
    }
  });

  it("installs without a job rather than joining an id another install already owns", async () => {
    // Two installs under one id would share a controller and an emitter:
    // cancelling one would abort the other, either could commit the other's
    // record, and progress would be pushed to the wrong window. The second must
    // therefore run detached — no progress — rather than latch onto the first.
    const file = join(tmpdir(), `plugin-job-dup-${process.pid}.dntr`);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const firstEmit = vi.fn();
    pluginInstallJobs.begin(JOB_ID, firstEmit);
    let optsDuringInstall: unknown = "unset";
    mockInstallPlugin.mockImplementation((_p: string, opts: unknown) => {
      optsDuringInstall = opts;
      return Promise.resolve({ status: "installed", pluginId: "acme.job" });
    });
    try {
      const handler = getHandler("plugin:install-from-path");
      await handler({ sender: { id: 1 } }, file, JOB_ID);
      expect(optsDuringInstall).toBeUndefined();
      // The pre-existing owner's emitter never saw the interloper's progress.
      expect(firstEmit).not.toHaveBeenCalled();
      // ...and its job survived the second install's teardown.
      expect(pluginInstallJobs.signal(JOB_ID)).toBeDefined();
    } finally {
      await rm(file, { force: true });
    }
  });

  it("cancels a live job and reports it", async () => {
    const file = join(tmpdir(), `plugin-job-cancel-${process.pid}.dntr`);
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const cancel = getHandler("plugin:cancel-install");
    let cancelResult: unknown;
    mockInstallPlugin.mockImplementation(async () => {
      cancelResult = await cancel({}, JOB_ID);
      return { status: "cancelled" };
    });
    try {
      const handler = getHandler("plugin:install-from-path");
      const result = await handler({ sender: { id: 1 } }, file, JOB_ID);
      expect(cancelResult).toBe(true);
      expect(result).toEqual({ status: "cancelled" });
    } finally {
      await rm(file, { force: true });
    }
  });

  it("reports false for an unknown or already-finished job", async () => {
    const cancel = getHandler("plugin:cancel-install");
    // Nothing is in flight — the renderer must learn the cancel did nothing
    // rather than see a button that silently no-ops.
    expect(await cancel({}, "00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(await cancel({}, "not a job id")).toBe(false);
  });

  describe("plugin recipe handlers (#11860)", () => {
    const registered = {
      id: "acme.tools.deploy",
      name: "Deploy",
      terminals: [{ type: "terminal" as const, command: "ls" }],
      createdAt: 0,
      origin: { kind: "plugin" as const, pluginId: "acme.tools", contributionId: "deploy" },
    };

    it("plugin:recipes-get returns the service snapshot", async () => {
      const handler = getHandler("plugin:recipes-get");
      mockGetPluginRecipes.mockReturnValueOnce([registered]);
      await expect(handler({ sender: { id: 1 } })).resolves.toEqual([registered]);
    });

    it("plugin:recipe-record-use forwards a valid id and timestamp", async () => {
      const handler = getHandler("plugin:recipe-record-use");
      mockRecordPluginRecipeUse.mockResolvedValueOnce(registered);
      await expect(handler({}, "acme.tools.deploy", 1234)).resolves.toEqual(registered);
      expect(mockRecordPluginRecipeUse).toHaveBeenCalledWith("acme.tools.deploy", 1234);
    });

    it("plugin:recipe-record-use rejects an unusable id or timestamp before reaching the service", async () => {
      // TS types are not runtime guarantees across contextBridge — a buggy or
      // hostile renderer can send anything, and a NaN timestamp would otherwise
      // be persisted as a run that sorts unpredictably forever.
      const handler = getHandler("plugin:recipe-record-use");
      for (const args of [
        ["", 1] as const,
        [null, 1] as const,
        ["acme.tools.deploy", Number.NaN] as const,
        ["acme.tools.deploy", 0] as const,
        ["acme.tools.deploy", -5] as const,
        ["acme.tools.deploy", "1234"] as const,
      ]) {
        await expect(handler({}, ...args)).rejects.toThrow();
      }
      expect(mockRecordPluginRecipeUse).not.toHaveBeenCalled();
    });

    it("plugin:recipe-metadata-update accepts only the two user-owned fields", async () => {
      const handler = getHandler("plugin:recipe-metadata-update");
      mockUpdatePluginRecipeMetadata.mockResolvedValue(registered);

      await handler({}, "acme.tools.deploy", { showInEmptyState: false, autoAssign: null });
      expect(mockUpdatePluginRecipeMetadata).toHaveBeenCalledWith("acme.tools.deploy", {
        showInEmptyState: false,
        autoAssign: null,
      });

      // Provenance is resolved from the registry, never taken from the caller —
      // an unknown key is dropped rather than reaching the store.
      mockUpdatePluginRecipeMetadata.mockClear();
      await handler({}, "acme.tools.deploy", { pluginId: "evil.plugin", terminals: [] });
      expect(mockUpdatePluginRecipeMetadata).toHaveBeenCalledWith("acme.tools.deploy", {});
    });

    it("plugin:recipe-metadata-update rejects malformed patch values", async () => {
      const handler = getHandler("plugin:recipe-metadata-update");
      mockUpdatePluginRecipeMetadata.mockResolvedValue(registered);
      for (const patch of [
        "not-an-object",
        null,
        { showInEmptyState: "yes" },
        { autoAssign: "sometimes" },
      ]) {
        await expect(handler({}, "acme.tools.deploy", patch)).rejects.toThrow();
      }
      expect(mockUpdatePluginRecipeMetadata).not.toHaveBeenCalled();
    });

    it("propagates the service's unknown-recipe rejection", async () => {
      // The registry is the only authority on which ids exist; the handler must
      // not invent a record for a plugin that never declared one.
      const handler = getHandler("plugin:recipe-record-use");
      mockRecordPluginRecipeUse.mockRejectedValueOnce(new Error("Plugin recipe x not found"));
      await expect(handler({}, "ghost.plugin.x", 1)).rejects.toThrow(/not found/);
    });
  });
});

describe("project-local plugin handlers", () => {
  const PROJECT = "a".repeat(64);

  function getHandler(channel: string) {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  beforeEach(() => {
    mockListProjectPlugins.mockReturnValue([]);
    mockSetProjectPluginTrust.mockResolvedValue(undefined);
    mockActivateStagedProjectPlugin.mockResolvedValue(undefined);
    mockReloadProjectPlugins.mockResolvedValue(undefined);
  });

  it("resolves the project from the SENDER, never from an argument", async () => {
    mockGetProjectForWebContents.mockReturnValue(PROJECT);
    mockListProjectPlugins.mockReturnValue([{ projectId: PROJECT, id: "acme.dashboard" }]);

    const result = await getHandler("plugin:project-list")({ sender: { id: 1 } });

    expect(mockListProjectPlugins).toHaveBeenCalledWith(PROJECT);
    expect(result).toEqual([{ projectId: PROJECT, id: "acme.dashboard" }]);
  });

  it("returns an empty list for a sender with no project binding", async () => {
    mockGetProjectForWebContents.mockReturnValue(null);
    expect(await getHandler("plugin:project-list")({ sender: { id: 1 } })).toEqual([]);
    expect(mockListProjectPlugins).not.toHaveBeenCalled();
  });

  it("records a trust decision against the sender's project", async () => {
    mockGetProjectForWebContents.mockReturnValue(PROJECT);
    await getHandler("plugin:project-set-trust")({ sender: { id: 1 } }, "enabled");
    expect(mockSetProjectPluginTrust).toHaveBeenCalledWith(PROJECT, "enabled");
  });

  it("rejects an unknown trust decision", async () => {
    mockGetProjectForWebContents.mockReturnValue(PROJECT);
    await expect(
      getHandler("plugin:project-set-trust")({ sender: { id: 1 } }, "always")
    ).rejects.toThrow(/invalid trust decision/);
    expect(mockSetProjectPluginTrust).not.toHaveBeenCalled();
  });

  it("refuses to record trust for a sender with no project", async () => {
    mockGetProjectForWebContents.mockReturnValue(null);
    await expect(
      getHandler("plugin:project-set-trust")({ sender: { id: 1 } }, "enabled")
    ).rejects.toThrow(/no project/);
  });

  it("activates a staged plugin by manifest id and rejects a malformed one", async () => {
    mockGetProjectForWebContents.mockReturnValue(PROJECT);
    await getHandler("plugin:project-activate-staged")({ sender: { id: 1 } }, "acme.dashboard");
    expect(mockActivateStagedProjectPlugin).toHaveBeenCalledWith(PROJECT, "acme.dashboard");

    await expect(
      getHandler("plugin:project-activate-staged")({ sender: { id: 1 } }, "../../etc/passwd")
    ).rejects.toThrow(/scoped plugin name/);
  });

  it("reloads the sender's project only", async () => {
    mockGetProjectForWebContents.mockReturnValue(PROJECT);
    await getHandler("plugin:project-reload")({ sender: { id: 1 } });
    expect(mockReloadProjectPlugins).toHaveBeenCalledWith(PROJECT);
  });
});

describe("plugin:invoke project binding", () => {
  const PROJECT_A = "a".repeat(64);
  const PROJECT_B = "b".repeat(64);
  const INSTANCE_A = `project__${PROJECT_A}__acme.dashboard`;
  const trustedEvent = { senderFrame: { url: "app://daintree/" }, sender: { id: 33 } };

  function invokeHandler() {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === "plugin:invoke")![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  it("rejects a project plugin invoked from a different project's renderer", async () => {
    mockGetProjectForWebContents.mockReturnValue(PROJECT_B);
    await expect(invokeHandler()(trustedEvent, INSTANCE_A, "get-data")).rejects.toThrow(
      /different project/
    );
    expect(mockDispatchHandler).not.toHaveBeenCalled();
  });

  it("rejects a project plugin invoked from a renderer with no project", async () => {
    mockGetProjectForWebContents.mockReturnValue(null);
    await expect(invokeHandler()(trustedEvent, INSTANCE_A, "get-data")).rejects.toThrow(
      /different project/
    );
    expect(mockDispatchHandler).not.toHaveBeenCalled();
  });

  it("allows a project plugin invoked from its own project's renderer", async () => {
    mockGetProjectForWebContents.mockReturnValue(PROJECT_A);
    mockDispatchHandler.mockResolvedValue({ ok: true });
    await invokeHandler()(trustedEvent, INSTANCE_A, "get-data");
    expect(mockDispatchHandler).toHaveBeenCalledWith(
      INSTANCE_A,
      "get-data",
      expect.objectContaining({ projectId: PROJECT_A, pluginId: INSTANCE_A }),
      []
    );
  });

  it("leaves an app-global plugin id unconstrained by the sender's project", async () => {
    mockGetProjectForWebContents.mockReturnValue(PROJECT_B);
    mockDispatchHandler.mockResolvedValue({ ok: true });
    await invokeHandler()(trustedEvent, "acme.dashboard", "get-data");
    expect(mockDispatchHandler).toHaveBeenCalled();
  });
});
