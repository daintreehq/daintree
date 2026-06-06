import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubForgeProvider } from "../forgeProvider.js";
import { GitHubAuth } from "../GitHubAuth.js";

const mockGetConfigAsync = vi.fn();

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getConfigAsync: (...args: unknown[]) => mockGetConfigAsync(...args),
  },
}));

beforeEach(() => {
  mockGetConfigAsync.mockReset();
});

describe("githubForgeProvider.identity.getCurrentUser", () => {
  it("returns null when no token is configured", async () => {
    mockGetConfigAsync.mockResolvedValue({ hasToken: false });
    const user = await githubForgeProvider.identity?.getCurrentUser();
    expect(user).toBeNull();
  });

  it("returns null when the token has no cached username yet", async () => {
    mockGetConfigAsync.mockResolvedValue({ hasToken: true });
    const user = await githubForgeProvider.identity?.getCurrentUser();
    expect(user).toBeNull();
  });

  it("projects cached username and avatarUrl into a ForgeUser", async () => {
    mockGetConfigAsync.mockResolvedValue({
      hasToken: true,
      username: "ada",
      avatarUrl: "https://avatars.example/ada.png",
    });
    const user = await githubForgeProvider.identity?.getCurrentUser();
    expect(user).toEqual({
      login: "ada",
      avatarUrl: "https://avatars.example/ada.png",
      rawData: { source: "GitHubAuth.cached" },
    });
  });

  it("omits avatarUrl when the cache has no avatar", async () => {
    mockGetConfigAsync.mockResolvedValue({ hasToken: true, username: "ada" });
    const user = await githubForgeProvider.identity?.getCurrentUser();
    expect(user?.login).toBe("ada");
    expect(user?.avatarUrl).toBeUndefined();
  });

  it("delegates to GitHubAuth.getConfigAsync so the cold-start pendingValidation coalesces", async () => {
    // The capability is a thin pass-through — the existing
    // `GitHubAuth.pendingValidation` singleflight is the only thing that
    // deduplicates concurrent `/user` probes on a cold cache. A second
    // identity source (e.g. a parallel map) would silently split that
    // coalescing and double the round-trip — see lesson #9061.
    mockGetConfigAsync.mockResolvedValue({ hasToken: true, username: "ada" });
    await githubForgeProvider.identity?.getCurrentUser();
    expect(mockGetConfigAsync).toHaveBeenCalledTimes(1);
  });

  it("propagates getConfigAsync rejections so the host can surface them", async () => {
    // The host handler decides whether to wrap the throw in an error toast;
    // the capability is transparent to it. The renderer-side action catches
    // the rejection and routes it to `assignmentError` (mirroring the old
    // `getConfig()` rejection case).
    mockGetConfigAsync.mockRejectedValue(new Error("IPC unavailable"));
    await expect(githubForgeProvider.identity?.getCurrentUser()).rejects.toThrow("IPC unavailable");
  });
});

describe("githubForgeProvider.identity capability presence", () => {
  it("is registered as a sibling field on the ForgeProviderImpl", () => {
    expect(githubForgeProvider.identity).toBeDefined();
    expect(typeof githubForgeProvider.identity?.getCurrentUser).toBe("function");
  });
});

// Smoke: the existing `getToken`/`createClient` mock is unrelated to the
// identity path. Keep one assertion that the module loaded without throwing,
// so a typo in the import path can't silently regress to "identity: undefined".
describe("githubForgeProvider import smoke", () => {
  it("loads the provider module without throwing", () => {
    expect(GitHubAuth.getConfigAsync).toBeDefined();
  });
});
