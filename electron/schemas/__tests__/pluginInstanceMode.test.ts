import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";

const base = { name: "acme.ledger", version: "1.0.0" };

function errorCodes(origin: "builtin" | "user" | "project", manifest: Record<string, unknown>) {
  const result = getPluginManifestSchema(origin).safeParse(manifest);
  if (result.success) return [];
  return result.error.issues.map(
    (i) => (i as unknown as { params?: { errorCode?: string } }).params?.errorCode
  );
}

describe("manifest instanceMode (#14103)", () => {
  it("parses a legacy manifest with no instanceMode key materialized", () => {
    const result = getPluginManifestSchema("user").safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect("instanceMode" in result.data).toBe(false);
  });

  it("accepts the opt-in on an installed package", () => {
    expect(errorCodes("user", { ...base, instanceMode: "project" })).toEqual([]);
  });

  it("rejects the opt-in outside the installed origin", () => {
    expect(errorCodes("builtin", { ...base, instanceMode: "project" })).toContain(
      "instance_mode_installed_only"
    );
    expect(errorCodes("project", { ...base, scope: "project", instanceMode: "project" })).toContain(
      "instance_mode_installed_only"
    );
  });

  it("rejects combining the opt-in with project-local scope", () => {
    expect(errorCodes("user", { ...base, scope: "project", instanceMode: "project" })).toContain(
      "instance_mode_scope_conflict"
    );
  });

  const projectDb = {
    contributes: { databases: [{ id: "main", location: "project" }] },
    capabilities: ["fs:project-write"],
  };

  it("allows a project database only for an instanced package", () => {
    expect(errorCodes("user", { ...base, ...projectDb })).toContain("database_project_scope_only");
    expect(errorCodes("user", { ...base, ...projectDb, instanceMode: "project" })).not.toContain(
      "database_project_scope_only"
    );
  });

  it("applies the project-runtime contribution restrictions to an instanced package", () => {
    const codes = errorCodes("user", {
      ...base,
      instanceMode: "project",
      contributes: {
        projectTemplates: [{ id: "static-site", title: "Static site", description: "A site." }],
      },
    });
    expect(codes).toContain("projectTemplates_project_scope_forbidden");
  });
});
