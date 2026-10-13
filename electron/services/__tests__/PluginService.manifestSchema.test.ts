import { describe, expect, it } from "vitest";
import { getPluginManifestSchema, isPrivateOrLoopbackHostname } from "../../schemas/plugin.js";
import { BUILT_IN_PLUGIN_CAPABILITIES } from "../../../shared/types/plugin.js";

describe("PluginManifestSchema name validation", () => {
  const validBase = { version: "1.0.0" };
  const sixtyFourCharName = `a.${"b".repeat(62)}`; // 1 + 1 + 62 = 64 chars
  const sixtyFiveCharName = `a.${"b".repeat(63)}`; // 1 + 1 + 63 = 65 chars

  it.each([
    "acme.linear-context",
    "a.b",
    "daintreehq.dev-tools",
    "daintree-hq.my-cool-plugin",
    "acme.good-1",
    sixtyFourCharName,
  ])("accepts scoped name %j", (name) => {
    const result = getPluginManifestSchema("user").safeParse({ name, ...validBase });
    expect(result.success).toBe(true);
  });

  it.each([
    "linear-context",
    "test-plugin",
    "Acme.linear-context",
    "acme.Linear",
    "acme..tools",
    ".acme.tools",
    "acme.tools.",
    "acme.team.tools",
    "acme/tools",
    "acme_tools",
    "acme.-foo",
    "acme.foo-",
    "-acme.foo",
    "---.foo",
    "acme.---",
    " acme.foo",
    "acme.foo ",
    "acme.foo\n",
    sixtyFiveCharName,
    "",
  ])("rejects unscoped or malformed name %j", (name) => {
    const result = getPluginManifestSchema("user").safeParse({ name, ...validBase });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("rejection includes an explanatory error message", () => {
    const result = getPluginManifestSchema("user").safeParse({ name: "bare-plugin", ...validBase });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameIssue = result.error.issues.find((i) => i.path[0] === "name");
      expect(nameIssue?.message).toContain("publisher.name");
    }
  });
});

describe("getPluginManifestSchema namespace lock", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("rejects user plugin with daintree.* name", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      name: "daintree.github-evil",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nsIssue = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode ===
            "namespace_reserved"
      );
      expect(nsIssue).toBeDefined();
      expect(nsIssue!.path).toEqual(["name"]);
    }
  });

  it("accepts builtin plugin with daintree.* name", () => {
    const result = getPluginManifestSchema("builtin").safeParse({
      ...validBase,
      name: "daintree.github",
    });
    expect(result.success).toBe(true);
  });

  it("accepts user plugin with non-daintree.* scoped name", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      name: "acme.daintree",
    });
    expect(result.success).toBe(true);
  });

  it("accepts user plugin with daintreehq.* name (not the daintree. prefix)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      name: "daintreehq.dev-tools",
    });
    expect(result.success).toBe(true);
  });
});

describe("PluginManifestSchema capabilities field", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("defaults to empty array when omitted", () => {
    const result = getPluginManifestSchema("user").safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([]);
    }
  });

  it("accepts built-in capability strings", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: ["fs:project-read", "network:fetch", "agent:invoke"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual([
        "fs:project-read",
        "network:fetch",
        "agent:invoke",
      ]);
    }
  });

  it("rejects custom (non-built-in) capability strings", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: ["custom:my-perm", "org.specific:do-thing"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "capabilities")).toBe(true);
    }
  });

  it("rejects whitespace-padded capability strings (no implicit trim)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: ["  fs:project-read  "],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "capabilities")).toBe(true);
    }
  });

  it('rejects stale "permissions" key because schema is strict', () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      permissions: ["fs:project-read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("BUILT_IN_PLUGIN_CAPABILITIES has no duplicate entries", () => {
    // A duplicate is the failure that actually matters: the list is a public
    // contract rendered as a permissions checklist, so a repeated token shows
    // the user the same grant twice. The previous form of this test asserted a
    // hardcoded length, which only ever forced a mechanical edit when the list
    // grew — it could not fail for any reason a reader would care about.
    expect(new Set(BUILT_IN_PLUGIN_CAPABILITIES).size).toBe(BUILT_IN_PLUGIN_CAPABILITIES.length);
  });

  it("rejects null capabilities value", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema scopes field", () => {
  const validBase = { name: "acme.scope-test", version: "1.0.0" };

  it("accepts empty scopes object (both buckets optional)", () => {
    const result = getPluginManifestSchema("user").safeParse({ ...validBase, scopes: {} });
    expect(result.success).toBe(true);
  });

  it("accepts a valid network scope with one https URL", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      scopes: { network: { allowedUrls: ["https://api.example.com/v2"] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes?.network?.allowedUrls).toEqual(["https://api.example.com/v2"]);
    }
  });

  it.each([
    ["http://api.example.com", "scope_url_not_https"],
    ["ftp://api.example.com", "scope_url_not_https"],
    ["file:///etc/passwd", "scope_url_not_https"],
    ["https://localhost", "scope_url_private_target"],
    ["https://intranet", "scope_url_hostname_unqualified"],
    ["https://127.0.0.1", "scope_url_private_target"],
    ["https://[::1]", "scope_url_private_target"],
    ["https://[fe80::1]", "scope_url_private_target"],
    ["https://[fc00::1]", "scope_url_private_target"],
    ["https://[fd00::1]", "scope_url_private_target"],
    ["https://[::ffff:127.0.0.1]", "scope_url_private_target"],
    ["https://169.254.169.254", "scope_url_private_target"],
    ["https://10.0.0.1", "scope_url_private_target"],
    ["https://192.168.1.1", "scope_url_private_target"],
    ["https://172.16.0.1", "scope_url_private_target"],
    ["https://172.31.255.255", "scope_url_private_target"],
    ["https://0", "scope_url_private_target"],
    ["https://0.0.0.0", "scope_url_private_target"],
    ["https://localhost.", "scope_url_private_target"],
    ["https://LOCALHOST", "scope_url_private_target"],
    ["https://user:pass@example.com", "scope_url_has_credentials"],
    ["https://example.com/*", "scope_wildcard_rejected"],
    ["https://*.example.com", "scope_wildcard_rejected"],
    ["not-a-url", "scope_url_invalid"],
  ])("rejects network.allowedUrls entry %j with errorCode %s", (url, errorCode) => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      scopes: { network: { allowedUrls: [url] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const matching = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode === errorCode
      );
      expect(matching).toBeDefined();
    }
  });

  it("rejects empty allowedUrls array (min 1 required)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      scopes: { network: { allowedUrls: [] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown key inside scopes (strict)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      scopes: { networking: { allowedUrls: ["https://api.example.com"] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects unknown key inside scopes.network (strict)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      scopes: {
        network: {
          allowedUrls: ["https://api.example.com"],
          deniedUrls: ["https://evil.com"],
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it.each([
    ["/var/run/docker.sock"],
    ["/tmp/app.sock"],
    ["\\\\.\\pipe\\docker_engine"],
    ["\\\\?\\pipe\\docker_engine"],
  ])("accepts socket.allowedPaths entry %j on every platform", (socketPath) => {
    // A manifest must parse identically wherever it's read — a Windows-authored
    // plugin has to validate on a Linux CI box and vice versa — so both endpoint
    // forms are accepted regardless of the host running the check.
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: ["socket:connect"],
      scopes: { socket: { allowedPaths: [socketPath] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes?.socket?.allowedPaths).toEqual([socketPath]);
    }
  });

  it.each([
    ["relative/docker.sock"],
    ["/var/run/*.sock"],
    ["/var/run/../../etc/passwd"],
    ["\\\\.\\pipe\\"],
    [" /var/run/docker.sock"],
    [""],
  ])("rejects socket.allowedPaths entry %j", (socketPath) => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: ["socket:connect"],
      scopes: { socket: { allowedPaths: [socketPath] } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts socket:connect with no socket scope (scope is optional intent)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: ["socket:connect"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty socket.allowedPaths array", () => {
    // Declaring the bucket and leaving it empty says nothing; omit it instead.
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: ["socket:connect"],
      scopes: { socket: { allowedPaths: [] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside scopes.socket (strict)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      capabilities: ["socket:connect"],
      scopes: { socket: { allowedPaths: ["/var/run/docker.sock"], deniedPaths: ["/x"] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("accepts a valid fs scope with an absolute path", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      scopes: { fs: { allowedPaths: ["/home/user/projects"] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes?.fs?.allowedPaths).toEqual(["/home/user/projects"]);
    }
  });

  it.each([
    ["relative/path", "scope_path_relative"],
    ["./relative", "scope_path_relative"],
    ["../escape", "scope_path_relative"],
    ["/home/user/../etc", "scope_path_traversal"],
    ["/home/user/**", "scope_wildcard_rejected"],
    ["/home/*/projects", "scope_wildcard_rejected"],
  ])("rejects fs.allowedPaths entry %j with errorCode %s", (entryPath, errorCode) => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      scopes: { fs: { allowedPaths: [entryPath] } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const matching = result.error.issues.find(
        (i) =>
          i.code === "custom" &&
          (i as unknown as { params?: { errorCode?: string } }).params?.errorCode === errorCode
      );
      expect(matching).toBeDefined();
    }
  });

  it("rejects empty allowedPaths array (min 1 required)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      scopes: { fs: { allowedPaths: [] } },
    });
    expect(result.success).toBe(false);
  });
});

describe("isPrivateOrLoopbackHostname (download SSRF guard)", () => {
  // `new URL` keeps brackets on IPv6 literals, so feed the bracketed form the
  // install/checkForUpdate paths actually pass.
  it.each([
    "[::1]",
    "[fe80::1]",
    "[fc00::1]",
    "[fd00::1]",
    "[::ffff:127.0.0.1]",
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "0.0.0.0",
    "localhost",
    "localhost.",
  ])("blocks %j", (host) => {
    expect(isPrivateOrLoopbackHostname(host)).toBe(true);
  });

  it.each(["8.8.8.8", "[2606:4700::1111]", "203.0.113.5", "api.example.com"])(
    "allows public address %j",
    (host) => {
      expect(isPrivateOrLoopbackHostname(host)).toBe(false);
    }
  );
});

describe("PluginManifestSchema forgeProviders contribution", () => {
  const validBase = { name: "acme.forge", version: "1.0.0" };

  it("defaults contributes.forgeProviders to [] when contributes is absent", () => {
    const result = getPluginManifestSchema("user").safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([]);
    }
  });

  it("defaults contributes.forgeProviders to [] when contributes is an empty object", () => {
    const result = getPluginManifestSchema("user").safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([]);
    }
  });

  it("accepts a fully specified forgeProviders entry", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        // settingsScopeRef / viewRefs are cross-validated against the manifest's
        // own settings/views (#10620), and each referenced view needs a matching
        // panel id — declare them so this stays a positive case.
        panels: [
          { id: "github-issues", name: "Issues", iconId: "eye", color: "#abc" },
          { id: "github-prs", name: "PRs", iconId: "eye", color: "#abc" },
        ],
        settings: [{ id: "github", type: "string", label: "GitHub" }],
        views: [
          { id: "github-issues", componentPath: "./issues.js", location: "panel" },
          { id: "github-prs", componentPath: "./prs.js", location: "panel" },
        ],
        forgeProviders: [
          {
            id: "github",
            name: "GitHub",
            matches: ["github.com"],
            capabilities: ["issues", "pulls", "reviews", "required-checks", "releases"],
            settingsScopeRef: "github",
            viewRefs: ["github-issues", "github-prs"],
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.forgeProviders).toEqual([
        {
          id: "github",
          name: "GitHub",
          matches: ["github.com"],
          capabilities: ["issues", "pulls", "reviews", "required-checks", "releases"],
          settingsScopeRef: "github",
          viewRefs: ["github-issues", "github-prs"],
        },
      ]);
    }
  });

  it("rejects a forgeProviders entry missing required fields", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        forgeProviders: [{ id: "gh" }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema fileDecorationProviders contribution", () => {
  const validBase = { name: "acme.decor", version: "1.0.0" };

  it("defaults contributes.fileDecorationProviders to [] when contributes is absent", () => {
    const result = getPluginManifestSchema("user").safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([]);
    }
  });

  it("defaults to [] when contributes is an empty object", () => {
    const result = getPluginManifestSchema("user").safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([]);
    }
  });

  it("accepts a valid fileDecorationProviders entry", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        fileDecorationProviders: [{ id: "worktree-diff-review", scopes: ["worktree-diff:*"] }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.fileDecorationProviders).toEqual([
        { id: "worktree-diff-review", scopes: ["worktree-diff:*"] },
      ]);
    }
  });

  it("rejects an entry with an empty scopes array", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: { fileDecorationProviders: [{ id: "d", scopes: [] }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry missing required fields", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: { fileDecorationProviders: [{ id: "d" }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys on the entry (strict schema)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        fileDecorationProviders: [{ id: "d", scopes: ["s:*"], extra: true }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema contributes strict validation", () => {
  const validBase = { name: "acme.test", version: "1.0.0" };

  it("rejects unknown keys inside contributes (typo'd contribution-point names)", () => {
    // `commandz` is a deliberate typo of `commands` (#9281) — strict-mode
    // rejection of unknown keys catches plugin-author typos.
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        commandz: [{ id: "foo", title: "Foo", description: "bar", category: "test" }],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedIssue = result.error.issues.find((i) => i.code === "unrecognized_keys");
      expect(unrecognizedIssue).toBeDefined();
    }
  });

  it("accepts an explicit dockable:false on a panel contribution (#11332)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "eye", color: "#abc", dockable: false }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.panels[0]?.dockable).toBe(false);
    }
  });

  it("leaves dockable undefined when a panel omits it — the dockable-by-default path (#11332)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "eye", color: "#abc" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Assert the panel exists before checking key absence, so an empty
      // panels array can't make `?.dockable` pass vacuously.
      expect(result.data.contributes.panels).toHaveLength(1);
      expect(
        Object.prototype.hasOwnProperty.call(result.data.contributes.panels[0], "dockable")
      ).toBe(false);
    }
  });

  it("rejects a non-boolean dockable on a panel contribution (#11332)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "eye", color: "#abc", dockable: "yes" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("migrates the deprecated experimental_views alias to the stable views key (#10466)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        // A view needs a matching panel id (view_panel_ref_unknown, #10620).
        panels: [{ id: "v", name: "V", iconId: "eye", color: "#abc" }],
        experimental_views: [{ id: "v", componentPath: "./v.js", location: "panel" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toHaveLength(1);
      // The deprecated key is stripped from the parsed output — no
      // `experimental_*` field survives in the frozen contract.
      expect("experimental_views" in result.data.contributes).toBe(false);
    }
  });

  it("migrates the deprecated experimental_mcpServers alias to the stable mcpServers key (#10466)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        experimental_mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.mcpServers).toHaveLength(1);
      expect("experimental_mcpServers" in result.data.contributes).toBe(false);
    }
  });

  it("prefers the canonical key over a deprecated alias when both are present (#10466)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        // The surviving canonical view needs a matching panel id (#10620).
        panels: [{ id: "canonical", name: "Canonical", iconId: "eye", color: "#abc" }],
        views: [{ id: "canonical", componentPath: "./c.js", location: "panel" }],
        experimental_views: [{ id: "legacy", componentPath: "./l.js", location: "panel" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toHaveLength(1);
      expect(result.data.contributes.views[0]?.id).toBe("canonical");
      expect("experimental_views" in result.data.contributes).toBe(false);
    }
  });

  it("treats an explicit empty canonical array as canonical and does not adopt the alias (#10466)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: {
        views: [],
        experimental_views: [{ id: "legacy", componentPath: "./l.js", location: "panel" }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toHaveLength(0);
    }
  });

  it("produces a clean error rather than throwing when contributes is not an object (#10466)", () => {
    for (const bad of [null, [], 42, "x"]) {
      const result = getPluginManifestSchema("user").safeParse({ ...validBase, contributes: bad });
      expect(result.success).toBe(false);
    }
  });

  it("accepts empty contributes object (no unknown keys, defaults populate)", () => {
    const result = getPluginManifestSchema("user").safeParse({ ...validBase, contributes: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.views).toEqual([]);
      expect(result.data.contributes.mcpServers).toEqual([]);
    }
  });
});

describe("panel contribution PTY / dockable cross-field rule (#11375)", () => {
  const validBase = { name: "acme.panels", version: "1.0.0" };
  const basePanel = {
    id: "my-panel",
    name: "My Panel",
    iconId: "puzzle",
    color: "#123456",
  };

  it("rejects hasPty:true combined with an explicit dockable:false", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: { panels: [{ ...basePanel, hasPty: true, dockable: false }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.includes("dockable") && i.path.includes("panels")
      );
      expect(issue, "expected an issue on the panel's dockable field").toBeDefined();
      expect(issue?.message).toContain("dockable");
    }
  });

  it("accepts hasPty:true with dockable:true", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: { panels: [{ ...basePanel, hasPty: true, dockable: true }] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts hasPty:true with dockable omitted (defaults to dockable)", () => {
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: { panels: [{ ...basePanel, hasPty: true }] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a non-PTY panel that opts out of the dock (dockable:false)", () => {
    // `hasPty` defaults to false, so the explicit opt-out is the whole point of
    // the flag for a non-PTY view — it must stay valid.
    const result = getPluginManifestSchema("user").safeParse({
      ...validBase,
      contributes: { panels: [{ ...basePanel, dockable: false }] },
    });
    expect(result.success).toBe(true);
  });
});
