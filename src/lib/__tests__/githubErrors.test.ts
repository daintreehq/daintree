import { describe, it, expect } from "vitest";
import { isRateLimitError, isTokenRelatedError, isTransientNetworkError } from "@/lib/githubErrors";

describe("isTokenRelatedError", () => {
  it("matches the documented token error strings", () => {
    expect(isTokenRelatedError("GitHub token not configured. Set it in Settings.")).toBe(true);
    expect(isTokenRelatedError("Invalid GitHub token. Please update in Settings.")).toBe(true);
    expect(
      isTokenRelatedError("Token lacks required permissions. Required scopes: repo, read:org")
    ).toBe(true);
    expect(isTokenRelatedError("SSO authorization required. Re-authorize at github.com.")).toBe(
      true
    );
  });

  it("returns false for unrelated errors", () => {
    expect(isTokenRelatedError("Cannot reach GitHub. Check your internet connection.")).toBe(false);
    expect(isTokenRelatedError("GitHub rate limit exceeded. Try again in a few minutes.")).toBe(
      false
    );
    expect(isTokenRelatedError("Repository not found or token lacks access.")).toBe(false);
  });

  it("returns false for transient API errors so the dropdown stays out of reconnect-mode", () => {
    expect(isTokenRelatedError("GitHub is temporarily unavailable. Please retry.")).toBe(false);
  });

  it("returns false for partial-results SSO so a per-org failure isn't treated as a globally bad token", () => {
    expect(
      isTokenRelatedError(
        "GitHub returned partial results — some organizations require SSO authorization."
      )
    ).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isTokenRelatedError(null)).toBe(false);
    expect(isTokenRelatedError(undefined)).toBe(false);
    expect(isTokenRelatedError("")).toBe(false);
  });
});

describe("isTransientNetworkError", () => {
  it("matches the canonical network error from parseGitHubError", () => {
    expect(isTransientNetworkError("Cannot reach GitHub. Check your internet connection.")).toBe(
      true
    );
  });

  it("matches any string starting with the canonical prefix", () => {
    expect(isTransientNetworkError("Cannot reach GitHub.")).toBe(true);
    expect(isTransientNetworkError("Cannot reach GitHub. Try again later.")).toBe(true);
  });

  it("matches the transient-API prefix for 5xx and ambiguous-401 outages", () => {
    expect(isTransientNetworkError("GitHub is temporarily unavailable. Please retry.")).toBe(true);
    expect(isTransientNetworkError("GitHub is temporarily unavailable.")).toBe(true);
  });

  it("returns false for token, rate-limit, and 404 errors", () => {
    expect(isTransientNetworkError("SSO authorization required. Re-authorize at github.com.")).toBe(
      false
    );
    expect(isTransientNetworkError("Invalid GitHub token. Please update in Settings.")).toBe(false);
    expect(isTransientNetworkError("GitHub rate limit exceeded. Try again in a few minutes.")).toBe(
      false
    );
    expect(isTransientNetworkError("Repository not found or token lacks access.")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
    expect(isTransientNetworkError("")).toBe(false);
  });

  it("is case-sensitive (matches the canonical capitalization only)", () => {
    expect(isTransientNetworkError("cannot reach GitHub.")).toBe(false);
    expect(isTransientNetworkError("CANNOT REACH GITHUB.")).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it("matches the primary rate-limit error from GitHubRateLimitError", () => {
    expect(isRateLimitError("GitHub rate limit exceeded. Waiting for quota reset.")).toBe(true);
  });

  it("matches the secondary rate-limit error from GitHubRateLimitError", () => {
    expect(isRateLimitError("GitHub secondary rate limit triggered. Pausing requests.")).toBe(true);
  });

  it("matches the duration-bearing variants from GitHubErrors.parseGitHubError", () => {
    expect(isRateLimitError("GitHub rate limit exceeded. Resets in 2m 30s.")).toBe(true);
    expect(isRateLimitError("GitHub secondary rate limit triggered. Resuming in 45s.")).toBe(true);
  });

  it("matches any string starting with either canonical prefix", () => {
    expect(isRateLimitError("GitHub rate limit exceeded.")).toBe(true);
    expect(isRateLimitError("GitHub secondary rate limit triggered.")).toBe(true);
  });

  it("returns false for token, transient, and unrelated errors", () => {
    expect(isRateLimitError("GitHub token not configured. Set it in Settings.")).toBe(false);
    expect(isRateLimitError("Invalid GitHub token. Please update in Settings.")).toBe(false);
    expect(isRateLimitError("Cannot reach GitHub. Check your internet connection.")).toBe(false);
    expect(isRateLimitError("GitHub is temporarily unavailable. Please retry.")).toBe(false);
    expect(isRateLimitError("Repository not found or token lacks access.")).toBe(false);
  });

  it("returns false for the legacy non-prefixed rate-limit message", () => {
    // `parseGitHubError` returns "GitHub rate limit exceeded. Try again in a few minutes."
    // which already matches; this guard is for a hypothetical generic form.
    expect(isRateLimitError("API rate limit exceeded")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError("")).toBe(false);
  });

  it("is case-sensitive (matches the canonical capitalization only)", () => {
    expect(isRateLimitError("github rate limit exceeded.")).toBe(false);
    expect(isRateLimitError("GITHUB RATE LIMIT EXCEEDED.")).toBe(false);
  });
});
