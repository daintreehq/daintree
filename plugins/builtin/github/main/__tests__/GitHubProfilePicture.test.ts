import { beforeEach, describe, expect, it, vi } from "vitest";

let mockToken: string | null = "test-token";
let mockTokenVersion = 0;

vi.mock("../GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => mockToken),
    getTokenVersion: vi.fn(() => mockTokenVersion),
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

function okResponse(items: Array<{ avatar_url?: unknown }>) {
  return { ok: true, status: 200, json: async () => ({ items }) };
}

describe("GitHubProfilePicture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToken = "test-token";
    mockTokenVersion = 0;
    _resetGitHubProfilePictureCachesForTests();
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

  it("treats a 422 as a genuine cached miss", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) });
    expect(await resolveAuthorAvatar("dev@example.com")).toBeNull();
    expect(await resolveAuthorAvatar("dev@example.com")).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

  it("retries once a token becomes available (no-token is not cached)", async () => {
    mockToken = null;
    expect(await resolveAuthorAvatar("dev@example.com")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();

    mockToken = "test-token";
    mockFetch.mockResolvedValueOnce(
      okResponse([{ avatar_url: "https://avatars.example/after-token" }])
    );
    expect(await resolveAuthorAvatar("dev@example.com")).toBe(
      "https://avatars.example/after-token"
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("singleflights a TRANSIENT failure: all callers get null, then a retry succeeds", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise((res) => {
        resolveFetch = res;
      })
    );

    const calls = Array.from({ length: 10 }, () => resolveAuthorAvatar("burst@example.com"));
    resolveFetch({ ok: false, status: 403, json: async () => ({}) });
    const results = await Promise.all(calls);
    expect(results).toEqual(Array(10).fill(null));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // inflight was cleared and 403 wasn't cached — a later lookup retries.
    mockFetch.mockResolvedValueOnce(
      okResponse([{ avatar_url: "https://avatars.example/recovered" }])
    );
    expect(await resolveAuthorAvatar("burst@example.com")).toBe(
      "https://avatars.example/recovered"
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("caches a successful response even when the initiating caller aborts", async () => {
    const controller = new AbortController();
    let resolveFetch: (v: unknown) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise((res) => {
        resolveFetch = res;
      })
    );

    const first = gitHubProfilePictureProvider.resolveByEmail(
      "abort@example.com",
      controller.signal
    );
    const second = resolveAuthorAvatar("abort@example.com");

    controller.abort();
    resolveFetch(okResponse([{ avatar_url: "https://avatars.example/shared-win" }]));

    expect(await first).toBe("https://avatars.example/shared-win");
    expect(await second).toBe("https://avatars.example/shared-win");
    // Cached — a third lookup does not hit the network.
    expect(await resolveAuthorAvatar("abort@example.com")).toBe(
      "https://avatars.example/shared-win"
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["items null", { items: null }],
    ["empty object item", { items: [{}] }],
    ["empty string avatar_url", { items: [{ avatar_url: "" }] }],
    ["non-string avatar_url", { items: [{ avatar_url: 42 }] }],
  ])("treats a malformed body (%s) as a cached genuine miss", async (_label, body) => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
    expect(await resolveAuthorAvatar("malformed@example.com")).toBeNull();
    expect(await resolveAuthorAvatar("malformed@example.com")).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

  it("does not let a lookup started under an earlier token serve callers after a token change", async () => {
    let resolveOld: (v: unknown) => void = () => {};
    let resolveNew: (v: unknown) => void = () => {};
    mockFetch
      .mockReturnValueOnce(new Promise((res) => (resolveOld = res)))
      .mockReturnValueOnce(new Promise((res) => (resolveNew = res)));

    const before = resolveAuthorAvatar("dev@example.com");
    mockTokenVersion = 1;
    const after = resolveAuthorAvatar("dev@example.com");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // The old lookup settling first must neither evict the new flight nor
    // seed the cache the new token reads from.
    resolveOld(okResponse([{ avatar_url: "https://avatars.example/old" }]));
    expect(await before).toBe("https://avatars.example/old");
    const joiner = resolveAuthorAvatar("dev@example.com");
    resolveNew(okResponse([{ avatar_url: "https://avatars.example/new" }]));

    expect(await after).toBe("https://avatars.example/new");
    expect(await joiner).toBe("https://avatars.example/new");
    expect(await resolveAuthorAvatar("dev@example.com")).toBe("https://avatars.example/new");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
