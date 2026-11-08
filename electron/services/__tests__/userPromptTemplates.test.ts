import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureUserPromptTemplatesDir,
  getUserPromptTemplatesDir,
  parseUserPromptTemplate,
  readUserPromptTemplates,
} from "../userPromptTemplates.js";

const VALID = `---
title: Review a change
description: Review a change for correctness
args:
  - name: focus
    label: Focus
    required: true
---

Review this change, focusing on {{focus}}.
`;

function reasonFor(raw: string): string {
  const parsed = parseUserPromptTemplate("t", raw);
  if (!("reason" in parsed)) throw new Error("expected the file to be refused");
  return parsed.reason;
}

describe("parseUserPromptTemplate", () => {
  it("takes the plugin contract's fields from frontmatter, the id from the name, the body from the text", () => {
    expect(parseUserPromptTemplate("review-change", VALID)).toEqual({
      template: {
        id: "review-change",
        title: "Review a change",
        description: "Review a change for correctness",
        args: [{ name: "focus", label: "Focus", required: true }],
        body: "Review this change, focusing on {{focus}}.",
      },
    });
  });

  it("defaults args to none, so the template fills the draft with no form", () => {
    const parsed = parseUserPromptTemplate(
      "t",
      "---\ntitle: T\ndescription: D\n---\nRun the tests."
    );
    expect(parsed).toEqual({
      template: { id: "t", title: "T", description: "D", args: [], body: "Run the tests." },
    });
  });

  it("reads CRLF files and keeps a horizontal rule in the prompt", () => {
    const parsed = parseUserPromptTemplate(
      "t",
      "---\r\ntitle: T\r\ndescription: D\r\n---\r\n\r\nFirst\r\n---\r\nSecond\r\n"
    );
    expect("template" in parsed && parsed.template.body).toBe("First\r\n---\r\nSecond");
  });

  it("merges a shared anchor the way other YAML the person writes does", () => {
    const parsed = parseUserPromptTemplate(
      "t",
      "---\ntitle: T\ndescription: D\nargs:\n  - &base\n    name: a\n    label: A\n  - <<: *base\n    name: b\n---\n{{a}} {{b}}"
    );
    expect("template" in parsed && parsed.template.args).toEqual([
      { name: "a", label: "A" },
      { name: "b", label: "A" },
    ]);
  });

  it("names the frontmatter a file without one needs", () => {
    expect(reasonFor("Just some notes.")).toContain("no frontmatter");
    expect(reasonFor("---\nnever closed")).toContain("no frontmatter");
  });

  it("names the line of bad YAML, without quoting the file", () => {
    const reason = reasonFor("---\ntitle: T\nsecret: [unclosed sk-live-123\n---\nBody");
    expect(reason).toContain("isn't valid YAML");
    expect(reason).toMatch(/line \d+/);
    expect(reason).not.toContain("sk-live-123");
  });

  it.each([
    ["an empty block", "---\n---\nBody", "title is missing"],
    ["a list instead of a mapping", "---\n- a\n---\nBody", "expected object"],
    ["no description", "---\ntitle: T\n---\nBody", "description is missing"],
    ["an unknown key", "---\ntitle: T\ndescription: D\nmodel: x\n---\nBody", "model"],
    ["its own id", "---\nid: x\ntitle: T\ndescription: D\n---\nBody", "id"],
    ["a body in frontmatter", "---\nbody: x\ntitle: T\ndescription: D\n---\nBody", "body"],
    ["no prompt text", "---\ntitle: T\ndescription: D\n---\n\n  \n", "no prompt text"],
  ])("refuses %s", (_name, raw, expected) => {
    expect(reasonFor(raw)).toContain(expected);
  });

  it("holds titles and bodies to the plugin contract's limits", () => {
    expect(reasonFor(`---\ntitle: ${"t".repeat(81)}\ndescription: D\n---\nBody`)).toContain(
      "title:"
    );
    const longest = "x".repeat(8192);
    expect(
      "template" in parseUserPromptTemplate("t", `---\ntitle: T\ndescription: D\n---\n${longest}`)
    ).toBe(true);
    expect(reasonFor(`---\ntitle: T\ndescription: D\n---\n${longest}x`)).toContain("limit");
  });

  it("refuses a bad argument, a repeated one and a reference to an undeclared one", () => {
    const withArgs = (args: string, body: string) =>
      `---\ntitle: T\ndescription: D\nargs:\n${args}\n---\n${body}`;
    expect(reasonFor(withArgs("  - name: Bad-Name\n    label: L", "x"))).toContain("args.0.name");
    expect(
      reasonFor(withArgs("  - name: a\n    label: A\n  - name: a\n    label: B", "{{a}}"))
    ).toContain('Duplicate argument "a"');
    expect(reasonFor(withArgs("  - name: a\n    label: A", "{{a}} {{b}}"))).toContain("{{b}}");
  });

  it("doesn't let a template bring any expansion past its named arguments", () => {
    const parsed = parseUserPromptTemplate(
      "t",
      "---\ntitle: T\ndescription: D\n---\n$HOME `whoami` $(date) stay as written"
    );
    expect("template" in parsed && parsed.template.body).toBe(
      "$HOME `whoami` $(date) stay as written"
    );
  });
});

describe("readUserPromptTemplates", () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-templates-"));
    dir = path.join(root, "templates");
    await fs.mkdir(dir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = (name: string, text: string | Buffer = VALID) =>
    fs.writeFile(path.join(dir, name), text);

  it("lives in the person's home, beside their other Daintree content", () => {
    expect(getUserPromptTemplatesDir()).toBe(path.join(os.homedir(), ".daintree", "templates"));
  });

  it("treats a missing folder as nothing to show, and doesn't create it", async () => {
    const missing = path.join(root, "absent");
    await expect(readUserPromptTemplates(missing)).resolves.toEqual({
      directory: missing,
      templates: [],
      problems: [],
    });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the folder only when asked to, empty", async () => {
    const asked = path.join(root, "nested", "templates");
    await expect(ensureUserPromptTemplatesDir(asked)).resolves.toBe(asked);
    await expect(fs.readdir(asked)).resolves.toEqual([]);
  });

  it("reports an unreadable folder rather than showing it as empty", async () => {
    const file = path.join(root, "not-a-folder");
    await fs.writeFile(file, "x");
    const snapshot = await readUserPromptTemplates(file);
    expect(snapshot.templates).toEqual([]);
    expect(snapshot.problems).toEqual([
      { fileName: null, reason: expect.stringContaining("folder couldn't be read") },
    ]);
  });

  it("lists templates by file name, and any name will do", async () => {
    await write("zeta.md");
    await write("My review (v2).md");
    await write("alpha.md");
    const { templates } = await readUserPromptTemplates(dir);
    expect(templates.map((t) => t.id)).toEqual(["alpha", "My review (v2)", "zeta"]);
  });

  it("looks only at visible Markdown files directly in the folder", async () => {
    await write("kept.md");
    await write("notes.txt");
    await write(".hidden.md");
    await fs.mkdir(path.join(dir, "folder.md"));
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "nested.md"), VALID);
    const { templates, problems } = await readUserPromptTemplates(dir);
    expect(templates.map((t) => t.id)).toEqual(["kept"]);
    expect(problems).toEqual([]);
  });

  it("leaves a bad file out, says which and why, and keeps the rest", async () => {
    await write("bad.md", "---\ntitle: T\n---\nBody");
    await write("good.md");
    const { templates, problems } = await readUserPromptTemplates(dir);
    expect(templates.map((t) => t.id)).toEqual(["good"]);
    expect(problems).toEqual([{ fileName: "bad.md", reason: "description is missing" }]);
  });

  it("picks up an added, an edited and a removed file on the next read", async () => {
    await write("one.md");
    const first = await readUserPromptTemplates(dir);
    expect(first.templates.map((t) => t.id)).toEqual(["one"]);

    await write("two.md");
    await write("one.md", VALID.replace("Review a change\n", "Edited title\n"));
    const second = await readUserPromptTemplates(dir);
    expect(second.templates.map((t) => t.title)).toEqual(["Edited title", "Review a change"]);

    await fs.rm(path.join(dir, "one.md"));
    const third = await readUserPromptTemplates(dir);
    expect(third.templates.map((t) => t.id)).toEqual(["two"]);
  });

  it("clears a file's problem once it has been fixed", async () => {
    await write("half.md", "---\ntitle: T");
    expect((await readUserPromptTemplates(dir)).problems).toHaveLength(1);
    await write("half.md");
    const fixed = await readUserPromptTemplates(dir);
    expect(fixed.problems).toEqual([]);
    expect(fixed.templates.map((t) => t.id)).toEqual(["half"]);
  });

  it("refuses an oversized file without parsing it", async () => {
    await write("big.md", `${VALID}${"x".repeat(64 * 1024)}`);
    const { templates, problems } = await readUserPromptTemplates(dir);
    expect(templates).toEqual([]);
    expect(problems[0]).toMatchObject({ fileName: "big.md" });
    expect(problems[0]?.reason).toContain("KB");
  });

  it("refuses a file that isn't UTF-8", async () => {
    await write("latin.md", Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
    const { problems } = await readUserPromptTemplates(dir);
    expect(problems).toEqual([{ fileName: "latin.md", reason: "It isn't valid UTF-8" }]);
  });

  it("reads a file with a byte order mark", async () => {
    await write("bom.md", `﻿${VALID}`);
    const { templates, problems } = await readUserPromptTemplates(dir);
    expect(problems).toEqual([]);
    expect(templates.map((t) => t.id)).toEqual(["bom"]);
  });

  it("stops at the file cap and says so", async () => {
    await Promise.all(
      Array.from({ length: 101 }, (_, i) => write(`t${String(i).padStart(3, "0")}.md`))
    );
    const { templates, problems } = await readUserPromptTemplates(dir);
    expect(templates).toHaveLength(100);
    expect(templates.at(-1)?.id).toBe("t099");
    expect(problems).toEqual([{ fileName: null, reason: expect.stringContaining("first 100") }]);
  });

  describe.skipIf(process.platform === "win32")("links", () => {
    it("follows a link to a file kept elsewhere, as a dotfiles setup makes", async () => {
      const elsewhere = path.join(root, "dotfiles.md");
      await fs.writeFile(elsewhere, VALID);
      await fs.symlink(elsewhere, path.join(dir, "linked.md"));
      const { templates, problems } = await readUserPromptTemplates(dir);
      expect(problems).toEqual([]);
      expect(templates.map((t) => t.id)).toEqual(["linked"]);
    });

    it("follows a linked folder", async () => {
      const elsewhere = path.join(root, "dotfiles");
      await fs.mkdir(elsewhere);
      await fs.writeFile(path.join(elsewhere, "linked.md"), VALID);
      const linked = path.join(root, "linked-folder");
      await fs.symlink(elsewhere, linked);
      const { templates } = await readUserPromptTemplates(linked);
      expect(templates.map((t) => t.id)).toEqual(["linked"]);
    });

    it("refuses a link to a folder, and passes over a dangling link", async () => {
      await fs.mkdir(path.join(root, "a-folder"));
      await fs.symlink(path.join(root, "a-folder"), path.join(dir, "folder.md"));
      await fs.symlink(path.join(root, "gone.md"), path.join(dir, "dangling.md"));
      const { templates, problems } = await readUserPromptTemplates(dir);
      expect(templates).toEqual([]);
      expect(problems).toEqual([{ fileName: "folder.md", reason: "It isn't a regular file" }]);
    });

    it("doesn't hang on a FIFO named like a template", async () => {
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkfifo", [path.join(root, "pipe.md")]);
      await fs.symlink(path.join(root, "pipe.md"), path.join(dir, "pipe.md"));
      const { problems } = await readUserPromptTemplates(dir);
      expect(problems).toEqual([{ fileName: "pipe.md", reason: "It isn't a regular file" }]);
    });
  });
});
