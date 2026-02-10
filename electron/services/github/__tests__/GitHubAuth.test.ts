import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { GitHubAuth } from "../GitHubAuth.js";

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
});
