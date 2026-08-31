import { describe, expect, it } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";

const schema = getPluginManifestSchema("user");

function manifestWithSkills(skills: unknown, extra?: Record<string, unknown>) {
  return schema.safeParse({
    name: "acme.skills-plugin",
    version: "1.0.0",
    contributes: { skills },
    ...extra,
  });
}

function errorCodes(result: ReturnType<typeof schema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues
    .map((i) => (i as { params?: { errorCode?: string } }).params?.errorCode)
    .filter((c): c is string => typeof c === "string");
}

describe("contributes.skills schema (#10892)", () => {
  it("accepts a valid skill and defaults triggers/other contributions", () => {
    const result = manifestWithSkills([
      { id: "tdd-workflow", name: "TDD Workflow", path: "./skills/tdd.md", triggers: ["tdd"] },
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contributes.skills).toHaveLength(1);
      // Sibling contribution arrays still default to empty.
      expect(result.data.contributes.panels).toEqual([]);
    }
  });

  it("requires no capability (skills are inert declarative content)", () => {
    const result = manifestWithSkills([{ id: "s", name: "S", path: "./skills/s.md" }], {
      capabilities: [],
    });
    expect(result.success).toBe(true);
  });

  it("makes triggers optional", () => {
    const result = manifestWithSkills([{ id: "s", name: "S", path: "./skills/s.md" }]);
    expect(result.success).toBe(true);
  });

  it("rejects a duplicate skill id at the second occurrence", () => {
    const result = manifestWithSkills([
      { id: "dup", name: "One", path: "./skills/a.md" },
      { id: "dup", name: "Two", path: "./skills/b.md" },
    ]);
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("duplicate_contribution_id");
  });

  it("caps the skills array", () => {
    const many = Array.from({ length: MANIFEST_CONTRIBUTION_CAPS.skills + 1 }, (_v, i) => ({
      id: `s${i}`,
      name: `S${i}`,
      path: `./skills/s${i}.md`,
    }));
    expect(manifestWithSkills(many).success).toBe(false);
    const atCap = many.slice(0, MANIFEST_CONTRIBUTION_CAPS.skills);
    expect(manifestWithSkills(atCap).success).toBe(true);
  });

  it("rejects a malformed id", () => {
    expect(manifestWithSkills([{ id: "bad id!", name: "S", path: "./skills/s.md" }]).success).toBe(
      false
    );
  });

  describe("path traversal guard", () => {
    const cases: Array<[string, string]> = [
      ["absolute path", "/etc/passwd"],
      ["parent traversal", "../../secret.md"],
      ["backslash", ".\\skills\\s.md"],
      ["embedded URL scheme", "https://evil.test/s.md"],
      ["query string", "./skills/s.md?x=1"],
      ["fragment", "./skills/s.md#frag"],
      ["bare dot", "."],
    ];
    for (const [label, badPath] of cases) {
      it(`rejects ${label}`, () => {
        const result = manifestWithSkills([{ id: "s", name: "S", path: badPath }]);
        expect(result.success).toBe(false);
      });
    }

    it("accepts a normal relative POSIX path", () => {
      expect(manifestWithSkills([{ id: "s", name: "S", path: "./skills/s.md" }]).success).toBe(
        true
      );
      expect(manifestWithSkills([{ id: "s", name: "S", path: "skills/s.md" }]).success).toBe(true);
    });
  });

  it("rejects unknown fields (strict object)", () => {
    const result = manifestWithSkills([
      { id: "s", name: "S", path: "./skills/s.md", extra: "nope" },
    ]);
    expect(result.success).toBe(false);
  });
});
