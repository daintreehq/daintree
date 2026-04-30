import { describe, it, expect } from "vitest";
import { isTokenRelatedError, isTransientNetworkError } from "@/lib/githubErrors";

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
