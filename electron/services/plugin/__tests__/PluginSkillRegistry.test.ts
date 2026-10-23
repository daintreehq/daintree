import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  parseSkillMarkdown,
  registerPluginSkills,
  unregisterPluginSkills,
  clearPluginSkillRegistry,
  hasPluginSkills,
  searchPluginSkills,
  loadPluginSkill,
  type SkillVisibility,
} from "../PluginSkillRegistry.js";
import { makeProjectPluginInstanceKey } from "../../../../shared/types/plugin.js";

const NO_PROJECT: SkillVisibility = { projectId: null };

const SKILL_BODY = "# TDD Workflow\n\nWrite a failing test first.\n";
const SKILL_FILE = `---\ndescription: Step-by-step test-driven development.\napplies_to:\n  - language: typescript\n---\n\n${SKILL_BODY}`;

describe("parseSkillMarkdown", () => {
  it("splits frontmatter description from the body", () => {
    const { description, body } = parseSkillMarkdown(SKILL_FILE);
    expect(description).toBe("Step-by-step test-driven development.");
    // The body excludes the frontmatter delimiters.
    expect(body).toBe(SKILL_BODY);
    expect(body).not.toContain("---");
  });

  it("treats a file with no frontmatter as all body", () => {
    const raw = "# Just a heading\n\nNo frontmatter here.";
    const { description, body } = parseSkillMarkdown(raw);
    expect(description).toBeNull();
    expect(body).toBe(raw);
  });

  it("degrades to null description on malformed YAML without dropping the body", () => {
    const raw = "---\ndescription: : : not valid\n\tbad indent\n---\n\nBody survives.";
    const { description, body } = parseSkillMarkdown(raw);
    expect(description).toBeNull();
    expect(body).toBe("Body survives.");
  });

  it("ignores a non-string description", () => {
    const raw = "---\ndescription:\n  nested: object\n---\n\nBody.";
    const { description } = parseSkillMarkdown(raw);
    expect(description).toBeNull();
  });

  it("treats empty frontmatter as no description and keeps the body clean", () => {
    const { description, body } = parseSkillMarkdown("---\n---\n\n# Body\n");
    expect(description).toBeNull();
    expect(body).toBe("# Body\n");
    expect(body).not.toContain("---");
  });

  it("resolves YAML merge keys so a description inherited via an anchor survives", () => {
    const raw = "---\nshared: &shared\n  description: Inherited.\n<<: *shared\n---\n\nBody.\n";
    const { description } = parseSkillMarkdown(raw);
    expect(description).toBe("Inherited.");
  });

  it("does not treat a --- line inside the body as the closing fence", () => {
    const raw = "---\ndescription: Real.\n---\n\nIntro.\n\n---\n\nMore.\n";
    const { description, body } = parseSkillMarkdown(raw);
    expect(description).toBe("Real.");
    // The body's own horizontal rule survives — only the first fenced block is frontmatter.
    expect(body).toBe("Intro.\n\n---\n\nMore.\n");
  });

  it("degrades to whole-file body when the closing fence is not a full line", () => {
    // `---notclose` must NOT be accepted as a closing fence.
    const raw = "---\ndescription: x\n---notclose\nBody.";
    const { description, body } = parseSkillMarkdown(raw);
    expect(description).toBeNull();
    expect(body).toBe(raw);
  });

  it("handles CRLF frontmatter delimiters and a leading BOM", () => {
    const raw = "﻿---\r\ndescription: Windows line endings.\r\n---\r\n\r\nBody line.\r\n";
    const { description, body } = parseSkillMarkdown(raw);
    expect(description).toBe("Windows line endings.");
    expect(body).toContain("Body line.");
    expect(body).not.toContain("---");
  });
});

describe("PluginSkillRegistry", () => {
  let dir: string;

  beforeEach(async () => {
    clearPluginSkillRegistry();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-reg-"));
    await fs.mkdir(path.join(dir, "skills"), { recursive: true });
    await fs.writeFile(path.join(dir, "skills", "tdd.md"), SKILL_FILE, "utf8");
  });

  afterEach(async () => {
    clearPluginSkillRegistry();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("registers a skill under its {pluginId}.{skillId} id and loads its body", async () => {
    await registerPluginSkills("acme.plugin", dir, [
      { id: "tdd-workflow", name: "TDD Workflow", path: "./skills/tdd.md", triggers: ["tdd"] },
    ]);

    const loaded = loadPluginSkill("acme.plugin.tdd-workflow", NO_PROJECT);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe("acme.plugin.tdd-workflow");
    expect(loaded?.name).toBe("TDD Workflow");
    expect(loaded?.description).toBe("Step-by-step test-driven development.");
    expect(loaded?.body).toBe(SKILL_BODY);
  });

  it("skips a skill whose file is missing without throwing", async () => {
    await registerPluginSkills("acme.plugin", dir, [
      { id: "present", name: "Present", path: "./skills/tdd.md" },
      { id: "missing", name: "Missing", path: "./skills/nope.md" },
    ]);
    expect(loadPluginSkill("acme.plugin.present", NO_PROJECT)).not.toBeNull();
    expect(loadPluginSkill("acme.plugin.missing", NO_PROJECT)).toBeNull();
  });

  it("rejects a skill whose path escapes the plugin dir via symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skill-outside-"));
    await fs.writeFile(path.join(outside, "secret.md"), "leaked", "utf8");
    // A symlink inside the plugin dir pointing outside it — the lexical path
    // grammar passes, but read-time realpath containment must reject it.
    try {
      await fs.symlink(path.join(outside, "secret.md"), path.join(dir, "skills", "link.md"));
    } catch (err) {
      // Windows CI without symlink privilege (EPERM) — the containment guard is
      // covered by the realpath logic; skip where symlinks can't be created.
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        await fs.rm(outside, { recursive: true, force: true });
        return;
      }
      throw err;
    }
    await registerPluginSkills("acme.plugin", dir, [
      { id: "escape", name: "Escape", path: "./skills/link.md" },
    ]);
    expect(loadPluginSkill("acme.plugin.escape", NO_PROJECT)).toBeNull();
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("skips a skill whose path is not a regular file", async () => {
    // Point the skill at the skills/ directory itself — stat reports a non-file.
    await registerPluginSkills("acme.plugin", dir, [
      { id: "notfile", name: "Not A File", path: "./skills" },
    ]);
    expect(loadPluginSkill("acme.plugin.notfile", NO_PROJECT)).toBeNull();
  });

  it("skips a skill whose file exceeds the size cap without throwing", async () => {
    // 600KB > the 512KB cap.
    await fs.writeFile(path.join(dir, "skills", "huge.md"), "x".repeat(600 * 1024), "utf8");
    await registerPluginSkills("acme.plugin", dir, [
      { id: "present", name: "Present", path: "./skills/tdd.md" },
      { id: "huge", name: "Huge", path: "./skills/huge.md" },
    ]);
    expect(loadPluginSkill("acme.plugin.present", NO_PROJECT)).not.toBeNull();
    expect(loadPluginSkill("acme.plugin.huge", NO_PROJECT)).toBeNull();
  });

  describe("search", () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(dir, "skills", "review.md"),
        "---\ndescription: Code review rubric.\n---\n\n# Review\n",
        "utf8"
      );
      await registerPluginSkills("acme.plugin", dir, [
        {
          id: "tdd-workflow",
          name: "TDD Workflow",
          path: "./skills/tdd.md",
          triggers: ["test-driven", "red-green-refactor"],
        },
        { id: "code-review", name: "Code Review", path: "./skills/review.md" },
      ]);
    });

    it("matches on triggers and name via token overlap", () => {
      const { skills } = searchPluginSkills({ query: "tdd" }, NO_PROJECT);
      expect(skills.map((s) => s.id)).toContain("acme.plugin.tdd-workflow");
      expect(skills.map((s) => s.id)).not.toContain("acme.plugin.code-review");
    });

    it("matches on description tokens", () => {
      const { skills } = searchPluginSkills({ query: "rubric" }, NO_PROJECT);
      expect(skills.map((s) => s.id)).toEqual(["acme.plugin.code-review"]);
    });

    it("returns no matches for an unrelated query", () => {
      expect(searchPluginSkills({ query: "kubernetes helm chart" }, NO_PROJECT).skills).toEqual([]);
    });

    it("lists all skills for an empty query, bounded by limit", () => {
      const all = searchPluginSkills({ query: "" }, NO_PROJECT);
      expect(all.skills.length).toBe(2);
      const limited = searchPluginSkills({ query: "", limit: 1 }, NO_PROJECT);
      expect(limited.skills.length).toBe(1);
    });

    it("clamps the limit into [1, 50] and floors a fractional value", () => {
      // Fractional floors to 1; a huge value is capped by the registry (2 skills here).
      expect(searchPluginSkills({ query: "", limit: 1.9 }, NO_PROJECT).skills.length).toBe(1);
      expect(searchPluginSkills({ query: "", limit: 10_000 }, NO_PROJECT).skills.length).toBe(2);
      // A below-range value floors up to the minimum of 1.
      expect(searchPluginSkills({ query: "", limit: 0 }, NO_PROJECT).skills.length).toBe(1);
    });

    it("search results carry metadata but never the body", () => {
      const match = searchPluginSkills({ query: "tdd" }, NO_PROJECT).skills[0];
      expect(match).toMatchObject({
        id: "acme.plugin.tdd-workflow",
        name: "TDD Workflow",
        description: "Step-by-step test-driven development.",
      });
      expect(match).not.toHaveProperty("body");
    });
  });

  describe("scoped teardown", () => {
    beforeEach(async () => {
      await registerPluginSkills("acme.plugin", dir, [
        { id: "tdd-workflow", name: "TDD Workflow", path: "./skills/tdd.md", triggers: ["tdd"] },
      ]);
    });

    it("removes only the unloaded plugin's skills", async () => {
      const other = await fs.mkdtemp(path.join(os.tmpdir(), "skill-other-"));
      await fs.mkdir(path.join(other, "skills"), { recursive: true });
      await fs.writeFile(path.join(other, "skills", "b.md"), SKILL_FILE, "utf8");
      await registerPluginSkills("beta.plugin", other, [
        { id: "s", name: "Beta Skill", path: "./skills/b.md" },
      ]);

      unregisterPluginSkills("acme.plugin");

      expect(loadPluginSkill("acme.plugin.tdd-workflow", NO_PROJECT)).toBeNull();
      expect(loadPluginSkill("beta.plugin.s", NO_PROJECT)).not.toBeNull();
      expect(searchPluginSkills({ query: "tdd" }, NO_PROJECT).skills).toEqual([]);
      await fs.rm(other, { recursive: true, force: true });
    });

    it("re-registering a plugin replaces its prior skills (no stale duplicates)", async () => {
      await registerPluginSkills("acme.plugin", dir, [
        { id: "renamed", name: "Renamed", path: "./skills/tdd.md" },
      ]);
      expect(loadPluginSkill("acme.plugin.tdd-workflow", NO_PROJECT)).toBeNull();
      expect(loadPluginSkill("acme.plugin.renamed", NO_PROJECT)).not.toBeNull();
    });
  });

  describe("project visibility (#13831)", () => {
    const PROJECT_A = "a".repeat(64);
    const PROJECT_B = "b".repeat(64);
    const instanceA = makeProjectPluginInstanceKey(PROJECT_A, "acme.ledger");
    const instanceB = makeProjectPluginInstanceKey(PROJECT_B, "acme.ledger");
    const skill = [{ id: "tdd", name: "TDD", path: "./skills/tdd.md", triggers: ["tdd"] }];

    beforeEach(async () => {
      await registerPluginSkills("acme.installed", dir, skill);
      await registerPluginSkills(instanceA, dir, skill);
      await registerPluginSkills(instanceB, dir, skill);
    });

    const searchIds = (visibility: SkillVisibility, query = "tdd") =>
      searchPluginSkills({ query }, visibility).skills.map((match) => match.id);

    it("serves a project plugin's skills only to its own project", () => {
      expect(searchIds({ projectId: PROJECT_A })).toEqual(
        [`${instanceA}.tdd`, "acme.installed.tdd"].sort()
      );
      expect(searchIds({ projectId: PROJECT_B })).toEqual(
        ["acme.installed.tdd", `${instanceB}.tdd`].sort()
      );
      expect(loadPluginSkill(`${instanceA}.tdd`, { projectId: PROJECT_A })?.body).toBe(SKILL_BODY);
    });

    it("treats no project as an identity, not a wildcard", () => {
      expect(searchIds(NO_PROJECT)).toEqual(["acme.installed.tdd"]);
      expect(searchIds(NO_PROJECT, "")).toEqual(["acme.installed.tdd"]);
      expect(loadPluginSkill(`${instanceA}.tdd`, NO_PROJECT)).toBeNull();
    });

    it("answers a load of another project's skill exactly as an unknown id", () => {
      expect(loadPluginSkill(`${instanceA}.tdd`, { projectId: PROJECT_B })).toBeNull();
      expect(loadPluginSkill(`${instanceA}.nope`, { projectId: PROJECT_B })).toBeNull();
    });

    it("filters before the limit, so hidden skills cannot crowd out visible ones", () => {
      const limited = searchPluginSkills({ query: "", limit: 1 }, { projectId: PROJECT_B });
      expect(limited.skills.map((match) => match.id)).toEqual(["acme.installed.tdd"]);
    });

    it("narrows to one plugin instance when asked", () => {
      expect(searchIds({ projectId: PROJECT_A, pluginInstanceId: instanceA })).toEqual([
        `${instanceA}.tdd`,
      ]);
      expect(searchIds({ projectId: PROJECT_A, pluginInstanceId: "acme.installed" })).toEqual([
        "acme.installed.tdd",
      ]);
      // The instance narrowing never widens past the project rule.
      expect(searchIds({ projectId: PROJECT_B, pluginInstanceId: instanceA })).toEqual([]);
      expect(
        loadPluginSkill("acme.installed.tdd", { projectId: PROJECT_A, pluginInstanceId: instanceA })
      ).toBeNull();
    });

    it("tears down one project's instance without touching the other's", () => {
      unregisterPluginSkills(instanceA);
      expect(hasPluginSkills(instanceA)).toBe(false);
      expect(hasPluginSkills(instanceB)).toBe(true);
      expect(searchIds({ projectId: PROJECT_B })).toEqual(
        ["acme.installed.tdd", `${instanceB}.tdd`].sort()
      );
    });
  });
});
