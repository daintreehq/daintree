import { beforeEach, describe, expect, it, vi } from "vitest";

let mockToken: string | null = "test-token";

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => mockToken),
  },
  GITHUB_API_TIMEOUT_MS: 5000,
  rateLimitAwareFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
}));

vi.mock("../GitHubRateLimitService.js", () => ({
  GitHubRateLimitError: class GitHubRateLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GitHubRateLimitError";
    }
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  gitHubProfilePictureProvider,
  resolveAuthorAvatar,
  _resetGitHubProfilePictureCachesForTests,
} from "../GitHubProfilePicture.js";
import { GitHubRateLimitError } from "../GitHubRateLimitService.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../../../shared/utils/forgeProviderIds.js";

function okResponse(items: Array<{ avatar_url?: unknown }>) {
  return { ok: true, status: 200, json: async () => ({ items }) };
}

describe("GitHubProfilePicture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToken = "test-token";
    _resetGitHubProfilePictureCachesForTests();
  });

  it("exposes the canonical GitHub provider id", () => {
    expect(gitHubProfilePictureProvider.providerId).toBe(BUILTIN_GITHUB_PROVIDER_ID);
  });

  it("resolves the first user's avatar_url for a public email", async () => {
    mockFetch.mockResolvedValueOnce(okResponse([{ avatar_url: "https://avatars.example/u/1" }]));
    const url = await resolveAuthorAvatar("dev@example.com");
    expect(url).toBe("https://avatars.example/u/1");
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("search/users?q=");
    expect(calledUrl).toContain("dev%40example.com");
    expect(calledUrl).toContain("+in:email");
  });

  it("returns null when no profile matches the email", async () => {
    mockFetch.mockResolvedValueOnce(okResponse([]));
    expect(await resolveAuthorAvatar("nobody@example.com")).toBeNull();
  });

  it("returns null without opening a socket when there is no token", async () => {
    mockToken = null;
    expect(await resolveAuthorAvatar("dev@example.com")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("treats a 422 as a genuine cached miss", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) });
    expect(await resolveAuthorAvatar("dev@example.com")).toBeNull();
    expect(await resolveAuthorAvatar("dev@example.com")).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("treats a 403 as transient and does not cache it", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    expect(await resolveAuthorAvatar("dev@example.com")).toBeNull();
    mockFetch.mockResolvedValueOnce(okResponse([{ avatar_url: "https://avatars.example/late" }]));
    expect(await resolveAuthorAvatar("dev@example.com")).toBe("https://avatars.example/late");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns null (not a throw) on rate-limit errors", async () => {
    mockFetch.mockRejectedValueOnce(new GitHubRateLimitError("secondary limit"));
    await expect(resolveAuthorAvatar("dev@example.com")).resolves.toBeNull();
  });

  it("caches resolved URLs — a second lookup does not hit the network", async () => {
    mockFetch.mockResolvedValueOnce(okResponse([{ avatar_url: "https://avatars.example/u/2" }]));
    expect(await resolveAuthorAvatar("dev@example.com")).toBe("https://avatars.example/u/2");
    expect(await resolveAuthorAvatar("DEV@example.com")).toBe("https://avatars.example/u/2");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("caches null misses so repeated lookups don't re-hit the API", async () => {
    mockFetch.mockResolvedValueOnce(okResponse([]));
    expect(await resolveAuthorAvatar("nobody@example.com")).toBeNull();
    expect(await resolveAuthorAvatar("nobody@example.com")).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("singleflights concurrent lookups for the same email into one request", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise((res) => {
        resolveFetch = res;
      })
    );

    const calls = Array.from({ length: 10 }, () => resolveAuthorAvatar("shared@example.com"));
    resolveFetch(okResponse([{ avatar_url: "https://avatars.example/shared" }]));
    const results = await Promise.all(calls);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(new Set(results)).toEqual(new Set(["https://avatars.example/shared"]));
  });

  it("returns null for an empty email without a request", async () => {
    expect(await resolveAuthorAvatar("   ")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("retries after a failed lookup (inflight entry is cleared)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    expect(await resolveAuthorAvatar("flaky@example.com")).toBeNull();
    mockFetch.mockResolvedValueOnce(
      okResponse([{ avatar_url: "https://avatars.example/recovered" }])
    );
    expect(await resolveAuthorAvatar("flaky@example.com")).toBe(
      "https://avatars.example/recovered"
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
