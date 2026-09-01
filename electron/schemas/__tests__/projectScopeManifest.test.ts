import { describe, it, expect } from "vitest";
import { getPluginManifestSchema, PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

/**
 * The origin gate for project-local plugins. `scope: "project"` and the root the
 * manifest was discovered under must agree in BOTH directions, so a manifest
 * cannot be moved between roots and quietly keep loading under assumptions its
 * author never made. Nothing in the app produces a `scope: "project"` manifest
 * yet — the schema deliberately lands first, so a malformed one is rejected
 * before any code path can create it.
 */

const ORIGINS = ["builtin", "user", "project"] as const;

function parse(origin: PluginOrigin, manifest: Record<string, unknown>) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.project-plugin",
    version: "1.0.0",
    ...manifest,
  });
}

function errorCodes(result: ReturnType<ReturnType<typeof getPluginManifestSchema>["safeParse"]>) {
  if (result.success) return [];
  return result.error.issues
    .map((i) => (i as { params?: { errorCode?: string } }).params?.errorCode)
    .filter((c): c is string => typeof c === "string");
}

function messageForCode(
  result: ReturnType<ReturnType<typeof getPluginManifestSchema>["safeParse"]>,
  code: string
) {
  if (result.success) return undefined;
  return result.error.issues.find(
    (i) => (i as { params?: { errorCode?: string } }).params?.errorCode === code
  )?.message;
}

const forgeProvider = { id: "prov", name: "Prov", matches: ["github.com"] };

describe('manifest "scope": "project" origin gate', () => {
  it("accepts a project-origin manifest that declares the scope", () => {
    const result = parse("project", { scope: "project" });
    expect(result.success).toBe(true);
  });

  it("rejects a project-origin manifest with no scope", () => {
    const result = parse("project", {});
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("project_scope_required");
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "scope")).toBe(true);
    }
  });

  it("rejects a project-origin manifest with an explicitly undefined scope", () => {
    // `undefined` takes the optional branch rather than the literal branch, so
    // the gate must catch it in superRefine and not rely on the field schema.
    const result = parse("project", { scope: undefined });
    expect(errorCodes(result)).toContain("project_scope_required");
  });

  it.each(["builtin", "user"] as const)(
    "rejects a %s-origin manifest that declares the project scope",
    (origin) => {
      const result = parse(origin, { scope: "project" });
      expect(result.success).toBe(false);
      expect(errorCodes(result)).toContain("project_scope_not_allowed");
      expect(messageForCode(result, "project_scope_not_allowed")).toContain(origin);
    }
  );

  it.each(["builtin", "user"] as const)("accepts a %s-origin manifest with no scope", (origin) => {
    const result = parse(origin, {});
    expect(result.success).toBe(true);
  });

  it.each(ORIGINS)('rejects any scope value other than "project" under %s', (origin) => {
    const result = parse(origin, { scope: "user" });
    expect(result.success).toBe(false);
  });

  it("still applies the gate when contributes is absent entirely", () => {
    // `contributes` carries a `.default({})`, so superRefine sees a fully
    // materialized object — the gate must not depend on the key being written.
    const result = parse("project", {});
    expect(errorCodes(result)).toContain("project_scope_required");
    expect(parse("project", { scope: "project" }).success).toBe(true);
  });

  it("still applies the gate through the deprecated-alias preprocess", () => {
    // `contributes` is wrapped in a preprocess that rewrites `experimental_*`
    // aliases. A manifest taking that branch must not slip the scope check.
    const result = parse("project", {
      contributes: {
        panels: [{ id: "p", name: "Panel", iconId: "sparkles", color: "#ffffff" }],
        experimental_views: [{ id: "p", componentPath: "./view.js", location: "panel" }],
      },
    });
    expect(errorCodes(result)).toContain("project_scope_required");
  });

  it("does not let the project scope unlock the reserved daintree.* namespace", () => {
    const result = getPluginManifestSchema("project").safeParse({
      name: "daintree.impostor",
      version: "1.0.0",
      scope: "project",
    });
    expect(errorCodes(result)).toContain("namespace_reserved");
  });
});

describe('contributes.forgeProviders under "scope": "project"', () => {
  it("rejects a forge provider declared by a project plugin", () => {
    const result = parse("project", {
      scope: "project",
      contributes: { forgeProviders: [forgeProvider] },
    });
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("forge_provider_project_scope_forbidden");
  });

  it("names the worker-port reason rather than restating the rule", () => {
    const result = parse("project", {
      scope: "project",
      contributes: { forgeProviders: [forgeProvider] },
    });
    const message = messageForCode(result, "forge_provider_project_scope_forbidden") ?? "";
    // The refusal must explain WHY, matching the runtime refusal in
    // pluginDevWorkerHostProxy.registerForgeProvider.
    expect(message).toContain("synchronous");
    expect(message).toMatch(/worker/i);
    expect(message).toContain("parseRemote");
  });

  it("accepts a project plugin with an empty forgeProviders array", () => {
    const result = parse("project", { scope: "project", contributes: { forgeProviders: [] } });
    expect(result.success).toBe(true);
  });

  it.each(["builtin", "user"] as const)("still accepts a forge provider from %s", (origin) => {
    const result = parse(origin, { contributes: { forgeProviders: [forgeProvider] } });
    expect(result.success).toBe(true);
  });
});

describe("getPluginManifestSchema origin widening", () => {
  const daintreeNamed = { name: "daintree.first-party", version: "1.0.0" };

  it("maps the deprecated boolean bridge onto the same origins", () => {
    // The two forbidden-to-edit call sites (PluginService, PluginInstaller)
    // still pass a boolean. Pin the mapping so the bridge cannot drift from the
    // meaning the flag had.
    expect(getPluginManifestSchema(true).safeParse(daintreeNamed).success).toBe(
      getPluginManifestSchema("builtin").safeParse(daintreeNamed).success
    );
    expect(getPluginManifestSchema(false).safeParse(daintreeNamed).success).toBe(
      getPluginManifestSchema("user").safeParse(daintreeNamed).success
    );
  });

  it("keeps the reserved namespace to the builtin origin only", () => {
    expect(getPluginManifestSchema("builtin").safeParse(daintreeNamed).success).toBe(true);
    expect(errorCodes(getPluginManifestSchema("user").safeParse(daintreeNamed))).toContain(
      "namespace_reserved"
    );
  });

  it("still accepts a scope-less manifest under both pre-existing origins", () => {
    // Smoke check on the widening being a pure rename: a manifest that declares
    // no scope must not notice which of the two old origins it is parsed under.
    const manifest = {
      name: "acme.unchanged",
      version: "1.0.0",
      contributes: { forgeProviders: [forgeProvider] },
    };
    expect(getPluginManifestSchema("user").safeParse(manifest).success).toBe(true);
    expect(getPluginManifestSchema("builtin").safeParse(manifest).success).toBe(true);
  });
});

/**
 * Sample contributions for the groups a project plugin may not declare. Every
 * one of these parses cleanly under `user` origin — the only thing rejecting
 * them under `project` is the structurally-global rule.
 */
const UNSCOPED_SAMPLES: Record<UnscopedGroup, unknown[]> = {
  menuItems: [{ label: "Do it", actionId: "acme.project-plugin.go", location: "help" }],
  agents: [
    { id: "acme-agent", name: "Acme", command: "acme", color: "#123456", iconId: "sparkles" },
  ],
  skills: [{ id: "skill", name: "Skill", path: "skills/skill.md" }],
  recipes: [{ id: "boot", name: "Boot", terminals: [{ type: "shell" }] }],
  fileDecorationProviders: [{ id: "dec", scopes: ["file"] }],
  processTools: [{ command: "acmetool", iconId: "sparkles" }],
  mcpServers: [{ id: "srv", name: "Srv", command: "node" }],
};

type UnscopedGroup = (typeof PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS)[number][0];

const UNSCOPED_GROUPS = PROJECT_SCOPE_UNSCOPED_CONTRIBUTIONS.map(([group]) => group);

/**
 * Every group here still broadcasts app-wide (`PluginContributionBroadcaster`
 * filters panels, actions, toolbar buttons, keybindings and context menus and
 * nothing else), so a project plugin declaring one publishes it to every
 * project. That was unreachable before project-local plugins existed; now it is
 * a live leak, and the manifest gate is what turns it into a load-time error.
 */
describe('structurally-global contributions under "scope": "project"', () => {
  // `capabilities` covers the agents sample's `agent:register` requirement so
  // the assertion below is about the scope rule and not a second, unrelated
  // issue on the same path.
  const parseGroup = (group: UnscopedGroup, entries: unknown[]) =>
    parse("project", {
      scope: "project",
      capabilities: ["agent:register"],
      contributes: { [group]: entries },
    });

  it.each(UNSCOPED_GROUPS)("rejects contributes.%s from a project plugin", (group) => {
    const result = parseGroup(group, UNSCOPED_SAMPLES[group]);
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain(`${group}_project_scope_forbidden`);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === `contributes.${group}`)).toBe(
        true
      );
    }
  });

  it.each(UNSCOPED_GROUPS)(
    "names the structural reason rather than restating the rule for %s",
    (group) => {
      const message =
        messageForCode(
          parseGroup(group, UNSCOPED_SAMPLES[group]),
          `${group}_project_scope_forbidden`
        ) ?? "";
      // The house style the forge rule set: say WHY it cannot be scoped yet.
      expect(message).toContain(`contributes.${group}`);
      // Something past the em-dash — the reason clause, not just the rule.
      const reason = message.split("—")[1]?.trim() ?? "";
      expect(reason.length).toBeGreaterThan(40);
    }
  );

  it.each(UNSCOPED_GROUPS)("accepts an empty contributes.%s array", (group) => {
    const result = parseGroup(group, []);
    expect(result.success).toBe(true);
  });

  it.each(UNSCOPED_GROUPS)("still accepts contributes.%s from an installed plugin", (group) => {
    const result = parse("user", {
      capabilities: ["agent:register"],
      contributes: { [group]: UNSCOPED_SAMPLES[group] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects every group at once rather than stopping at the first", () => {
    const contributes: Record<string, unknown> = {};
    for (const group of UNSCOPED_GROUPS) contributes[group] = UNSCOPED_SAMPLES[group];
    const codes = errorCodes(
      parse("project", { scope: "project", capabilities: ["agent:register"], contributes })
    );
    for (const group of UNSCOPED_GROUPS) {
      expect(codes).toContain(`${group}_project_scope_forbidden`);
    }
  });

  it("is not slipped by the deprecated-alias preprocess", () => {
    // `contributes` is wrapped in a preprocess that rewrites `experimental_*`.
    // A manifest taking that branch must still hit the scope rule.
    const codes = errorCodes(
      parse("project", {
        scope: "project",
        contributes: { experimental_mcpServers: UNSCOPED_SAMPLES.mcpServers },
      })
    );
    expect(codes).toContain("mcpServers_project_scope_forbidden");
  });

  it("keeps the scoped contribution groups available to a project plugin", () => {
    // The complement of the rule: what the broadcaster DOES narrow to the
    // owning project stays declarable, or project plugins would be useless.
    const result = parse("project", {
      scope: "project",
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "puzzle", color: "#ffffff" }],
        views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }],
        commands: [
          {
            id: "go",
            title: "Go",
            description: "Go",
            category: "Acme",
            kind: "command",
            danger: "safe",
          },
        ],
        toolbarButtons: [
          { id: "btn", label: "Go", iconId: "sparkles", actionId: "acme.project-plugin.go" },
        ],
        keybindings: [{ actionId: "acme.project-plugin.go", combo: "Ctrl+Alt+G" }],
        contextMenus: [{ label: "Go", actionId: "acme.project-plugin.go", location: "terminal" }],
        settings: [{ id: "token", type: "string", label: "Token" }],
      },
    });
    expect(result.success).toBe(true);
  });
});

/**
 * `contributes.surfaces` (§7.8). A surface claim replaces one project's own
 * chrome, so it is available to project plugins alone, and it must name a view
 * the same manifest actually ships.
 */
describe("contributes.surfaces", () => {
  const panel = { id: "overview", name: "Overview", iconId: "puzzle", color: "#ffffff" };
  const view = { id: "overview", componentPath: "dist/overview.js", location: "panel" as const };

  const withSurface = (surfaces: unknown, extra: Record<string, unknown> = {}) => ({
    scope: "project",
    contributes: { panels: [panel], views: [view], surfaces, ...extra },
  });

  it("accepts an emptyCanvas claim naming a declared view", () => {
    const result = parse("project", withSurface({ emptyCanvas: { viewId: "overview" } }));
    expect(result.success).toBe(true);
  });

  it("rejects an emptyCanvas viewId matching no declared view", () => {
    const result = parse("project", withSurface({ emptyCanvas: { viewId: "nope" } }));
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("surface_view_ref_unknown");
    expect(messageForCode(result, "surface_view_ref_unknown")).toContain("contributes.views");
  });

  it.each(["builtin", "user"] as const)("rejects a surface claim from %s origin", (origin) => {
    const result = getPluginManifestSchema(origin).safeParse({
      name: "acme.installed",
      version: "1.0.0",
      contributes: {
        panels: [panel],
        views: [view],
        surfaces: { emptyCanvas: { viewId: "overview" } },
      },
    });
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("surfaces_project_scope_only");
  });

  it("names the locality reason rather than restating the rule", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.installed",
      version: "1.0.0",
      contributes: {
        panels: [panel],
        views: [view],
        surfaces: { emptyCanvas: { viewId: "overview" } },
      },
    });
    const message = messageForCode(result, "surfaces_project_scope_only") ?? "";
    expect(message).toMatch(/bound to no project|no project/i);
  });

  it("accepts an empty surfaces object from an installed plugin", () => {
    // An empty claim set is not a claim. Rejecting it would break any manifest
    // that writes the key defensively, and there is nothing to arbitrate.
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.installed",
      version: "1.0.0",
      contributes: { surfaces: {} },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an explicit undefined slot as a claim from an installed plugin", () => {
    // `{ emptyCanvas: undefined }` takes the optional branch and must read as
    // absent, not as a claim — the gate filters on the VALUE, not the key.
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.installed",
      version: "1.0.0",
      contributes: { surfaces: { emptyCanvas: undefined } },
    });
    expect(result.success).toBe(true);
  });

  it("materializes an empty surfaces object when the key is absent", () => {
    const result = parse("project", { scope: "project" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contributes.surfaces).toEqual({});
  });

  it("rejects an unknown surface slot", () => {
    // The three-slot design is a closed set: a typo (or a slot from a later
    // phase) must fail loudly rather than validate and never render.
    const result = parse("project", withSurface({ projectHome: { viewId: "overview" } }));
    expect(result.success).toBe(false);
  });

  it("rejects a claim on a PTY panel", () => {
    // TerminalPane renders a PTY panel and the matching view module is never
    // loaded, so the claim would hold the project's only empty-canvas slot
    // against every other plugin and draw nothing.
    const result = parse("project", {
      scope: "project",
      contributes: {
        panels: [{ ...panel, hasPty: true }],
        views: [view],
        surfaces: { emptyCanvas: { viewId: "overview" } },
      },
    });
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("surface_view_ref_pty");
    expect(messageForCode(result, "surface_view_ref_pty")).toContain("hasPty");
  });

  it("caps the slot's viewId to the shared safe-id grammar", () => {
    const result = parse("project", withSurface({ emptyCanvas: { viewId: "over view!" } }));
    expect(result.success).toBe(false);
  });
});
