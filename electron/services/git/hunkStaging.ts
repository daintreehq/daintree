import path from "node:path";
import { GIT_FILE_DIFF_MAX_PATCH_BYTES } from "../../../shared/config/gitReadLimits.js";
import type { GitHunkStagingResult } from "../../../shared/types/ipc/git.js";
import {
  buildHunkPatch,
  findHunk,
  hasNoContext,
  isPlainModification,
  parseFilePatch,
  type PatchHunk,
} from "../../../shared/utils/patchHunks.js";
import { runExclusive } from "../../utils/keyedMutex.js";
import { AppError } from "../../utils/errorTypes.js";
import { GitCommandError, runGitForBytes } from "./reviewPoint/runGit.js";

export type HunkStagingDirection = "stage" | "unstage";

const GIT_TIMEOUT_MS = 30_000;
const SMALL_OUTPUT_BYTES = 64 * 1024;
const REGULAR_INDEX_ENTRY = /^(100644|100755) [0-9a-f]+ 0\t/;

/**
 * Parse the hunks a renderer read. Each must be one bare hunk, header line
 * first; anything else is a malformed request, not a stale one.
 */
export function parseReadHunks(texts: readonly string[]): PatchHunk[] {
  return texts.map((text) => {
    const parsed = parseFilePatch(text);
    if (!parsed || parsed.header.length > 0 || parsed.hunks.length !== 1) {
      throw new AppError({
        code: "VALIDATION",
        message: "Each hunk must be one unified-diff hunk",
      });
    }
    return parsed.hunks[0]!;
  });
}

/** The one index entry for `gitPath`, when it is a regular file with no conflict. */
async function hasRegularIndexEntry(cwd: string, gitPath: string): Promise<boolean> {
  const { stdout } = await runGitForBytes(cwd, ["ls-files", "-s", "-z", "--", gitPath], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxStdoutBytes: SMALL_OUTPUT_BYTES,
  });
  const entries = stdout.toString("utf8").split("\0").filter(Boolean);
  if (entries.length !== 1) return false;
  const entry = entries[0]!;
  return REGULAR_INDEX_ENTRY.test(entry) && entry.slice(entry.indexOf("\t") + 1) === gitPath;
}

/**
 * The side's diff as the pane reads it, but with fixed prefixes, so a user's
 * `diff.noprefix` or `diff.mnemonicPrefix` can't change how `git apply` reads
 * the paths. Context width, algorithm and the rest of the user's diff config
 * stay as they are: they decide where git's hunks start and end, and the
 * hunks have to come out the same as the ones the pane showed. Null when the
 * output isn't UTF-8: a lossy decode could make two different lines compare
 * equal, and would write the replacement characters into the index.
 */
async function readSideDiff(
  cwd: string,
  gitPath: string,
  direction: HunkStagingDirection
): Promise<string | null> {
  const { stdout } = await runGitForBytes(
    cwd,
    [
      "diff",
      ...(direction === "unstage" ? ["--cached"] : []),
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--submodule=short",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      gitPath,
    ],
    { timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: GIT_FILE_DIFF_MAX_PATCH_BYTES }
  );
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout);
  } catch {
    return null;
  }
}

function isIndexLocked(error: GitCommandError): boolean {
  return /index\.lock'?: File exists|another git process seems to be running/i.test(error.stderr);
}

function isPreimageMismatch(error: GitCommandError): boolean {
  return /patch does not apply|patch failed/i.test(error.stderr);
}

/**
 * Stage (or unstage) git's hunks of one file as the diff pane read them
 * (#17331).
 *
 * The side's diff is read again first, and each hunk has to be in it still,
 * the same lines at the same old start: an agent writing elsewhere in the file
 * moves only the new side, so that never holds the user up, but lines it
 * rewrote are refused as `stale`, since staging the version on screen would let
 * a commit record code that is in neither HEAD nor the file. The patch is then
 * built from that fresh read, never from the renderer's text, with each hunk's
 * start shifted past the hunks left out, as `git add -p` does.
 *
 * Every write to one worktree's index from here runs one at a time with the
 * other batched index writes, so nothing Daintree does lands between the read
 * and the apply. Another git process still can, as it can under `git add -p`;
 * the apply then fails or lands where git finds the same lines.
 */
export function applyReadHunks(
  cwd: string,
  gitPath: string,
  read: readonly PatchHunk[],
  direction: HunkStagingDirection
): Promise<GitHunkStagingResult> {
  return runExclusive(`git-index-batches:${path.resolve(cwd)}`, async () => {
    if (!(await hasRegularIndexEntry(cwd, gitPath))) return { status: "unsupported" };

    const text = await readSideDiff(cwd, gitPath, direction);
    if (text === null) return { status: "unsupported" };
    const fresh = parseFilePatch(text);
    if (!fresh || fresh.hunks.length === 0 || !isPlainModification(fresh.header)) {
      return { status: "stale" };
    }

    const selected = new Set<number>();
    for (const hunk of read) {
      const index = findHunk(fresh, hunk, selected);
      if (index === null) return { status: "stale" };
      selected.add(index);
    }

    const patch = buildHunkPatch(fresh, selected, direction === "stage" ? "forward" : "reverse");
    const zeroContext = [...selected].some((index) => hasNoContext(fresh.hunks[index]!));
    try {
      await runGitForBytes(
        cwd,
        [
          "apply",
          "--cached",
          ...(direction === "unstage" ? ["-R"] : []),
          "--whitespace=nowarn",
          ...(zeroContext ? ["--unidiff-zero"] : []),
          "-",
        ],
        {
          input: Buffer.from(patch, "utf8"),
          timeoutMs: GIT_TIMEOUT_MS,
          maxStdoutBytes: SMALL_OUTPUT_BYTES,
          // A user's `apply.ignoreWhitespace` would let a hunk match lines
          // that differ from the ones it was checked against.
          config: [["apply.ignoreWhitespace", "no"]],
        }
      );
    } catch (error) {
      if (error instanceof GitCommandError) {
        if (isIndexLocked(error)) {
          throw new AppError({ code: "GIT_INDEX_LOCKED", message: error.message, cause: error });
        }
        // Another process moved the index between the read and the apply.
        if (isPreimageMismatch(error)) return { status: "stale" };
      }
      throw error;
    }
    return { status: "applied" };
  });
}
