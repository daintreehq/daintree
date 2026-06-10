import { describe, it, expect } from "vitest";
import {
  extractHostname,
  hostnameMatchesAny,
  matchProviderForRemoteUrl,
  normalizeHostname,
  type ForgeProviderMatcher,
} from "../forgeHostnames.js";

describe("normalizeHostname", () => {
  it.each([
    ["GitHub.com", "github.com"],
    ["www.gitlab.com", "gitlab.com"],
    ["  Bitbucket.org  ", "bitbucket.org"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it("returns null for empty input", () => {
    expect(normalizeHostname("")).toBe(null);
    expect(normalizeHostname("   ")).toBe(null);
  });
});

describe("extractHostname", () => {
  it.each([
    ["https://github.com/owner/repo", "github.com"],
    ["https://github.com/owner/repo.git", "github.com"],
    ["http://gitlab.com/owner/repo", "gitlab.com"],
    ["https://user@bitbucket.org/owner/repo.git", "bitbucket.org"],
    ["https://x-access-token:abc@github.com/owner/repo.git", "github.com"],
    ["git@gitlab.com:owner/repo.git", "gitlab.com"],
    ["ssh://git@codeberg.org/owner/repo.git", "codeberg.org"],
    ["  https://github.com/owner/repo.git  ", "github.com"],
    ["HTTPS://GitLab.com/Owner/Repo.git", "gitlab.com"],
    ["https://ghe.example.com/owner/repo.git", "ghe.example.com"],
    ["https://host.example.com:8443/owner/repo.git", "host.example.com"],
  ])("extracts hostname from %s", (url, expected) => {
    expect(extractHostname(url)).toBe(expected);
  });

  it.each(["", "   ", "owner/repo"])("returns null for malformed input: %j", (url) => {
    expect(extractHostname(url)).toBe(null);
  });
});

describe("hostnameMatchesAny", () => {
  it("matches case-insensitively with www stripped from patterns", () => {
    expect(hostnameMatchesAny("gitlab.com", ["GitLab.com"])).toBe(true);
    expect(hostnameMatchesAny("gitlab.com", ["www.gitlab.com"])).toBe(true);
  });

  it("requires exact hostname matches — no subdomain or substring bleed", () => {
    expect(hostnameMatchesAny("github.example.com", ["github.com"])).toBe(false);
    expect(hostnameMatchesAny("example.com", ["github.com", "gitlab.com"])).toBe(false);
  });
});

describe("matchProviderForRemoteUrl", () => {
  const matchers: ForgeProviderMatcher[] = [
    { providerId: "daintree.github.github", hostnames: ["github.com"] },
    { providerId: "acme.gitlab.gitlab", hostnames: ["gitlab.com", "gitlab.example.com"] },
  ];

  it.each([
    ["https://github.com/owner/repo.git", "daintree.github.github"],
    ["git@github.com:owner/repo.git", "daintree.github.github"],
    ["ssh://git@gitlab.com/owner/repo.git", "acme.gitlab.gitlab"],
    ["https://gitlab.example.com/owner/repo.git", "acme.gitlab.gitlab"],
  ])("resolves %s to %s", (url, expected) => {
    expect(matchProviderForRemoteUrl(url, matchers)).toBe(expected);
  });

  it.each([
    "https://bitbucket.org/owner/repo.git",
    "https://github.example.com/owner/repo.git",
    "https://example.com/github.com/owner/repo",
    "owner/repo",
    "",
  ])("returns null when no provider matches: %j", (url) => {
    expect(matchProviderForRemoteUrl(url, matchers)).toBe(null);
  });

  it("returns the first matching provider in table order", () => {
    const overlapping: ForgeProviderMatcher[] = [
      { providerId: "first", hostnames: ["example.com"] },
      { providerId: "second", hostnames: ["example.com"] },
    ];
    expect(matchProviderForRemoteUrl("https://example.com/o/r.git", overlapping)).toBe("first");
  });

  it("returns null for an empty matcher table", () => {
    expect(matchProviderForRemoteUrl("https://github.com/owner/repo.git", [])).toBe(null);
  });
});
