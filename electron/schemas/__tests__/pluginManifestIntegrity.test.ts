import { describe, it, expect } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";

const schema = getPluginManifestSchema(false);

function manifestWith(contributes: Record<string, unknown>) {
  return schema.safeParse({
    name: "acme.my-plugin",
    version: "1.0.0",
    contributes,
  });
}

// Minimal valid entry factories — only the fields the integrity checks read
// matter; every other required field is set to a schema-valid stub.
function panel(id: string): Record<string, unknown> {
  return { id, name: "Panel", iconId: "sparkles", color: "#fff" };
}
function command(id: string): Record<string, unknown> {
  return {
    id,
    title: "Cmd",
    description: "",
    category: "general",
    kind: "command",
    danger: "safe",
  };
}
function view(id: string): Record<string, unknown> {
  return { id, name: "View", componentPath: "./view/index.js", location: "panel" };
}
function setting(id: string): Record<string, unknown> {
  return { id, type: "string" };
}
function mcpServer(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "srv", name: "Server", command: "node", ...overrides };
}
function forgeProvider(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "prov", name: "Prov", matches: ["github.com"], ...overrides };
}

function errorCodes(result: ReturnType<typeof schema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues
    .map((i) => (i as { params?: { errorCode?: string } }).params?.errorCode)
    .filter((c): c is string => typeof c === "string");
}

function issueWithCode(result: ReturnType<typeof schema.safeParse>, code: string) {
  if (result.success) return undefined;
  return result.error.issues.find(
    (i) => (i as { params?: { errorCode?: string } }).params?.errorCode === code
  );
}

describe("duplicate contribution ids (#10620)", () => {
  // Each array carries an `id` keying a runtime registry; a duplicate first-wins
  // silently at load, so the second contribution must be rejected at parse time.
  const arrays: Array<[string, (id: string) => Record<string, unknown>, Record<string, unknown>]> =
    [
      ["panels", panel, {}],
      ["commands", command, {}],
      ["views", view, {}],
      ["settings", setting, {}],
      ["mcpServers", (id) => mcpServer({ id }), {}],
      ["forgeProviders", (id) => forgeProvider({ id }), {}],
      ["fileDecorationProviders", (id) => ({ id, scopes: ["file"] }), {}],
    ];

  it.each(arrays)("rejects two %s entries sharing an id", (arrayName, make) => {
    // Views need matching panels to isolate the duplicate check from the
    // view→panel cross-ref; supply them when testing views.
    const extra = arrayName === "views" ? { panels: [panel("dup"), panel("other")] } : {};
    const result = manifestWith({ [arrayName]: [make("dup"), make("dup")], ...extra });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "duplicate_contribution_id");
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual(["contributes", arrayName, 1, "id"]);
  });

  it.each(arrays)("accepts distinct %s ids", (arrayName, make) => {
    const extra = arrayName === "views" ? { panels: [panel("a"), panel("b")] } : {};
    const result = manifestWith({ [arrayName]: [make("a"), make("b")], ...extra });
    expect(result.success).toBe(true);
  });

  it("reports the duplicate at the second occurrence, not the first", () => {
    const result = manifestWith({ commands: [command("a"), command("b"), command("a")] });
    expect(result.success).toBe(false);
    const dupIssues = (result.success ? [] : result.error.issues).filter(
      (i) =>
        (i as { params?: { errorCode?: string } }).params?.errorCode === "duplicate_contribution_id"
    );
    expect(dupIssues.map((i) => i.path)).toEqual([["contributes", "commands", 2, "id"]]);
  });

  it("does not flag the same id used across different arrays", () => {
    // Cross-array ids are namespaced independently and never collide.
    const result = manifestWith({
      panels: [panel("shared")],
      commands: [command("shared")],
    });
    expect(result.success).toBe(true);
  });
});

describe("forgeProvider cross-references (#10620)", () => {
  it("accepts settingsScopeRef that names a declared setting", () => {
    const result = manifestWith({
      settings: [setting("token")],
      forgeProviders: [forgeProvider({ settingsScopeRef: "token" })],
    });
    expect(result.success).toBe(true);
  });

  it("rejects settingsScopeRef that names no declared setting", () => {
    const result = manifestWith({
      forgeProviders: [forgeProvider({ settingsScopeRef: "missing" })],
    });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "forge_settings_scope_ref_unknown");
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual(["contributes", "forgeProviders", 0, "settingsScopeRef"]);
  });

  it("accepts viewRefs that name declared views", () => {
    const result = manifestWith({
      panels: [panel("v1")],
      views: [view("v1")],
      forgeProviders: [forgeProvider({ viewRefs: ["v1"] })],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a viewRef that names no declared view, at the ref index", () => {
    const result = manifestWith({
      panels: [panel("v1")],
      views: [view("v1")],
      forgeProviders: [forgeProvider({ viewRefs: ["v1", "ghost"] })],
    });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "forge_view_ref_unknown");
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual(["contributes", "forgeProviders", 0, "viewRefs", 1]);
  });
});

describe("view → panel cross-reference (#10620)", () => {
  it("accepts a view whose id matches a panel", () => {
    const result = manifestWith({ panels: [panel("rich")], views: [view("rich")] });
    expect(result.success).toBe(true);
  });

  it("rejects a view with no matching panel (was silently ignored before)", () => {
    const result = manifestWith({ views: [view("orphan")] });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "view_panel_ref_unknown");
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual(["contributes", "views", 0, "id"]);
  });
});

describe("MCP server ${settings:*} token references (#10620)", () => {
  it("accepts tokens that name declared settings across command/args/env", () => {
    const result = manifestWith({
      settings: [setting("api_key"), setting("base_url"), setting("home")],
      mcpServers: [
        mcpServer({
          command: "${settings:home}/bin/server",
          args: ["--key", "${settings:api_key}"],
          env: { BASE_URL: "${settings:base_url}" },
        }),
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown token in command", () => {
    const result = manifestWith({
      mcpServers: [mcpServer({ command: "${settings:nope}" })],
    });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "settings_token_unknown");
    expect(issue?.path).toEqual(["contributes", "mcpServers", 0, "command"]);
  });

  it("rejects an unknown token in an arg, at the arg index", () => {
    const result = manifestWith({
      settings: [setting("known")],
      mcpServers: [mcpServer({ args: ["--a", "${settings:known}", "${settings:bad}"] })],
    });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "settings_token_unknown");
    expect(issue?.path).toEqual(["contributes", "mcpServers", 0, "args", 2]);
  });

  it("rejects an unknown token in an env value, keyed by the env name", () => {
    const result = manifestWith({
      mcpServers: [mcpServer({ env: { TOKEN: "${settings:absent}" } })],
    });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "settings_token_unknown");
    expect(issue?.path).toEqual(["contributes", "mcpServers", 0, "env", "TOKEN"]);
  });

  it("reports every unknown token in one string", () => {
    const result = manifestWith({
      mcpServers: [mcpServer({ args: ["${settings:a}-${settings:b}"] })],
    });
    const tokenIssues = errorCodes(result).filter((c) => c === "settings_token_unknown");
    expect(tokenIssues).toHaveLength(2);
  });
});
