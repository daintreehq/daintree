import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findUnusablePluginAssets } from "../pluginManifestAssetFiles.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-asset-files-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content = "x"): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content, "utf8");
}

function knowledge(instructions: string, skillPath?: string) {
  return {
    contributes: {
      assistantKnowledge: {
        instructions,
        ...(skillPath ? { skills: [{ id: "deploy", path: skillPath }] } : {}),
      },
    },
  };
}

describe("findUnusablePluginAssets", () => {
  it("accepts a file inside a directory whose name merely starts with ..", async () => {
    await write("..assets/notes.md");
    expect(await findUnusablePluginAssets(dir, knowledge("..assets/notes.md"))).toEqual([]);
  });

  it("accepts a relative link that stays inside the plugin", async () => {
    await write("docs/actual.md");
    await fs.symlink("docs/actual.md", path.join(dir, "notes.md"));
    expect(await findUnusablePluginAssets(dir, knowledge("notes.md"))).toEqual([]);
  });

  it("refuses a link that leaves the plugin, a directory, and a missing file", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-asset-outside-"));
    try {
      await fs.writeFile(path.join(outside, "notes.md"), "x", "utf8");
      await fs.symlink(path.join(outside, "notes.md"), path.join(dir, "notes.md"));
      await fs.mkdir(path.join(dir, "skills", "deploy", "SKILL.md"), { recursive: true });

      expect(await findUnusablePluginAssets(dir, knowledge("notes.md", "skills/deploy"))).toEqual([
        'assistantKnowledge.instructions "notes.md" resolves outside the plugin directory',
        'assistantKnowledge.skills[0].path "skills/deploy" (expected skills/deploy/SKILL.md) is not a file',
      ]);
      expect(await findUnusablePluginAssets(dir, knowledge("absent.md"))).toEqual([
        'assistantKnowledge.instructions "absent.md" is missing from the plugin',
      ]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a SKILL.md spelled in another case, which the knowledge reader can't find", async () => {
    await write("notes.md");
    await write("skills/deploy/skill.md");
    const problems = await findUnusablePluginAssets(dir, knowledge("notes.md", "skills/deploy"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/skills\/deploy\/SKILL\.md\) is missing from the plugin/);
  });

  it("skips optional narration", async () => {
    await write("dist/tour.js");
    const manifest = {
      contributes: {
        tours: [{ componentPath: "dist/tour.js", chapters: [{ audioUrl: "tours/intro.ogg" }] }],
      },
    };
    expect(await findUnusablePluginAssets(dir, manifest)).toEqual([]);
  });
});
