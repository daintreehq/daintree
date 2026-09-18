import { describe, expect, it } from "vitest";
import { findMissingGitHubScopes } from "../credentialScopes.js";

describe("findMissingGitHubScopes", () => {
  it("reports nothing missing when both are held", () => {
    expect(findMissingGitHubScopes(["repo", "read:org"])).toEqual([]);
  });

  it("ignores extra scopes", () => {
    expect(findMissingGitHubScopes(["gist", "repo", "workflow", "read:org"])).toEqual([]);
  });

  it.each(["write:org", "admin:org"])("treats %s as satisfying read:org", (orgScope) => {
    expect(findMissingGitHubScopes(["repo", orgScope])).toEqual([]);
  });

  it("reports each missing scope in declaration order", () => {
    expect(findMissingGitHubScopes(["gist"])).toEqual(["repo", "read:org"]);
    expect(findMissingGitHubScopes(["read:org"])).toEqual(["repo"]);
    expect(findMissingGitHubScopes(["repo"])).toEqual(["read:org"]);
  });

  it("doesn't treat public_repo as repo", () => {
    expect(findMissingGitHubScopes(["public_repo", "read:org"])).toEqual(["repo"]);
  });

  it("treats an empty list as unknown rather than missing everything", () => {
    // Fine-grained PATs and GitHub App tokens send no x-oauth-scopes header.
    expect(findMissingGitHubScopes([])).toEqual([]);
    expect(findMissingGitHubScopes(["", "  "])).toEqual([]);
  });

  it("tolerates whitespace and duplicates", () => {
    expect(findMissingGitHubScopes([" repo ", "repo", " write:org"])).toEqual([]);
  });
});
