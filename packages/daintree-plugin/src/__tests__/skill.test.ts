import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSkillAdd } from "../commands/skill.js";
import { loadBundledSkill } from "../skills.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-skill-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeManifest(manifest: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(tmpDir, "plugin.json"), JSON.stringify(manifest), "utf8");
}

const SKILL_MD = ".claude/skills/daintree-tour/SKILL.md";

describe("bundled daintree-tour skill", () => {
  it("has the frontmatter Claude Code indexes", async () => {
    const files = await loadBundledSkill("daintree-tour");
    const skill = files[SKILL_MD];
    expect(skill).toBeDefined();
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill!)?.[1];
    expect(frontmatter).toBeDefined();
    const lines = frontmatter!.split("\n");
    expect(lines).toContain("name: daintree-tour");
    const description = lines.find((line) => line.startsWith("description: "));
    expect(description).toBeDefined();
    // Claude Code truncates longer descriptions in the skill listing.
    expect(description!.length).toBeLessThanOrEqual(1024);
  });

  it("only links to reference files it ships", async () => {
    const files = await loadBundledSkill("daintree-tour");
    const shipped = new Set(Object.keys(files));
    const referenced = new Set<string>();
    for (const content of Object.values(files)) {
      for (const match of content.matchAll(/`(references\/[a-z0-9-]+\.md)`/g)) {
        referenced.add(`.claude/skills/daintree-tour/${match[1]}`);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const ref of referenced) expect(shipped).toContain(ref);
  });

  it("names only CLI flags the tour commands define", async () => {
    const files = await loadBundledSkill("daintree-tour");
    const cli = await fs.readFile(path.join(import.meta.dirname, "..", "cli.ts"), "utf8");
    // Each command's own options: from its `.command("x")` to the next one.
    const optionsOf = (command: string): Set<string> => {
      const start = cli.indexOf(`.command("${command}")`);
      const end = cli.indexOf(".command(", start + 1);
      const body = cli.slice(start, end === -1 ? undefined : end);
      return new Set([...body.matchAll(/"(--[a-z-]+)[ "<]/g)].map((m) => m[1]!));
    };
    let checked = 0;
    for (const content of Object.values(files)) {
      for (const match of content.matchAll(
        /daintree-plugin (?:tour )?(voice|align|preview|validate|package)([^`\n]*)/g
      )) {
        const defined = optionsOf(match[1]!);
        for (const flag of match[2]!.matchAll(/(--[a-z-]+)/g)) {
          expect(defined, `flag ${flag[1]} in "${match[0]}"`).toContain(flag[1]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("runSkillAdd", () => {
  it("installs the skill into a plugin", async () => {
    await writeManifest({ name: "acme.site" });
    const result = await runSkillAdd("daintree-tour", { dir: tmpDir });

    const bundled = await loadBundledSkill("daintree-tour");
    expect(result.written).toEqual(Object.keys(bundled).sort());
    expect(result.unchanged).toEqual([]);
    expect(result.installDir).toBe(path.join(tmpDir, ".claude", "skills", "daintree-tour"));
    for (const [rel, content] of Object.entries(bundled)) {
      expect(await fs.readFile(path.join(tmpDir, rel), "utf8")).toBe(content);
    }
  });

  it("is a no-op when the installed copy is already current", async () => {
    await writeManifest({ name: "acme.site" });
    await runSkillAdd("daintree-tour", { dir: tmpDir });
    const again = await runSkillAdd("daintree-tour", { dir: tmpDir });
    expect(again.written).toEqual([]);
    expect(again.unchanged).toContain(SKILL_MD);
  });

  it("refuses to overwrite an edited file, and writes nothing at all", async () => {
    await writeManifest({ name: "acme.site" });
    await fs.mkdir(path.join(tmpDir, ".claude", "skills", "daintree-tour"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, SKILL_MD), "my own notes\n", "utf8");

    await expect(runSkillAdd("daintree-tour", { dir: tmpDir })).rejects.toThrow(
      /differ from the bundled skill[\s\S]*SKILL\.md[\s\S]*--force/
    );
    expect(await fs.readFile(path.join(tmpDir, SKILL_MD), "utf8")).toBe("my own notes\n");
    await expect(
      fs.access(path.join(tmpDir, ".claude", "skills", "daintree-tour", "references"))
    ).rejects.toThrow();
  });

  it("replaces differing files with --force and keeps files the bundle doesn't ship", async () => {
    await writeManifest({ name: "acme.site" });
    const skillDir = path.join(tmpDir, ".claude", "skills", "daintree-tour");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, SKILL_MD), "old copy\n", "utf8");
    await fs.writeFile(path.join(skillDir, "local-notes.md"), "keep me\n", "utf8");

    const result = await runSkillAdd("daintree-tour", { dir: tmpDir, force: true });
    expect(result.written).toContain(SKILL_MD);
    const bundled = await loadBundledSkill("daintree-tour");
    expect(await fs.readFile(path.join(tmpDir, SKILL_MD), "utf8")).toBe(bundled[SKILL_MD]);
    expect(await fs.readFile(path.join(skillDir, "local-notes.md"), "utf8")).toBe("keep me\n");
  });

  it("refuses a project plugin, which can't contribute tours", async () => {
    await writeManifest({ name: "acme.site", scope: "project" });
    await expect(runSkillAdd("daintree-tour", { dir: tmpDir })).rejects.toThrow(/project plugin/);
    await expect(fs.access(path.join(tmpDir, ".claude"))).rejects.toThrow();
  });

  it("needs a plugin directory", async () => {
    await expect(runSkillAdd("daintree-tour", { dir: tmpDir })).rejects.toThrow(
      /No plugin\.json in .*run this from the plugin's directory/
    );
    await fs.writeFile(path.join(tmpDir, "plugin.json"), "{ nope", "utf8");
    await expect(runSkillAdd("daintree-tour", { dir: tmpDir })).rejects.toThrow(
      "plugin.json is not valid JSON"
    );
    await fs.writeFile(path.join(tmpDir, "plugin.json"), "[]", "utf8");
    await expect(runSkillAdd("daintree-tour", { dir: tmpDir })).rejects.toThrow(
      "plugin.json must be a JSON object"
    );
  });

  it("names the skills it has when asked for one it doesn't", async () => {
    await writeManifest({ name: "acme.site" });
    await expect(runSkillAdd("nope", { dir: tmpDir })).rejects.toThrow(
      'No bundled skill "nope"; available: daintree-tour'
    );
  });

  it.skipIf(process.platform === "win32")(
    "won't write through a symlinked .claude folder",
    async () => {
      await writeManifest({ name: "acme.site" });
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-skill-outside-"));
      try {
        await fs.symlink(outside, path.join(tmpDir, ".claude"));
        await expect(runSkillAdd("daintree-tour", { dir: tmpDir })).rejects.toThrow(
          ".claude is a symlink"
        );
        expect(await fs.readdir(outside)).toEqual([]);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    }
  );

  it("refuses a bundle without its SKILL.md rather than reporting it up to date", async () => {
    await writeManifest({ name: "acme.site" });
    const skillsRoot = path.join(tmpDir, "bundle");
    await fs.mkdir(path.join(skillsRoot, "daintree-tour"), { recursive: true });
    await expect(runSkillAdd("daintree-tour", { dir: tmpDir, skillsRoot })).rejects.toThrow(
      /has no SKILL\.md/
    );
  });

  it("reports a bundle missing from the install", async () => {
    await writeManifest({ name: "acme.site" });
    await expect(
      runSkillAdd("daintree-tour", { dir: tmpDir, skillsRoot: path.join(tmpDir, "absent") })
    ).rejects.toThrow(/bundled "daintree-tour" skill is missing/);
  });
});
