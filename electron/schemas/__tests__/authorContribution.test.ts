import { describe, it, expect } from "vitest";
import { MANIFEST_AUTHORS_CAP, PluginAuthorSchema, getPluginManifestSchema } from "../plugin.js";

function manifestWith(overrides: Record<string, unknown>) {
  return {
    name: "acme.my-plugin",
    version: "1.0.0",
    ...overrides,
  };
}

function authorIssueCode(result: { success: boolean; error?: { issues: unknown[] } }): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues
    .map((i) => (i as { params?: { errorCode?: string } }).params?.errorCode)
    .filter((c): c is string => typeof c === "string");
}

describe("PluginAuthorSchema (issue #10516)", () => {
  it("accepts a minimal author with only a name", () => {
    const result = PluginAuthorSchema.safeParse({ name: "Alice" });
    expect(result.success).toBe(true);
  });

  it("accepts an author with all fields valid", () => {
    const result = PluginAuthorSchema.safeParse({
      name: "Alice Example",
      url: "https://alice.example.com",
      email: "alice@example.com",
      role: "Maintainer",
    });
    expect(result.success).toBe(true);
  });

  it("trims and rejects a blank name", () => {
    expect(PluginAuthorSchema.safeParse({ name: "" }).success).toBe(false);
    expect(PluginAuthorSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("trims surrounding whitespace from name and role in the parsed output", () => {
    const result = PluginAuthorSchema.safeParse({ name: "  Alice  ", role: "  Maintainer  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Alice");
      expect(result.data.role).toBe("Maintainer");
    }
  });

  it("reports the failing path for a nested invalid url", () => {
    const result = getPluginManifestSchema(false).safeParse(
      manifestWith({ authors: [{ name: "Alice", url: "http://alice.dev" }] })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) =>
          (i as { params?: { errorCode?: string } }).params?.errorCode === "scope_url_not_https"
      );
      expect(issue?.path).toEqual(["authors", 0, "url"]);
    }
  });

  it("rejects unknown keys (strict object)", () => {
    const result = PluginAuthorSchema.safeParse({ name: "Alice", twitter: "@alice" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string name", () => {
    expect(PluginAuthorSchema.safeParse({ name: 42 }).success).toBe(false);
  });

  it.each([
    ["http://alice.dev", "scope_url_not_https"],
    ["ftp://alice.dev", "scope_url_not_https"],
    ["https://localhost", "scope_url_private_target"],
    ["https://intranet", "scope_url_hostname_unqualified"],
    ["https://127.0.0.1", "scope_url_private_target"],
    ["https://192.168.1.1", "scope_url_private_target"],
    ["https://user:pass@alice.dev", "scope_url_has_credentials"],
    ["https://*.alice.dev", "scope_wildcard_rejected"],
    ["not-a-url", "scope_url_invalid"],
  ])("rejects url %j with errorCode %s (same discipline as network scopes)", (url, errorCode) => {
    const result = PluginAuthorSchema.safeParse({ name: "Alice", url });
    expect(result.success).toBe(false);
    expect(authorIssueCode(result)).toContain(errorCode);
  });

  it("accepts a multi-label https url for a personal site", () => {
    expect(
      PluginAuthorSchema.safeParse({ name: "Greg", url: "https://siteorigin.com" }).success
    ).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(PluginAuthorSchema.safeParse({ name: "Alice", email: "not-an-email" }).success).toBe(
      false
    );
  });

  it("rejects a blank role", () => {
    expect(PluginAuthorSchema.safeParse({ name: "Alice", role: "  " }).success).toBe(false);
  });
});

describe("manifest authors field (issue #10516)", () => {
  it("accepts a manifest with no authors field (backward-safe optional)", () => {
    expect(getPluginManifestSchema(false).safeParse(manifestWith({})).success).toBe(true);
  });

  it("accepts a manifest with a valid authors array", () => {
    const result = getPluginManifestSchema(false).safeParse(
      manifestWith({
        authors: [
          { name: "Alice", url: "https://alice.example.com", role: "Author" },
          { name: "Bob", email: "bob@example.com" },
        ],
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authors).toHaveLength(2);
      expect(result.data.authors?.[0]?.name).toBe("Alice");
    }
  });

  it("accepts exactly the author cap and rejects one over", () => {
    const make = (count: number) =>
      getPluginManifestSchema(false).safeParse(
        manifestWith({
          authors: Array.from({ length: count }, (_, i) => ({ name: `Author ${i}` })),
        })
      );
    expect(make(MANIFEST_AUTHORS_CAP).success).toBe(true);
    expect(make(MANIFEST_AUTHORS_CAP + 1).success).toBe(false);
  });

  it("rejects a manifest whose author has an invalid url", () => {
    const result = getPluginManifestSchema(false).safeParse(
      manifestWith({ authors: [{ name: "Alice", url: "http://alice.dev" }] })
    );
    expect(result.success).toBe(false);
    expect(authorIssueCode(result)).toContain("scope_url_not_https");
  });

  it("rejects a non-array authors value", () => {
    expect(
      getPluginManifestSchema(false).safeParse(manifestWith({ authors: "Alice" })).success
    ).toBe(false);
  });
});
