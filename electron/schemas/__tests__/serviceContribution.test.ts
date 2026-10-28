import { describe, expect, it } from "vitest";
import {
  getPluginManifestSchema,
  MANIFEST_SERVICE_METHODS_CAP,
  MANIFEST_SERVICE_PROVIDES_CAP,
  MANIFEST_SERVICE_REQUIRES_CAP,
} from "../plugin.js";

function parse(services: unknown, name = "acme.jira") {
  return getPluginManifestSchema("user").safeParse({
    name,
    version: "1.0.0",
    contributes: { services },
  });
}

function issuesOf(services: unknown, name?: string): string[] {
  const result = parse(services, name);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

const provide = (extra: Record<string, unknown> = {}) => ({
  name: "acme.jira.issues",
  version: "1.2.0",
  methods: ["lookup"],
  ...extra,
});

const importOf = (extra: Record<string, unknown> = {}) => ({
  name: "acme.git.repo",
  range: "^1.0.0",
  ...extra,
});

describe("contributes.services (#14105)", () => {
  it("defaults to no exports and no imports", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.jira",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.services).toEqual({ provides: [], requires: [] });
    // A fresh object per parse, so one manifest can't share another's arrays.
    const again = getPluginManifestSchema("user").parse({ name: "acme.jira", version: "1.0.0" });
    expect(again.contributes.services.provides).not.toBe(result.data.contributes.services.provides);
  });

  it("accepts a provided service and an optional import", () => {
    const result = parse({ provides: [provide()], requires: [importOf({ optional: true })] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.services.requires[0].optional).toBe(true);
  });

  it("only lets a plugin provide services under its own id", () => {
    expect(issuesOf({ provides: [provide({ name: "acme.git.issues" })] })).toEqual([
      expect.stringContaining('must start with "acme.jira."'),
    ]);
    // A prefix of the id is not the id.
    expect(issuesOf({ provides: [provide({ name: "acme.jira.issues" })] }, "acme.jir")).not.toEqual(
      []
    );
  });

  it("refuses an import of the plugin's own service", () => {
    expect(issuesOf({ requires: [importOf({ name: "acme.jira.issues" })] })).toEqual([
      expect.stringContaining("can't import its own"),
    ]);
  });

  it.each([
    ["a bare manifest id", "acme.jira"],
    ["upper case", "acme.jira.Issues"],
    ["a trailing dot", "acme.jira.issues."],
    ["an extra segment", "acme.jira.issues.v2"],
  ])("rejects a service name with %s", (_label, name) => {
    expect(parse({ requires: [importOf({ name })] }).success).toBe(false);
  });

  it("holds versions to strict semver and ranges to valid semver ranges", () => {
    expect(parse({ provides: [provide({ version: "v1.2.0" })] }).success).toBe(false);
    expect(parse({ provides: [provide({ version: "1.2" })] }).success).toBe(false);
    expect(parse({ provides: [provide({ version: "1.2.0-beta.1" })] }).success).toBe(true);
    expect(parse({ requires: [importOf({ range: "not a range" })] }).success).toBe(false);
    expect(parse({ requires: [importOf({ range: ">=1.2.0 <3" })] }).success).toBe(true);
  });

  it("requires at least one method, each named like an identifier and listed once", () => {
    expect(parse({ provides: [provide({ methods: [] })] }).success).toBe(false);
    expect(parse({ provides: [provide({ methods: ["__proto__"] })] }).success).toBe(false);
    expect(parse({ provides: [provide({ methods: ["get-issue"] })] }).success).toBe(false);
    expect(parse({ provides: [provide({ methods: ["lookup", "lookup"] })] }).success).toBe(false);
  });

  it("rejects a repeated service name in either list", () => {
    expect(parse({ provides: [provide(), provide({ version: "2.0.0" })] }).success).toBe(false);
    expect(parse({ requires: [importOf(), importOf({ range: "^2.0.0" })] }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(parse({ provides: [], requires: [], events: [] }).success).toBe(false);
    expect(parse({ provides: [provide({ description: "x" })] }).success).toBe(false);
    expect(parse({ requires: [importOf({ install: true })] }).success).toBe(false);
  });

  it("caps every list", () => {
    const provides = Array.from({ length: MANIFEST_SERVICE_PROVIDES_CAP + 1 }, (_, i) =>
      provide({ name: `acme.jira.svc${i}` })
    );
    expect(parse({ provides }).success).toBe(false);
    expect(parse({ provides: provides.slice(0, -1) }).success).toBe(true);

    const requires = Array.from({ length: MANIFEST_SERVICE_REQUIRES_CAP + 1 }, (_, i) =>
      importOf({ name: `acme.git.svc${i}` })
    );
    expect(parse({ requires }).success).toBe(false);
    expect(parse({ requires: requires.slice(0, -1) }).success).toBe(true);

    const methods = Array.from({ length: MANIFEST_SERVICE_METHODS_CAP + 1 }, (_, i) => `m${i}`);
    expect(parse({ provides: [provide({ methods })] }).success).toBe(false);
    expect(parse({ provides: [provide({ methods: methods.slice(0, -1) })] }).success).toBe(true);
  });
});
