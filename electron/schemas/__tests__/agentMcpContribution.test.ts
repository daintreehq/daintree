import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";

const ENDPOINT = { id: "data", name: "Household ledger", mode: "tools" };

function manifestWith(overrides: Record<string, unknown>) {
  return { name: "acme.ledger", version: "1.0.0", ...overrides };
}

function errorCodes(result: { success: boolean; error?: { issues: unknown[] } }): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? "zod"
  );
}

describe("contributes.agentMcp", () => {
  it("accepts an endpoint when mcp:expose is declared", () => {
    const result = getPluginManifestSchema("user").safeParse(
      manifestWith({ capabilities: ["mcp:expose"], contributes: { agentMcp: [ENDPOINT] } })
    );
    expect(result.success).toBe(true);
  });

  it("requires the mcp:expose capability", () => {
    const result = getPluginManifestSchema("user").safeParse(
      manifestWith({ contributes: { agentMcp: [ENDPOINT] } })
    );
    expect(errorCodes(result)).toContain("mcp_expose_capability_required");
  });

  it("is allowed for a project-scoped plugin, unlike mcpServers", () => {
    const result = getPluginManifestSchema("project").safeParse(
      manifestWith({
        scope: "project",
        capabilities: ["mcp:expose"],
        contributes: { agentMcp: [ENDPOINT] },
      })
    );
    expect(result.success).toBe(true);
  });

  it("rejects a second endpoint and transport-shaped fields", () => {
    const schema = getPluginManifestSchema("user");
    expect(
      schema.safeParse(
        manifestWith({
          capabilities: ["mcp:expose"],
          contributes: { agentMcp: [ENDPOINT, { ...ENDPOINT, id: "reports" }] },
        })
      ).success
    ).toBe(false);
    expect(
      schema.safeParse(
        manifestWith({
          capabilities: ["mcp:expose"],
          contributes: { agentMcp: [{ ...ENDPOINT, url: "http://127.0.0.1:1/mcp" }] },
        })
      ).success
    ).toBe(false);
    expect(
      schema.safeParse(
        manifestWith({
          capabilities: ["mcp:expose"],
          contributes: { agentMcp: [{ ...ENDPOINT, mode: "proxy" }] },
        })
      ).success
    ).toBe(false);
  });

  it.each([".", ".."])("rejects the dot-segment id %s, which would vanish from its URL", (id) => {
    const result = getPluginManifestSchema("user").safeParse(
      manifestWith({
        capabilities: ["mcp:expose"],
        contributes: { agentMcp: [{ ...ENDPOINT, id }] },
      })
    );
    expect(result.success).toBe(false);
  });
});

describe("mcpName", () => {
  const parse = (origin: "user" | "project", mcpName: string) =>
    getPluginManifestSchema(origin).safeParse(
      manifestWith({ mcpName, ...(origin === "project" ? { scope: "project" } : {}) })
    );

  it.each(["user", "project"] as const)("accepts a short lowercase name (%s)", (origin) => {
    expect(parse(origin, "books").success).toBe(true);
  });

  it.each(["docs", "runbooks"])(
    "rejects %s, which would name the server after one of the Daintree Assistant's own",
    (mcpName) => {
      for (const origin of ["user", "project"] as const) {
        const result = parse(origin, mcpName);
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain("mcpName");
      }
    }
  );

  it("still accepts names that only start with a reserved one", () => {
    const schema = getPluginManifestSchema("user");
    expect(schema.safeParse(manifestWith({ mcpName: "docs-index" })).success).toBe(true);
    expect(schema.safeParse(manifestWith({ mcpName: "runbooks2" })).success).toBe(true);
  });
});
