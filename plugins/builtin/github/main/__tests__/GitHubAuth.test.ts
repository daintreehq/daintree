import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  GitHubAuth,
  GITHUB_FETCH_CONCURRENCY,
  _getGithubFetchSemaphoreForTests,
  _resetGithubFetchSemaphoreForTests,
  captureAuthMetadata,
  getLastAuthMetadata,
  parseSsoHeader,
  parseSsoKind,
  rateLimitAwareFetch,
} from "../GitHubAuth.js";
import { gitHubRateLimitService, GitHubRateLimitError } from "../GitHubRateLimitService.js";

function createStorage() {
  let token: string | undefined;
  return {
    get: () => token,
    set: (nextToken: string) => {
      token = nextToken;
    },
    delete: () => {
      token = undefined;
    },
  };
}

describe("GitHubAuth", () => {
  beforeEach(() => {
    GitHubAuth.initializeStorage(createStorage());
    GitHubAuth.clearToken();
    gitHubRateLimitService._resetForTests();
    _resetGithubFetchSemaphoreForTests();
  });

  it("clears cached user info when memory token changes", () => {
    GitHubAuth.setToken("ghp_oldtoken0123456789012345678901234567890");
    GitHubAuth.setValidatedUserInfo("old-user", "https://example.com/avatar.png", ["repo"]);

    GitHubAuth.setMemoryToken("ghp_newtoken0123456789012345678901234567890");

    const config = GitHubAuth.getConfig();
    expect(config.username).toBeUndefined();
    expect(config.avatarUrl).toBeUndefined();
    expect(config.scopes).toBeUndefined();
  });

  it("trims memory tokens before storing", () => {
    GitHubAuth.setMemoryToken("  ghp_trimmedtoken0123456789012345678901234567  ");

    expect(GitHubAuth.getToken()).toBe("ghp_trimmedtoken0123456789012345678901234567");
  });

  it("maps connection failures to a clear network error", async () => {
    (globalThis as unknown as { fetch: Mock }).fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Cannot reach GitHub. Check your internet connection.");
  });

  it("maps timeout errors to a clear network error", async () => {
    const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
    (globalThis as unknown as { fetch: Mock }).fetch = vi.fn().mockRejectedValue(timeoutError);

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Cannot reach GitHub. Check your internet connection.");
  });

  it("returns 'Invalid or expired token' for a 401 with 'Bad credentials' in the body", async () => {
    (globalThis as unknown as { fetch: Mock }).fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"message":"Bad credentials"}', { status: 401 }));

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid or expired token");
  });

  it("returns the transient message for a 401 without 'Bad credentials' so a brief auth-service incident isn't reported as an invalid token", async () => {
    (globalThis as unknown as { fetch: Mock }).fetch = vi
      .fn()
      .mockResolvedValue(new Response("<html>Service Disrupted</html>", { status: 401 }));

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("GitHub is temporarily unavailable. Please retry.");
  });

  it("returns the transient message for a 5xx response", async () => {
    (globalThis as unknown as { fetch: Mock }).fetch = vi
      .fn()
      .mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(result.valid).toBe(false);
    expect(result.error).toBe("GitHub is temporarily unavailable. Please retry.");
  });

  describe("parseSsoHeader", () => {
    it("extracts the url= URL from a required-form header", () => {
      const url = parseSsoHeader(
        "required; url=https://github.com/orgs/acme/sso?authorization_request=abc123"
      );
      expect(url).toBe("https://github.com/orgs/acme/sso?authorization_request=abc123");
    });

    it("returns null for the partial-results form (no url)", () => {
      const url = parseSsoHeader("partial-results; organizations=123456,789012");
      expect(url).toBeNull();
    });

    it("returns null for malformed input", () => {
      expect(parseSsoHeader(null)).toBeNull();
      expect(parseSsoHeader("")).toBeNull();
      expect(parseSsoHeader("gibberish")).toBeNull();
    });

    it("rejects non-https urls to avoid phishing via a spoofed header", () => {
      expect(parseSsoHeader("required; url=http://evil.example/")).toBeNull();
    });

    it("rejects urls outside the github.com domain", () => {
      expect(
        parseSsoHeader("required; url=https://github.com.attacker.example/orgs/acme/sso")
      ).toBeNull();
      expect(parseSsoHeader("required; url=https://evil.example/orgs/acme/sso")).toBeNull();
    });

    it("accepts github.com subdomains", () => {
      expect(
        parseSsoHeader("required; url=https://www.github.com/orgs/acme/sso?authorization_request=x")
      ).toBe("https://www.github.com/orgs/acme/sso?authorization_request=x");
    });
  });

  describe("parseSsoKind", () => {
    it("classifies the required form as 'required'", () => {
      expect(
        parseSsoKind("required; url=https://github.com/orgs/acme/sso?authorization_request=abc123")
      ).toBe("required");
    });

    it("classifies the partial-results form as 'partial'", () => {
      expect(parseSsoKind("partial-results; organizations=123456,789012")).toBe("partial");
    });

    it("is case-insensitive at the prefix", () => {
      expect(parseSsoKind("REQUIRED; url=https://github.com/orgs/acme/sso")).toBe("required");
      expect(parseSsoKind("Partial-Results; organizations=12345")).toBe("partial");
    });

    it("returns null for null/empty/gibberish", () => {
      expect(parseSsoKind(null)).toBeNull();
      expect(parseSsoKind("")).toBeNull();
      expect(parseSsoKind("gibberish")).toBeNull();
    });
  });

  describe("captureAuthMetadata", () => {
    it("captures the SSO URL and exposes it via getLastAuthMetadata", () => {
      GitHubAuth.clearToken();
      captureAuthMetadata(
        new Headers({
          "x-github-sso":
            "required; url=https://github.com/orgs/acme/sso?authorization_request=abc123",
        })
      );
      const metadata = getLastAuthMetadata();
      expect(metadata?.ssoUrl).toBe(
        "https://github.com/orgs/acme/sso?authorization_request=abc123"
      );
    });

    it("captures token expiry from GitHub-Authentication-Token-Expiration", () => {
      GitHubAuth.clearToken();
      captureAuthMetadata(
        new Headers({
          "github-authentication-token-expiration": "2030-01-02T03:04:05Z",
        })
      );
      const metadata = getLastAuthMetadata();
      expect(metadata?.tokenExpiresAt?.toISOString()).toBe("2030-01-02T03:04:05.000Z");
    });

    it("clears metadata when the token changes", () => {
      GitHubAuth.clearToken();
      captureAuthMetadata(
        new Headers({
          "x-github-sso":
            "required; url=https://github.com/orgs/acme/sso?authorization_request=abc123",
        })
      );
      expect(getLastAuthMetadata()?.ssoUrl).toBeDefined();

      GitHubAuth.setToken("ghp_newtoken0123456789012345678901234567890");
      expect(getLastAuthMetadata()).toBeNull();
    });

    it("does nothing when no relevant headers are present", () => {
      GitHubAuth.clearToken();
      captureAuthMetadata(new Headers({ "content-type": "application/json" }));
      expect(getLastAuthMetadata()).toBeNull();
    });
  });

  it("passes AbortSignal.timeout to fetch during validation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ login: "user", avatar_url: "" }),
      headers: new Headers({ "x-oauth-scopes": "repo" }),
    });
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("validate passes x-github-request-id to rate-limit service when present", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ login: "user", avatar_url: "" }),
      headers: new Headers({
        "x-oauth-scopes": "repo",
        "x-github-request-id": "beef-dead-42",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      }),
    });
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    // Reset rate-limit state so validate doesn't hit a pre-existing block.
    const { gitHubRateLimitService } = await import("../GitHubRateLimitService.js");
    gitHubRateLimitService._resetForTests();

    await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    // Should not mark blocked since remaining=4999 > 0.
    expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(false);
  });

  it("validate captures primary rate limit when remaining=0", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ login: "user", avatar_url: "" }),
      headers: new Headers({
        "x-oauth-scopes": "repo",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
      }),
    });
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    const { gitHubRateLimitService } = await import("../GitHubRateLimitService.js");
    gitHubRateLimitService._resetForTests();

    await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(gitHubRateLimitService.shouldBlockRequest().blocked).toBe(true);
    expect(gitHubRateLimitService.shouldBlockRequest().reason).toBe("primary");

    gitHubRateLimitService._resetForTests();
  });

  it("validate sends User-Agent, X-GitHub-Api-Version, and Bearer headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ login: "user", avatar_url: "" }),
      headers: new Headers({ "x-oauth-scopes": "repo" }),
    });
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_validtoken012345678901234567890123456789",
          "User-Agent": "Daintree-Electron",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      })
    );
  });

  it("filters empty strings from x-oauth-scopes", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ login: "user", avatar_url: "" }),
      headers: new Headers({ "x-oauth-scopes": "repo, read:user, " }),
    });
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(result.valid).toBe(true);
    expect(result.scopes).toEqual(["repo", "read:user"]);
  });

  it("returns empty scopes for comma-only header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ login: "user", avatar_url: "" }),
      headers: new Headers({ "x-oauth-scopes": "," }),
    });
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(result.valid).toBe(true);
    expect(result.scopes).toEqual([]);
  });

  it("include response.status on generic error so it is actionable even when statusText is empty", async () => {
    (globalThis as unknown as { fetch: Mock }).fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 422, statusText: "" }));

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("422");
  });

  it("prevents stale auth metadata from repopulating after mid-flight token rotation", async () => {
    GitHubAuth.setToken("ghp_stale00000000000000000000000000000000000");

    let resolveFetch: ((value: Response) => void) | null = null;
    const mockFetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    const validatePromise = GitHubAuth.validate("ghp_stale00000000000000000000000000000000000");

    // Wait until validate has acquired its semaphore slot and dispatched the
    // mock fetch. The semaphore introduces one microtask between `validate()`
    // and the fetch call, so without this we'd rotate the token before the
    // mock's executor had a chance to capture `resolveFetch`.
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

    // Token rotates before the stale response lands.
    GitHubAuth.setToken("ghp_fresh00000000000000000000000000000000000");

    resolveFetch!(
      new Response('{"login":"old-user"}', {
        status: 200,
        headers: {
          "x-oauth-scopes": "repo",
          "x-github-sso":
            "required; url=https://github.com/orgs/stale/sso?authorization_request=abc",
        },
      })
    );
    await validatePromise;

    // Stale SSO URL must not leak into current metadata.
    expect(getLastAuthMetadata()?.ssoUrl).toBeUndefined();
  });

  describe("rateLimitAwareFetch — preflight circuit-breaker", () => {
    afterEach(() => {
      gitHubRateLimitService._resetForTests();
    });

    it("throws GitHubRateLimitError when the service is currently blocked, without making a network request", async () => {
      const mockFetch = vi.fn();
      (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

      // Seed an active secondary block.
      gitHubRateLimitService.update(new Headers({ "retry-after": "30" }), 429);

      await expect(rateLimitAwareFetch("https://api.github.com/user")).rejects.toBeInstanceOf(
        GitHubRateLimitError
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("bypasses the preflight when daintreeSkipRateLimitPreflight is true", async () => {
      gitHubRateLimitService.update(new Headers({ "retry-after": "30" }), 429);

      const mockFetch = vi.fn().mockResolvedValue(
        new Response('{"login":"user"}', {
          status: 200,
          headers: { "x-oauth-scopes": "repo" },
        })
      );
      (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

      const response = await rateLimitAwareFetch("https://api.github.com/user", {
        daintreeSkipRateLimitPreflight: true,
      });
      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalled();
    });

    it("strips daintreeSkipRateLimitPreflight before forwarding init to fetch", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

      await rateLimitAwareFetch("https://api.github.com/user", {
        method: "GET",
        daintreeSkipRateLimitPreflight: true,
      });

      const forwardedInit = mockFetch.mock.calls[0][1] as Record<string, unknown>;
      expect(forwardedInit.daintreeSkipRateLimitPreflight).toBeUndefined();
      expect(forwardedInit.method).toBe("GET");
    });
  });

  describe("rateLimitAwareFetch — concurrency cap", () => {
    afterEach(() => {
      gitHubRateLimitService._resetForTests();
    });

    it("queues calls past the concurrency limit instead of dispatching all at once", async () => {
      const pending: Array<(response: Response) => void> = [];
      const mockFetch = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          })
      );
      (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

      const totalRequests = GITHUB_FETCH_CONCURRENCY + 2;
      const inflight = Array.from({ length: totalRequests }, (_, i) =>
        rateLimitAwareFetch(`https://api.github.com/user?n=${i}`)
      );

      // Wait until the semaphore has granted exactly GITHUB_FETCH_CONCURRENCY
      // slots — the remaining 2 must still be queued, not in flight.
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(GITHUB_FETCH_CONCURRENCY);
      });
      expect(_getGithubFetchSemaphoreForTests().active).toBe(GITHUB_FETCH_CONCURRENCY);
      expect(_getGithubFetchSemaphoreForTests().pending).toBe(
        totalRequests - GITHUB_FETCH_CONCURRENCY
      );

      // Resolve one in-flight request; the next queued call should dispatch.
      pending[0]!(new Response(null, { status: 200 }));
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(GITHUB_FETCH_CONCURRENCY + 1);
      });

      // Drain the rest. Each resolved request may dispatch a new queued
      // call (adding to `pending`), so loop until every in-flight finishes.
      let nextIndex = 1;
      while (nextIndex < totalRequests) {
        if (nextIndex < pending.length) {
          pending[nextIndex]!(new Response(null, { status: 200 }));
          nextIndex++;
        } else {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      await Promise.all(inflight);
      expect(_getGithubFetchSemaphoreForTests().active).toBe(0);
      expect(_getGithubFetchSemaphoreForTests().pending).toBe(0);
    });

    it("releases the semaphore slot when fetch throws", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

      const before = _getGithubFetchSemaphoreForTests().active;
      await expect(rateLimitAwareFetch("https://api.github.com/user")).rejects.toThrow(
        "ECONNREFUSED"
      );
      expect(_getGithubFetchSemaphoreForTests().active).toBe(before);
    });

    it("re-checks the circuit breaker after acquiring a queued slot so a block registered while queued stops the dispatch", async () => {
      // Fill all 8 slots with pending fetches we control, then queue 1 more.
      // While the queued waiter is parked, register a secondary block.
      // When a slot frees, the queued waiter must NOT dispatch — it must
      // throw GitHubRateLimitError instead.
      const pending: Array<{
        resolve: (response: Response) => void;
        reject: (err: unknown) => void;
      }> = [];
      const mockFetch = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve, reject) => {
            pending.push({ resolve, reject });
          })
      );
      (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

      // Fill the semaphore.
      const inflight: Array<Promise<Response>> = [];
      for (let i = 0; i < GITHUB_FETCH_CONCURRENCY; i++) {
        inflight.push(rateLimitAwareFetch(`https://api.github.com/user?n=${i}`));
      }
      // Wait for all 8 slots to be granted.
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(GITHUB_FETCH_CONCURRENCY);
      });

      // Queue a 9th request — it will park in the semaphore queue.
      const queuedPromise = rateLimitAwareFetch("https://api.github.com/user?queued=1");

      // Service registers a block while the 9th request is parked.
      gitHubRateLimitService.update(new Headers({ "retry-after": "30" }), 429);

      // Release a slot. The post-acquire re-check must fire and throw.
      pending[0]!.resolve(new Response(null, { status: 200 }));

      await expect(queuedPromise).rejects.toBeInstanceOf(GitHubRateLimitError);
      // mockFetch should NOT have been called a 9th time — the queued waiter
      // bailed at the re-check rather than dispatching the network request.
      expect(mockFetch).toHaveBeenCalledTimes(GITHUB_FETCH_CONCURRENCY);

      // Drain the remaining in-flight to free the test cleanly.
      for (let i = 1; i < pending.length; i++) {
        pending[i]!.resolve(new Response(null, { status: 200 }));
      }
      await Promise.all(inflight);
    });

    it("synchronously registers a body-classified secondary block before releasing the slot, stopping queued waiters", async () => {
      // First request returns a 403 with a secondary-limit body and no
      // retry-after. The block must be registered BEFORE the slot is
      // released, so the second queued request fails preflight at the
      // post-acquire re-check rather than dispatching to GitHub.
      const body = "You have exceeded a secondary rate limit. Please wait.";

      let resolveA: ((response: Response) => void) | null = null;
      let resolveB: ((response: Response) => void) | null = null;
      const mockFetch = vi.fn().mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveA = resolve;
          })
      );
      mockFetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveB = resolve;
          })
      );
      (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

      // Fill the semaphore so that only one slot is left, then queue both
      // calls. We'll resolve the first one with a 403 secondary-limit body.
      // Using GITHUB_FETCH_CONCURRENCY = 1 here would be cleaner but the
      // semaphore is a singleton — so we fill it to N-1 and let our two
      // calls compete for the last slot + the queue.
      const filler: Array<{
        resolve: (response: Response) => void;
      }> = [];
      const fillerMock = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            filler.push({ resolve });
          })
      );
      (globalThis as unknown as { fetch: Mock }).fetch = fillerMock;
      const fillers: Array<Promise<Response>> = [];
      for (let i = 0; i < GITHUB_FETCH_CONCURRENCY - 1; i++) {
        fillers.push(rateLimitAwareFetch(`https://api.github.com/filler?n=${i}`));
      }
      await vi.waitFor(() => {
        expect(fillerMock).toHaveBeenCalledTimes(GITHUB_FETCH_CONCURRENCY - 1);
      });
      // Swap in the real test mock for the next two calls.
      (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

      const callA = rateLimitAwareFetch("https://api.github.com/A");
      const callB = rateLimitAwareFetch("https://api.github.com/B");

      // Wait until call A has dispatched (slot 8 taken) — call B is queued.
      await vi.waitFor(() => {
        expect(resolveA).not.toBeNull();
      });

      // Resolve A with a 403 secondary-limit body (no retry-after header).
      resolveA!(new Response(body, { status: 403 }));

      // B must fail with GitHubRateLimitError because the body-classified
      // secondary block was registered synchronously before A released.
      await expect(callB).rejects.toBeInstanceOf(GitHubRateLimitError);
      // The B fetch must NOT have been invoked — the post-acquire re-check
      // tripped at the gate.
      expect(resolveB).toBeNull();

      // Cleanup fillers so the test exits cleanly.
      for (const f of filler) f.resolve(new Response(null, { status: 200 }));
      await Promise.all(fillers);
      // Drain whatever's left for the test mock.
      await callA;
    });
  });

  it("validate() distinguishes a secondary-rate-limit 403 from a permissions 403", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("You have exceeded a secondary rate limit. Please wait.", { status: 403 })
      );
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    const result = await GitHubAuth.validate("ghp_validtoken012345678901234567890123456789");
    expect(result.valid).toBe(false);
    // Must NOT report this as a permissions error.
    expect(result.error).not.toBe("Token lacks required permissions");
    expect(result.error).toMatch(/secondary rate limit/i);
  });

  it("validate returns empty scopes for fine-grained PAT with empty x-oauth-scopes header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ login: "user", avatar_url: "" }),
      headers: new Headers({
        "x-oauth-scopes": "",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      }),
    });
    (globalThis as unknown as { fetch: Mock }).fetch = mockFetch;

    const { gitHubRateLimitService } = await import("../GitHubRateLimitService.js");
    gitHubRateLimitService._resetForTests();

    const result = await GitHubAuth.validate("github_pat_finegrainedtoken");

    expect(result.valid).toBe(true);
    expect(result.scopes).toEqual([]);

    gitHubRateLimitService._resetForTests();
  });
});
