import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  probeRepoPRListChange,
  probeOpenPRList,
  batchCheckLinkedPRs,
} from "../GitHubPRDiscovery.js";
import { repoPRListETagCache, openPRListETagCache, clearPRCaches } from "../GitHubCaches.js";
import { GitHubAuth, _resetGithubFetchSemaphoreForTests } from "../GitHubAuth.js";
import { gitHubRateLimitService } from "../GitHubRateLimitService.js";
import { getRepoContext } from "../GitHubRepoContext.js";
import type { PRSnapshot } from "../../../../../shared/types/forge.js";

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

  it("returns 'unknown' (idempotent) when a 200 carries the same ETag as the cache", async () => {
    repoPRListETagCache.set("o/r", 'W/"same"');
    setFetch(
      () =>
        new Response("[]", { status: 200, headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"same"' } })
    );

    const result = await probeRepoPRListChange("o", "r", "ghp_token");

    expect(result).toBe("unknown");
    expect(repoPRListETagCache.get("o/r")).toBe('W/"same"');
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

describe("probeOpenPRList", () => {
  beforeEach(() => {
    openPRListETagCache.clear();
    gitHubRateLimitService._resetForTests();
    _resetGithubFetchSemaphoreForTests();
  });

  afterEach(() => {
    gitHubRateLimitService._resetForTests();
  });

  function openPRBody(
    items: Array<{ number: number; sha?: string; updatedAt?: string; title?: string }>
  ): string {
    return JSON.stringify(
      items.map((i) => ({
        number: i.number,
        state: "open",
        title: i.title ?? "PR",
        updated_at: i.updatedAt ?? "2024-01-01T00:00:00Z",
        head: { sha: i.sha ?? "sha1" },
      }))
    );
  }

  const tracked = (number: number, overrides: Partial<PRSnapshot> = {}): PRSnapshot => ({
    number,
    headSha: "sha1",
    updatedAt: "2024-01-01T00:00:00Z",
    state: "open",
    title: "PR",
    ...overrides,
  });

  it("hits the open-PR list with the fixed query and sends If-None-Match when an ETag is cached", async () => {
    openPRListETagCache.set("o/r", 'W/"cached"');
    const mock = setFetch(() => new Response(null, { status: 304, headers: RATE_LIMIT_HEADERS }));

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1)]);

    expect(result).toEqual({ kind: "unchanged" });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/pulls?state=open&per_page=100");
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('W/"cached"');
    // A 304 leaves the existing baseline in place.
    expect(openPRListETagCache.get("o/r")).toBe('W/"cached"');
  });

  it("commits the ETag and reports unchanged when no tracked PR differs", async () => {
    openPRListETagCache.set("o/r", 'W/"old"');
    setFetch(
      () =>
        new Response(openPRBody([{ number: 1, sha: "sha1", updatedAt: "2024-01-01T00:00:00Z" }]), {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"new"' },
        })
    );

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1)]);

    expect(result).toEqual({ kind: "unchanged" });
    // Caller is in sync → baseline advances so the next tick can 304.
    expect(openPRListETagCache.get("o/r")).toBe('W/"new"');
  });

  it("reports the changed PR and does NOT commit the ETag while the change is unconsumed", async () => {
    openPRListETagCache.set("o/r", 'W/"old"');
    setFetch(
      () =>
        new Response(openPRBody([{ number: 1, sha: "sha2", updatedAt: "2024-02-02T00:00:00Z" }]), {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"new"' },
        })
    );

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1)]);

    expect(result).toEqual({
      kind: "changed",
      changed: [
        {
          number: 1,
          headSha: "sha2",
          updatedAt: "2024-02-02T00:00:00Z",
          state: "open",
          title: "PR",
        },
      ],
    });
    // ETag stays on the old baseline so the next tick re-fetches and re-diffs.
    expect(openPRListETagCache.get("o/r")).toBe('W/"old"');
  });

  it("flags an open tracked PR that left the open list as changed with null markers", async () => {
    setFetch(
      () =>
        new Response(openPRBody([{ number: 9 }]), {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"x"' },
        })
    );

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1)]);

    expect(result).toEqual({
      kind: "changed",
      changed: [{ number: 1, headSha: null, updatedAt: null, state: null, title: null }],
    });
  });

  it("does not flag a known-merged tracked PR that is absent from the open list", async () => {
    setFetch(
      () =>
        new Response(openPRBody([{ number: 9 }]), {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"x"' },
        })
    );

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1, { state: "merged" })]);

    expect(result).toEqual({ kind: "unchanged" });
    expect(openPRListETagCache.get("o/r")).toBe('W/"x"');
  });

  it("flags a known-merged tracked PR that reappears in the open list (reopened)", async () => {
    setFetch(
      () =>
        new Response(openPRBody([{ number: 1, sha: "sha3", updatedAt: "2024-03-03T00:00:00Z" }]), {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"x"' },
        })
    );

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1, { state: "closed" })]);

    expect(result).toEqual({
      kind: "changed",
      changed: [
        {
          number: 1,
          headSha: "sha3",
          updatedAt: "2024-03-03T00:00:00Z",
          state: "open",
          title: "PR",
        },
      ],
    });
  });

  it("falls back when the core rate-limit bucket is blocking", async () => {
    gitHubRateLimitService.update(
      {
        get: (name: string) =>
          ({
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
            "x-ratelimit-resource": "core",
          })[name.toLowerCase()] ?? null,
      } as unknown as Headers,
      200
    );
    const mock = setFetch(() => new Response(openPRBody([{ number: 1 }]), { status: 200 }));

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1)]);

    expect(result).toEqual({ kind: "fallback" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("falls back on a non-200/304 status", async () => {
    setFetch(() => new Response("nope", { status: 500, headers: RATE_LIMIT_HEADERS }));

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1)]);

    expect(result).toEqual({ kind: "fallback" });
  });

  it("falls back when the 200 body is not an array", async () => {
    setFetch(
      () =>
        new Response('{"message":"oops"}', {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"x"' },
        })
    );

    const result = await probeOpenPRList("o", "r", "ghp_token", [tracked(1)]);

    expect(result).toEqual({ kind: "fallback" });
  });

  it("falls back (writing nothing) when the ETag cache version changes mid-flight", async () => {
    openPRListETagCache.set("o/r", 'W/"old"');
    let resolveFetch: ((response: Response) => void) | null = null;
    setFetch(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const probe = probeOpenPRList("o", "r", "ghp_token", [tracked(1, { headSha: "sha1" })]);
    await vi.waitFor(() => expect(resolveFetch).not.toBeNull());

    clearPRCaches();

    resolveFetch!(
      new Response(openPRBody([{ number: 1, sha: "sha9" }]), {
        status: 200,
        headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"new"' },
      })
    );

    expect(await probe).toEqual({ kind: "fallback" });
    expect(openPRListETagCache.get("o/r")).toBeUndefined();
  });

  it("falls back when the fetch rejects", async () => {
    setFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    expect(await probeOpenPRList("o", "r", "ghp_token", [tracked(1)])).toEqual({
      kind: "fallback",
    });
  });

  it("reports changed on the cold-start (null-marker) snapshot every detection goes through", async () => {
    setFetch(
      () =>
        new Response(openPRBody([{ number: 1, sha: "sha1", updatedAt: "2024-01-01T00:00:00Z" }]), {
          status: 200,
          headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"x"' },
        })
    );

    // A freshly-detected PR has null head.sha/updated_at markers — they can
    // never match a real REST field, so the first revalidation must re-fetch.
    const result = await probeOpenPRList("o", "r", "ghp_token", [
      tracked(1, { headSha: null, updatedAt: null }),
    ]);

    expect(result.kind).toBe("changed");
    // The ETag is NOT committed while the caller is out of sync.
    expect(openPRListETagCache.get("o/r")).toBeUndefined();
  });

  it("self-heals across cycles: changed (no commit) → synced (commit) → 304", async () => {
    openPRListETagCache.set("o/r", 'W/"E0"');
    // Header-aware mock: a request already holding the post-change ETag gets a
    // 304; otherwise a 200 reporting PR #1 at the new sha + the new ETag.
    setFetch((...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      const inm = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
      if (inm === 'W/"E1"') {
        return new Response(null, { status: 304, headers: RATE_LIMIT_HEADERS });
      }
      return new Response(
        openPRBody([{ number: 1, sha: "sha2", updatedAt: "2024-02-02T00:00:00Z" }]),
        { status: 200, headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"E1"' } }
      );
    });

    // Cycle 1: caller still on the old sha → changed, old ETag preserved.
    const c1 = await probeOpenPRList("o", "r", "ghp_token", [tracked(1, { headSha: "sha1" })]);
    expect(c1.kind).toBe("changed");
    expect(openPRListETagCache.get("o/r")).toBe('W/"E0"');

    // Cycle 2: caller consumed the change (sha2) → clean diff commits the ETag.
    const c2 = await probeOpenPRList("o", "r", "ghp_token", [
      tracked(1, { headSha: "sha2", updatedAt: "2024-02-02T00:00:00Z" }),
    ]);
    expect(c2).toEqual({ kind: "unchanged" });
    expect(openPRListETagCache.get("o/r")).toBe('W/"E1"');

    // Cycle 3: the committed ETag now drives a zero-cost 304.
    const c3 = await probeOpenPRList("o", "r", "ghp_token", [
      tracked(1, { headSha: "sha2", updatedAt: "2024-02-02T00:00:00Z" }),
    ]);
    expect(c3).toEqual({ kind: "unchanged" });
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

  it("falls through to GraphQL on a cold-cache 200 (probe returns 'unknown')", async () => {
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

  it("falls through to GraphQL when a warm-cache 200 reports a changed ETag", async () => {
    repoPRListETagCache.set("o/r", 'W/"old"');
    setFetch(
      () => new Response("[]", { status: 200, headers: { ...RATE_LIMIT_HEADERS, etag: 'W/"new"' } })
    );
    const client = vi.fn().mockResolvedValue({});
    vi.spyOn(GitHubAuth, "createClient").mockReturnValue(client as never);

    const result = await batchCheckLinkedPRs("/tmp/repo", [
      { worktreeId: "w1", issueNumber: 5, branchName: "feature/x" },
    ]);

    expect(client).toHaveBeenCalledTimes(1);
    expect(result.results.size).toBe(1);
  });

  it("returns a rate-limit error and skips GraphQL when the probe's 200 exhausts the core bucket", async () => {
    setFetch(
      () =>
        new Response("[]", {
          status: 200,
          headers: {
            etag: 'W/"e"',
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
            "x-ratelimit-resource": "core",
          },
        })
    );
    const client = vi.fn().mockResolvedValue({});
    vi.spyOn(GitHubAuth, "createClient").mockReturnValue(client as never);

    const result = await batchCheckLinkedPRs("/tmp/repo", [
      { worktreeId: "w1", issueNumber: 5, branchName: "feature/x" },
    ]);

    expect(result.error).toBeDefined();
    expect(result.rateLimit).toBeDefined();
    expect(client).not.toHaveBeenCalled();
  });

  it("skips the repo probe entirely when no token is configured", async () => {
    GitHubAuth.clearToken();
    const mock = setFetch(() => new Response(null, { status: 304, headers: RATE_LIMIT_HEADERS }));
    const client = vi.fn().mockResolvedValue({});
    vi.spyOn(GitHubAuth, "createClient").mockReturnValue(client as never);

    const result = await batchCheckLinkedPRs("/tmp/repo", [
      { worktreeId: "w1", issueNumber: 5, branchName: "feature/x" },
    ]);

    expect(mock).not.toHaveBeenCalled();
    expect(client).toHaveBeenCalledTimes(1);
    expect(result.results.size).toBe(1);
  });
});
