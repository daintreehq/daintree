import { describe, it, expect } from "vitest";
import { buildGitHubSearchQuery } from "../github.js";

describe("buildGitHubSearchQuery", () => {
  // Issues
  it("returns empty for open issues with no search", () => {
    expect(buildGitHubSearchQuery(undefined, "open", "issue")).toBe("");
    expect(buildGitHubSearchQuery("", "open", "issue")).toBe("");
  });

  it("returns is:open + search text for open issues with search", () => {
    expect(buildGitHubSearchQuery("bug fix", "open", "issue")).toBe("is:open bug fix");
  });

  it("returns is:closed for closed issues with no search", () => {
    expect(buildGitHubSearchQuery(undefined, "closed", "issue")).toBe("is:closed");
  });

  it("returns is:closed + search text for closed issues with search", () => {
    expect(buildGitHubSearchQuery("memory leak", "closed", "issue")).toBe("is:closed memory leak");
  });

  // PRs
  it("returns empty for open PRs with no search", () => {
    expect(buildGitHubSearchQuery(undefined, "open", "pr")).toBe("");
  });

  it("returns is:merged for merged PRs with no search", () => {
    expect(buildGitHubSearchQuery(undefined, "merged", "pr")).toBe("is:merged");
  });

  it("returns is:merged + search text for merged PRs with search", () => {
    expect(buildGitHubSearchQuery("refactor", "merged", "pr")).toBe("is:merged refactor");
  });

  it("returns is:closed for closed PRs", () => {
    expect(buildGitHubSearchQuery(undefined, "closed", "pr")).toBe("is:closed");
  });

  // All filter
  it("returns search text only for all state with search", () => {
    expect(buildGitHubSearchQuery("feature", "all", "issue")).toBe("feature");
  });

  it("returns empty for all state with no search", () => {
    expect(buildGitHubSearchQuery(undefined, "all", "issue")).toBe("");
  });

  // Default state
  it("defaults to open when state is undefined", () => {
    expect(buildGitHubSearchQuery(undefined, undefined, "issue")).toBe("");
    expect(buildGitHubSearchQuery("test", undefined, "issue")).toBe("is:open test");
  });

  // Whitespace trimming
  it("trims whitespace from search text", () => {
    expect(buildGitHubSearchQuery("  hello  ", "closed", "issue")).toBe("is:closed hello");
  });
});
