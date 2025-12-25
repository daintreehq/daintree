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
}

export interface NoteListItem {
  id: string;
  title: string;
  path: string;
  scope: "worktree" | "project";
  worktreeId?: string;
  createdAt: number;
  modifiedAt: number;
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

    return {
      metadata,
      content: "",
      path: relativePath,
    };
  }

  async read(notePath: string): Promise<NoteContent> {
    const absolutePath = this.validatePath(notePath);

    try {
      const fileContent = await fs.readFile(absolutePath, "utf-8");
      const { data, content } = matter(fileContent);

      return {
        metadata: data as NoteMetadata,
        content,
        path: notePath,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Note not found: ${notePath}`);
      }
      throw error;
    }
  }

  async write(notePath: string, content: string, metadata: NoteMetadata): Promise<void> {
    const absolutePath = this.validatePath(notePath);

    const fileContent = matter.stringify(content, metadata);

    await fs.writeFile(absolutePath, fileContent, "utf-8");
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
          const fileContent = await fs.readFile(filePath, "utf-8");
          const { data } = matter(fileContent);
          const metadata = data as NoteMetadata;

          const stats = await fs.stat(filePath);

          notes.push({
            id: metadata.id,
            title: metadata.title,
            path: relativePath,
            scope: metadata.scope,
            worktreeId: metadata.worktreeId,
            createdAt: metadata.createdAt,
            modifiedAt: stats.mtimeMs,
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

  async delete(notePath: string): Promise<void> {
    const absolutePath = this.validatePath(notePath);
    await fs.unlink(absolutePath);
  }

  setProjectPath(projectPath: string): void {
    this.projectPath = projectPath;
  }
}
