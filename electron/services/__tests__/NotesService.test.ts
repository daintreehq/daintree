import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotesService, NoteConflictError, type NoteMetadata } from "../NotesService.js";

const projectId = "test-project-id";

function makeMetadata(overrides: Partial<NoteMetadata> = {}): NoteMetadata {
  return {
    id: "note-1",
    title: "Sample Note",
    scope: "project",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("NotesService", () => {
  let userDataDir: string;
  let service: NotesService;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-notes-service-"));
    service = new NotesService(userDataDir, projectId);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("stores notes under userData/notes/projectId, not in project directory", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-project-"));
    try {
      await service.create("Test note", "project");

      const notesDir = path.join(userDataDir, "notes", projectId);
      const files = await fs.readdir(notesDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.md$/);

      // Ensure no .daintree directory was created in any project-like dir
      const daintreeExists = await fs
        .access(path.join(projectDir, ".daintree"))
        .then(() => true)
        .catch(() => false);
      expect(daintreeExists).toBe(false);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects mixed-separator traversal paths in write/read/delete", async () => {
    const metadata = makeMetadata();

    await expect(
      service.write("safe\\..\\escape.md", "payload", metadata, undefined)
    ).rejects.toThrow("Path traversal detected");

    await expect(service.read("safe\\..\\escape.md")).rejects.toThrow("Path traversal detected");

    await expect(service.delete("safe\\..\\escape.md")).rejects.toThrow("Path traversal detected");
  });

  it("rejects absolute and blank paths in write/read/delete", async () => {
    const metadata = makeMetadata();
    const invalidPaths = [
      "",
      "   ",
      "/tmp/escape.md",
      "C:\\escape.md",
      "\\\\server\\share\\note.md",
    ];

    for (const invalidPath of invalidPaths) {
      await expect(service.write(invalidPath, "payload", metadata)).rejects.toThrow(
        "Path traversal detected"
      );
      await expect(service.read(invalidPath)).rejects.toThrow("Path traversal detected");
      await expect(service.delete(invalidPath)).rejects.toThrow("Path traversal detected");
    }
  });

  it("allows filenames containing double-dot that are not traversal segments", async () => {
    const metadata = makeMetadata();

    const writeResult = await service.write("safe..name.md", "content", metadata);
    expect(writeResult.lastModified).toBeGreaterThan(0);

    const readResult = await service.read("safe..name.md");
    expect(readResult.content.trimEnd()).toBe("content");
    expect(readResult.metadata.title).toBe(metadata.title);
  });

  it("throws NoteConflictError when expected mtime is stale", async () => {
    const created = await service.create("Conflict note", "project");

    await service.write(created.path, "updated", created.metadata);
    const staleTimestamp = created.lastModified - 5000;

    await expect(
      service.write(created.path, "newer", created.metadata, staleTimestamp)
    ).rejects.toBeInstanceOf(NoteConflictError);
  });

  it("returns empty list/search when notes directory does not exist", async () => {
    expect(await service.list()).toEqual([]);
    expect(await service.search("anything")).toEqual({ notes: [], query: "anything" });
  });

  it("skips malformed note files during list/search without crashing", async () => {
    const created = await service.create("Search me", "project");
    const notesDir = path.join(userDataDir, "notes", projectId);
    await fs.writeFile(path.join(notesDir, "bad.md"), "---\nfoo: [\n---\ncontent", "utf8");

    const listed = await service.list();
    expect(listed.some((note) => note.path === created.path)).toBe(true);

    const search = await service.search("search");
    expect(search.notes.some((note) => note.path === created.path)).toBe(true);
  });

  it("skips files with invalid note metadata schema", async () => {
    const created = await service.create("Healthy note", "project");
    const notesDir = path.join(userDataDir, "notes", projectId);
    await fs.writeFile(
      path.join(notesDir, "invalid-metadata.md"),
      "---\nid: invalid\nscope: project\ncreatedAt: nope\n---\nbody",
      "utf8"
    );

    const listed = await service.list();
    expect(listed.some((note) => note.path === created.path)).toBe(true);
    expect(listed.some((note) => note.path === "invalid-metadata.md")).toBe(false);

    const searched = await service.search("healthy");
    expect(searched.notes.some((note) => note.path === created.path)).toBe(true);
  });

  it("round-trips tags through frontmatter with normalization", async () => {
    const metadata = makeMetadata({ tags: ["Auth", " backend "] });
    await service.write("tagged.md", "body", metadata);

    const result = await service.read("tagged.md");
    expect(result.metadata.tags).toEqual(["auth", "backend"]);
  });

  it("returns empty tags array for notes without tags in frontmatter", async () => {
    const created = await service.create("No tags note", "project");
    const listed = await service.list();
    const note = listed.find((n) => n.id === created.metadata.id);
    expect(note).toBeDefined();
    expect(note!.tags).toEqual([]);
  });

  it("handles scalar string tags in YAML frontmatter", async () => {
    const notesDir = path.join(userDataDir, "notes", projectId);
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(
      path.join(notesDir, "scalar-tag.md"),
      "---\nid: scalar-1\ntitle: Scalar Tag\nscope: project\ncreatedAt: 1700000000000\ntags: auth\n---\nbody",
      "utf8"
    );

    const listed = await service.list();
    const note = listed.find((n) => n.id === "scalar-1");
    expect(note).toBeDefined();
    expect(note!.tags).toEqual(["auth"]);
  });

  it("includes tags in search results and searches tag text", async () => {
    const tagged = makeMetadata({ id: "tag-search", tags: ["deployment"] });
    await service.write("searchable.md", "plain content", tagged);

    const untagged = makeMetadata({ id: "no-match", title: "Other" });
    await service.write("other.md", "different content", untagged);

    const result = await service.search("deployment");
    expect(result.notes.some((n) => n.id === "tag-search")).toBe(true);
    expect(result.notes.find((n) => n.id === "tag-search")!.tags).toEqual(["deployment"]);
    expect(result.notes.some((n) => n.id === "no-match")).toBe(false);
  });

  it("normalizes scalar tags when reading a note", async () => {
    const notesDir = path.join(userDataDir, "notes", projectId);
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(
      path.join(notesDir, "scalar-read.md"),
      "---\nid: sr-1\ntitle: Scalar Read\nscope: project\ncreatedAt: 1700000000000\ntags: Auth\n---\nbody",
      "utf8"
    );

    const result = await service.read("scalar-read.md");
    expect(result.metadata.tags).toEqual(["auth"]);
  });

  it("omits tags key from frontmatter when tags array is empty", async () => {
    const metadata = makeMetadata({ tags: [] });
    await service.write("no-tags.md", "body", metadata);

    const raw = await fs.readFile(path.join(userDataDir, "notes", projectId, "no-tags.md"), "utf8");
    expect(raw).not.toContain("tags:");
  });

  describe("saveAttachment", () => {
    it("writes an attachment with a sha256 content-addressed filename", async () => {
      const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const result = await service.saveAttachment(data, "image/png", "clipboard.png");

      expect(result.relativePath).toMatch(/^attachments\/[0-9a-f]{64}\.png$/);
      expect(result.isNew).toBe(true);

      const absolutePath = path.join(userDataDir, "notes", projectId, result.relativePath);
      const written = await fs.readFile(absolutePath);
      expect(written.equals(data)).toBe(true);
    });

    it("dedups identical bytes and returns the same relative path", async () => {
      const data = Buffer.from("hello attachment");
      const first = await service.saveAttachment(data, "image/png");
      const second = await service.saveAttachment(data, "image/png");

      expect(second.relativePath).toBe(first.relativePath);
      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);

      const attachmentsDir = path.join(userDataDir, "notes", projectId, "attachments");
      const files = await fs.readdir(attachmentsDir);
      expect(files.length).toBe(1);
    });

    it("produces different paths for different bytes", async () => {
      const first = await service.saveAttachment(Buffer.from("alpha"), "image/png");
      const second = await service.saveAttachment(Buffer.from("beta"), "image/png");
      expect(second.relativePath).not.toBe(first.relativePath);
    });

    it("maps MIME types to correct extensions", async () => {
      const png = await service.saveAttachment(Buffer.from("a"), "image/png");
      const jpeg = await service.saveAttachment(Buffer.from("b"), "image/jpeg");
      const webp = await service.saveAttachment(Buffer.from("c"), "image/webp");
      const svg = await service.saveAttachment(Buffer.from("d"), "image/svg+xml");
      const gif = await service.saveAttachment(Buffer.from("e"), "image/gif");

      expect(png.relativePath.endsWith(".png")).toBe(true);
      expect(jpeg.relativePath.endsWith(".jpg")).toBe(true);
      expect(webp.relativePath.endsWith(".webp")).toBe(true);
      expect(svg.relativePath.endsWith(".svg")).toBe(true);
      expect(gif.relativePath.endsWith(".gif")).toBe(true);
    });

    it("falls back to original filename extension for unknown MIME types", async () => {
      const result = await service.saveAttachment(
        Buffer.from("pdf body"),
        "application/x-unknown",
        "spec.pdf"
      );
      expect(result.relativePath.endsWith(".pdf")).toBe(true);
    });

    it("uses .bin when MIME and filename are both unknown", async () => {
      const result = await service.saveAttachment(Buffer.from("mystery"), "application/x-unknown");
      expect(result.relativePath.endsWith(".bin")).toBe(true);
    });

    it("rejects empty buffers", async () => {
      await expect(service.saveAttachment(Buffer.alloc(0), "image/png")).rejects.toThrow(
        "Attachment is empty"
      );
    });

    it("rejects attachments that exceed the size limit", async () => {
      const oversized = Buffer.alloc(51 * 1024 * 1024);
      await expect(service.saveAttachment(oversized, "image/png")).rejects.toThrow(
        /Attachment too large/
      );
    });

    it("creates the attachments directory on first call", async () => {
      const attachmentsDir = path.join(userDataDir, "notes", projectId, "attachments");
      await expect(fs.access(attachmentsDir)).rejects.toBeDefined();

      await service.saveAttachment(Buffer.from("hello"), "image/png");
      await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();
    });

    it("rejects path-traversal attempts via malicious originalName extensions", async () => {
      // Extensions must not contain slashes or dots
      const result = await service.saveAttachment(
        Buffer.from("payload"),
        "application/x-unknown",
        "../../escape.weird"
      );
      // Should accept the extension but sanitize to safe form
      expect(result.relativePath.startsWith("attachments/")).toBe(true);
      expect(result.relativePath.includes("..")).toBe(false);
    });
  });

  describe("getDirPath", () => {
    it("returns the absolute notes directory for the project", () => {
      const dir = service.getDirPath();
      expect(dir).toBe(path.join(userDataDir, "notes", projectId));
    });
  });
});
