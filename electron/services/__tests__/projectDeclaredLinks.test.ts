import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeclaredProjectLinks } from "../projectDeclaredLinks.js";

const roots: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeProject(manifest: string | Buffer | null): Promise<string> {
  const root = await makeDir("declared-links-");
  if (manifest !== null) await writeFile(join(root, "package.json"), manifest);
  return root;
}

const MANIFEST = JSON.stringify({
  name: "widget",
  homepage: "https://widget.example.dev",
  repository: { type: "git", url: "git+https://github.com/acme/widget.git" },
  bugs: { url: "https://github.com/acme/widget/issues" },
});

const ALL_THREE = [
  { field: "homepage", title: "Homepage", url: "https://widget.example.dev/" },
  { field: "repository", title: "Repository", url: "https://github.com/acme/widget" },
  { field: "bugs", title: "Issues", url: "https://github.com/acme/widget/issues" },
];

// Symlinks need privileges on Windows and mkfifo has no equivalent; CI is Ubuntu.
const posixIt = it.skipIf(process.platform === "win32");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("readDeclaredProjectLinks (#17252)", () => {
  it("reads the links the root package.json declares", async () => {
    const root = await makeProject(MANIFEST);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });

  it("reads a manifest saved with a byte order mark", async () => {
    const root = await makeProject(`${String.fromCharCode(0xfeff)}${MANIFEST}`);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });

  it("follows edits to the file", async () => {
    const root = await makeProject(JSON.stringify({ homepage: "https://one.example.dev" }));
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([
      { field: "homepage", title: "Homepage", url: "https://one.example.dev/" },
    ]);
    await writeFile(join(root, "package.json"), "{ not json");
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
    await writeFile(join(root, "package.json"), MANIFEST);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual(ALL_THREE);
  });

  it.each([
    ["is missing", null],
    ["is empty", ""],
    ["isn't JSON", "{ name: widget"],
    ["holds an array", JSON.stringify([{ homepage: "https://widget.example.dev" }])],
    ["holds a string", JSON.stringify("https://widget.example.dev")],
    ["declares nothing", JSON.stringify({ name: "widget" })],
  ])("declares nothing when the file %s", async (_label, manifest) => {
    const root = await makeProject(manifest);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  it("declares nothing for a project folder that is gone", async () => {
    const root = await makeProject(MANIFEST);
    await rm(root, { recursive: true, force: true });
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  it("skips a manifest too large to be one a person wrote", async () => {
    const padding = " ".repeat(512 * 1024);
    const root = await makeProject(`${MANIFEST.slice(0, -1)},"x":"${padding}"}`);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  it("skips a directory standing where the file should be", async () => {
    const root = await makeProject(null);
    await mkdir(join(root, "package.json"));
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  posixIt("refuses a manifest linked from outside the project", async () => {
    const outside = await makeDir("declared-outside-");
    await writeFile(join(outside, "package.json"), MANIFEST);
    const root = await makeProject(null);
    await symlink(join(outside, "package.json"), join(root, "package.json"));
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });

  posixIt("reads through a project folder that is itself a link", async () => {
    const real = await makeProject(MANIFEST);
    const parent = await makeDir("declared-link-parent-");
    const linked = join(parent, "project");
    await symlink(real, linked);
    await expect(readDeclaredProjectLinks(linked)).resolves.toEqual(ALL_THREE);
  });

  posixIt("doesn't wait on a FIFO standing at the path", async () => {
    const root = await makeProject(null);
    execFileSync("mkfifo", [join(root, "package.json")]);
    await expect(readDeclaredProjectLinks(root)).resolves.toEqual([]);
  });
});
