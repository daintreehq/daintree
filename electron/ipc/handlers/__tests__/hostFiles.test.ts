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
  vi.restoreAllMocks();
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

  it("lists the home folder for the home token, and only for the exact token", async () => {
    const home = path.join(dir, "home");
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "notes.md"), "x");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const listing = await listHostDirectory({ path: "~" });
    expect(listing.path).toBe(home);
    expect(listing.parent).toBe(dir);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.md"]);
    for (const near of ["~/notes", "~ ", " ~"]) {
      await expect(listHostDirectory({ path: near })).rejects.toMatchObject({
        code: "INVALID_PATH",
      });
    }
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

  it("never holds the home listing behind a project parent that stalls", async () => {
    const home = path.join(dir, "home");
    const stalled = path.join(dir, "mounts", "slow");
    await fs.mkdir(home);
    await fs.mkdir(stalled, { recursive: true });
    await fs.writeFile(path.join(home, "notes.md"), "x");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    projects.list = [{ path: path.join(stalled, "app") }];

    const realStat = fs.stat.bind(fs);
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => {
      if (String(target) === stalled) {
        entered();
        await gate;
      }
      return realStat(target, ...rest);
    });

    let rootsSettled = false;
    const roots = getHostPickerRoots().finally(() => {
      rootsSettled = true;
    });
    try {
      await reached;
      const listing = await listHostDirectory({ path: "~" });
      expect(listing.path).toBe(home);
      expect(listing.entries.map((entry) => entry.name)).toEqual(["notes.md"]);
      expect(rootsSettled).toBe(false);
    } finally {
      release();
    }
    expect((await roots).roots.map((root) => root.path)).toContain(stalled);
  });
});
