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

  it("treats kind as optional (minimal contribution still valid)", () => {
    const result = ForgeProviderContributionSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBeUndefined();
  });
});
