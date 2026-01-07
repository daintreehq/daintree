import { describe, it, expect } from "vitest";
import { parseGitHubRepoUrl } from "../GitHubService.js";

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
    it("parses basic SSH URL", () => {
      const result = parseGitHubRepoUrl("git@github.com:owner/repo");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses SSH URL with .git suffix", () => {
      const result = parseGitHubRepoUrl("git@github.com:owner/repo.git");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses SSH URL with dotted repo name", () => {
      const result = parseGitHubRepoUrl("git@github.com:org/my.repo");
      expect(result).toEqual({ owner: "org", repo: "my.repo" });
    });

    it("parses SSH URL with dotted repo name and .git suffix", () => {
      const result = parseGitHubRepoUrl("git@github.com:org/my.repo.git");
      expect(result).toEqual({ owner: "org", repo: "my.repo" });
    });
  });

  describe("Dotted repo names", () => {
    it("parses HTTPS URL with dotted repo name", () => {
      const result = parseGitHubRepoUrl("https://github.com/org/my.repo");
      expect(result).toEqual({ owner: "org", repo: "my.repo" });
    });

    it("parses HTTPS URL with dotted repo name and .git suffix", () => {
      const result = parseGitHubRepoUrl("https://github.com/org/my.repo.git");
      expect(result).toEqual({ owner: "org", repo: "my.repo" });
    });

    it("parses HTTPS URL with dotted repo name and trailing slash", () => {
      const result = parseGitHubRepoUrl("https://github.com/org/my.repo/");
      expect(result).toEqual({ owner: "org", repo: "my.repo" });
    });

    it("parses HTTPS URL with dotted repo name, .git suffix, and trailing slash", () => {
      const result = parseGitHubRepoUrl("https://github.com/org/my.repo.git/");
      expect(result).toEqual({ owner: "org", repo: "my.repo" });
    });

    it("parses repo with multiple dots", () => {
      const result = parseGitHubRepoUrl("https://github.com/org/my.fancy.repo.name");
      expect(result).toEqual({ owner: "org", repo: "my.fancy.repo.name" });
    });
  });

  describe("Edge cases", () => {
    it("handles dashes in owner and repo", () => {
      const result = parseGitHubRepoUrl("https://github.com/my-org/my-repo");
      expect(result).toEqual({ owner: "my-org", repo: "my-repo" });
    });

    it("handles underscores in owner and repo", () => {
      const result = parseGitHubRepoUrl("https://github.com/my_org/my_repo");
      expect(result).toEqual({ owner: "my_org", repo: "my_repo" });
    });

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

    it("returns null for missing repo (SSH)", () => {
      expect(parseGitHubRepoUrl("git@github.com:owner")).toBeNull();
    });

    it("returns null for missing owner and repo", () => {
      expect(parseGitHubRepoUrl("https://github.com/")).toBeNull();
    });

    it("returns null for empty path", () => {
      expect(parseGitHubRepoUrl("https://github.com")).toBeNull();
    });

    it("returns null for invalid URL", () => {
      expect(parseGitHubRepoUrl("not-a-url")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseGitHubRepoUrl("")).toBeNull();
    });
  });
});
