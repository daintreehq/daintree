import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginHostApi } from "../../../../../shared/types/plugin.js";

const { gitHubAuthMock, secureStorageMock, tokenHealthMock, updateForgeCredentialsMock } =
  vi.hoisted(() => ({
    gitHubAuthMock: {
      initializeStorage: vi.fn(),
      getToken: vi.fn<() => string | undefined>(),
      getTokenVersion: vi.fn(() => 0),
      validate: vi.fn(),
      setValidatedUserInfo: vi.fn(),
      setMemoryToken: vi.fn(),
    },
    secureStorageMock: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    tokenHealthMock: { start: vi.fn(), stop: vi.fn(), resetState: vi.fn() },
    updateForgeCredentialsMock: vi.fn(),
  }));

vi.mock("../GitHubAuth.js", () => ({ GitHubAuth: gitHubAuthMock }));
vi.mock("../forgeProvider.js", () => ({ githubForgeProvider: {} }));
vi.mock("../reviewDecorationProvider.js", () => ({
  registerReviewDecorationProvider: vi.fn(() => vi.fn()),
  createReviewDecorationProvider: vi.fn(),
}));
vi.mock("../GitHubCaches.js", () => ({
  startCacheSweep: vi.fn(),
  stopCacheSweep: vi.fn(),
  clearGitHubCaches: vi.fn(),
}));
vi.mock("../GitHubTokenHealthService.js", () => ({
  gitHubTokenHealthService: tokenHealthMock,
}));
vi.mock("../../../../../electron/services/SecureStorage.js", () => ({
  secureStorage: secureStorageMock,
}));
vi.mock("../../../../../electron/services/WorkspaceClient.js", () => ({
  getWorkspaceClient: () => ({ updateForgeCredentials: updateForgeCredentialsMock }),
}));

import { activate } from "../index.js";

function makeHost(): PluginHostApi {
  return {
    registerForgeProvider: vi.fn(() => vi.fn()),
  } as unknown as PluginHostApi;
}

describe("github plugin activate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitHubAuthMock.getToken.mockReturnValue(undefined);
    gitHubAuthMock.getTokenVersion.mockReturnValue(0);
  });

  it("initializes token storage before registering the forge provider", async () => {
    const host = makeHost();
    const order: string[] = [];
    gitHubAuthMock.initializeStorage.mockImplementation(() => order.push("storage"));
    vi.mocked(host.registerForgeProvider).mockImplementation(() => {
      order.push("provider");
      return Promise.resolve(vi.fn());
    });

    await activate(host);

    expect(order).toEqual(["storage", "provider"]);
  });

  it("returns synchronously even while a stored-token validate hangs (#10325)", async () => {
    gitHubAuthMock.getToken.mockReturnValue("tok-123");
    // A validate() that never resolves models a slow/offline network — it must
    // be floated, never awaited, so activation cannot stall on it.
    gitHubAuthMock.validate.mockReturnValue(new Promise<never>(() => {}));

    const dispose = await activate(makeHost());

    expect(typeof dispose).toBe("function");
    expect(gitHubAuthMock.validate).toHaveBeenCalledWith("tok-123");
  });

  it("contains a rejected validate() so it can't surface as an unhandled rejection (#10325)", async () => {
    gitHubAuthMock.getToken.mockReturnValue("tok-123");
    gitHubAuthMock.validate.mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      activate(makeHost());
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnSpy).toHaveBeenCalled();
      expect(unhandled).toHaveLength(0);
      expect(gitHubAuthMock.setValidatedUserInfo).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warnSpy.mockRestore();
    }
  });

  it("forwards the captured token version so a stale write can be rejected (#10325)", async () => {
    gitHubAuthMock.getToken.mockReturnValue("tok-123");
    gitHubAuthMock.getTokenVersion.mockReturnValue(7);
    gitHubAuthMock.validate.mockResolvedValue({
      valid: true,
      username: "octocat",
      avatarUrl: undefined,
      scopes: ["repo"],
    });

    await activate(makeHost());
    await new Promise((resolve) => setImmediate(resolve));

    expect(gitHubAuthMock.setValidatedUserInfo).toHaveBeenCalledWith(
      "octocat",
      undefined,
      ["repo"],
      7
    );
  });

  it("pushes stored credentials to workspace hosts on activation", async () => {
    gitHubAuthMock.getToken.mockReturnValue("tok-123");
    gitHubAuthMock.validate.mockResolvedValue({ valid: false });

    await activate(makeHost());
    await new Promise((resolve) => setImmediate(resolve));

    expect(updateForgeCredentialsMock).toHaveBeenCalledWith(expect.any(String), {
      kind: "bearer",
      value: "tok-123",
    });
  });

  it("skips the credential push and validation when no token is stored", async () => {
    await activate(makeHost());
    await new Promise((resolve) => setImmediate(resolve));

    expect(gitHubAuthMock.validate).not.toHaveBeenCalled();
    expect(updateForgeCredentialsMock).not.toHaveBeenCalled();
  });
});
