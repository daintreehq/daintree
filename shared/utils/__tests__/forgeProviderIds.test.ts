import { describe, it, expect } from "vitest";
import { normalizeProviderId, BUILTIN_GITHUB_PROVIDER_ID } from "../forgeProviderIds.js";

describe("BUILTIN_GITHUB_PROVIDER_ID", () => {
  it("matches the canonical pluginId.contributionId form from plugin.json", () => {
    expect(BUILTIN_GITHUB_PROVIDER_ID).toBe("daintree.github.github");
  });
});

describe("normalizeProviderId", () => {
  it("maps bare 'github' to canonical", () => {
    expect(normalizeProviderId("github")).toBe(BUILTIN_GITHUB_PROVIDER_ID);
  });

  it("maps legacy 'builtin.github' to canonical", () => {
    expect(normalizeProviderId("builtin.github")).toBe(BUILTIN_GITHUB_PROVIDER_ID);
  });

  it("passes unknown third-party ids through unchanged", () => {
    expect(normalizeProviderId("acme.gitea.gitea")).toBe("acme.gitea.gitea");
    expect(normalizeProviderId("some.other.id")).toBe("some.other.id");
  });

  it("trims surrounding whitespace before classifying", () => {
    expect(normalizeProviderId("  builtin.github  ")).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(normalizeProviderId("\tgithub\n")).toBe(BUILTIN_GITHUB_PROVIDER_ID);
  });

  it("returns null for empty/whitespace/non-string inputs", () => {
    expect(normalizeProviderId("")).toBeNull();
    expect(normalizeProviderId("   ")).toBeNull();
    expect(normalizeProviderId(null)).toBeNull();
    expect(normalizeProviderId(undefined)).toBeNull();
    expect(normalizeProviderId(42)).toBeNull();
    expect(normalizeProviderId({})).toBeNull();
  });
});
