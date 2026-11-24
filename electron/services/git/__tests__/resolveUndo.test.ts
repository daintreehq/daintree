import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseResolveUndoPaths, RESOLVE_UNDO_ARGS } from "../resolveUndo.js";

const OID = "de980441c3ab03a8c07dda1ad27b8a11f39deb1e";
const record = (stage: number, file: string, mode = "100644") =>
  `${mode} ${OID} ${stage}\t${file}\0`;

describe("parseResolveUndoPaths", () => {
  it("reads nothing as an empty list", () => {
    expect(parseResolveUndoPaths("")).toEqual([]);
  });

  it("counts a path once however many stages git kept for it", () => {
    const raw = record(1, "a.txt") + record(2, "a.txt") + record(3, "a.txt") + record(2, "b.txt");
    expect(parseResolveUndoPaths(raw)).toEqual(["a.txt", "b.txt"]);
  });

  it("accepts a deletion that kept only two stages, a gitlink, and a SHA-256 object name", () => {
    const sha256 = "a".repeat(64);
    const raw =
      record(1, "gone.txt") +
      record(2, "gone.txt") +
      record(1, "vendor/lib", "160000") +
      `100644 ${sha256} 3\tdeep/new.txt\0`;
    expect(parseResolveUndoPaths(raw)).toEqual(["gone.txt", "vendor/lib", "deep/new.txt"]);
  });

  it("keeps a path's own tab, newline, leading and trailing space, and case", () => {
    const names = ["tab\tfile.txt", "new\nline.txt", " lead and trail ", "Readme.md", "README.md"];
    const raw = names.map((name) => record(2, name)).join("");
    expect(parseResolveUndoPaths(raw)).toEqual(names);
  });

  it.each([
    ["a record cut off before its terminator", `100644 ${OID} 2\ta.txt`],
    ["a record with no tab", `100644 ${OID} 2 a.txt\0`],
    ["a record with no path", `100644 ${OID} 2\t\0`],
    ["a stage outside 1-3", record(0, "a.txt")],
    ["a header that is not a mode, object name and stage", "not a header\ta.txt\0"],
    ["a mode that is not six octal digits", `7 ${OID} 2\ta.txt\0`],
    ["an object name that is abbreviated", "100644 de98044 2\ta.txt\0"],
    ["one good record beside a bad one", record(2, "a.txt") + "garbage\0"],
  ])("reports nothing for %s", (_label, raw) => {
    expect(parseResolveUndoPaths(raw)).toBeNull();
  });
});

// Control characters in a file name cannot be created on Windows.
describe.skipIf(process.platform === "win32")("resolve-undo against real git", () => {
  let root: string;
  let repo: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        LC_ALL: "C",
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  }

  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  };

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resolve-undo-")));
    repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    // Spelled as git C-quotes them without -z.
    const names = ["tab\tfile.txt", "new\nline.txt", "sub/in dir.txt", "clean.txt"];
    for (const name of names) write(name, "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "topic");
    for (const name of names) write(name, `topic ${name}\n`);
    git(repo, "commit", "-qam", "topic");
    git(repo, "checkout", "-q", "main");
    for (const name of names.filter((n) => n !== "clean.txt")) write(name, `main ${name}\n`);
    git(repo, "commit", "-qam", "main");
    try {
      git(repo, "merge", "topic");
    } catch {
      // The conflicts are the fixture.
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("lists a resolution and not a path git merged without a conflict", () => {
    expect(git(repo, ...RESOLVE_UNDO_ARGS)).toBe("");
    expect(git(repo, "diff", "--cached", "--name-only", "--", "clean.txt")).toBe("clean.txt\n");

    write("tab\tfile.txt", "resolved\n");
    write("new\nline.txt", "resolved\n");
    write("sub/in dir.txt", "resolved\n");
    git(repo, "add", "--", "tab\tfile.txt", "new\nline.txt", "sub/in dir.txt");

    expect(parseResolveUndoPaths(git(repo, ...RESOLVE_UNDO_ARGS))).toEqual([
      "new\nline.txt",
      "sub/in dir.txt",
      "tab\tfile.txt",
    ]);
  });
});
