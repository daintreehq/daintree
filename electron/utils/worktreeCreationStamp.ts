import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Marks a linked worktree as one Daintree created (#17321). It sits in the
 * worktree's own administrative directory (`.git/worktrees/<name>/`), so git
 * removes it with the worktree, a checkout made later at the same path by hand
 * gets a fresh directory without it, and nothing inside the checkout can forge
 * it. The topology watcher ignores the name: it is not one git reads.
 */
export const WORKTREE_CREATION_STAMP_FILE = "daintree-created";

export interface WorktreeCreationStamp {
  createdAt: number;
  branch: string;
}

export async function writeWorktreeCreationStamp(
  gitDir: string,
  stamp: WorktreeCreationStamp
): Promise<void> {
  await writeFile(
    path.join(gitDir, WORKTREE_CREATION_STAMP_FILE),
    `${JSON.stringify({ createdAt: stamp.createdAt, branch: stamp.branch })}\n`,
    { encoding: "utf8", flag: "wx" }
  );
}

/**
 * The stamp in `gitDir`, or null when there is none. Rejects when the file is
 * there but can't be read or doesn't parse, so a caller deciding whether to
 * remove the worktree never reads "unknown" as "not ours" or as "ours".
 */
export async function readWorktreeCreationStamp(
  gitDir: string
): Promise<WorktreeCreationStamp | null> {
  let text: string;
  try {
    text = await readFile(path.join(gitDir, WORKTREE_CREATION_STAMP_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("worktree creation stamp is not an object");
  }
  const { createdAt, branch } = parsed as { createdAt?: unknown; branch?: unknown };
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || typeof branch !== "string") {
    throw new Error("worktree creation stamp is malformed");
  }
  return { createdAt, branch };
}
