import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectImageType,
  HostInbox,
  nameLength,
  reconcileImageExtension,
  sanitizeInboxName,
  truncateName,
} from "../hostInbox.js";

let base: string;
let root: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "inbox-test-")));
  root = path.join(base, "daintree-inbox");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

async function age(target: string, ms: number): Promise<void> {
  const at = new Date(Date.now() - ms);
  await fs.utimes(target, at, at);
}

async function addFile(bucket: "clipboard" | "files", name: string, size = 4, ageMs = 0) {
  if (bucket === "clipboard") {
    const file = path.join(root, "clipboard", name);
    await fs.writeFile(file, Buffer.alloc(size));
    if (ageMs) await age(file, ageMs);
    return file;
  }
  const dir = path.join(root, "files", name);
  await fs.mkdir(dir);
  const file = path.join(dir, "a.bin");
  await fs.writeFile(file, Buffer.alloc(size));
  if (ageMs) {
    await age(file, ageMs);
    await age(dir, ageMs);
  }
  return dir;
}

describe("names", () => {
  it("strips control characters and separators and caps the length", () => {
    expect(sanitizeInboxName("a/b\\c\u0000d\u001b.txt")).toBe("abcd.txt");
    expect(sanitizeInboxName("...hidden")).toBe("hidden");
    expect(sanitizeInboxName("\u0007")).toBe("file");
    const long = sanitizeInboxName(`${"x".repeat(500)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(255);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("bounds a name in bytes on Linux, keeping its extension and whole characters", () => {
    const fits = `${"界".repeat(80)}.txt`;
    expect(sanitizeInboxName(fits, "linux")).toBe(fits);

    const long = sanitizeInboxName(`${"界".repeat(100)}.txt`, "linux");
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
    // As much of the name as fits: one more character wouldn't.
    expect(Buffer.byteLength(long) + Buffer.byteLength("界")).toBeGreaterThan(255);
    expect(long.endsWith(".txt")).toBe(true);
    expect("界".repeat(100).startsWith(long.slice(0, -".txt".length))).toBe(true);

    const emoji = sanitizeInboxName(`${"😀".repeat(70)}.md`, "linux");
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(255);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(emoji.endsWith(".md")).toBe(true);
  });

  it("keeps a long name's start when its extension alone is too long to keep whole", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const name = sanitizeInboxName(`${"a".repeat(300)}.${"b".repeat(300)}`, platform);
      expect(nameLength(name, platform)).toBeLessThanOrEqual(255);
      expect(name.startsWith("a".repeat(200))).toBe(true);
    }
    expect(sanitizeInboxName(".bashrc", "linux")).toBe("bashrc");
  });

  it("truncates to whole characters within the limit", () => {
    expect(truncateName("ab😀", 3, "linux")).toBe("ab");
    expect(truncateName("ab😀", 6, "linux")).toBe("ab😀");
    expect(truncateName("ab😀", 3, "darwin")).toBe("ab");
    expect(truncateName("ab😀", 4, "darwin")).toBe("ab😀");
    expect(truncateName("界界", 5, "linux")).toBe("界");
  });

  it("bounds a name in UTF-16 units on macOS and Windows, where a CJK name holds more bytes", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const cjk = `${"界".repeat(100)}.txt`;
      expect(sanitizeInboxName(cjk, platform)).toBe(cjk);
      const long = sanitizeInboxName(`${"x".repeat(500)}.pdf`, platform);
      expect(long.length).toBeLessThanOrEqual(255);
      expect(long.endsWith(".pdf")).toBe(true);
      const emoji = sanitizeInboxName("😀".repeat(200), platform);
      expect(emoji.length).toBeLessThanOrEqual(255);
      expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it("checks image extensions against the content", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectImageType(png)).toBe("png");
    expect(reconcileImageExtension("a.PNG", png)).toBe("a.PNG");
    expect(reconcileImageExtension("a.gif", png)).toBe("a.png");
    expect(reconcileImageExtension("a.jpg", new Uint8Array([1, 2, 3]))).toBe("a.bin");
    expect(reconcileImageExtension("notes.txt", png)).toBe("notes.txt");
  });
});

describe("placing a name at the limit", () => {
  const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ");

  it("keeps a corrected image extension within the limit, and still finds the file again", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    // Fits exactly as named; the content is WebP, so `.png` becomes the longer `.webp`.
    const name = `${"x".repeat(251)}.png`;
    const sha256 = crypto.createHash("sha256").update(webp).digest("hex");
    const part = await inbox.createPart();
    await part.handle.write(webp);
    await part.handle.close();
    const placed = await inbox.place("files", part.path, name, sha256);
    const placedName = path.basename(placed);
    expect(placedName.endsWith(".webp")).toBe(true);
    expect(placedName.length).toBeLessThanOrEqual(255);
    expect(name.startsWith(placedName.slice(0, -".webp".length))).toBe(true);
    expect(await inbox.findDuplicate("files", name, sha256, webp.byteLength)).toBe(placed);
  });

  it("does the same for a non-ASCII name, counted as this host's filesystem counts it", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    // 255 bytes, so the longer `.webp` forces a cut on Linux.
    const name = `${"界".repeat(83)}ab.png`;
    const sha256 = crypto.createHash("sha256").update(webp).digest("hex");
    const part = await inbox.createPart();
    await part.handle.write(webp);
    await part.handle.close();
    const placed = await inbox.place("files", part.path, name, sha256);
    const placedName = path.basename(placed);
    expect(placedName.endsWith(".webp")).toBe(true);
    expect(nameLength(placedName)).toBeLessThanOrEqual(255);
    expect(await inbox.findDuplicate("files", name, sha256, webp.byteLength)).toBe(placed);
  });

  it("keeps a name that fits as it is", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    const name = `${"y".repeat(251)}.txt`;
    const content = Buffer.from("notes");
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const part = await inbox.createPart();
    await part.handle.write(content);
    await part.handle.close();
    expect(path.basename(await inbox.place("files", part.path, name, sha256))).toBe(name);
  });
});

describe("the inbox folder", () => {
  it("is created owner-only and refuses a planted symlink", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(root, "files"))).mode & 0o777).toBe(0o700);

    const elsewhere = await fs.mkdtemp(path.join(base, "elsewhere-"));
    const planted = path.join(base, "planted-inbox");
    await fs.symlink(elsewhere, planted);
    await expect(new HostInbox({ root: planted }).ensure()).rejects.toThrow(/real directory/);
  });

  it("creates part files 0600 with O_EXCL", async () => {
    const inbox = new HostInbox({ root });
    const part = await inbox.createPart();
    await part.handle.close();
    expect((await fs.stat(part.path)).mode & 0o777).toBe(0o600);
  });
});

describe("cleanup", () => {
  it("drops entries older than a day and stale part files", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    const oldFile = await addFile("files", "20200101-000000-aaaaaaaaaaaa", 4, 25 * HOUR);
    const fresh = await addFile("files", "20200101-000001-bbbbbbbbbbbb", 4);
    const oldImage = await addFile("clipboard", "clipboard-old.png", 4, 25 * HOUR);
    const stalePart = path.join(root, ".part-old");
    await fs.writeFile(stalePart, "x");
    await age(stalePart, 2 * HOUR);
    await inbox.cleanup();
    const exists = async (p: string) => !!(await fs.lstat(p).catch(() => null));
    expect(await exists(oldFile)).toBe(false);
    expect(await exists(oldImage)).toBe(false);
    expect(await exists(stalePart)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it("keeps only the newest clipboard images", async () => {
    const inbox = new HostInbox({ root, maxClipboardImages: 2 });
    await inbox.ensure();
    const images = [];
    for (let i = 0; i < 4; i++)
      images.push(await addFile("clipboard", `clipboard-${i}.png`, 4, (4 - i) * 1000));
    await inbox.cleanup();
    expect((await fs.readdir(path.join(root, "clipboard"))).sort()).toEqual([
      "clipboard-2.png",
      "clipboard-3.png",
    ]);
  });

  it("keeps the whole inbox under its size cap, oldest first", async () => {
    const inbox = new HostInbox({ root, maxTotalBytes: 25 });
    await inbox.ensure();
    await addFile("files", "20200101-000000-aaaaaaaaaaaa", 10, 3000);
    await addFile("files", "20200101-000001-bbbbbbbbbbbb", 10, 2000);
    await addFile("files", "20200101-000002-cccccccccccc", 10, 1000);
    await inbox.cleanup();
    expect((await fs.readdir(path.join(root, "files"))).sort()).toEqual([
      "20200101-000001-bbbbbbbbbbbb",
      "20200101-000002-cccccccccccc",
    ]);
  });

  it("never sweeps a live part file", async () => {
    const inbox = new HostInbox({ root, stalePartMs: 0, maxTotalBytes: 0 });
    const part = await inbox.createPart();
    await part.handle.close();
    await age(part.path, 2 * HOUR);
    await inbox.cleanup();
    expect(await fs.lstat(part.path).catch(() => null)).not.toBeNull();
    inbox.releasePart(part.path);
    await inbox.cleanup();
    expect(await fs.lstat(part.path).catch(() => null)).toBeNull();
  });

  it("leaves a root that is a symlink alone", async () => {
    const real = await fs.mkdtemp(path.join(base, "real-"));
    await fs.mkdir(path.join(real, "files"));
    await addFileAt(path.join(real, "files", "old"), 25 * HOUR);
    await fs.symlink(real, root);
    await new HostInbox({ root }).cleanup();
    expect(await fs.readdir(path.join(real, "files"))).toEqual(["old"]);
  });
});

/** An entry holding a whole tree: `files` maps paths inside the folder to their size. */
async function addTree(
  entryName: string,
  folderName: string,
  files: Record<string, number>,
  ageMs = 0
): Promise<string> {
  const entry = path.join(root, "files", entryName);
  const touched = [entry];
  for (const [relative, size] of Object.entries(files)) {
    const file = path.join(entry, folderName, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(size));
    touched.push(file);
    for (let dir = path.dirname(file); dir !== entry; dir = path.dirname(dir)) touched.push(dir);
  }
  if (ageMs) {
    for (const target of new Set(touched)) await age(target, ageMs);
  }
  return entry;
}

const exists = async (p: string) => !!(await fs.lstat(p).catch(() => null));

describe("entries holding a tree", () => {
  it("counts every file of a nested tree against the size cap", async () => {
    // 30 bytes in all: leaving out any one file of the tree keeps it under.
    const inbox = new HostInbox({ root, maxTotalBytes: 29 });
    await inbox.ensure();
    // The tree's direct children hold nothing; its 20 bytes are all nested.
    const tree = await addTree(
      "20200101-000000-aaaaaaaaaaaa",
      "project",
      { "src/a.ts": 8, "src/lib/b.ts": 8, "docs/deep/er/c.md": 4 },
      3000
    );
    const newer = await addFile("files", "20200101-000001-bbbbbbbbbbbb", 10, 1000);
    await inbox.cleanup();
    expect(await exists(tree)).toBe(false);
    expect(await exists(newer)).toBe(true);
  });

  it("keeps a tree within the cap when nothing pushes it over", async () => {
    const inbox = new HostInbox({ root, maxTotalBytes: 25 });
    await inbox.ensure();
    const tree = await addTree("20200101-000000-aaaaaaaaaaaa", "project", {
      "src/a.ts": 8,
      "src/lib/b.ts": 8,
    });
    await addFile("files", "20200101-000001-bbbbbbbbbbbb", 8);
    await inbox.cleanup();
    expect(await exists(path.join(tree, "project", "src", "lib", "b.ts"))).toBe(true);
  });

  it("prunes an old tree whole, and keeps one a recent file inside holds fresh", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    const old = await addTree(
      "20200101-000000-aaaaaaaaaaaa",
      "old",
      { "a/b/c.txt": 4, "d.txt": 4 },
      25 * HOUR
    );
    const touched = await addTree(
      "20200101-000001-bbbbbbbbbbbb",
      "touched",
      { "a/b/c.txt": 4, "d.txt": 4 },
      25 * HOUR
    );
    // An agent wrote deep inside this one an hour ago.
    await age(path.join(touched, "touched", "a", "b", "c.txt"), HOUR);
    await inbox.cleanup();
    expect(await exists(old)).toBe(false);
    expect(await exists(path.join(touched, "touched", "a", "b", "c.txt"))).toBe(true);
    expect(await exists(path.join(touched, "touched", "d.txt"))).toBe(true);
  });

  it("never follows a symlink inside a tree when counting or pruning it", async () => {
    const outside = await fs.mkdtemp(path.join(base, "outside-"));
    await fs.writeFile(path.join(outside, "big.bin"), Buffer.alloc(100));
    const inbox = new HostInbox({ root, maxTotalBytes: 50 });
    await inbox.ensure();
    const tree = await addTree("20200101-000000-aaaaaaaaaaaa", "project", { "a.txt": 4 });
    await fs.symlink(outside, path.join(tree, "project", "linked"));
    await inbox.cleanup();
    // The 100 bytes behind the link aren't the inbox's: the tree stays under the cap.
    expect(await exists(tree)).toBe(true);

    await age(path.join(tree, "project", "a.txt"), 25 * HOUR);
    await age(path.join(tree, "project"), 25 * HOUR);
    await age(tree, 25 * HOUR);
    await fs.lutimes(
      path.join(tree, "project", "linked"),
      new Date(Date.now() - 25 * HOUR),
      new Date(Date.now() - 25 * HOUR)
    );
    await inbox.cleanup();
    expect(await exists(tree)).toBe(false);
    expect(await fs.readdir(outside)).toEqual(["big.bin"]);
  });

  it("still deduplicates an existing single-file entry beside a tree with the same id", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    const content = Buffer.from("notes");
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const id = sha256.slice(0, 12);
    // A tree whose folder carries the same name sorts first and must not be taken for it.
    await addTree(`20200101-000000-${id}`, "notes.txt", { "inner.txt": content.byteLength });
    const part = await inbox.createPart();
    await part.handle.write(content);
    await part.handle.close();
    const placed = await inbox.place("files", part.path, "notes.txt", sha256);
    expect(await inbox.findDuplicate("files", "notes.txt", sha256, content.byteLength)).toBe(
      placed
    );
  });
});

/** Age `target` and everything under it. */
async function ageTree(target: string, ms: number): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    for (const inner of await fs.readdir(target)) await ageTree(path.join(target, inner), ms);
  }
  const at = new Date(Date.now() - ms);
  await fs.lutimes(target, at, at);
}

async function buildTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

function gateRename() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realRename = fs.rename.bind(fs);
  const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await gate;
    return realRename(from, to);
  });
  return { rename, release };
}

function gateMade(prefix: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const made: string[] = [];
  const holds = (target: unknown) => path.basename(String(target)).startsWith(prefix);
  const realMkdir = fs.mkdir.bind(fs);
  const realOpen = fs.open.bind(fs);
  // Made on disk, but its maker hasn't heard back yet.
  vi.spyOn(fs, "mkdir").mockImplementation((async (target: string, options?: unknown) => {
    const result = await realMkdir(target, options as never);
    if (holds(target)) {
      made.push(target);
      await gate;
    }
    return result;
  }) as typeof fs.mkdir);
  vi.spyOn(fs, "open").mockImplementation((async (target: string, flags?: never, mode?: never) => {
    const handle = await realOpen(target, flags, mode);
    if (holds(target)) {
      made.push(target);
      await gate;
    }
    return handle;
  }) as typeof fs.open);
  return { made, release };
}

describe("staging and publishing a tree", () => {
  it("builds a tree in owner-only staging and shows it only once publication completes", async () => {
    const inbox = new HostInbox({ root });
    const staging = await inbox.createStaging();
    expect(path.dirname(path.dirname(staging.treePath))).toBe(root);
    expect((await fs.stat(path.dirname(staging.treePath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(staging.treePath)).mode & 0o777).toBe(0o700);
    await buildTree(staging.treePath, { "src/a.ts": "a", "src/lib/b.ts": "b", "README.md": "r" });
    expect(await fs.readdir(path.join(root, "files"))).toEqual([]);

    const { rename, release } = gateRename();
    const publishing = inbox.publishTree(staging, "project");
    await vi.waitFor(() => expect(rename).toHaveBeenCalled());
    // Mid-publication the entry folder may exist, but nothing of the tree is in it.
    for (const entry of await fs.readdir(path.join(root, "files"))) {
      expect(await fs.readdir(path.join(root, "files", entry))).toEqual([]);
    }
    release();
    const published = await publishing;

    const entry = path.dirname(published);
    expect(path.dirname(entry)).toBe(path.join(root, "files"));
    expect(path.basename(entry)).toMatch(/^\d{8}-\d{6}-[0-9a-f]{12}$/);
    expect(path.basename(published)).toBe("project");
    expect(await fs.readFile(path.join(published, "src", "lib", "b.ts"), "utf8")).toBe("b");
    expect(await fs.readFile(path.join(published, "README.md"), "utf8")).toBe("r");
    // The staging folder is gone, and the spent handle can't publish again.
    expect(await exists(path.dirname(staging.treePath))).toBe(false);
    await expect(inbox.publishTree(staging, "project")).rejects.toThrow(/staging/);
  });

  it("never lets a cleanup pass sweep the entry folder a tree is being renamed into", async () => {
    // A live upload holds the total over the cap, so a pass sweeps everything it may.
    const inbox = new HostInbox({ root, maxTotalBytes: 1 });
    const part = await inbox.createPart();
    await part.handle.write(Buffer.alloc(16));
    await part.handle.close();
    const staging = await inbox.createStaging();
    await buildTree(staging.treePath, { "a.txt": "a" });
    const passes = vi.spyOn(inbox as unknown as { cleanupOnce(): Promise<void> }, "cleanupOnce");

    const { rename, release } = gateRename();
    const publishing = inbox.publishTree(staging, "project");
    try {
      await vi.waitFor(() => expect(rename).toHaveBeenCalled());
      const cleaning = inbox.cleanup();
      // Time for a pass that didn't wait its turn to finish and sweep the empty entry folder.
      await Promise.race([cleaning, new Promise((resolve) => setTimeout(resolve, 100))]);
      expect(passes).not.toHaveBeenCalled();
      release();
      // It resolves: the entry folder was still there to rename into.
      expect(path.basename(await publishing)).toBe("project");
      await cleaning;
      expect(passes).toHaveBeenCalledOnce();
    } finally {
      release();
      await publishing.catch(() => {});
    }
  });

  it("never lets a discard delete part of a tree mid-publication", async () => {
    const inbox = new HostInbox({ root });
    const staging = await inbox.createStaging();
    await buildTree(staging.treePath, { "a.txt": "a", "b/c.txt": "c" });
    const { rename, release } = gateRename();
    const publishing = inbox.publishTree(staging, "project");
    try {
      await vi.waitFor(() => expect(rename).toHaveBeenCalled());
      const discarding = inbox.discardStaging(staging);
      await Promise.race([discarding, new Promise((resolve) => setTimeout(resolve, 100))]);
      release();
      const published = await publishing;
      // Publication won: the discard finds nothing left to remove.
      await discarding;
      expect(await fs.readFile(path.join(published, "a.txt"), "utf8")).toBe("a");
      expect(await fs.readFile(path.join(published, "b", "c.txt"), "utf8")).toBe("c");
    } finally {
      release();
      await publishing.catch(() => {});
    }
  });

  it("treats a staging folder or part file as live from before it exists", async () => {
    const inbox = new HostInbox({ root, stalePartMs: 0, maxTotalBytes: 0 });
    await inbox.ensure();
    const { made, release } = gateMade(".");
    const staging = inbox.createStaging();
    const part = inbox.createPart();
    try {
      await vi.waitFor(() => expect(made).toHaveLength(2));
      for (const target of made) await age(target, 2 * HOUR);
      await inbox.cleanup();
      for (const target of made) expect(await exists(target)).toBe(true);
    } finally {
      release();
      await (await part).handle.close();
      await staging;
    }
  });

  it("rolls back a staging folder it couldn't finish making", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    const realMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation((async (target: string, options?: unknown) => {
      if (path.basename(target) === "tree") {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      }
      return realMkdir(target, options as never);
    }) as typeof fs.mkdir);
    await expect(inbox.createStaging()).rejects.toThrow("no space");
    expect((await fs.readdir(root)).filter((name) => name.startsWith(".stage-"))).toEqual([]);
  });

  it("refuses to publish a staged tree replaced by a symlink", async () => {
    const inbox = new HostInbox({ root });
    const staging = await inbox.createStaging();
    const outside = await fs.mkdtemp(path.join(base, "outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "s");
    await fs.rm(staging.treePath, { recursive: true });
    await fs.symlink(outside, staging.treePath);
    await expect(inbox.publishTree(staging, "project")).rejects.toThrow(/not a folder/);
    expect(await fs.readdir(path.join(root, "files"))).toEqual([]);
    await inbox.discardStaging(staging);
    expect(await exists(path.dirname(staging.treePath))).toBe(false);
    expect(await fs.readdir(outside)).toEqual(["secret.txt"]);
  });

  it("gives a published tree a safe name inside its own entry folder", async () => {
    const inbox = new HostInbox({ root });
    const first = await inbox.createStaging();
    const second = await inbox.createStaging();
    await buildTree(first.treePath, { "a.txt": "1" });
    await buildTree(second.treePath, { "a.txt": "2" });
    const one = await inbox.publishTree(first, "../evil");
    const two = await inbox.publishTree(second, "../evil");
    for (const published of [one, two]) {
      expect(path.basename(published)).toBe("evil");
      expect(path.dirname(path.dirname(published))).toBe(path.join(root, "files"));
    }
    expect(path.dirname(one)).not.toBe(path.dirname(two));
    expect(await fs.readFile(path.join(one, "a.txt"), "utf8")).toBe("1");
    expect(await fs.readFile(path.join(two, "a.txt"), "utf8")).toBe("2");
  });

  it("keeps a staging whose publication failed, to publish again or discard", async () => {
    const inbox = new HostInbox({ root });
    const staging = await inbox.createStaging();
    await buildTree(staging.treePath, { "a.txt": "a" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("busy"), { code: "EBUSY" })
    );
    await expect(inbox.publishTree(staging, "project")).rejects.toThrow("busy");
    expect(await fs.readdir(path.join(root, "files"))).toEqual([]);
    expect(await fs.readFile(path.join(staging.treePath, "a.txt"), "utf8")).toBe("a");

    const published = await inbox.publishTree(staging, "project");
    // Discarding a published handle leaves what it published alone.
    await inbox.discardStaging(staging);
    expect(await fs.readFile(path.join(published, "a.txt"), "utf8")).toBe("a");
  });

  it("discards a staging whole, and refuses a handle it never issued", async () => {
    const inbox = new HostInbox({ root });
    const staging = await inbox.createStaging();
    await buildTree(staging.treePath, { "deep/er/a.txt": "a" });
    await inbox.discardStaging(staging);
    await inbox.discardStaging(staging);
    expect(await exists(path.dirname(staging.treePath))).toBe(false);
    await expect(inbox.publishTree(staging, "project")).rejects.toThrow(/staging/);

    const elsewhere = await fs.mkdtemp(path.join(base, "elsewhere-"));
    await expect(inbox.publishTree({ treePath: elsewhere }, "project")).rejects.toThrow(/staging/);
    expect(await exists(elsewhere)).toBe(true);
    expect(await fs.readdir(path.join(root, "files"))).toEqual([]);
  });

  it("never sweeps a live staging, and sweeps one a stopped host or abandoned send left", async () => {
    const inbox = new HostInbox({ root, stalePartMs: HOUR });
    const live = await inbox.createStaging();
    await buildTree(live.treePath, { "a/b.txt": "live" });
    // Another instance stands in for a host that stopped mid-build.
    const crashed = new HostInbox({ root, stalePartMs: HOUR });
    const left = await crashed.createStaging();
    await buildTree(left.treePath, { "a/b.txt": "left" });
    const recent = await crashed.createStaging();
    await buildTree(recent.treePath, { "a/b.txt": "recent" });
    await ageTree(path.dirname(live.treePath), 2 * HOUR);
    await ageTree(path.dirname(left.treePath), 2 * HOUR);

    await inbox.cleanup();
    expect(await fs.readFile(path.join(live.treePath, "a", "b.txt"), "utf8")).toBe("live");
    expect(await exists(path.dirname(left.treePath))).toBe(false);
    // Not stale yet: it might still belong to a host sharing this inbox.
    expect(await exists(recent.treePath)).toBe(true);
  });

  it("counts a live staging's bytes toward the cap, but never sweeps it", async () => {
    // The staging alone is over the cap: everything else goes, and it stays.
    const inbox = new HostInbox({ root, maxTotalBytes: 15 });
    const staging = await inbox.createStaging();
    await buildTree(staging.treePath, { "a/b.bin": "x".repeat(10), "c.bin": "y".repeat(10) });
    const older = await addFile("files", "20200101-000000-aaaaaaaaaaaa", 10, 1000);
    await inbox.cleanup();
    expect(await exists(older)).toBe(false);
    expect(await exists(path.join(staging.treePath, "a", "b.bin"))).toBe(true);
    expect(await exists(path.join(staging.treePath, "c.bin"))).toBe(true);
  });

  it("keeps an entry it couldn't read to the bottom rather than judge it on part of it", async () => {
    const inbox = new HostInbox({ root });
    await inbox.ensure();
    const tree = await addTree(
      "20200101-000000-aaaaaaaaaaaa",
      "project",
      { "a.txt": 4, "deep/b.txt": 4 },
      25 * HOUR
    );
    const deep = path.join(tree, "project", "deep");
    const realReaddir = fs.readdir.bind(fs);
    const readdir = vi.spyOn(fs, "readdir").mockImplementation((async (
      target: string,
      options?: unknown
    ) => {
      if (target === deep) throw Object.assign(new Error("too many files"), { code: "EMFILE" });
      return realReaddir(target, options as never);
    }) as typeof fs.readdir);
    await inbox.cleanup();
    expect(await exists(path.join(tree, "project", "deep", "b.txt"))).toBe(true);
    // Read whole on the next pass, it is judged by its age again.
    readdir.mockRestore();
    await inbox.cleanup();
    expect(await exists(tree)).toBe(false);
  });
});

describe("reserving room for a tree", () => {
  /** A disk whose free space is read only once `together` reservations are all asking. */
  function disk(free: number) {
    let waiting: Array<() => void> = [];
    const state = {
      together: 1,
      freeBytes: async () => {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length < state.together) return;
          const ready = waiting;
          waiting = [];
          for (const go of ready) go();
        });
        return free;
      },
    };
    return state;
  }
  const granted = (reservations: Array<unknown>) =>
    reservations.filter((reservation) => reservation !== null);

  it("refuses the second of two reservations that only fit one at a time", async () => {
    const free = disk(100);
    const inbox = new HostInbox({ root, freeBytes: free.freeBytes, freeSpaceMarginBytes: 0 });
    free.together = 2;
    const first = await Promise.all([inbox.reserve(60), inbox.reserve(60)]);
    expect(granted(first)).toHaveLength(1);
    free.together = 1;
    const held = first.find((reservation) => reservation !== null)!;
    expect(await inbox.reserve(41)).toBeNull();
    const rest = await inbox.reserve(40);
    expect(rest).not.toBeNull();

    held.release();
    held.release();
    // Only `held` went, however often released: the 40 still held leaves 60, not 61.
    expect(await inbox.reserve(61)).toBeNull();
    rest!.release();
    const whole = await inbox.reserve(100);
    expect(whole).not.toBeNull();
    whole!.release();

    free.together = 2;
    expect(granted(await Promise.all([inbox.reserve(60), inbox.reserve(60)]))).toHaveLength(1);
  });

  it("keeps the margin free beyond every reservation", async () => {
    const inbox = new HostInbox({
      root,
      freeBytes: disk(100).freeBytes,
      freeSpaceMarginBytes: 10,
    });
    expect(await inbox.reserve(91)).toBeNull();
    expect(await inbox.reserve(90)).not.toBeNull();
  });

  it("admits when the disk's free space can't be read, as single files do", async () => {
    const inbox = new HostInbox({ root, freeBytes: async () => null });
    expect(await inbox.reserve(10 * 1024 * 1024 * 1024)).not.toBeNull();
    await expect(inbox.reserve(-1)).rejects.toThrow(RangeError);
    await expect(inbox.reserve(1.5)).rejects.toThrow(RangeError);
  });

  it("reads the disk's free space by default", async () => {
    const statfs = vi.spyOn(fs, "statfs").mockResolvedValue({ bavail: 10, bsize: 4096 } as never);
    const inbox = new HostInbox({ root, freeSpaceMarginBytes: 0 });
    const whole = await inbox.reserve(10 * 4096);
    expect(whole).not.toBeNull();
    expect(await inbox.reserve(1)).toBeNull();
    whole!.release();
    expect(await inbox.reserve(10 * 4096 + 1)).toBeNull();
    expect(statfs).toHaveBeenCalledWith(root);

    statfs.mockRejectedValue(new Error("unsupported"));
    expect(await inbox.reserve(10 * 4096 + 1)).not.toBeNull();
  });
});

async function addFileAt(dir: string, ageMs: number): Promise<void> {
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "a"), "x");
  await age(path.join(dir, "a"), ageMs);
  await age(dir, ageMs);
}
