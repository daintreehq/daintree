import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getPluginManifestSchema } from "../plugin.js";

/**
 * The project-local fixture and the origin gate were authored separately, so
 * nothing else proves they agree. Discovery tests load this manifest from disk;
 * if the gate ever stops accepting it the failure would otherwise surface as a
 * confusing "plugin not found" rather than a schema mismatch.
 */
const FIXTURE = path.join(
  "plugins",
  "fixtures",
  "project-local",
  ".daintree",
  "plugins",
  "acme.project-hello",
  "plugin.json"
);

describe("the project-local fixture manifest", () => {
  const manifest: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));

  it("parses under the project origin", () => {
    const result = getPluginManifestSchema("project").safeParse(manifest);
    expect(result.success ? null : result.error.issues).toBe(null);
  });

  it.each(["user", "builtin"] as const)("is rejected under the %s origin", (origin) => {
    // `scope: "project"` is what closes this direction — a project plugin must
    // not be installable as a .dntr or shipped as a builtin.
    expect(getPluginManifestSchema(origin).safeParse(manifest).success).toBe(false);
  });
});
