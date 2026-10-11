import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPluginFiles } from "../HostPluginAssetService.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dt-plugin-files-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "dt-plugin-outside-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("listPluginFiles", () => {
  it("lists every servable file with its sha256, and nothing outside the root", async () => {
    await fs.mkdir(path.join(root, "dist", "chunks"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "view.js"), "view");
    await fs.writeFile(path.join(root, "dist", "chunks", "a.js"), "a");
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "HEAD"), "ref");
    await fs.writeFile(path.join(outside, "secret.js"), "secret");
    await fs.symlink(path.join(outside, "secret.js"), path.join(root, "dist", "escape.js"));
    await fs.symlink(path.join(root, "dist", "view.js"), path.join(root, "dist", "alias.js"));
    expect(await listPluginFiles(root)).toEqual([
      { path: "dist/alias.js", sha256: sha("view") },
      { path: "dist/chunks/a.js", sha256: sha("a") },
      { path: "dist/view.js", sha256: sha("view") },
    ]);
  });

  it("lists a directory reached through a link under both paths, and stops at a loop", async () => {
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist", "view.js"), "view");
    await fs.symlink(path.join(root, "dist"), path.join(root, "aaa"));
    await fs.symlink(path.join(root, "dist"), path.join(root, "dist", "self"));
    expect(await listPluginFiles(root)).toEqual([
      { path: "aaa/view.js", sha256: sha("view") },
      { path: "dist/view.js", sha256: sha("view") },
    ]);
  });
});
