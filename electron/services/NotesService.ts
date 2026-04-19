import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resilientAtomicWriteFile, resilientUnlink } from "../utils/fs.js";
import matter from "gray-matter";
import { nanoid } from "nanoid";
import { normalizeTags } from "../../shared/utils/noteTags.js";

export const NOTES_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  "application/zip": ".zip",
};

function sanitizeExtension(ext: string): string {
  if (!ext) return "";
  const lower = ext.toLowerCase();
  const match = lower.match(/^\.[a-z0-9]{1,10}$/);
  return match ? match[0] : "";
}

function deriveExtension(mimeType: string, originalName?: string): string {
  const fromMime = MIME_TO_EXT[mimeType.toLowerCase()];
  if (fromMime) return fromMime;

  if (originalName) {
    const ext = sanitizeExtension(path.extname(originalName));
    if (ext) return ext;
  }

  return ".bin";
}

export interface NoteMetadata {
  id: string;
  title: string;
  scope: "worktree" | "project";
  worktreeId?: string;
  createdAt: number;
  tags?: string[];
}

export interface NoteContent {
  metadata: NoteMetadata;
  content: string;
  path: string;
  lastModified: number;
}

export interface NoteListItem {
  id: string;
  title: string;
  path: string;
  scope: "worktree" | "project";
  worktreeId?: string;
  createdAt: number;
  modifiedAt: number;
  preview: string;
  tags: string[];
}

export interface SearchResult {
  notes: NoteListItem[];
  query: string;
}

export class NoteConflictError extends Error {
  constructor(
    message: string,
    public readonly currentLastModified: number
  ) {
    super(message);
    this.name = "NoteConflictError";
  }
}

export class NotesService {
  private userDataPath: string;
  private projectId: string;

  constructor(userDataPath: string, projectId: string) {
    this.userDataPath = userDataPath;
    this.projectId = projectId;
  }

  private getNotesDir(): string {
    return path.join(this.userDataPath, "notes", this.projectId);
  }

  private validatePath(notePath: string): string {
    const normalizedPath = notePath.trim().replace(/\\/g, "/");

    if (
      normalizedPath.length === 0 ||
      path.posix.isAbsolute(normalizedPath) ||
      path.win32.isAbsolute(normalizedPath)
    ) {
      throw new Error("Path traversal detected");
    }

    const segments = normalizedPath.split("/").filter((segment) => segment && segment !== ".");
    if (segments.includes("..")) {
      throw new Error("Path traversal detected");
    }

    const notesDir = path.resolve(this.getNotesDir());
    const resolved = path.resolve(notesDir, ...segments);
    const relative = path.relative(notesDir, resolved);

    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Path traversal detected");
    }

    return resolved;
  }

  async ensureNotesDir(): Promise<void> {
    const notesDir = this.getNotesDir();
    await fs.mkdir(notesDir, { recursive: true });
  }

  private extractPreview(content: string, maxLength: number = 100): string {
    const firstLine = content.split("\n").find((line) => line.trim()) || "";
    return firstLine.slice(0, maxLength);
  }

  private parseMetadata(data: unknown): NoteMetadata | null {
    if (!data || typeof data !== "object") {
      return null;
    }

    const candidate = data as Partial<NoteMetadata>;
    const scope = candidate.scope;

    if (
      typeof candidate.id !== "string" ||
      typeof candidate.title !== "string" ||
      (scope !== "worktree" && scope !== "project") ||
      typeof candidate.createdAt !== "number" ||
      Number.isNaN(candidate.createdAt)
    ) {
      return null;
    }

    if (candidate.worktreeId !== undefined && typeof candidate.worktreeId !== "string") {
      return null;
    }

    const tags = normalizeTags((data as Record<string, unknown>).tags);

    return {
      id: candidate.id,
      title: candidate.title,
      scope,
      ...(candidate.worktreeId !== undefined && { worktreeId: candidate.worktreeId }),
      createdAt: candidate.createdAt,
      ...(tags.length > 0 && { tags }),
    };
  }

  async create(
    title: string,
    scope: "worktree" | "project",
    worktreeId?: string
  ): Promise<NoteContent> {
    await this.ensureNotesDir();

    const id = nanoid();
    const createdAt = Date.now();
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 50);
    const filename = `${slug || "note"}-${id.substring(0, 8)}.md`;
    const relativePath = filename;
    const absolutePath = this.validatePath(relativePath);

    const metadata: NoteMetadata = {
      id,
      title,
      scope,
      ...(worktreeId !== undefined && { worktreeId }),
      createdAt,
    };

    const frontmatter = matter.stringify("", metadata);

    await resilientAtomicWriteFile(absolutePath, frontmatter, "utf-8");

    const stats = await fs.stat(absolutePath);

    return {
      metadata,
      content: "",
      path: relativePath,
      lastModified: stats.mtimeMs,
    };
  }

  async read(notePath: string): Promise<NoteContent> {
    const absolutePath = this.validatePath(notePath);

    try {
      const [fileContent, stats] = await Promise.all([
        fs.readFile(absolutePath, "utf-8"),
        fs.stat(absolutePath),
      ]);
      const { data, content } = matter(fileContent);
      const rawMetadata = data as NoteMetadata;
      const tags = normalizeTags((data as Record<string, unknown>).tags);

      return {
        metadata: {
          ...rawMetadata,
          ...(tags.length > 0 ? { tags } : { tags: undefined }),
        },
        content: content.replace(/^\n/, ""),
        path: notePath,
        lastModified: stats.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Note not found: ${notePath}`);
      }
      throw error;
    }
  }

  async write(
    notePath: string,
    content: string,
    metadata: NoteMetadata,
    expectedLastModified?: number
  ): Promise<{ lastModified: number }> {
    const absolutePath = this.validatePath(notePath);
    await this.ensureNotesDir();
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });

    // Check for conflicts if expectedLastModified is provided
    if (expectedLastModified !== undefined) {
      try {
        const currentStats = await fs.stat(absolutePath);
        // Allow 1 second tolerance for filesystem timestamp precision
        if (Math.abs(currentStats.mtimeMs - expectedLastModified) > 1000) {
          throw new NoteConflictError("Note has been modified externally", currentStats.mtimeMs);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        // File doesn't exist, that's fine for new notes
      }
    }

    // Normalize tags at write time
    const normalizedTags = normalizeTags(metadata.tags);

    // Filter out undefined values and empty tags to prevent YAML serialization errors
    const cleanMetadata = Object.fromEntries(
      Object.entries({
        ...metadata,
        tags: normalizedTags.length > 0 ? normalizedTags : undefined,
      }).filter(([, v]) => v !== undefined)
    );

    const fileContent = matter.stringify(content, cleanMetadata);

    await resilientAtomicWriteFile(absolutePath, fileContent, "utf-8");

    const stats = await fs.stat(absolutePath);
    return { lastModified: stats.mtimeMs };
  }

  /**
   * Reads the current disk version of the note and writes it to a dated
   * sibling file. Used to preserve an externally-modified version when the
   * user is about to force-save their in-memory buffer to the original path.
   *
   * The returned relative path points to the preserved on-disk content; it
   * carries its own frontmatter with a fresh id and a `(conflict YYYY-MM-DD)`
   * title suffix so it appears in the notes list without collisions.
   */
  async createConflictCopy(notePath: string): Promise<{ conflictPath: string }> {
    const original = await this.read(notePath);

    const posixDir = path.posix.dirname(notePath.replace(/\\/g, "/"));
    const relDir = posixDir === "." ? "" : posixDir;
    const base = path.posix.basename(notePath.replace(/\\/g, "/"), ".md");
    // Use local date: the filename should match the day the user experienced
    // the conflict, not a UTC date that can skew by a calendar day in the
    // evening in western timezones.
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;
    const notesDir = path.resolve(this.getNotesDir());

    // Atomically reserve a free filename via exclusive create (O_CREAT|O_EXCL)
    // so two concurrent conflict saves on the same note cannot both pick the
    // same slot and overwrite each other's preserved copy.
    let conflictRelativePath = "";
    await fs.mkdir(path.join(notesDir, relDir), { recursive: true });
    for (let i = 0; i < 1000; i++) {
      const suffix = i === 0 ? "" : `-${i + 1}`;
      const conflictName = `${base} (conflict ${date}${suffix}).md`;
      const candidateRelative = relDir ? `${relDir}/${conflictName}` : conflictName;
      const candidateAbs = path.join(notesDir, relDir, conflictName);
      try {
        const handle = await fs.open(candidateAbs, "wx");
        await handle.close();
        conflictRelativePath = candidateRelative;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
      }
    }

    if (!conflictRelativePath) {
      throw new Error("Failed to generate a unique conflict copy filename");
    }

    const conflictMetadata: NoteMetadata = {
      id: nanoid(),
      title: `${original.metadata.title} (conflict ${date})`,
      scope: original.metadata.scope,
      ...(original.metadata.worktreeId !== undefined && {
        worktreeId: original.metadata.worktreeId,
      }),
      createdAt: original.metadata.createdAt,
      ...(original.metadata.tags &&
        original.metadata.tags.length > 0 && { tags: original.metadata.tags }),
    };

    await this.write(conflictRelativePath, original.content, conflictMetadata);

    return { conflictPath: conflictRelativePath };
  }

  async list(): Promise<NoteListItem[]> {
    const notesDir = this.getNotesDir();

    try {
      await this.ensureNotesDir();
      const files = await fs.readdir(notesDir);

      const notes: NoteListItem[] = [];

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const filePath = path.join(notesDir, file);
        const relativePath = file;

        try {
          const [fileContent, stats] = await Promise.all([
            fs.readFile(filePath, "utf-8"),
            fs.stat(filePath),
          ]);
          const { data, content } = matter(fileContent);
          const metadata = this.parseMetadata(data);
          if (!metadata) {
            console.warn(`[NotesService] Skipping note with invalid metadata: ${file}`);
            continue;
          }

          notes.push({
            id: metadata.id,
            title: metadata.title,
            path: relativePath,
            scope: metadata.scope,
            worktreeId: metadata.worktreeId,
            createdAt: metadata.createdAt,
            modifiedAt: stats.mtimeMs,
            preview: this.extractPreview(content),
            tags: metadata.tags ?? [],
          });
        } catch (error) {
          console.error(`[NotesService] Failed to read note ${file}:`, error);
        }
      }

      return notes.sort((a, b) => b.modifiedAt - a.modifiedAt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async search(query: string): Promise<SearchResult> {
    if (!query.trim()) {
      return { notes: await this.list(), query };
    }

    const notesDir = this.getNotesDir();
    const lowerQuery = query.toLowerCase();

    try {
      await this.ensureNotesDir();
      const files = await fs.readdir(notesDir);

      const matchingNotes: NoteListItem[] = [];

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const filePath = path.join(notesDir, file);
        const relativePath = file;

        try {
          const [fileContent, stats] = await Promise.all([
            fs.readFile(filePath, "utf-8"),
            fs.stat(filePath),
          ]);
          const { data, content } = matter(fileContent);
          const metadata = this.parseMetadata(data);
          if (!metadata) {
            console.warn(`[NotesService] Skipping note with invalid metadata: ${file}`);
            continue;
          }

          const tags = metadata.tags ?? [];

          // Search in title, content, and tags
          const titleMatch = metadata.title.toLowerCase().includes(lowerQuery);
          const contentMatch = content.toLowerCase().includes(lowerQuery);
          const tagMatch = tags.some((t) => t.includes(lowerQuery));

          if (titleMatch || contentMatch || tagMatch) {
            matchingNotes.push({
              id: metadata.id,
              title: metadata.title,
              path: relativePath,
              scope: metadata.scope,
              worktreeId: metadata.worktreeId,
              createdAt: metadata.createdAt,
              modifiedAt: stats.mtimeMs,
              preview: this.extractPreview(content),
              tags,
            });
          }
        } catch (error) {
          console.error(`[NotesService] Failed to search note ${file}:`, error);
        }
      }

      return {
        notes: matchingNotes.sort((a, b) => b.modifiedAt - a.modifiedAt),
        query,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { notes: [], query };
      }
      throw error;
    }
  }

  async delete(notePath: string): Promise<void> {
    const absolutePath = this.validatePath(notePath);
    await resilientUnlink(absolutePath);
  }

  getProjectId(): string {
    return this.projectId;
  }

  getDirPath(): string {
    return this.getNotesDir();
  }

  getAttachmentsDir(): string {
    return path.join(this.getNotesDir(), "attachments");
  }

  async saveAttachment(
    data: Buffer,
    mimeType: string,
    originalName?: string
  ): Promise<{ relativePath: string; isNew: boolean }> {
    if (data.byteLength === 0) {
      throw new Error("Attachment is empty");
    }
    if (data.byteLength > NOTES_MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment too large (${data.byteLength} bytes, limit ${NOTES_MAX_ATTACHMENT_BYTES})`
      );
    }

    const extension = deriveExtension(mimeType, originalName);
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    const filename = `${hash}${extension}`;
    const relativePath = `attachments/${filename}`;
    const attachmentsDir = this.getAttachmentsDir();
    const absolutePath = path.join(attachmentsDir, filename);

    try {
      await fs.access(absolutePath);
      return { relativePath, isNew: false };
    } catch {
      // File doesn't exist — write it below
    }

    await fs.mkdir(attachmentsDir, { recursive: true });
    await resilientAtomicWriteFile(absolutePath, data);

    return { relativePath, isNew: true };
  }
}
