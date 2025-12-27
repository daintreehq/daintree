import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { nanoid } from "nanoid";

export interface NoteMetadata {
  id: string;
  title: string;
  scope: "worktree" | "project";
  worktreeId?: string;
  createdAt: number;
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
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  private getNotesDir(): string {
    return path.join(this.projectPath, ".canopy", "notes");
  }

  private validatePath(notePath: string): string {
    const notesDir = path.resolve(this.getNotesDir());
    const resolved = path.resolve(notesDir, notePath);
    const relative = path.relative(notesDir, resolved);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Path traversal detected");
    }

    return resolved;
  }

  async ensureNotesDir(): Promise<void> {
    const notesDir = this.getNotesDir();
    await fs.mkdir(notesDir, { recursive: true });
    await this.ensureGitignore();
  }

  private async ensureGitignore(): Promise<void> {
    const gitignorePath = path.join(this.projectPath, ".gitignore");
    const canopyNotesEntry = ".canopy/notes/";

    try {
      let content = "";
      try {
        content = await fs.readFile(gitignorePath, "utf-8");
      } catch {
        // File doesn't exist, will create
      }

      if (!content.includes(canopyNotesEntry)) {
        const newEntry =
          content.endsWith("\n") || content === ""
            ? `${canopyNotesEntry}\n`
            : `\n${canopyNotesEntry}\n`;
        await fs.appendFile(gitignorePath, newEntry, "utf-8");
      }
    } catch (error) {
      console.error("[NotesService] Failed to update .gitignore:", error);
    }
  }

  private extractPreview(content: string, maxLength: number = 100): string {
    const firstLine = content.split("\n").find((line) => line.trim()) || "";
    return firstLine.slice(0, maxLength);
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

    await fs.writeFile(absolutePath, frontmatter, "utf-8");

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

      return {
        metadata: data as NoteMetadata,
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

    // Filter out undefined values to prevent YAML serialization errors
    const cleanMetadata = Object.fromEntries(
      Object.entries(metadata).filter(([, v]) => v !== undefined)
    );

    const fileContent = matter.stringify(content, cleanMetadata);

    await fs.writeFile(absolutePath, fileContent, "utf-8");

    const stats = await fs.stat(absolutePath);
    return { lastModified: stats.mtimeMs };
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
          const metadata = data as NoteMetadata;

          notes.push({
            id: metadata.id,
            title: metadata.title,
            path: relativePath,
            scope: metadata.scope,
            worktreeId: metadata.worktreeId,
            createdAt: metadata.createdAt,
            modifiedAt: stats.mtimeMs,
            preview: this.extractPreview(content),
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
          const metadata = data as NoteMetadata;

          // Search in title and content
          const titleMatch = metadata.title.toLowerCase().includes(lowerQuery);
          const contentMatch = content.toLowerCase().includes(lowerQuery);

          if (titleMatch || contentMatch) {
            matchingNotes.push({
              id: metadata.id,
              title: metadata.title,
              path: relativePath,
              scope: metadata.scope,
              worktreeId: metadata.worktreeId,
              createdAt: metadata.createdAt,
              modifiedAt: stats.mtimeMs,
              preview: this.extractPreview(content),
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
    await fs.unlink(absolutePath);
  }

  setProjectPath(projectPath: string): void {
    this.projectPath = projectPath;
  }
}
