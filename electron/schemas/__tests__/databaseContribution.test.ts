import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";

function projectManifest(overrides: Record<string, unknown>) {
  return { name: "acme.ledger", version: "1.0.0", scope: "project", ...overrides };
}

function errorCodes(result: { success: boolean; error?: { issues: unknown[] } }): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? "zod"
  );
}

const parseProject = (manifest: unknown) => getPluginManifestSchema("project").safeParse(manifest);

describe("contributes.databases", () => {
  it("defaults each entry to a project database in delete journal mode", () => {
    const result = parseProject(
      projectManifest({
        capabilities: ["fs:project-write"],
        contributes: { databases: [{ id: "ledger" }] },
      })
    );
    expect(result.success && result.data.contributes.databases).toEqual([
      { id: "ledger", location: "project", journalMode: "delete" },
    ]);
  });

  it("requires fs:project-write for a project database", () => {
    const result = parseProject(
      projectManifest({ contributes: { databases: [{ id: "ledger" }] } })
    );
    expect(errorCodes(result)).toContain("database_project_write_required");
  });

  it("allows a local database with no capability", () => {
    const result = parseProject(
      projectManifest({ contributes: { databases: [{ id: "cache", location: "local" }] } })
    );
    expect(result.success).toBe(true);
  });

  it("refuses a project database on an installed plugin", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.ledger",
      version: "1.0.0",
      capabilities: ["fs:project-write"],
      contributes: { databases: [{ id: "ledger" }] },
    });
    expect(errorCodes(result)).toContain("database_project_scope_only");
  });

  it("refuses a path on a local database", () => {
    const result = parseProject(
      projectManifest({
        contributes: { databases: [{ id: "cache", location: "local", path: "data/x.db" }] },
      })
    );
    expect(errorCodes(result)).toContain("database_local_path_unsupported");
  });

  it.each([
    ["/abs/finance.db"],
    ["../outside.db"],
    ["data/finance.json"],
    [".git/finance.db"],
    ["sub/.git/finance.db"],
  ])("rejects the path %s", (badPath) => {
    const result = parseProject(
      projectManifest({
        capabilities: ["fs:project-write"],
        contributes: { databases: [{ id: "ledger", path: badPath }] },
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects duplicate ids and unknown fields", () => {
    const duplicate = parseProject(
      projectManifest({
        capabilities: ["fs:project-write"],
        contributes: { databases: [{ id: "a" }, { id: "a" }] },
      })
    );
    expect(duplicate.success).toBe(false);
    const unknownField = parseProject(
      projectManifest({
        capabilities: ["fs:project-write"],
        contributes: { databases: [{ id: "a", url: "libsql://x" }] },
      })
    );
    expect(unknownField.success).toBe(false);
  });
});
