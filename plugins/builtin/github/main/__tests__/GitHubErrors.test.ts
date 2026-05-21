import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequestError } from "@octokit/request-error";
import { GraphqlResponseError } from "@octokit/graphql";
import type { RequestOptions, OctokitResponse } from "@octokit/types";

import { parseGitHubError } from "../GitHubErrors.js";
import { GitHubAuth, captureAuthMetadata } from "../GitHubAuth.js";
import { gitHubRateLimitService } from "../GitHubRateLimitService.js";

// Mirror the renderer-side classifiers from `src/lib/githubErrors.ts`. The
// renderer can't be imported here (Electron main/renderer boundary), so the
// rules are duplicated locally and exercised against real `parseGitHubError`
// outputs to confirm the cross-cutting contract: a token-related output
// matches `isTokenRelatedError`, a transient output matches
// `isTransientNetworkError`. Independent tests in
// `src/lib/__tests__/githubErrors.test.ts` cover the renderer-side
// implementation against the same canonical strings.
function isTokenRelatedError(msg: string): boolean {
  return (
    msg.includes("GitHub token not configured") ||
    msg.includes("Invalid GitHub token") ||
    msg.includes("Token lacks required permissions") ||
    msg.includes("SSO authorization required")
  );
}
function isTransientNetworkError(msg: string): boolean {
  return (
    msg.startsWith("Cannot reach GitHub.") || msg.startsWith("GitHub is temporarily unavailable.")
  );
}

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

const REQUEST: RequestOptions = {
  method: "POST",
  url: "https://api.github.com/graphql",
  headers: {},
};

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
  data: unknown = {}
): OctokitResponse<unknown> {
  return {
    url: "https://api.github.com/graphql",
    status,
    headers,
    data,
  };
}

function makeRequestError(
  message: string,
  status: number,
  response: OctokitResponse<unknown> | undefined,
  cause?: Error
): RequestError {
  return new RequestError(message, status, {
    request: REQUEST,
    response,
    cause,
  });
}

function makeGraphqlResponseError(
  headers: Record<string, string>,
  errors: Array<{ message: string }> = [{ message: "boom" }]
): GraphqlResponseError<unknown> {
  return new GraphqlResponseError(
    { method: "POST", url: "https://api.github.com/graphql", query: "" },
    headers,
    { data: null, errors: errors as never }
  );
}

describe("parseGitHubError", () => {
  beforeEach(() => {
    GitHubAuth.initializeStorage(createStorage());
    GitHubAuth.clearToken();
    gitHubRateLimitService.clear();
  });

  afterEach(() => {
    gitHubRateLimitService.clear();
  });

  describe("RequestError", () => {
    it("classifies a 401 with 'Bad credentials' as an invalid token", () => {
      const error = makeRequestError("Bad credentials", 401, makeResponse(401));
      const message = parseGitHubError(error);
      expect(message).toBe("Invalid GitHub token. Please update in Settings.");
      expect(isTokenRelatedError(message)).toBe(true);
      expect(isTransientNetworkError(message)).toBe(false);
    });

    it("classifies a 401 without 'Bad credentials' as transient", () => {
      const error = makeRequestError("Unauthorized", 401, makeResponse(401));
      const message = parseGitHubError(error);
      expect(message).toBe("GitHub is temporarily unavailable. Please retry.");
      expect(isTokenRelatedError(message)).toBe(false);
      expect(isTransientNetworkError(message)).toBe(true);
    });

    it("classifies a 403 with x-github-sso 'required' as SSO authorization required", () => {
      const error = makeRequestError(
        "Resource protected by org SAML enforcement",
        403,
        makeResponse(403, {
          "x-github-sso":
            "required; url=https://github.com/orgs/acme/sso?authorization_request=abc",
        })
      );
      const message = parseGitHubError(error);
      expect(message).toContain("SSO authorization required.");
      expect(isTokenRelatedError(message)).toBe(true);
    });

    it("includes the captured SSO URL when one is in the auth metadata cache", () => {
      captureAuthMetadata(
        new Headers({
          "x-github-sso":
            "required; url=https://github.com/orgs/acme/sso?authorization_request=xyz",
        })
      );
      const error = makeRequestError(
        "SAML enforcement",
        403,
        makeResponse(403, { "x-github-sso": "required; url=https://github.com/orgs/acme/sso" })
      );
      const message = parseGitHubError(error);
      expect(message).toBe(
        "SSO authorization required. Re-authorize at: https://github.com/orgs/acme/sso?authorization_request=xyz"
      );
    });

    it("classifies a 403 with x-github-sso 'partial-results' as a non-token partial-results message", () => {
      const error = makeRequestError(
        "partial",
        403,
        makeResponse(403, { "x-github-sso": "partial-results; organizations=12345" })
      );
      const message = parseGitHubError(error);
      expect(message).toBe(
        "GitHub returned partial results — some organizations require SSO authorization."
      );
      expect(isTokenRelatedError(message)).toBe(false);
      expect(isTransientNetworkError(message)).toBe(false);
    });

    it("classifies a plain 403 as a scope-missing error", () => {
      const error = makeRequestError("Forbidden", 403, makeResponse(403));
      const message = parseGitHubError(error);
      expect(message).toBe("Token lacks required permissions. Required scopes: repo, read:org");
      expect(isTokenRelatedError(message)).toBe(true);
    });

    it("classifies a 404 as repository-not-found", () => {
      const error = makeRequestError("Not Found", 404, makeResponse(404));
      expect(parseGitHubError(error)).toBe("Repository not found or token lacks access.");
    });

    it("classifies a 500 with a response present as transient (server-side)", () => {
      const error = makeRequestError("Internal Server Error", 500, makeResponse(500));
      const message = parseGitHubError(error);
      expect(message).toBe("GitHub is temporarily unavailable. Please retry.");
      expect(isTransientNetworkError(message)).toBe(true);
      expect(isTokenRelatedError(message)).toBe(false);
    });

    it("classifies a 502 Bad Gateway as transient", () => {
      const error = makeRequestError("Bad Gateway", 502, makeResponse(502));
      const message = parseGitHubError(error);
      expect(message).toBe("GitHub is temporarily unavailable. Please retry.");
      expect(isTransientNetworkError(message)).toBe(true);
    });

    it("classifies a 503 Service Unavailable as transient", () => {
      const error = makeRequestError("Service Unavailable", 503, makeResponse(503));
      expect(parseGitHubError(error)).toBe("GitHub is temporarily unavailable. Please retry.");
    });

    it("classifies a network failure (no response) as a network error", () => {
      const cause = new Error("getaddrinfo ENOTFOUND api.github.com");
      const error = makeRequestError(cause.message, 500, undefined, cause);
      const message = parseGitHubError(error);
      expect(message).toBe("Cannot reach GitHub. Check your internet connection.");
      expect(isTransientNetworkError(message)).toBe(true);
    });

    it("classifies a RequestError with no response (status=500 fallback) as a network error", () => {
      // RequestError with `response: undefined` is the shape Octokit produces
      // for any pre-HTTP-response failure (DNS, abort, unreachable host).
      // Hitting the !error.response short-circuit, not the cause-chain.
      const abort = new Error("The operation was aborted");
      abort.name = "AbortError";
      const error = makeRequestError("AbortError", 500, undefined, abort);
      expect(parseGitHubError(error)).toBe("Cannot reach GitHub. Check your internet connection.");
    });
  });

  describe("non-Octokit error with AbortError cause chain", () => {
    it("classifies a plain Error wrapping an AbortError as a network error", () => {
      // This is the path `isAbortLike` actually exists for: a raw `fetch`
      // failure thrown outside Octokit (e.g. from a code path that bypasses
      // the GraphQL client). RequestError variants short-circuit before
      // reaching the cause-chain inspector.
      const abort = new Error("The operation was aborted");
      abort.name = "AbortError";
      const wrapper = new Error("fetch failed");
      (wrapper as { cause?: unknown }).cause = abort;
      expect(parseGitHubError(wrapper)).toBe(
        "Cannot reach GitHub. Check your internet connection."
      );
    });
  });

  describe("GraphqlResponseError", () => {
    it("classifies x-github-sso 'required' as SSO authorization required", () => {
      const error = makeGraphqlResponseError({
        "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=abc",
      });
      const message = parseGitHubError(error);
      expect(message).toContain("SSO authorization required.");
      expect(isTokenRelatedError(message)).toBe(true);
    });

    it("classifies x-github-sso 'partial-results' as a non-token partial-results message", () => {
      const error = makeGraphqlResponseError({
        "x-github-sso": "partial-results; organizations=12345",
      });
      const message = parseGitHubError(error);
      expect(message).toBe(
        "GitHub returned partial results — some organizations require SSO authorization."
      );
      expect(isTokenRelatedError(message)).toBe(false);
    });

    it("falls back to the first GraphQL error message when no SSO header is present", () => {
      const error = makeGraphqlResponseError({}, [{ message: "Field 'unknown' doesn't exist" }]);
      expect(parseGitHubError(error)).toBe("GitHub API error: Field 'unknown' doesn't exist");
    });
  });

  describe("non-Octokit errors", () => {
    it("passes through pre-classified strings verbatim (idempotent)", () => {
      const original = new Error("Invalid GitHub token. Please update in Settings.");
      expect(parseGitHubError(original)).toBe("Invalid GitHub token. Please update in Settings.");

      const transient = new Error("GitHub is temporarily unavailable. Please retry.");
      expect(parseGitHubError(transient)).toBe("GitHub is temporarily unavailable. Please retry.");

      const partial = new Error(
        "GitHub returned partial results — some organizations require SSO authorization."
      );
      expect(parseGitHubError(partial)).toBe(
        "GitHub returned partial results — some organizations require SSO authorization."
      );
    });

    it("classifies a TimeoutError as a network error", () => {
      const timeout = new DOMException("Timed out", "TimeoutError");
      expect(parseGitHubError(timeout)).toBe(
        "Cannot reach GitHub. Check your internet connection."
      );
    });

    it("classifies an ECONNRESET as a network error", () => {
      const error = new Error("read ECONNRESET");
      expect(parseGitHubError(error)).toBe("Cannot reach GitHub. Check your internet connection.");
    });

    it("falls through to the generic API error bucket for unknown errors", () => {
      const error = new Error("Something else broke");
      expect(parseGitHubError(error)).toBe("GitHub API error: Something else broke");
    });
  });

  describe("rate-limit pre-emption", () => {
    it("returns the primary-rate-limit message when the rate-limit service is blocking on a quota reset", () => {
      // Simulate a rate-limit response that the fetch wrapper has already
      // recorded (Phase 1 / Phase 2 in `rateLimitAwareFetch`).
      const resetAt = Math.floor((Date.now() + 60_000) / 1000).toString();
      gitHubRateLimitService.update(
        new Headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": resetAt,
        }),
        403
      );
      const error = makeRequestError("rate limit exceeded", 403, makeResponse(403));
      const message = parseGitHubError(error);
      // The canonical primary-bucket message — confirms we hit the
      // rate-limit branch, not the 403 SSO/scope branch.
      expect(message).toMatch(/^GitHub rate limit exceeded\. Resets in /);
    });

    it("returns the secondary-rate-limit message when retry-after fires the secondary-bucket path", () => {
      // `retry-after` is the header GitHub sends for secondary limits.
      gitHubRateLimitService.update(new Headers({ "retry-after": "60" }), 403);
      const error = makeRequestError("Forbidden", 403, makeResponse(403));
      expect(parseGitHubError(error)).toMatch(
        /^GitHub secondary rate limit triggered\. Resuming in /
      );
    });
  });
});
