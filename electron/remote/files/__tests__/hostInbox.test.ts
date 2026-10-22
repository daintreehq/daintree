import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectImageType,
  HostInbox,
  reconcileImageExtension,
  sanitizeInboxName,
} from "../hostInbox.js";

let base: string;
let root: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "inbox-test-")));
  root = path.join(base, "daintree-inbox");
});

afterEach(async () => {
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
    expect(long.endsWith(".txt")).toBe(true);
    expect("界".repeat(100).startsWith(long.slice(0, -".txt".length))).toBe(true);

    const emoji = sanitizeInboxName(`${"😀".repeat(70)}.md`, "linux");
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(255);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(emoji.endsWith(".md")).toBe(true);
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

async function addFileAt(dir: string, ageMs: number): Promise<void> {
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "a"), "x");
  await age(path.join(dir, "a"), ageMs);
  await age(dir, ageMs);
}
