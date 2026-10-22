import { describe, it, expect } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";

const schema = getPluginManifestSchema("user");

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
  return { id, componentPath: "./view/index.js", location: "panel" };
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
function toolbarButton(id: string): Record<string, unknown> {
  // actionId in the plugin's own namespace with no declared commands → the
  // imperative escape hatch, so the actionId gate stays out of the way.
  return { id, label: "Btn", iconId: "sparkles", actionId: "acme.my-plugin.x" };
}
function agent(id: string): Record<string, unknown> {
  return { id, name: "Agent", command: "claude", color: "#abcdef", iconId: "sparkles" };
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
      ["toolbarButtons", toolbarButton, {}],
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

  // Agents carry an extra capability gate, so they sit outside the matrix and
  // declare `agent:register` to isolate the duplicate-id check.
  it("rejects two agents sharing an id", () => {
    const result = schema.safeParse({
      name: "acme.my-plugin",
      version: "1.0.0",
      capabilities: ["agent:register"],
      contributes: { agents: [agent("dup"), agent("dup")] },
    });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "duplicate_contribution_id");
    expect(issue?.path).toEqual(["contributes", "agents", 1, "id"]);
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

describe("location: settings views", () => {
  function settingsView(id: string): Record<string, unknown> {
    return { id, componentPath: "./view/settings.js", location: "settings" };
  }

  it("accepts one settings view with no panel of its own", () => {
    const result = manifestWith({ views: [settingsView("prefs")] });
    expect(result.success).toBe(true);
  });

  it("accepts a settings view beside panel views", () => {
    const result = manifestWith({
      panels: [panel("rich")],
      views: [view("rich"), settingsView("prefs")],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a second settings view", () => {
    const result = manifestWith({ views: [settingsView("a"), settingsView("b")] });
    expect(result.success).toBe(false);
    expect(issueWithCode(result, "settings_view_duplicate")?.path).toEqual([
      "contributes",
      "views",
      1,
      "location",
    ]);
  });

  it("rejects a settings view that shares a panel's id", () => {
    const result = manifestWith({ panels: [panel("rich")], views: [settingsView("rich")] });
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("settings_view_panel_id_collision");
  });

  it("rejects a project surface that names a settings view", () => {
    const result = getPluginManifestSchema("project").safeParse({
      name: "acme.my-plugin",
      version: "1.0.0",
      scope: "project",
      contributes: {
        views: [settingsView("prefs")],
        surfaces: { emptyCanvas: { viewId: "prefs" } },
      },
    });
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("surface_view_ref_settings");
  });
});

describe("location: sidebar views", () => {
  function sidebarView(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, componentPath: "./view/sidebar.js", location: "sidebar", name: "Board", ...extra };
  }

  it("accepts several sidebar views with no panel of their own", () => {
    const result = manifestWith({
      views: [sidebarView("board", { priority: 200, when: "isGitBacked" }), sidebarView("docs")],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a sidebar view without a name", () => {
    const { name: _omit, ...unnamed } = sidebarView("board");
    const result = manifestWith({ views: [unnamed] });
    expect(result.success).toBe(false);
    expect(issueWithCode(result, "sidebar_view_name_missing")?.path).toEqual([
      "contributes",
      "views",
      0,
      "name",
    ]);
  });

  it.each(["activeSidebarView == 'acme.my-plugin.board'", "isGitBacked && !activeSidebarView"])(
    "rejects a sidebar view whose when reads activeSidebarView: %s",
    (when) => {
      const result = manifestWith({ views: [sidebarView("board", { when })] });
      expect(result.success).toBe(false);
      expect(issueWithCode(result, "sidebar_view_when_reads_active_view")?.path).toEqual([
        "contributes",
        "views",
        0,
        "when",
      ]);
    }
  );

  it("rejects a sidebar view that shares a panel's id", () => {
    const result = manifestWith({ panels: [panel("rich")], views: [sidebarView("rich")] });
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("sidebar_view_panel_id_collision");
  });

  it.each([
    ["panel", { name: "Rich" }, "name"],
    ["panel", { priority: 5 }, "priority"],
    ["settings", { when: "isGitBacked" }, "when"],
  ])("rejects a %s view that sets the sidebar-only %o", (location, extra, field) => {
    const result = manifestWith({
      panels: [panel("rich")],
      views: [{ ...view(location === "panel" ? "rich" : "prefs"), location, ...extra }],
    });
    expect(result.success).toBe(false);
    expect(issueWithCode(result, "view_sidebar_field_misplaced")?.path).toEqual([
      "contributes",
      "views",
      0,
      field,
    ]);
  });

  it("rejects a project surface that names a sidebar view", () => {
    const result = getPluginManifestSchema("project").safeParse({
      name: "acme.my-plugin",
      version: "1.0.0",
      scope: "project",
      contributes: {
        views: [sidebarView("board")],
        surfaces: { emptyCanvas: { viewId: "board" } },
      },
    });
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("surface_view_ref_sidebar");
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

  it("rejects a malformed token whose id breaks the safe-id grammar", () => {
    // `foo/bar` is unmatchable by the supervisor's stricter regex, so the literal
    // token would reach exec — flag it at parse time instead.
    const result = manifestWith({
      mcpServers: [mcpServer({ command: "${settings:foo/bar}" })],
    });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "settings_token_malformed");
    expect(issue?.path).toEqual(["contributes", "mcpServers", 0, "command"]);
  });

  it("reports the token issue at the correct server index with multiple servers", () => {
    const result = manifestWith({
      settings: [setting("ok")],
      mcpServers: [
        mcpServer({ id: "a", args: ["${settings:ok}"] }),
        mcpServer({ id: "b", args: ["${settings:bad}"] }),
      ],
    });
    expect(result.success).toBe(false);
    const issue = issueWithCode(result, "settings_token_unknown");
    expect(issue?.path).toEqual(["contributes", "mcpServers", 1, "args", 0]);
  });
});

describe("contributes.fileEditors (#12323, #13809)", () => {
  const builtinSchema = getPluginManifestSchema("builtin");
  const projectSchema = getPluginManifestSchema("project");

  function slotEditor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "markdown",
      slot: "markdown.editor",
      extensions: ["md", "markdown"],
      ...overrides,
    };
  }

  function viewEditor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "records",
      view: "records-editor",
      mode: "edit",
      extensions: ["json"],
      ...overrides,
    };
  }

  const editorView = {
    id: "records-editor",
    componentPath: "dist/editor.js",
    location: "fileEditor",
  };

  function builtinWith(contributes: Record<string, unknown>) {
    return builtinSchema.safeParse({ name: "daintree.my-plugin", version: "1.0.0", contributes });
  }

  function projectWith(contributes: Record<string, unknown>) {
    return projectSchema.safeParse({
      name: "acme.my-plugin",
      version: "1.0.0",
      scope: "project",
      contributes,
    });
  }

  it("accepts a slot-backed entry from a built-in plugin and defaults the group to empty", () => {
    expect(builtinWith({ fileEditors: [slotEditor()] }).success).toBe(true);
    const bare = manifestWith({});
    expect(bare.success && bare.data.contributes.fileEditors).toEqual([]);
  });

  it("refuses a slot-backed entry from any other origin", () => {
    const result = manifestWith({ fileEditors: [slotEditor()] });
    expect(result.success).toBe(false);
    expect(issueWithCode(result, "fileEditors_slot_builtin_only")?.path).toEqual([
      "contributes",
      "fileEditors",
      0,
      "slot",
    ]);
  });

  it("accepts a view-backed entry from an installed plugin", () => {
    const result = manifestWith({ views: [editorView], fileEditors: [viewEditor()] });
    expect(result.success).toBe(true);
    expect(
      manifestWith({
        views: [editorView],
        fileEditors: [viewEditor({ mode: "view", extensions: ["csv"] })],
      }).success
    ).toBe(true);
  });

  it("requires exactly one of slot and view, and a mode with a view", () => {
    expect(
      builtinWith({ views: [editorView], fileEditors: [viewEditor({ slot: "markdown.editor" })] })
        .success
    ).toBe(false);
    expect(builtinWith({ fileEditors: [{ id: "x", extensions: ["md"] }] }).success).toBe(false);
    expect(
      manifestWith({ views: [editorView], fileEditors: [viewEditor({ mode: undefined })] }).success
    ).toBe(false);
    expect(builtinWith({ fileEditors: [slotEditor({ mode: "edit" })] }).success).toBe(false);
  });

  it("requires a view-backed entry to name one of its own fileEditor views", () => {
    const missing = manifestWith({ fileEditors: [viewEditor()] });
    expect(issueWithCode(missing, "file_editor_view_ref_unknown")).toBeDefined();
    const panelView = manifestWith({
      panels: [panel("records-editor")],
      views: [{ id: "records-editor", componentPath: "dist/editor.js", location: "panel" }],
      fileEditors: [viewEditor()],
    });
    expect(issueWithCode(panelView, "file_editor_view_ref_unknown")).toBeDefined();
  });

  it("does not require a panel for a fileEditor view, and refuses one sharing a panel id", () => {
    expect(manifestWith({ views: [editorView] }).success).toBe(true);
    const collision = manifestWith({ panels: [panel("records-editor")], views: [editorView] });
    expect(issueWithCode(collision, "file_editor_view_panel_id_collision")).toBeDefined();
  });

  it("refuses a surface claim naming a fileEditor view", () => {
    const result = projectWith({
      views: [editorView],
      surfaces: { emptyCanvas: { viewId: "records-editor" } },
    });
    expect(issueWithCode(result, "surface_view_ref_file_editor")).toBeDefined();
  });

  it("accepts paths only from a project plugin", () => {
    const paths = ["content/entries/*.json", "data/**/*.record"];
    expect(projectWith({ views: [editorView], fileEditors: [viewEditor({ paths })] }).success).toBe(
      true
    );
    expect(
      projectWith({
        views: [editorView],
        fileEditors: [viewEditor({ extensions: undefined, paths })],
      }).success
    ).toBe(true);
    const installed = manifestWith({ views: [editorView], fileEditors: [viewEditor({ paths })] });
    expect(issueWithCode(installed, "fileEditors_paths_project_only")).toBeDefined();
  });

  it("refuses paths that reach outside the project or negate", () => {
    for (const pattern of [
      "/etc/*.json",
      "../x.json",
      "a/../b.json",
      "C:/x.json",
      "a\\b",
      "!x.json",
    ]) {
      expect(
        projectWith({ views: [editorView], fileEditors: [viewEditor({ paths: [pattern] })] })
          .success
      ).toBe(false);
    }
  });

  it("requires extensions or paths", () => {
    expect(
      manifestWith({ views: [editorView], fileEditors: [viewEditor({ extensions: undefined })] })
        .success
    ).toBe(false);
  });

  it("accepts an explicit byte ceiling and refuses one above the host ceiling", () => {
    expect(builtinWith({ fileEditors: [slotEditor({ maxBytes: 2 * 1024 * 1024 })] }).success).toBe(
      true
    );
    expect(builtinWith({ fileEditors: [slotEditor({ maxBytes: 0 })] }).success).toBe(false);
    expect(builtinWith({ fileEditors: [slotEditor({ maxBytes: 65 * 1024 * 1024 })] }).success).toBe(
      false
    );
  });

  it("requires bare lower-case extensions without the dot", () => {
    expect(builtinWith({ fileEditors: [slotEditor({ extensions: [".md"] })] }).success).toBe(false);
    expect(builtinWith({ fileEditors: [slotEditor({ extensions: ["MD"] })] }).success).toBe(false);
    expect(builtinWith({ fileEditors: [slotEditor({ extensions: [] })] }).success).toBe(false);
  });

  it("is strict about unknown fields", () => {
    expect(builtinWith({ fileEditors: [slotEditor({ component: "x" })] }).success).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const result = builtinWith({ fileEditors: [slotEditor(), slotEditor()] });
    expect(result.success).toBe(false);
  });
});

describe("cached manifest schema", () => {
  it("returns one schema per origin", () => {
    expect(getPluginManifestSchema("user")).toBe(schema);
    expect(getPluginManifestSchema(false)).toBe(schema);
    expect(getPluginManifestSchema(true)).toBe(getPluginManifestSchema("builtin"));
    expect(getPluginManifestSchema("project")).not.toBe(schema);
  });

  it("never shares defaulted contribution arrays between parses", () => {
    const parse = () => {
      const result = schema.safeParse({ name: "acme.bare", version: "1.0.0" });
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    };
    const first = parse();
    const second = parse();
    expect(second.contributes).not.toBe(first.contributes);
    expect(second.contributes.panels).not.toBe(first.contributes.panels);
    expect(second.contributes.surfaces).not.toBe(first.contributes.surfaces);
  });
});
