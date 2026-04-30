import { beforeEach, describe, expect, it } from "vitest";

import { parseGitHubError } from "../GitHubService.js";
import { GitHubAuth, captureAuthMetadata } from "../github/GitHubAuth.js";

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

describe("parseGitHubError — SSO path", () => {
  beforeEach(() => {
    GitHubAuth.initializeStorage(createStorage());
    GitHubAuth.clearToken();
  });

  it("uses captured X-GitHub-SSO URL when available, even when the error message contains '403'", () => {
    // Octokit formats SSO-enforcement errors like:
    //   "Resource protected by organization SAML enforcement. You must
    //    grant your OAuth token access to this organization. (403)"
    // The generic 403 check used to swallow this case before the SSO
    // branch could run. This test guards against that regression.
    captureAuthMetadata(
      new Headers({
        "x-github-sso":
          "required; url=https://github.com/orgs/acme/sso?authorization_request=abc123",
      })
    );

    const result = parseGitHubError(
      new Error(
        "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization. (403)"
      )
    );

    expect(result).toBe(
      "SSO authorization required. Re-authorize at: https://github.com/orgs/acme/sso?authorization_request=abc123"
    );
  });

  it("falls back to the generic SSO message when no URL was captured", () => {
    const result = parseGitHubError(new Error("SAML enforcement (403)"));
    expect(result).toBe("SSO authorization required. Re-authorize at github.com.");
  });

  it("returns the generic permissions message for plain 403s without SAML/SSO markers", () => {
    const result = parseGitHubError(new Error("Forbidden (403)"));
    expect(result).toBe("Token lacks required permissions. Required scopes: repo, read:org");
  });
});
