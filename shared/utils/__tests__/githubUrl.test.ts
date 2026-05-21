import { describe, it, expect } from "vitest";
import { isGitHubRemoteUrl } from "../githubUrl.js";

describe("isGitHubRemoteUrl", () => {
  it.each([
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "http://github.com/owner/repo",
    "https://user@github.com/owner/repo.git",
    "https://x-access-token:abc@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "  https://github.com/owner/repo.git  ",
    "HTTPS://GitHub.com/Owner/Repo.git",
  ])("matches GitHub URL: %s", (url) => {
    expect(isGitHubRemoteUrl(url)).toBe(true);
  });

  it.each([
    "",
    "owner/repo",
    "https://gitlab.com/owner/repo.git",
    "https://bitbucket.org/owner/repo.git",
    "git@gitlab.com:owner/repo.git",
    "https://github.example.com/owner/repo.git",
    "https://ghe.example.com/owner/repo.git",
    "https://example.com/github.com/owner/repo",
    "ssh://git@gitlab.com/owner/repo.git",
  ])("does not match non-GitHub URL: %s", (url) => {
    expect(isGitHubRemoteUrl(url)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isGitHubRemoteUrl(undefined)).toBe(false);
  });
});
