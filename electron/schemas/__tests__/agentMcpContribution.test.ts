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

  it.each(["docs", "runbooks", "decisions"])(
    "rejects %s, which would name the server after one of Daintree's own",
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
    expect(schema.safeParse(manifestWith({ mcpName: "decisions-log" })).success).toBe(true);
  });
});

describe("contributes.agentMcp groups", () => {
  const parse = (groups: unknown) =>
    getPluginManifestSchema("user").safeParse(
      manifestWith({
        capabilities: ["mcp:expose"],
        contributes: { agentMcp: [{ ...ENDPOINT, groups }] },
      })
    );

  it("accepts read and write groups", () => {
    expect(
      parse([
        { id: "search", name: "Search", access: "read" },
        { id: "changes", name: "Change", description: "Commits previews.", access: "write" },
      ]).success
    ).toBe(true);
  });

  it("rejects duplicate ids, an empty list, an unknown access and stray fields", () => {
    const search = { id: "search", name: "Search", access: "read" };
    expect(parse([search, search]).success).toBe(false);
    expect(parse([]).success).toBe(false);
    expect(parse([{ ...search, access: "admin" }]).success).toBe(false);
    expect(parse([{ ...search, readOnlyHint: true }]).success).toBe(false);
  });
});

describe("contributes.agentMcp source", () => {
  const SERVER = { id: "catalog", name: "Catalog", command: "node", args: ["dist/server.js"] };
  const GROUPS = [
    { id: "search", name: "Search", access: "read" },
    { id: "edit", name: "Edit", access: "write" },
  ];

  function bridged(
    source: Record<string, unknown>,
    overrides: {
      groups?: unknown;
      mcpServers?: unknown[];
      scope?: "project";
      databases?: unknown[];
    } = {}
  ) {
    return manifestWith({
      ...(overrides.scope ? { scope: overrides.scope } : {}),
      capabilities: ["mcp:expose"],
      contributes: {
        mcpServers: overrides.mcpServers ?? [SERVER],
        agentMcp: [
          {
            ...ENDPOINT,
            ...(overrides.groups !== undefined ? { groups: overrides.groups } : {}),
            source,
          },
        ],
        ...(overrides.databases ? { databases: overrides.databases } : {}),
      },
    });
  }

  const parse = (manifest: unknown, origin: "user" | "project" = "user") =>
    getPluginManifestSchema(origin).safeParse(manifest);

  it("accepts an allowlist that names tools of a declared server", () => {
    const result = parse(
      bridged({
        mcpServer: "catalog",
        tools: [{ name: "search_catalog", serverTool: "catalog.search", description: "Search." }],
      })
    );
    expect(result.success).toBe(true);
  });

  it("rejects a dangling server, a wildcard-shaped entry and an empty allowlist", () => {
    expect(
      errorCodes(parse(bridged({ mcpServer: "missing", tools: [{ name: "a", serverTool: "a" }] })))
    ).toContain("agent_mcp_source_unknown_server");
    expect(parse(bridged({ mcpServer: "catalog", tools: [] })).success).toBe(false);
    expect(
      parse(bridged({ mcpServer: "catalog", tools: [{ name: "all", serverTool: "*" }] })).success
    ).toBe(false);
    expect(parse(bridged({ mcpServer: "catalog", tools: "*" })).success).toBe(false);
  });

  it("rejects a blank description override", () => {
    expect(
      parse(
        bridged({
          mcpServer: "catalog",
          tools: [{ name: "find", serverTool: "find", description: "   " }],
        })
      ).success
    ).toBe(false);
  });

  it("holds agent names to the agent grammar and rejects duplicates and host names", () => {
    expect(
      parse(bridged({ mcpServer: "catalog", tools: [{ name: "Search-It", serverTool: "s" }] }))
        .success
    ).toBe(false);
    const duplicates = errorCodes(
      parse(
        bridged({
          mcpServer: "catalog",
          tools: [
            { name: "one", serverTool: "same" },
            { name: "one", serverTool: "same" },
          ],
        })
      )
    );
    expect(duplicates.filter((code) => code === "agent_mcp_source_duplicate")).toHaveLength(2);
    expect(
      errorCodes(
        parse(
          bridged({ mcpServer: "catalog", tools: [{ name: "database_query", serverTool: "q" }] })
        )
      )
    ).toContain("agent_mcp_source_reserved_name");
  });

  it("requires a declared group on every tool of a grouped endpoint and none otherwise", () => {
    expect(
      parse(
        bridged(
          {
            mcpServer: "catalog",
            tools: [
              { name: "find", serverTool: "find", group: "search" },
              { name: "put", serverTool: "put", group: "edit" },
            ],
          },
          { groups: GROUPS }
        )
      ).success
    ).toBe(true);
    expect(
      errorCodes(
        parse(
          bridged(
            { mcpServer: "catalog", tools: [{ name: "find", serverTool: "find" }] },
            { groups: GROUPS }
          )
        )
      )
    ).toContain("agent_mcp_source_group_unknown");
    expect(
      errorCodes(
        parse(
          bridged(
            { mcpServer: "catalog", tools: [{ name: "find", serverTool: "find", group: "nope" }] },
            { groups: GROUPS }
          )
        )
      )
    ).toContain("agent_mcp_source_group_unknown");
    expect(
      errorCodes(
        parse(
          bridged({
            mcpServer: "catalog",
            tools: [{ name: "find", serverTool: "find", group: "search" }],
          })
        )
      )
    ).toContain("agent_mcp_source_group_unknown");
  });

  it("counts the allowlist against the tool budget beside declared queries", () => {
    const tools = Array.from({ length: 16 }, (_, i) => ({ name: `t${i}`, serverTool: `t${i}` }));
    expect(parse(bridged({ mcpServer: "catalog", tools })).success).toBe(true);
    const result = parse(
      bridged(
        { mcpServer: "catalog", tools },
        {
          databases: [
            {
              id: "main",
              location: "local",
              queries: [
                {
                  name: "count_rows",
                  mode: "read",
                  description: "Count.",
                  params: {},
                  sql: "SELECT 1",
                },
              ],
            },
          ],
        }
      )
    );
    expect(errorCodes(result)).toContain("agent_mcp_source_too_many_tools");
  });

  it("lets a project plugin declare a server only when an endpoint bridges it", () => {
    const source = { mcpServer: "catalog", tools: [{ name: "find", serverTool: "find" }] };
    expect(parse(bridged(source, { scope: "project" }), "project").success).toBe(true);
    const unbridged = parse(
      bridged(source, {
        scope: "project",
        mcpServers: [SERVER, { ...SERVER, id: "other" }],
      }),
      "project"
    );
    expect(errorCodes(unbridged)).toContain("mcpServers_project_scope_forbidden");
  });
});
