import { describe, it, expect } from "vitest";
import { ForgeProviderContributionSchema } from "../plugin.js";

const base = {
  id: "gitea",
  name: "Gitea",
  matches: ["gitea.example.com"],
};

describe("ForgeProviderContributionSchema (issue #10471)", () => {
  it("accepts a minimal contribution (id, name, matches)", () => {
    expect(ForgeProviderContributionSchema.safeParse(base).success).toBe(true);
  });

  it("requires at least one match host", () => {
    expect(ForgeProviderContributionSchema.safeParse({ ...base, matches: [] }).success).toBe(false);
  });

  it("accepts arbitrary capability hint strings (informational, unvalidated)", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      capabilities: ["issues", "pulls", "provider-defined-thing"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-string capability hint", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      capabilities: [""],
    });
    expect(result.success).toBe(false);
  });

  it("accepts multiple credentialFields with a password-typed primary", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      credentialFields: [
        { id: "token", label: "API token", type: "password" },
        { id: "baseUrl", label: "Base URL", type: "text" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a credentialField with a reserved id (__proto__)", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      credentialFields: [{ id: "__proto__", label: "Token", type: "password" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a credentialField missing its id", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      credentialFields: [{ label: "API token", type: "password" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an opaque non-empty slot ref", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      slots: { settingsTab: "gitea.settingsTab" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-string slot ref (format-only validation)", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      slots: { settingsTab: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown slot name", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      slots: { notARealSlot: "gitea.view" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level fields (strict)", () => {
    const result = ForgeProviderContributionSchema.safeParse({
      ...base,
      experimental: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts the local/network kind values (#10563)", () => {
    for (const kind of ["local", "network"] as const) {
      expect(ForgeProviderContributionSchema.safeParse({ ...base, kind }).success).toBe(true);
    }
  });

  it("rejects an unknown kind value", () => {
    expect(ForgeProviderContributionSchema.safeParse({ ...base, kind: "offline" }).success).toBe(
      false
    );
  });
});

describe("ForgeProviderContributionSchema roles (#13700)", () => {
  const parse = (extra: Record<string, unknown>) =>
    ForgeProviderContributionSchema.safeParse({ ...base, ...extra });

  it("accepts an issues-only provider with no hostnames", () => {
    expect(parse({ roles: ["issues"], matches: [] }).success).toBe(true);
  });

  it("accepts both roles declared explicitly, in either order", () => {
    expect(parse({ roles: ["issues", "code"] }).success).toBe(true);
    expect(parse({ roles: ["code", "issues"] }).success).toBe(true);
  });

  it("still requires a hostname from a provider that serves code", () => {
    expect(parse({ roles: ["issues", "code"], matches: [] }).success).toBe(false);
  });

  it("rejects hostnames on an issues-only provider, which hostname routing never serves", () => {
    expect(parse({ roles: ["issues"], matches: ["linear.app"] }).success).toBe(false);
  });

  it("rejects a code-only provider", () => {
    expect(parse({ roles: ["code"] }).success).toBe(false);
  });

  it("rejects an empty, repeated or unknown role", () => {
    expect(parse({ roles: [] }).success).toBe(false);
    expect(parse({ roles: ["issues", "issues"], matches: [] }).success).toBe(false);
    expect(parse({ roles: ["wiki"] }).success).toBe(false);
  });
});

describe("ForgeProviderContributionSchema referencePrefixes", () => {
  const parse = (referencePrefixes: unknown) =>
    ForgeProviderContributionSchema.safeParse({ ...base, referencePrefixes });

  it("accepts a prefix per kind, or for one kind only", () => {
    expect(parse({ issue: "#", pr: "!" }).success).toBe(true);
    expect(parse({ pr: "#" }).success).toBe(true);
    expect(parse({}).success).toBe(true);
  });

  it("rejects a prefix that would run into the number or split the reference", () => {
    expect(parse({ issue: "" }).success).toBe(false);
    expect(parse({ issue: "v1" }).success).toBe(false);
    expect(parse({ pr: "PR " }).success).toBe(false);
    expect(parse({ pr: "#####" }).success).toBe(false);
  });

  it("rejects a kind it doesn't know", () => {
    expect(parse({ issue: "#", mergeRequest: "!" }).success).toBe(false);
  });
});
