import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CredentialImportCapability,
  CredentialImportUnavailable,
  ForgeProviderEntry,
  ForgeTokenHealthState,
} from "../../../../shared/types/forge.js";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null },
}));

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
  listMatchingProviders: vi.fn<(remoteUrl: string) => unknown[]>(() => [{}]),
}));

vi.mock("../../../services/forgeProviderRegistry.js", () => registryMock);

const workspaceClientMock = vi.hoisted(() => ({ updateForgeCredentials: vi.fn() }));

vi.mock("../../../services/WorkspaceClient.js", () => ({
  getWorkspaceClient: () => workspaceClientMock,
}));

vi.mock("../../../services/forgeProviderResolver.js", () => ({
  resolveForgeProvider: vi.fn(() => ({ entry: null, resolvedVia: null })),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: vi.fn(), getProjectSettings: vi.fn() },
}));

vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: { getGitService: vi.fn() },
}));

const pluginServiceMock = vi.hoisted(() => ({
  waitForInit: vi.fn(() => Promise.resolve()),
  activatePluginForForgeProvider: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: pluginServiceMock,
}));

const loggerMock = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../../../utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/logger.js")>()),
  ...loggerMock,
}));

import { registerForgeCredentialImportHandlers } from "../forgeCredentialImport.js";
import { registerForgeSettingsHandlers } from "../forgeSettings.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { forgeAuditService } from "../../../services/forge/forgeAuditService.js";

const PROVIDER_ID = "daintree.github.github";
const SECRET = "gho_SECRETSECRETSECRETSECRET0123456789";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

class FakeSender extends EventEmitter {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function fakeEvent(sender: FakeSender = new FakeSender()): Electron.IpcMainInvokeEvent {
  return { sender: sender as unknown as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

const preview = (...args: unknown[]) =>
  getHandler("forge:preview-credential-import")(fakeEvent(), ...args);
const commit = (...args: unknown[]) =>
  getHandler("forge:commit-credential-import")(fakeEvent(), ...args);

function makeImpl(credentialImport?: Partial<CredentialImportCapability>) {
  const refreshTokenHealth = vi.fn();
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true, scopes: ["repo"], account: "octo" }),
    setCredentials: vi.fn(),
    healthEvents: {
      getTokenHealth: vi.fn<() => ForgeTokenHealthState>(() => ({
        status: "healthy",
        tokenVersion: 1,
        checkedAt: 1,
      })),
      onTokenHealthChanged: vi.fn(() => () => {}),
      refreshTokenHealth,
    },
    ...(credentialImport ? { credentialImport } : {}),
  };
}

function candidate(account = "octo") {
  return {
    credentials: { token: SECRET },
    validation: { valid: true, scopes: ["repo", "read:org"], expiresAt: null, account },
  };
}

/**
 * Flatten a value to text, including what `JSON.stringify` drops: an Error's
 * message, stack and cause are non-enumerable, so a logged `new Error(secret)`
 * would otherwise serialize to `{}` and slip past the leak checks.
 */
function textOf(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "";
  seen.add(value);
  const parts: string[] = [];
  if (value instanceof Error) {
    parts.push(value.name, value.message, value.stack ?? "", textOf(value.cause, seen));
  }
  for (const key of Object.keys(value)) {
    parts.push(key, textOf((value as Record<string, unknown>)[key], seen));
  }
  return parts.join(" ");
}

const consoleSpies = {
  log: vi.spyOn(console, "log").mockImplementation(() => {}),
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {}),
};

/** Everything the handlers wrote anywhere a secret could leak. */
function observableOutput(result: unknown, appendSpy?: ReturnType<typeof vi.spyOn>): string {
  return textOf([
    result,
    loggerMock.logWarn.mock.calls,
    loggerMock.logError.mock.calls,
    loggerMock.logInfo.mock.calls,
    loggerMock.logDebug.mock.calls,
    consoleSpies.log.mock.calls,
    consoleSpies.warn.mock.calls,
    consoleSpies.error.mock.calls,
    appendSpy?.mock.calls ?? [],
  ]);
}

describe("registerForgeCredentialImportHandlers", () => {
  let cleanups: Array<() => void>;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
    for (const key of Object.keys(storeMock._data)) delete storeMock._data[key];
    registryMock.getRegisteredForgeProviders.mockReturnValue([]);
    registryMock.getForgeProviderImpl.mockReturnValue(undefined);
    cleanups = [registerForgeCredentialImportHandlers()];
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    vi.useRealTimers();
  });

  it("detects a secret hidden inside a logged Error", () => {
    // Guards the guard: the leak checks below are only as good as this.
    loggerMock.logWarn("oops", { error: new Error("wrapped", { cause: new Error(SECRET) }) });
    expect(observableOutput(undefined)).toContain(SECRET);
  });

  it("registers the preview and commit channels", () => {
    expect(ipcHandlers.has("forge:preview-credential-import")).toBe(true);
    expect(ipcHandlers.has("forge:commit-credential-import")).toBe(true);
  });

  describe("preview", () => {
    it("returns only the fields it projects, never extra provider properties", async () => {
      const impl = makeImpl({
        preview: vi.fn().mockResolvedValue({
          account: "octo",
          scopes: ["repo", "read:org", "gist"],
          missingScopes: [],
          source: "gh",
          token: SECRET,
        }),
      });
      registryMock.getForgeProviderImpl.mockReturnValue(impl);

      const result = await preview(PROVIDER_ID);

      expect(result).toEqual({
        unavailable: false,
        account: "octo",
        scopes: ["repo", "read:org", "gist"],
        missingScopes: [],
        source: "gh",
      });
      expect(observableOutput(result)).not.toContain(SECRET);
      expect(storeMock.set).not.toHaveBeenCalled();
    });

    it("activates a lazy provider before reading its capability", async () => {
      const impl = makeImpl({
        preview: vi.fn().mockResolvedValue({
          account: "octo",
          scopes: [],
          missingScopes: [],
          source: "gh",
        }),
      });
      registryMock.getForgeProviderImpl.mockReturnValueOnce(undefined).mockReturnValue(impl);

      await expect(preview(PROVIDER_ID)).resolves.toMatchObject({ unavailable: false });
      expect(pluginServiceMock.waitForInit).toHaveBeenCalled();
      expect(pluginServiceMock.activatePluginForForgeProvider).toHaveBeenCalledWith(PROVIDER_ID);
    });

    it("refuses a missing provider id without resolving a provider", async () => {
      await expect(preview("")).resolves.toEqual({ unavailable: true, reason: "invalid-request" });
      expect(pluginServiceMock.waitForInit).not.toHaveBeenCalled();
    });

    it("reports a provider that can't be activated", async () => {
      await expect(preview(PROVIDER_ID)).resolves.toEqual({
        unavailable: true,
        reason: "provider-unavailable",
      });
    });

    it("reports a provider without the capability as unsupported", async () => {
      registryMock.getForgeProviderImpl.mockReturnValue(makeImpl());
      await expect(preview(PROVIDER_ID)).resolves.toEqual({
        unavailable: true,
        reason: "unsupported",
      });
    });

    it("passes the provider's failure code through", async () => {
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({
          preview: vi.fn().mockResolvedValue({ unavailable: true, reason: "not-signed-in" }),
        })
      );
      await expect(preview(PROVIDER_ID)).resolves.toEqual({
        unavailable: true,
        reason: "not-signed-in",
      });
    });

    it("collapses a reason outside the known set, since it could carry anything", async () => {
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({ preview: vi.fn().mockResolvedValue({ unavailable: true, reason: SECRET }) })
      );
      const result = await preview(PROVIDER_ID);
      expect(result).toEqual({ unavailable: true, reason: "cli-failed" });
      expect(observableOutput(result)).not.toContain(SECRET);
    });

    it("contains a throwing provider without logging its message", async () => {
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({ preview: vi.fn().mockRejectedValue(new Error(`gh printed ${SECRET}`)) })
      );
      const result = await preview(PROVIDER_ID);
      expect(result).toEqual({ unavailable: true, reason: "cli-failed" });
      expect(loggerMock.logWarn).toHaveBeenCalledWith(
        "[forgeCredentialImport] preview failed",
        expect.objectContaining({ providerId: PROVIDER_ID, errorKind: "Error" })
      );
      expect(observableOutput(result)).not.toContain(SECRET);
    });

    it("aborts the provider's signal when the requesting window is destroyed", async () => {
      const sender = new FakeSender();
      let seen: AbortSignal | undefined;
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({
          preview: vi.fn(
            (signal?: AbortSignal) =>
              new Promise<CredentialImportUnavailable>((resolve) => {
                seen = signal;
                signal?.addEventListener("abort", () =>
                  resolve({ unavailable: true, reason: "cancelled" })
                );
                sender.destroy();
              })
          ),
        })
      );

      const result = await getHandler("forge:preview-credential-import")(
        fakeEvent(sender),
        PROVIDER_ID
      );

      expect(seen?.aborted).toBe(true);
      expect(result).toEqual({ unavailable: true, reason: "cancelled" });
      expect(sender.listenerCount("destroyed")).toBe(0);
    });

    it("cancels without calling the provider when the window is already gone", async () => {
      const previewFn = vi.fn();
      registryMock.getForgeProviderImpl.mockReturnValue(makeImpl({ preview: previewFn }));
      const sender = new FakeSender();
      sender.destroyed = true;

      const result = await getHandler("forge:preview-credential-import")(
        fakeEvent(sender),
        PROVIDER_ID
      );

      expect(result).toEqual({ unavailable: true, reason: "cancelled" });
      expect(previewFn).not.toHaveBeenCalled();
      expect(sender.listenerCount("destroyed")).toBe(0);
    });

    it("settles at the deadline even when plugin startup never finishes", async () => {
      vi.useFakeTimers();
      pluginServiceMock.waitForInit.mockReturnValueOnce(new Promise(() => {}));
      const sender = new FakeSender();

      const pending = getHandler("forge:preview-credential-import")(fakeEvent(sender), PROVIDER_ID);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toEqual({ unavailable: true, reason: "cancelled" });
      expect(sender.listenerCount("destroyed")).toBe(0);
    });

    it("settles at the deadline when a provider ignores the signal", async () => {
      vi.useFakeTimers();
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({ preview: vi.fn(() => new Promise<never>(() => {})) })
      );

      const pending = preview(PROVIDER_ID);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toEqual({ unavailable: true, reason: "cancelled" });
    });

    it("aborts the provider's signal once the import deadline passes", async () => {
      vi.useFakeTimers();
      let seen: AbortSignal | undefined;
      const onAbort = vi.fn();
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({
          preview: vi.fn((signal?: AbortSignal) => {
            seen = signal;
            signal?.addEventListener("abort", onAbort);
            return new Promise<CredentialImportUnavailable>(() => {});
          }),
        })
      );

      const pending = preview(PROVIDER_ID);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      // The provider is told to stop, so it can kill its CLI process.
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(seen?.aborted).toBe(true);
      await expect(pending).resolves.toEqual({ unavailable: true, reason: "cancelled" });
    });
  });

  describe("commit", () => {
    it("persists through the full credential pipeline and returns no secret", async () => {
      const commitFn = vi.fn().mockResolvedValue(candidate());
      const impl = makeImpl({ commit: commitFn });
      registryMock.getForgeProviderImpl.mockReturnValue(impl);

      const result = await commit(PROVIDER_ID, { account: "octo" });

      expect(result).toEqual({ unavailable: false, account: "octo", scopes: ["repo", "read:org"] });
      expect(commitFn).toHaveBeenCalledWith({ account: "octo" }, expect.any(AbortSignal));
      expect(storeMock.set).toHaveBeenCalledWith("forgeCredentials", {
        [PROVIDER_ID]: JSON.stringify({ token: SECRET }),
      });
      expect(impl.setCredentials).toHaveBeenCalledWith({ kind: "bearer", value: SECRET });
      expect(impl.healthEvents.refreshTokenHealth).toHaveBeenCalledWith({ force: true });
      expect(workspaceClientMock.updateForgeCredentials).toHaveBeenCalledWith(PROVIDER_ID, {
        kind: "bearer",
        value: SECRET,
      });
      // The commit's own validation is the audited one — no second round trip.
      expect(impl.validateToken).not.toHaveBeenCalled();
      expect(observableOutput(result)).not.toContain(SECRET);
    });

    it("runs the same side effects as a pasted credential", async () => {
      cleanups.push(registerForgeSettingsHandlers());
      const pasted = makeImpl();
      registryMock.getForgeProviderImpl.mockReturnValue(pasted);
      await getHandler("forge:set-credential")(fakeEvent(), PROVIDER_ID, { token: SECRET });

      const imported = makeImpl({ commit: vi.fn().mockResolvedValue(candidate()) });
      registryMock.getForgeProviderImpl.mockReturnValue(imported);
      await commit(PROVIDER_ID, { account: "octo" });

      for (const impl of [pasted, imported]) {
        expect(impl.setCredentials).toHaveBeenCalledWith({ kind: "bearer", value: SECRET });
        expect(impl.healthEvents.refreshTokenHealth).toHaveBeenCalledWith({ force: true });
      }
      expect(storeMock.set).toHaveBeenCalledTimes(2);
      expect(storeMock.set.mock.calls[0]).toEqual(storeMock.set.mock.calls[1]);
      expect(workspaceClientMock.updateForgeCredentials).toHaveBeenCalledTimes(2);
    });

    it("audits the commit under its own method name with an empty args summary", async () => {
      const appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({ commit: vi.fn().mockResolvedValue(candidate()) })
      );

      const result = await commit(PROVIDER_ID, { account: "octo" });

      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: PROVIDER_ID,
          methodName: "credentialImport.commit",
          result: "success",
          argsSummary: "",
        })
      );
      expect(observableOutput(result, appendSpy)).not.toContain(SECRET);
      appendSpy.mockRestore();
    });

    it("refuses when the CLI's account changed since the preview, and saves nothing", async () => {
      const appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
      const impl = makeImpl({
        commit: vi.fn().mockResolvedValue({ unavailable: true, reason: "account-changed" }),
      });
      registryMock.getForgeProviderImpl.mockReturnValue(impl);

      const result = await commit(PROVIDER_ID, { account: "octo" });

      expect(result).toEqual({ unavailable: true, reason: "account-changed" });
      expect(storeMock.set).not.toHaveBeenCalled();
      expect(impl.setCredentials).not.toHaveBeenCalled();
      expect(workspaceClientMock.updateForgeCredentials).not.toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ methodName: "credentialImport.commit", result: "error" })
      );
      appendSpy.mockRestore();
    });

    it("saves nothing when the signal aborts after the provider returned the credential", async () => {
      const sender = new FakeSender();
      const impl = makeImpl({
        commit: vi.fn(async () => {
          sender.destroy();
          return candidate();
        }),
      });
      registryMock.getForgeProviderImpl.mockReturnValue(impl);

      const result = await getHandler("forge:commit-credential-import")(
        fakeEvent(sender),
        PROVIDER_ID,
        { account: "octo" }
      );

      expect(result).toEqual({ unavailable: true, reason: "cancelled" });
      expect(storeMock.set).not.toHaveBeenCalled();
      expect(impl.setCredentials).not.toHaveBeenCalled();
    });

    it("saves nothing when a provider that ignores the signal outlives the deadline", async () => {
      vi.useFakeTimers();
      let finish: (value: ReturnType<typeof candidate>) => void = () => {};
      const impl = makeImpl({
        commit: vi.fn(() => new Promise<ReturnType<typeof candidate>>((r) => (finish = r))),
      });
      registryMock.getForgeProviderImpl.mockReturnValue(impl);

      const pending = commit(PROVIDER_ID, { account: "octo" });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toEqual({ unavailable: true, reason: "cancelled" });

      finish(candidate());
      await vi.advanceTimersByTimeAsync(0);
      expect(storeMock.set).not.toHaveBeenCalled();
      expect(impl.setCredentials).not.toHaveBeenCalled();
    });

    it("refuses a request without an expected account before calling the provider", async () => {
      const commitFn = vi.fn();
      registryMock.getForgeProviderImpl.mockReturnValue(makeImpl({ commit: commitFn }));

      for (const expected of [undefined, null, {}, { account: "  " }, { account: 7 }]) {
        await expect(commit(PROVIDER_ID, expected)).resolves.toEqual({
          unavailable: true,
          reason: "invalid-request",
        });
      }
      expect(commitFn).not.toHaveBeenCalled();
    });

    it("reports a provider without the capability as unsupported", async () => {
      registryMock.getForgeProviderImpl.mockReturnValue(makeImpl());
      await expect(commit(PROVIDER_ID, { account: "octo" })).resolves.toEqual({
        unavailable: true,
        reason: "unsupported",
      });
    });

    it("contains a throwing commit before its message reaches the audit log", async () => {
      const appendSpy = vi.spyOn(forgeAuditService, "appendRecord").mockImplementation(() => {});
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({ commit: vi.fn().mockRejectedValue(new Error(`bad token ${SECRET}`)) })
      );

      const result = await commit(PROVIDER_ID, { account: "octo" });

      expect(result).toEqual({ unavailable: true, reason: "cli-failed" });
      expect(storeMock.set).not.toHaveBeenCalled();
      expect(observableOutput(result, appendSpy)).not.toContain(SECRET);
      appendSpy.mockRestore();
    });

    it("contains a save-time throw and logs only its kind", async () => {
      const impl = makeImpl({ commit: vi.fn().mockResolvedValue(candidate()) });
      impl.setCredentials.mockImplementation(() => {
        throw new TypeError(`cannot apply ${SECRET}`);
      });
      registryMock.getForgeProviderImpl.mockReturnValue(impl);

      const result = await commit(PROVIDER_ID, { account: "octo" });

      expect(result).toEqual({ unavailable: true, reason: "save-failed" });
      expect(loggerMock.logWarn).toHaveBeenCalledWith(
        "[forgeCredentialImport] commit failed",
        expect.objectContaining({ providerId: PROVIDER_ID, errorKind: "TypeError" })
      );
      expect(observableOutput(result)).not.toContain(SECRET);
    });

    it("refuses a candidate whose primary credential is empty", async () => {
      registryMock.getForgeProviderImpl.mockReturnValue(
        makeImpl({
          commit: vi.fn().mockResolvedValue({
            credentials: { token: "   " },
            validation: { valid: true, account: "octo" },
          }),
        })
      );
      await expect(commit(PROVIDER_ID, { account: "octo" })).resolves.toEqual({
        unavailable: true,
        reason: "invalid-output",
      });
      expect(storeMock.set).not.toHaveBeenCalled();
    });
  });

  it("re-picks a pasted credential's primary field once activation registers the provider", async () => {
    cleanups.push(registerForgeSettingsHandlers());
    const entries: ForgeProviderEntry[] = [
      {
        pluginId: "acme",
        contribution: {
          id: "gitea",
          name: "Gitea",
          matches: ["gitea.example.com"],
          credentialFields: [
            { id: "baseUrl", label: "Base URL", type: "text" },
            { id: "token", label: "API token", type: "password" },
          ],
        },
      },
    ];
    // Unregistered before startup settles, so the pre-check sees no declared
    // fields and falls back to the first value.
    registryMock.getRegisteredForgeProviders.mockReturnValueOnce([]).mockReturnValue(entries);
    const impl = makeImpl();
    registryMock.getForgeProviderImpl.mockReturnValue(impl);

    const result = await getHandler("forge:set-credential")(fakeEvent(), "acme.gitea", {
      baseUrl: "https://gitea.example.com",
      token: "",
    });

    expect(result).toEqual({ valid: false, error: "Credential is required" });
    expect(impl.validateToken).not.toHaveBeenCalled();
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("shares one rate-limit budget with setCredential across all three channels", async () => {
    cleanups.push(registerForgeSettingsHandlers());
    registryMock.getForgeProviderImpl.mockReturnValue(
      makeImpl({
        preview: vi.fn().mockResolvedValue({ unavailable: true, reason: "not-signed-in" }),
        commit: vi.fn().mockResolvedValue({ unavailable: true, reason: "not-signed-in" }),
      })
    );
    const setCredential = getHandler("forge:set-credential");

    await setCredential(fakeEvent(), PROVIDER_ID, { token: "a" });
    await setCredential(fakeEvent(), PROVIDER_ID, { token: "b" });
    await preview(PROVIDER_ID);
    await preview(PROVIDER_ID);
    await commit(PROVIDER_ID, { account: "octo" });

    await expect(preview(PROVIDER_ID)).rejects.toThrow("Rate limit exceeded");
    await expect(commit(PROVIDER_ID, { account: "octo" })).rejects.toThrow("Rate limit exceeded");
    await expect(setCredential(fakeEvent(), PROVIDER_ID, { token: "c" })).rejects.toThrow(
      "Rate limit exceeded"
    );
  });
});
