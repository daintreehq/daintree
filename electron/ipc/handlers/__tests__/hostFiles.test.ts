import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projects = vi.hoisted(() => ({ list: [] as Array<{ path: string }> }));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getAllProjects: () => projects.list },
}));

import { getHostPickerRoots, listHostDirectory } from "../hostFiles.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "host-files-")));
  projects.list = [];
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("listHostDirectory", () => {
  it("lists folders first, then files, with sizes for files only", async () => {
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "b.txt"), "12345");
    await fs.writeFile(path.join(dir, "a.txt"), "1");
    const listing = await listHostDirectory({ path: dir });
    expect(listing.path).toBe(dir);
    expect(listing.parent).toBe(path.dirname(dir));
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([
      ["src", "directory", null],
      ["a.txt", "file", 1],
      ["b.txt", "file", 5],
    ]);
  });

  it("hides dotfiles unless asked", async () => {
    await fs.writeFile(path.join(dir, ".env"), "x");
    await fs.writeFile(path.join(dir, "visible"), "x");
    expect((await listHostDirectory({ path: dir })).entries.map((e) => e.name)).toEqual([
      "visible",
    ]);
    expect(
      (await listHostDirectory({ path: dir, showHidden: true })).entries.map((e) => e.name)
    ).toEqual([".env", "visible"]);
  });

  it("shows a symlink as a symlink, without following it", async () => {
    await fs.mkdir(path.join(dir, "real"));
    await fs.symlink(path.join(dir, "real"), path.join(dir, "alias"));
    await fs.symlink(path.join(dir, "missing"), path.join(dir, "broken"));
    const kinds = Object.fromEntries(
      (await listHostDirectory({ path: dir })).entries.map((e) => [e.name, e.kind])
    );
    expect(kinds).toEqual({ real: "directory", alias: "symlink", broken: "symlink" });
  });

  it("stops at the entry cap and says so", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => fs.writeFile(path.join(dir, `f${i}`), ""))
    );
    const listing = await listHostDirectory({ path: dir }, 5);
    expect(listing.entries).toHaveLength(5);
    expect(listing.truncated).toBe(true);
    const all = await listHostDirectory({ path: dir }, 12);
    expect(all.truncated).toBe(false);
  });

  it("refuses relative, empty and NUL paths", async () => {
    await expect(listHostDirectory({ path: "relative" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    await expect(listHostDirectory({ path: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(listHostDirectory({ path: `${dir}/\0x` })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("maps a missing folder and a file to typed errors", async () => {
    await fs.writeFile(path.join(dir, "file"), "x");
    await expect(listHostDirectory({ path: path.join(dir, "nope") })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(listHostDirectory({ path: path.join(dir, "file") })).rejects.toMatchObject({
      code: "NOT_A_DIRECTORY",
    });
  });

  it("has no parent at the filesystem root", async () => {
    const listing = await listHostDirectory({ path: path.parse(dir).root });
    expect(listing.parent).toBeNull();
  });
});

describe("getHostPickerRoots", () => {
  it("offers home, the parents of known projects, and the filesystem root", async () => {
    await fs.mkdir(path.join(dir, "app"));
    projects.list = [{ path: path.join(dir, "app") }, { path: path.join(dir, "gone", "x") }];
    const roots = await getHostPickerRoots();
    expect(roots.home).toBe(os.homedir());
    expect(roots.roots[0]).toEqual({ label: "Home", path: os.homedir() });
    const paths = roots.roots.map((root) => root.path);
    expect(paths).toContain(dir);
    expect(paths).not.toContain(path.join(dir, "gone"));
    expect(paths.at(-1)).toBe(path.parse(os.homedir()).root);
  });
});
