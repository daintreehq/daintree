import { afterEach, describe, it, expect } from "vitest";
import { parseGitHubRepoUrl } from "../GitHubRepoContext.js";
import { _resetEnterpriseHostForTests, setEnterpriseHost } from "../GitHubHost.js";

describe("parseGitHubRepoUrl", () => {
  describe("HTTPS URLs", () => {
    it("parses basic HTTPS URL", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo");
      expect(result).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
    });

    it("parses HTTPS URL with .git suffix", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo.git");
      expect(result).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
    });

    it("parses HTTPS URL with trailing slash", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo/");
      expect(result).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
    });

    it("parses HTTPS URL with trailing slash and .git suffix", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo.git/");
      expect(result).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
    });
  });

  describe("SSH URLs", () => {
    it("parses SSH URL with .git suffix", () => {
      const result = parseGitHubRepoUrl("git@github.com:owner/repo.git");
      expect(result).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
    });
  });

  describe("Dotted repo names", () => {
    it("parses HTTPS URL with dotted repo name and .git suffix", () => {
      const result = parseGitHubRepoUrl("https://github.com/org/my.repo.git");
      expect(result).toEqual({ host: "github.com", owner: "org", repo: "my.repo" });
    });
  });

  describe("Edge cases", () => {
    it("handles mixed characters", () => {
      const result = parseGitHubRepoUrl("https://github.com/My-Org.2024/my_repo.v2");
      expect(result).toEqual({ host: "github.com", owner: "My-Org.2024", repo: "my_repo.v2" });
    });

    it("ignores extra path segments after repo", () => {
      const result = parseGitHubRepoUrl("https://github.com/owner/repo/issues/123");
      expect(result).toEqual({ host: "github.com", owner: "owner", repo: "repo" });
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

  describe("GitHub Enterprise Server host", () => {
    afterEach(() => _resetEnterpriseHostForTests());

    it("rejects an Enterprise Server remote until its host is configured", () => {
      expect(parseGitHubRepoUrl("https://github.example.com/team/app.git")).toBeNull();
    });

    it.each([
      "https://github.example.com/team/app.git",
      "git@github.example.com:team/app.git",
      "ssh://git@github.example.com/team/app.git",
      "https://GitHub.Example.com/team/app",
    ])("parses %s on the configured host", (url) => {
      setEnterpriseHost("github.example.com");
      expect(parseGitHubRepoUrl(url)).toEqual({
        host: "github.example.com",
        owner: "team",
        repo: "app",
      });
    });

    it("still parses github.com, and nothing else, while a host is configured", () => {
      setEnterpriseHost("github.example.com");
      expect(parseGitHubRepoUrl("git@github.com:team/app.git")).toEqual({
        host: "github.com",
        owner: "team",
        repo: "app",
      });
      expect(parseGitHubRepoUrl("https://other.example.com/team/app")).toBeNull();
    });
  });
});
