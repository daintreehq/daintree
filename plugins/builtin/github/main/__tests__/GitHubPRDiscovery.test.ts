import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { probeRepoPRListChange, batchCheckLinkedPRs } from "../GitHubPRDiscovery.js";
import { repoPRListETagCache, clearPRCaches } from "../GitHubCaches.js";
import { GitHubAuth, _resetGithubFetchSemaphoreForTests } from "../GitHubAuth.js";
import { gitHubRateLimitService } from "../GitHubRateLimitService.js";
import { getRepoContext } from "../GitHubRepoContext.js";

vi.mock("../GitHubRepoContext.js", async () => {
  const actual =
    await vi.importActual<typeof import("../GitHubRepoContext.js")>("../GitHubRepoContext.js");
  return { ...actual, getRepoContext: vi.fn() };
});

const RATE_LIMIT_HEADERS = {
  "x-ratelimit-remaining": "4999",
  "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
  "x-ratelimit-resource": "core",
};

function setFetch(impl: () => Promise<Response> | Response): Mock {
  const mock = vi.fn(impl);
  (globalThis as unknown as { fetch: Mock }).fetch = mock;
  return mock;
}

function createStorage() {
  let token: string | undefined;
  return {
    get: () => token,
    set: (next: string) => {
      token = next;
    },
    delete: () => {
      token = undefined;
    },
  };
}

describe("probeRepoPRListChange", () => {
  beforeEach(() => {
    repoPRListETagCache.clear();
    gitHubRateLimitService._resetForTests();
    _resetGithubFetchSemaphoreForTests();
  });

  afterEach(() => {
    gitHubRateLimitService._resetForTests();
  });

  it("hits the pulls list endpoint with the fixed query and sends If-None-Match when an ETag is cached", async () => {
    repoPRListETagCache.set("o/r", 'W/"cached"');
    const mock = setFetch(() => new Response(null, { status: 304, headers: RATE_LIMIT_HEADERS }));

    const result = await probeRepoPRListChange("o", "r", "ghp_token");

    expect(result).toBe("unchanged");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/o/r/pulls?per_page=1&state=all&sort=updated&direction=desc"
    );
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('W/"cached"');
  });

  it("returns 'unknown' on a cold cache (200 with no prior ETag) and seeds the cache verbatim", async () => {
    setFetch(
      () =>
        new Response("[]", {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"seed"' },
        })
    );

    const result = await probeRepoPRListChange("o", "r", "ghp_token");

    expect(result).toBe("unknown");
    expect(repoPRListETagCache.get("o/r")).toBe('W/"seed"');
  });

  it("returns 'changed' when a prior ETag exists and a 200 brings a new ETag", async () => {
    repoPRListETagCache.set("o/r", 'W/"old"');
    setFetch(
      () =>
        new Response("[]", {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"new"' },
        })
    );

    const result = await probeRepoPRListChange("o", "r", "ghp_token");

    expect(result).toBe("changed");
    expect(repoPRListETagCache.get("o/r")).toBe('W/"new"');
  });

  it("does not send If-None-Match on a cold cache", async () => {
    const mock = setFetch(
      () => new Response("[]", { status: 200, headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"x"' } })
    );

    await probeRepoPRListChange("o", "r", "ghp_token");

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();
  });

  it("invalidates the cache and returns 'unknown' when a 200 carries no ETag header", async () => {
    repoPRListETagCache.set("o/r", 'W/"old"');
    setFetch(() => new Response("[]", { status: 200, headers: RATE_LIMIT_HEADERS }));

    const result = await probeRepoPRListChange("o", "r", "ghp_token");

    expect(result).toBe("unknown");
    expect(repoPRListETagCache.get("o/r")).toBeUndefined();
  });

  it("returns 'unknown' and writes nothing when the ETag cache version changes mid-flight", async () => {
    repoPRListETagCache.set("o/r", 'W/"old"');
    let resolveFetch: ((response: Response) => void) | null = null;
    setFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const probe = probeRepoPRListChange("o", "r", "ghp_token");
    await vi.waitFor(() => expect(resolveFetch).not.toBeNull());

    // Concurrent invalidation bumps the version between request start and response.
    clearPRCaches();

    resolveFetch!(
      new Response("[]", { status: 200, headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"new"' } })
    );

    expect(await probe).toBe("unknown");
    expect(repoPRListETagCache.get("o/r")).toBeUndefined();
  });

  it("returns 'unknown' when the fetch rejects", async () => {
    setFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    expect(await probeRepoPRListChange("o", "r", "ghp_token")).toBe("unknown");
  });
});

describe("batchCheckLinkedPRs repo-level probe gate", () => {
  beforeEach(() => {
    repoPRListETagCache.clear();
    gitHubRateLimitService._resetForTests();
    _resetGithubFetchSemaphoreForTests();
    GitHubAuth.initializeStorage(createStorage());
    GitHubAuth.setToken("ghp_validtoken012345678901234567890123456789");
    vi.mocked(getRepoContext).mockResolvedValue({ owner: "o", repo: "r" } as Awaited<
      ReturnType<typeof getRepoContext>
    >);
  });

  afterEach(() => {
    gitHubRateLimitService._resetForTests();
    GitHubAuth.clearToken();
    vi.restoreAllMocks();
  });

  it("returns empty results and skips GraphQL when the repo probe reports 304", async () => {
    repoPRListETagCache.set("o/r", 'W/"cached"');
    setFetch(() => new Response(null, { status: 304, headers: RATE_LIMIT_HEADERS }));
    const client = vi.fn().mockResolvedValue({});
    vi.spyOn(GitHubAuth, "createClient").mockReturnValue(client as never);

    const result = await batchCheckLinkedPRs("/tmp/repo", [
      { worktreeId: "w1", issueNumber: 5, branchName: "feature/x" },
    ]);

    expect(result.results.size).toBe(0);
    expect(result.error).toBeUndefined();
    expect(client).not.toHaveBeenCalled();
  });

  it("falls through to GraphQL when the repo probe reports a change (cold cache 200)", async () => {
    setFetch(
      () => new Response("[]", { status: 200, headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"e"' } })
    );
    const client = vi.fn().mockResolvedValue({});
    vi.spyOn(GitHubAuth, "createClient").mockReturnValue(client as never);

    const result = await batchCheckLinkedPRs("/tmp/repo", [
      { worktreeId: "w1", issueNumber: 5, branchName: "feature/x" },
    ]);

    expect(client).toHaveBeenCalledTimes(1);
    expect(result.results.size).toBe(1);
  });
});
