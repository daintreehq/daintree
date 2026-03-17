import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotesService, NoteConflictError, type NoteMetadata } from "../NotesService.js";

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
  let projectDir: string;
  let service: NotesService;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "canopy-notes-service-"));
    service = new NotesService(projectDir);
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("adds .canopy/notes entry to .gitignore only once", async () => {
    await service.create("First note", "project");
    await service.create("Second note", "project");

    const gitignorePath = path.join(projectDir, ".gitignore");
    const content = await fs.readFile(gitignorePath, "utf8");
    const matches = content.match(/\.canopy\/notes\//g) ?? [];

    expect(matches).toHaveLength(1);
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
    const notesDir = path.join(projectDir, ".canopy", "notes");
    await fs.writeFile(path.join(notesDir, "bad.md"), "---\nfoo: [\n---\ncontent", "utf8");

    const listed = await service.list();
    expect(listed.some((note) => note.path === created.path)).toBe(true);

    const search = await service.search("search");
    expect(search.notes.some((note) => note.path === created.path)).toBe(true);
  });

  it("skips files with invalid note metadata schema", async () => {
    const created = await service.create("Healthy note", "project");
    const notesDir = path.join(projectDir, ".canopy", "notes");
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
    const notesDir = path.join(projectDir, ".canopy", "notes");
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
    const notesDir = path.join(projectDir, ".canopy", "notes");
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

    const raw = await fs.readFile(path.join(projectDir, ".canopy", "notes", "no-tags.md"), "utf8");
    expect(raw).not.toContain("tags:");
  });
});
