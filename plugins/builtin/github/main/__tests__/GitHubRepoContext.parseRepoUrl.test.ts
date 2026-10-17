import { describe, it, expect } from "vitest";
import { parseGitHubRepoUrl } from "../GitHubRepoContext.js";

describe("parseGitHubRepoUrl", () => {
  describe("HTTPS URLs", () => {
    it("parses basic HTTPS URL", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses HTTPS URL with .git suffix", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo.git");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses HTTPS URL with trailing slash", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo/");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses HTTPS URL with trailing slash and .git suffix", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo.git/");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });
  });

  describe("SSH URLs", () => {
    it("parses SSH URL with .git suffix", () => {
      const result = parseGitHubRepoUrl("git@github.com:owner/repo.git");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });
  });

  describe("Dotted repo names", () => {
    it("parses HTTPS URL with dotted repo name and .git suffix", () => {
      const result = parseGitHubRepoUrl("https://github.com/org/my.repo.git");
      expect(result).toEqual({ owner: "org", repo: "my.repo" });
    });
  });

  describe("Edge cases", () => {
    it("handles mixed characters", () => {
      const result = parseGitHubRepoUrl("https://github.com/My-Org.2024/my_repo.v2");
      expect(result).toEqual({ owner: "My-Org.2024", repo: "my_repo.v2" });
    });

    it("ignores extra path segments after repo", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo/issues/123");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });
  });

  describe("Invalid inputs", () => {
    it("returns null for non-GitHub URLs", () => {
      expect(parseGitHubRepoUrl("https://gitlab.com/owner/repo")).toBeNull();
    });

    it("returns null for missing repo (HTTPS)", () => {
      expect(parseGitHubRepoUrl("https://github.com/owner")).toBeNull();
    });

    it("returns null for missing owner and repo", () => {
      expect(parseGitHubRepoUrl("https://github.com/")).toBeNull();
    });

    it("returns null for invalid URL", () => {
      expect(parseGitHubRepoUrl("not-a-url")).toBeNull();
    });
  });
});
