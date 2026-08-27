import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ForgeProviderEntry, ResolvedForgeProvider } from "../../../../shared/types/forge.js";
import type { ResolveForgeProviderInputs } from "../../../services/forgeProviderResolver.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({
  store: storeMock,
  auditLogsStore: { get: vi.fn(() => []), set: vi.fn() },
}));

const registryMock = vi.hoisted(() => ({
  getRegisteredForgeProviders: vi.fn<() => ForgeProviderEntry[]>(() => []),
  getForgeProviderImpl: vi.fn<(id: string) => unknown>(() => undefined),
  // Consulted by remote selection (#11408) to decide whether a URL is
  // parseable. Default "yes" keeps these tests about provider resolution.
  listMatchingProviders: vi.fn<(remoteUrl: string) => unknown[]>(() => [{}]),
}));

vi.mock("../../../services/forgeProviderRegistry.js", () => registryMock);

const workspaceClientMock = vi.hoisted(() => ({
  updateForgeCredentials: vi.fn(),
}));

vi.mock("../../../services/WorkspaceClient.js", () => ({
  getWorkspaceClient: () => workspaceClientMock,
}));

const resolverMock = vi.hoisted(() => ({
  resolveForgeProvider: vi.fn<(inputs: ResolveForgeProviderInputs) => ResolvedForgeProvider>(
    () => ({ entry: null, resolvedVia: null })
  ),
}));

vi.mock("../../../services/forgeProviderResolver.js", () => resolverMock);

const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getProjectSettings: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const gitServiceMock = vi.hoisted(() => ({
  getRemoteUrl: vi.fn(),
  listRemotes: vi.fn<() => Promise<Array<{ name: string; fetchUrl: string }>>>(async () => []),
}));
const gitServiceCacheMock = vi.hoisted(() => ({ getGitService: vi.fn(() => gitServiceMock) }));

vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: gitServiceCacheMock,
}));

// The handlers lazy-import PluginService to gate registry reads behind
// startup load + activation (the #9285 init-race guard); stub the singleton
// so tests never construct the real service.
const pluginServiceMock = vi.hoisted(() => ({
  waitForInit: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: pluginServiceMock,
}));

import { registerForgeSettingsHandlers } from "../forgeSettings.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { forgeAuditService } from "../../../services/forge/forgeAuditService.js";

function findHandler(channel: string): (...args: unknown[]) => unknown {
  const entry = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!entry) throw new Error(`handler not registered for ${channel}`);
  return entry[1] as (...args: unknown[]) => unknown;
}

describe("registerForgeSettingsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
    registryMock.getRegisteredForgeProviders.mockReturnValue([]);
    registryMock.getForgeProviderImpl.mockReturnValue(undefined);
    workspaceClientMock.updateForgeCredentials.mockReset();
    projectStoreMock.getProjectById.mockReturnValue({
      id: "project-1",
      path: "/repo",
      name: "repo",
    });
    projectStoreMock.getProjectSettings.mockResolvedValue({ runCommands: [] });
    gitServiceMock.getRemoteUrl.mockResolvedValue("https://github.com/owner/repo.git");
    // Mirrors the `getRemoteUrl` default above: a plain single-origin repo.
    gitServiceMock.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/owner/repo.git" },
    ]);
    registryMock.listMatchingProviders.mockReturnValue([{}]);
  });

  it("registers all IPC handlers including the credential channels", () => {
    const cleanup = registerForgeSettingsHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(7);
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-settings", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:set-default-provider",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:get-providers", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:resolve-provider", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:set-credential", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      "forge:get-credential-status",
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith("forge:clear-credential", expect.any(Function));
    cleanup();
  });

  it("getSettings returns null defaultProviderId when key is absent", () => {
    registerForgeSettingsHandlers();
    const getSettings = findHandler("forge:get-settings");
    expect(getSettings(null)).toEqual({ defaultProviderId: null });
  });

  it("getSettings returns the stored providerId when present", () => {
    storeMock._data["forgeDefaultProviderId"] = "acme.gitea";
    registerForgeSettingsHandlers();
    const getSettings = findHandler("forge:get-settings");
    expect(getSettings(null)).toEqual({ defaultProviderId: "acme.gitea" });
  });

  it("getSettings coerces non-string stored values to null", () => {
    storeMock._data["forgeDefaultProviderId"] = 42;
    registerForgeSettingsHandlers();
    const getSettings = findHandler("forge:get-settings");
    expect(getSettings(null)).toEqual({ defaultProviderId: null });
  });

  it("setDefaultProvider persists a string id and echoes it back", () => {
    registerForgeSettingsHandlers();
    const setDefault = findHandler("forge:set-default-provider");
    expect(setDefault(null, "acme.gitea")).toEqual({ defaultProviderId: "acme.gitea" });
    expect(storeMock.set).toHaveBeenCalledWith("forgeDefaultProviderId", "acme.gitea");
  });

  it("setDefaultProvider clears the value when called with null", () => {
    storeMock._data["forgeDefaultProviderId"] = "acme.gitea";
    registerForgeSettingsHandlers();
    const setDefault = findHandler("forge:set-default-provider");
    expect(setDefault(null, null)).toEqual({ defaultProviderId: null });
    expect(storeMock.set).toHaveBeenCalledWith("forgeDefaultProviderId", null);
  });

  it("setDefaultProvider treats empty string as null", () => {
    registerForgeSettingsHandlers();
    const setDefault = findHandler("forge:set-default-provider");
    expect(setDefault(null, "")).toEqual({ defaultProviderId: null });
    expect(storeMock.set).toHaveBeenCalledWith("forgeDefaultProviderId", null);
  });

  it("setDefaultProvider treats non-string payloads as null", () => {
    registerForgeSettingsHandlers();
    const setDefault = findHandler("forge:set-default-provider");
    expect(setDefault(null, 42)).toEqual({ defaultProviderId: null });
    expect(storeMock.set).toHaveBeenCalledWith("forgeDefaultProviderId", null);
  });

  it("setDefaultProvider treats whitespace-only strings as null", () => {
    registerForgeSettingsHandlers();
    const setDefault = findHandler("forge:set-default-provider");
    expect(setDefault(null, "   ")).toEqual({ defaultProviderId: null });
    expect(storeMock.set).toHaveBeenCalledWith("forgeDefaultProviderId", null);
  });

  it("setDefaultProvider trims surrounding whitespace from the persisted id", () => {
    registerForgeSettingsHandlers();
    const setDefault = findHandler("forge:set-default-provider");
    expect(setDefault(null, "  acme.gitea  ")).toEqual({ defaultProviderId: "acme.gitea" });
    expect(storeMock.set).toHaveBeenCalledWith("forgeDefaultProviderId", "acme.gitea");
  });

  it("setDefaultProvider canonicalizes a legacy 'builtin.github' input before persisting (#8451)", () => {
    registerForgeSettingsHandlers();
    const setDefault = findHandler("forge:set-default-provider");
    expect(setDefault(null, "builtin.github")).toEqual({
      defaultProviderId: "daintree.github.github",
    });
    expect(storeMock.set).toHaveBeenCalledWith("forgeDefaultProviderId", "daintree.github.github");
  });

  it("setDefaultProvider canonicalizes a legacy bare 'github' input before persisting (#8451)", () => {
    registerForgeSettingsHandlers();
    const setDefault = findHandler("forge:set-default-provider");
    expect(setDefault(null, "github")).toEqual({ defaultProviderId: "daintree.github.github" });
    expect(storeMock.set).toHaveBeenCalledWith("forgeDefaultProviderId", "daintree.github.github");
  });

  it("getSettings treats whitespace-only stored values as null", () => {
    storeMock._data["forgeDefaultProviderId"] = "   ";
    registerForgeSettingsHandlers();
    const getSettings = findHandler("forge:get-settings");
    expect(getSettings(null)).toEqual({ defaultProviderId: null });
  });

  it("getProviders returns the live registry contents", async () => {
    const entries: ForgeProviderEntry[] = [
      {
        pluginId: "acme.gitea",
        contribution: {
          id: "gitea",
          name: "Gitea",
          matches: ["gitea.example.com"],
        },
      },
    ];
    registryMock.getRegisteredForgeProviders.mockReturnValue(entries);
    registerForgeSettingsHandlers();
    const getProviders = findHandler("forge:get-providers");
    await expect(getProviders(null)).resolves.toEqual(entries);
  });

  it("getProviders reads the registry only after plugin init settles", async () => {
    let releaseGate: () => void = () => {};
    pluginServiceMock.waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    registerForgeSettingsHandlers();
    const getProviders = findHandler("forge:get-providers");
    const inFlight = getProviders(null) as Promise<unknown>;
    // Drain enough microtasks for the lazy-import chain to reach the gate.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(pluginServiceMock.waitForInit).toHaveBeenCalledTimes(1);
    expect(registryMock.getRegisteredForgeProviders).not.toHaveBeenCalled();
    releaseGate();
    await inFlight;
    expect(registryMock.getRegisteredForgeProviders).toHaveBeenCalledTimes(1);
  });

  it("resolveProvider resolves only after plugin init settles (descriptors register during deferred init)", async () => {
    let releaseGate: () => void = () => {};
    pluginServiceMock.waitForInit.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    );
    resolverMock.resolveForgeProvider.mockReturnValueOnce({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    const inFlight = resolveProvider(null, "project-1") as Promise<unknown>;
    // Drain enough microtasks for the lazy-import chain to reach the gate;
    // the gate itself (not import latency) must be what holds the handler.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(pluginServiceMock.waitForInit).toHaveBeenCalledTimes(1);
    // getProjectById is the first synchronous call after the gate — asserting
    // on it (not just the resolver, which sits behind further awaits) proves
    // the gate is what blocks, so this test fails on the un-gated handler.
    expect(projectStoreMock.getProjectById).not.toHaveBeenCalled();
    expect(resolverMock.resolveForgeProvider).not.toHaveBeenCalled();
    releaseGate();
    await inFlight;
    expect(projectStoreMock.getProjectById).toHaveBeenCalledTimes(1);
    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent identical resolves into one remote read (#12042)", async () => {
    // Every mounted forge consumer in the renderer resolves on mount and again
    // on every provenance change, and each resolution reaches
    // GitService.listRemotes — a `git remote -v` spawn.
    let releaseRemotes: (remotes: Array<{ name: string; fetchUrl: string }>) => void = () => {};
    gitServiceMock.listRemotes.mockImplementationOnce(
      () =>
        new Promise<Array<{ name: string; fetchUrl: string }>>((resolve) => {
          releaseRemotes = resolve;
        })
    );
    resolverMock.resolveForgeProvider.mockReturnValue({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");

    const inFlight = Array.from(
      { length: 5 },
      () => resolveProvider(null, "project-1") as Promise<unknown>
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    releaseRemotes([{ name: "origin", fetchUrl: "https://github.com/owner/repo.git" }]);
    const results = await Promise.all(inFlight);

    expect(gitServiceMock.listRemotes).toHaveBeenCalledTimes(1);
    // Joining must hand every caller the same answer, not drop the late ones.
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it("does not coalesce resolves for different projects or explicit remotes", async () => {
    resolverMock.resolveForgeProvider.mockReturnValue({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");

    await Promise.all([
      resolveProvider(null, "project-1"),
      resolveProvider(null, "project-2"),
      // An explicit URL asks about one specific remote, not the project's
      // routing choice — the Settings panel probes each remote in turn.
      resolveProvider(null, "project-1", "https://github.com/owner/other.git"),
    ]);

    expect(projectStoreMock.getProjectById).toHaveBeenCalledTimes(3);
  });

  it("re-reads remotes once a resolve has settled", async () => {
    // The in-flight entry must be evicted on settlement — a retained one would
    // pin the toolbar to a stale provider for the life of the app.
    resolverMock.resolveForgeProvider.mockReturnValue({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");

    await resolveProvider(null, "project-1");
    const readsAfterFirst = gitServiceMock.listRemotes.mock.calls.length;
    await resolveProvider(null, "project-1");

    expect(gitServiceMock.listRemotes.mock.calls.length).toBeGreaterThan(readsAfterFirst);
  });

  it("cleanup removes all registered handlers", () => {
    const cleanup = registerForgeSettingsHandlers();
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(7);
  });

  it("resolveProvider gathers inputs and delegates to the resolver", async () => {
    const entry: ForgeProviderEntry = {
      pluginId: "builtin",
      contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
    };
    const resolved: ResolvedForgeProvider = { entry, resolvedVia: "hostname" };
    resolverMock.resolveForgeProvider.mockReturnValueOnce(resolved);
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    await expect(resolveProvider(null, "project-1")).resolves.toEqual(resolved);
    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledWith({
      remoteUrl: "https://github.com/owner/repo.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
    });
  });

  it("resolveProvider forwards the optional remoteUrl when provided (skips git lookup)", async () => {
    const entry: ForgeProviderEntry = {
      pluginId: "acme.gitea",
      contribution: { id: "gitea", name: "Gitea", matches: ["gitea.example.com"] },
    };
    const resolved: ResolvedForgeProvider = { entry, resolvedVia: "hostname" };
    resolverMock.resolveForgeProvider.mockReturnValueOnce(resolved);
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    await expect(
      resolveProvider(null, "project-1", "git@gitea.example.com:owner/repo.git")
    ).resolves.toEqual(resolved);
    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledWith({
      remoteUrl: "git@gitea.example.com:owner/repo.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
    });
    expect(gitServiceMock.getRemoteUrl).not.toHaveBeenCalled();
  });

  it("resolveProvider treats a non-string remoteUrl as missing (falls back to git lookup)", async () => {
    const resolved: ResolvedForgeProvider = { entry: null, resolvedVia: null };
    resolverMock.resolveForgeProvider.mockReturnValueOnce(resolved);
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    await expect(resolveProvider(null, "project-1", 42)).resolves.toEqual(resolved);
    // Selection reads the remote table (#11408); `getRemoteUrl` is now only
    // the fallback for when enumeration itself fails.
    expect(gitServiceMock.listRemotes).toHaveBeenCalledTimes(1);
    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledWith({
      remoteUrl: "https://github.com/owner/repo.git",
      forgeProviderOverride: null,
      globalDefaultProviderId: null,
    });
  });

  it("resolveProvider resolves against the project's forgeRemote, not origin (#11408)", async () => {
    // The pill visibility gate. An origin-only lookup here hid issues and PRs
    // on every fork whose forge remote is named something else.
    projectStoreMock.getProjectSettings.mockResolvedValue({ forgeRemote: "upstream" });
    gitServiceMock.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/me/fork.git" },
      { name: "upstream", fetchUrl: "https://github.com/acme/canonical.git" },
    ]);
    resolverMock.resolveForgeProvider.mockReturnValueOnce({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");

    await resolveProvider(null, "project-1");

    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: "https://github.com/acme/canonical.git" })
    );
  });

  it("resolveProvider still honours an explicitly passed remoteUrl over the setting (#11408)", async () => {
    // The Settings routing panel probes each remote in turn — the project's
    // own selection must not override what the caller asked about.
    projectStoreMock.getProjectSettings.mockResolvedValue({ forgeRemote: "upstream" });
    gitServiceMock.listRemotes.mockResolvedValue([
      { name: "origin", fetchUrl: "https://github.com/me/fork.git" },
      { name: "upstream", fetchUrl: "https://github.com/acme/canonical.git" },
    ]);
    resolverMock.resolveForgeProvider.mockReturnValueOnce({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");

    await resolveProvider(null, "project-1", "https://github.com/me/fork.git");

    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ remoteUrl: "https://github.com/me/fork.git" })
    );
    expect(gitServiceMock.listRemotes).not.toHaveBeenCalled();
  });

  it("resolveProvider returns no-match for invalid projectId payloads without calling the resolver", async () => {
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    const noMatch = { entry: null, resolvedVia: null };
    await expect(resolveProvider(null, "")).resolves.toEqual(noMatch);
    await expect(resolveProvider(null, 42)).resolves.toEqual(noMatch);
    await expect(resolveProvider(null, undefined)).resolves.toEqual(noMatch);
    expect(resolverMock.resolveForgeProvider).not.toHaveBeenCalled();
  });

  it("resolveProvider returns no-match when the project is not found", async () => {
    projectStoreMock.getProjectById.mockReturnValue(null);
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    await expect(resolveProvider(null, "missing")).resolves.toEqual({
      entry: null,
      resolvedVia: null,
    });
    expect(resolverMock.resolveForgeProvider).not.toHaveBeenCalled();
  });

  it("resolveProvider passes forgeProviderOverride from project settings to the resolver", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      runCommands: [],
      forgeProviderOverride: "acme.gitea",
    });
    resolverMock.resolveForgeProvider.mockReturnValueOnce({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    await resolveProvider(null, "project-1");
    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ forgeProviderOverride: "acme.gitea" })
    );
  });

  it("resolveProvider passes globalDefaultProviderId from the store to the resolver (canonical form)", async () => {
    storeMock._data["forgeDefaultProviderId"] = "daintree.github.github";
    resolverMock.resolveForgeProvider.mockReturnValueOnce({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    await resolveProvider(null, "project-1");
    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ globalDefaultProviderId: "daintree.github.github" })
    );
  });

  it("getSettings normalizes legacy 'builtin.github' to canonical 'daintree.github.github' (#8451)", () => {
    storeMock._data["forgeDefaultProviderId"] = "builtin.github";
    registerForgeSettingsHandlers();
    const getSettings = findHandler("forge:get-settings");
    expect(getSettings(null)).toEqual({ defaultProviderId: "daintree.github.github" });
  });

  it("getSettings normalizes legacy bare 'github' to canonical 'daintree.github.github' (#8451)", () => {
    storeMock._data["forgeDefaultProviderId"] = "github";
    registerForgeSettingsHandlers();
    const getSettings = findHandler("forge:get-settings");
    expect(getSettings(null)).toEqual({ defaultProviderId: "daintree.github.github" });
  });

  it("resolveProvider normalizes legacy stored ids before delegating to the resolver", async () => {
    storeMock._data["forgeDefaultProviderId"] = "builtin.github";
    resolverMock.resolveForgeProvider.mockReturnValueOnce({ entry: null, resolvedVia: null });
    registerForgeSettingsHandlers();
    const resolveProvider = findHandler("forge:resolve-provider");
    await resolveProvider(null, "project-1");
    expect(resolverMock.resolveForgeProvider).toHaveBeenCalledWith(
      expect.objectContaining({ globalDefaultProviderId: "daintree.github.github" })
    );
  });

  // ── Credential channels (#8454) ──

  function registerGiteaProvider() {
    const entries: ForgeProviderEntry[] = [
      {
        pluginId: "acme",
        contribution: {
          id: "gitea",
          name: "Gitea",
          matches: ["gitea.example.com"],
          credentialFields: [
            { id: "token", label: "API token", type: "password" },
            { id: "baseUrl", label: "Base URL", type: "text" },
          ],
        },
      },
    ];
    registryMock.getRegisteredForgeProviders.mockReturnValue(entries);
  }

  it("setCredential validates the primary field, persists the record, and syncs the host", async () => {
    registerGiteaProvider();
    const validateToken = vi.fn().mockResolvedValue({ valid: true, scopes: ["repo"] });
    const setCredentials = vi.fn();
    registryMock.getForgeProviderImpl.mockReturnValue({ validateToken, setCredentials });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    const result = await setCredential(null, "acme.gitea", {
      token: "secret-token",
      baseUrl: "https://gitea.example.com",
    });

    expect(validateToken).toHaveBeenCalledWith("secret-token");
    expect(storeMock.set).toHaveBeenCalledWith("forgeCredentials", {
      "acme.gitea": JSON.stringify({
        token: "secret-token",
        baseUrl: "https://gitea.example.com",
      }),
    });
    // The credential must reach the live impl as a bearer credential (#9983),
    // not just the store — otherwise forge API calls run unauthenticated.
    expect(setCredentials).toHaveBeenCalledWith({ kind: "bearer", value: "secret-token" });
    expect(workspaceClientMock.updateForgeCredentials).toHaveBeenCalledWith("acme.gitea", {
      kind: "bearer",
      value: "secret-token",
    });
    expect(result).toEqual({ valid: true, scopes: ["repo"] });
  });

  it("setCredential delivers the password-typed field even when it is declared second", async () => {
    registryMock.getRegisteredForgeProviders.mockReturnValue([
      {
        pluginId: "acme",
        contribution: {
          id: "gitea",
          name: "Gitea",
          matches: ["gitea.example.com"],
          // Password field second so a `fields[0]`-always bug would validate/deliver the URL.
          credentialFields: [
            { id: "baseUrl", label: "Base URL", type: "text" },
            { id: "token", label: "API token", type: "password" },
          ],
        },
      },
    ]);
    const validateToken = vi.fn().mockResolvedValue({ valid: true });
    const setCredentials = vi.fn();
    registryMock.getForgeProviderImpl.mockReturnValue({ validateToken, setCredentials });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    await setCredential(null, "acme.gitea", {
      baseUrl: "https://gitea.example.com",
      token: "secret-token",
    });

    expect(validateToken).toHaveBeenCalledWith("secret-token");
    expect(setCredentials).toHaveBeenCalledWith({ kind: "bearer", value: "secret-token" });
  });

  it("setCredential succeeds when the impl does not implement the optional setCredentials", async () => {
    registerGiteaProvider();
    const validateToken = vi.fn().mockResolvedValue({ valid: true });
    // No setCredentials on the impl — the optional-call guard must not throw.
    registryMock.getForgeProviderImpl.mockReturnValue({ validateToken });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    const result = await setCredential(null, "acme.gitea", { token: "secret-token" });

    expect(result).toEqual({ valid: true });
    expect(storeMock.set).toHaveBeenCalledWith("forgeCredentials", {
      "acme.gitea": JSON.stringify({ token: "secret-token" }),
    });
  });

  it("setCredential does not call setCredentials when validation fails", async () => {
    registerGiteaProvider();
    const setCredentials = vi.fn();
    registryMock.getForgeProviderImpl.mockReturnValue({
      validateToken: vi.fn().mockResolvedValue({ valid: false, error: "Bad token" }),
      setCredentials,
    });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    await setCredential(null, "acme.gitea", { token: "nope" });

    expect(setCredentials).not.toHaveBeenCalled();
  });

  it("setCredential rate-limits after 5 calls in the window and skips validation (#9956)", async () => {
    registerGiteaProvider();
    const validateToken = vi.fn().mockResolvedValue({ valid: true, scopes: ["repo"] });
    registryMock.getForgeProviderImpl.mockReturnValue({ validateToken });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    for (let i = 0; i < 5; i++) {
      await setCredential(null, "acme.gitea", { token: `secret-${i}` });
    }
    expect(validateToken).toHaveBeenCalledTimes(5);

    await expect(setCredential(null, "acme.gitea", { token: "secret-6" })).rejects.toThrow(
      "Rate limit exceeded"
    );
    expect(validateToken).toHaveBeenCalledTimes(5);
  });

  it("setCredential does not persist or sync when validation fails", async () => {
    registerGiteaProvider();
    const validateToken = vi.fn().mockResolvedValue({ valid: false, error: "Bad token" });
    registryMock.getForgeProviderImpl.mockReturnValue({ validateToken });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    const result = await setCredential(null, "acme.gitea", { token: "nope" });

    expect(result).toEqual({ valid: false, error: "Bad token" });
    expect(storeMock.set).not.toHaveBeenCalledWith("forgeCredentials", expect.anything());
    expect(workspaceClientMock.updateForgeCredentials).not.toHaveBeenCalled();
  });

  it("setCredential returns a not-activated error when no impl is registered", async () => {
    registerGiteaProvider();
    registryMock.getForgeProviderImpl.mockReturnValue(undefined);
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    const result = (await setCredential(null, "acme.gitea", { token: "x" })) as {
      valid: boolean;
      error?: string;
    };

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not activated/i);
    expect(storeMock.set).not.toHaveBeenCalledWith("forgeCredentials", expect.anything());
  });

  it("setCredential rejects invalid payloads without touching the store", async () => {
    registerGiteaProvider();
    registryMock.getForgeProviderImpl.mockReturnValue({
      validateToken: vi.fn().mockResolvedValue({ valid: true }),
    });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    expect(await setCredential(null, "", { token: "x" })).toEqual({
      valid: false,
      error: expect.any(String),
    });
    expect(await setCredential(null, "acme.gitea", 42)).toEqual({
      valid: false,
      error: expect.any(String),
    });
    expect(await setCredential(null, "acme.gitea", { token: "   " })).toEqual({
      valid: false,
      error: expect.any(String),
    });
    expect(storeMock.set).not.toHaveBeenCalledWith("forgeCredentials", expect.anything());
  });

  it("getCredentialStatus reflects whether a non-empty record is stored", () => {
    storeMock._data["forgeCredentials"] = {
      "acme.gitea": JSON.stringify({ token: "stored" }),
      "acme.empty": JSON.stringify({ token: "  " }),
    };
    registerForgeSettingsHandlers();
    const getStatus = findHandler("forge:get-credential-status");

    expect(getStatus(null, "acme.gitea")).toEqual({ hasCredential: true });
    expect(getStatus(null, "acme.empty")).toEqual({ hasCredential: false });
    expect(getStatus(null, "acme.absent")).toEqual({ hasCredential: false });
    expect(getStatus(null, "")).toEqual({ hasCredential: false });
  });

  it("setCredential audits the validateToken call with an empty args summary on success", async () => {
    const appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
    registerGiteaProvider();
    registryMock.getForgeProviderImpl.mockReturnValue({
      validateToken: vi.fn().mockResolvedValue({ valid: true }),
    });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    await setCredential(null, "acme.gitea", { token: "secret-token" });

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "acme.gitea",
        methodName: "validateToken",
        result: "success",
        argsSummary: "",
      })
    );
    // The raw token must never reach the audit record under any field.
    const summary = (appendSpy.mock.calls[0]![0] as { argsSummary?: string }).argsSummary ?? "";
    expect(summary).not.toContain("secret-token");
    appendSpy.mockRestore();
  });

  it("setCredential audits a rejected credential ({ valid: false }) as an error result", async () => {
    const appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
    registerGiteaProvider();
    registryMock.getForgeProviderImpl.mockReturnValue({
      validateToken: vi.fn().mockResolvedValue({ valid: false, error: "Bad token" }),
    });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    await setCredential(null, "acme.gitea", { token: "nope" });

    // A resolved-but-rejected credential must surface as an error so bad-token
    // bursts are visible to the failure-cluster detector, not hidden as success.
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ methodName: "validateToken", result: "error" })
    );
    appendSpy.mockRestore();
  });

  it("setCredential audits a thrown validateToken as an error and rethrows", async () => {
    const appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
    registerGiteaProvider();
    registryMock.getForgeProviderImpl.mockReturnValue({
      validateToken: vi.fn().mockRejectedValue(new Error("network down")),
    });
    registerForgeSettingsHandlers();
    const setCredential = findHandler("forge:set-credential");

    await expect(setCredential(null, "acme.gitea", { token: "x" })).rejects.toThrow("network down");
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ methodName: "validateToken", result: "error" })
    );
    appendSpy.mockRestore();
  });

  it("clearCredential removes only the targeted provider and syncs a null credential", async () => {
    storeMock._data["forgeCredentials"] = {
      "acme.gitea": JSON.stringify({ token: "a" }),
      "corp.gitlab": JSON.stringify({ token: "b" }),
    };
    registerForgeSettingsHandlers();
    const clearCredential = findHandler("forge:clear-credential");

    await clearCredential(null, "acme.gitea");

    expect(storeMock.set).toHaveBeenCalledWith("forgeCredentials", {
      "corp.gitlab": JSON.stringify({ token: "b" }),
    });
    expect(workspaceClientMock.updateForgeCredentials).toHaveBeenCalledWith("acme.gitea", null);
  });

  it("clearCredential clears the live impl's in-memory auth via setCredentials(null)", async () => {
    storeMock._data["forgeCredentials"] = { "acme.gitea": JSON.stringify({ token: "a" }) };
    const setCredentials = vi.fn();
    registryMock.getForgeProviderImpl.mockReturnValue({ setCredentials });
    registerForgeSettingsHandlers();
    const clearCredential = findHandler("forge:clear-credential");

    await clearCredential(null, "acme.gitea");

    expect(setCredentials).toHaveBeenCalledWith(null);
  });

  it("clearCredential is a no-op for the impl when none is bound (no throw)", async () => {
    storeMock._data["forgeCredentials"] = { "acme.gitea": JSON.stringify({ token: "a" }) };
    registryMock.getForgeProviderImpl.mockReturnValue(undefined);
    registerForgeSettingsHandlers();
    const clearCredential = findHandler("forge:clear-credential");

    await expect(clearCredential(null, "acme.gitea")).resolves.toBeUndefined();
    expect(storeMock.set).toHaveBeenCalledWith("forgeCredentials", {});
  });
});
