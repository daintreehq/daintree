import { describe, it, expect } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
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
