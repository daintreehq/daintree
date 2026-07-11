import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginHostApi } from "../../../../../shared/types/plugin.js";

const { authMock, readOpsMock, updateForgeCredentialsMock } = vi.hoisted(() => ({
  authMock: {
    getToken: vi.fn<() => string | null>(),
    getTokenVersion: vi.fn(() => 0),
    validateGitLabToken: vi.fn(),
    setValidatedUserInfo: vi.fn(),
    setInstanceUrlReader: vi.fn(),
    setMemoryToken: vi.fn(),
    markTokenHealthy: vi.fn(),
    markTokenUnhealthy: vi.fn(),
    // Present only because index.ts re-exports them from GitLabAuth.js — a
    // mocked module must still provide every re-exported binding.
    getInstanceUrl: vi.fn(),
    getInstanceHost: vi.fn(),
    GITLAB_API_TIMEOUT_MS: 15_000,
    GITLAB_AUTH_TIMEOUT_MS: 10_000,
  },
  readOpsMock: { clearGitLabCaches: vi.fn() },
  updateForgeCredentialsMock: vi.fn(),
}));

vi.mock("../GitLabAuth.js", () => authMock);
vi.mock("../forgeProvider.js", () => ({ gitlabForgeProvider: {} }));
vi.mock("../readOps.js", () => readOpsMock);
vi.mock("../gitlabRemote.js", () => ({
  parseGitLabRemoteUrl: vi.fn(),
  repoFullPath: vi.fn(),
  encodeProjectId: vi.fn(),
}));
vi.mock("../../../../../electron/services/WorkspaceClient.js", () => ({
  getWorkspaceClient: () => ({ updateForgeCredentials: updateForgeCredentialsMock }),
}));

import { activate } from "../index.js";

function makeHost(): PluginHostApi {
  return {
    registerForgeProvider: vi.fn(() => Promise.resolve(vi.fn())),
    settings: { get: vi.fn(() => Promise.resolve(undefined)) },
  } as unknown as PluginHostApi;
}

describe("gitlab plugin activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.getToken.mockReturnValue(null);
    authMock.getTokenVersion.mockReturnValue(0);
  });

  it("wires the instance-URL reader before registering the forge provider", async () => {
    const host = makeHost();
    const order: string[] = [];
    authMock.setInstanceUrlReader.mockImplementation(() => order.push("reader"));
    vi.mocked(host.registerForgeProvider).mockImplementation(() => {
      order.push("provider");
      return Promise.resolve(vi.fn());
    });

    await activate(host);

    expect(order).toEqual(["reader", "provider"]);
    expect(host.registerForgeProvider).toHaveBeenCalledWith({ id: "gitlab" }, expect.any(Object));
  });

  it("returns synchronously even while a stored-token validate hangs", async () => {
    authMock.getToken.mockReturnValue("glpat-123");
    authMock.validateGitLabToken.mockReturnValue(new Promise<never>(() => {}));

    const dispose = await activate(makeHost());

    expect(typeof dispose).toBe("function");
    expect(authMock.validateGitLabToken).toHaveBeenCalledWith("glpat-123");
  });

  it("contains a rejected validate so it can't surface as an unhandled rejection", async () => {
    authMock.getToken.mockReturnValue("glpat-123");
    authMock.validateGitLabToken.mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await activate(makeHost());
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnSpy).toHaveBeenCalled();
      expect(unhandled).toHaveLength(0);
      expect(authMock.setValidatedUserInfo).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warnSpy.mockRestore();
    }
  });

  it("caches user info under the token version captured before validation", async () => {
    authMock.getToken.mockReturnValue("glpat-123");
    authMock.getTokenVersion.mockReturnValue(7);
    authMock.validateGitLabToken.mockResolvedValue({
      valid: true,
      authoritative: true,
      username: "dev",
      scopes: ["api"],
    });

    await activate(makeHost());
    await new Promise((resolve) => setImmediate(resolve));

    expect(authMock.setValidatedUserInfo).toHaveBeenCalledWith(
      { username: "dev", scopes: ["api"] },
      7
    );
  });

  it("pushes stored credentials to workspace hosts on activation", async () => {
    authMock.getToken.mockReturnValue("glpat-123");
    authMock.validateGitLabToken.mockResolvedValue({ valid: false, authoritative: false });

    await activate(makeHost());
    await new Promise((resolve) => setImmediate(resolve));

    expect(updateForgeCredentialsMock).toHaveBeenCalledWith("daintree.gitlab.gitlab", {
      kind: "bearer",
      value: "glpat-123",
    });
  });

  it("skips the credential push and validation when no token is stored", async () => {
    await activate(makeHost());
    await new Promise((resolve) => setImmediate(resolve));

    expect(authMock.validateGitLabToken).not.toHaveBeenCalled();
    expect(updateForgeCredentialsMock).not.toHaveBeenCalled();
  });

  it("disposes the registration and clears caches on deactivate", async () => {
    const disposeForge = vi.fn();
    const host = makeHost();
    vi.mocked(host.registerForgeProvider).mockResolvedValue(disposeForge);
    const order: string[] = [];
    authMock.setMemoryToken.mockImplementation(() => order.push("token"));
    authMock.setInstanceUrlReader.mockImplementation((reader: unknown) => {
      if (reader === null) order.push("reader");
    });

    const dispose = await activate(host);
    dispose();

    expect(disposeForge).toHaveBeenCalled();
    expect(readOpsMock.clearGitLabCaches).toHaveBeenCalled();
    // The token must be cleared BEFORE the settings reader goes away so a
    // late request can't pair the token with the default-instance fallback.
    expect(authMock.setMemoryToken).toHaveBeenCalledWith(null);
    expect(order).toEqual(["token", "reader"]);
  });
});
