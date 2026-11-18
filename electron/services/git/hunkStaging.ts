import { GIT_FILE_DIFF_MAX_PATCH_BYTES } from "../../../shared/config/gitReadLimits.js";
import type { GitHunkStagingResult } from "../../../shared/types/ipc/git.js";
import {
  buildHunkPatch,
  hasNoContext,
  isPlainModification,
  matchHunks,
  parseFilePatch,
  type PatchHunk,
} from "../../../shared/utils/patchHunks.js";
import { runExclusive } from "../../utils/keyedMutex.js";
import { gitIndexWriteKey } from "../../utils/gitIndexWriteKey.js";
import { AppError } from "../../utils/errorTypes.js";
import { GitCommandError, runGitForBytes } from "./reviewPoint/runGit.js";

export type HunkStagingDirection = "stage" | "unstage";

const GIT_TIMEOUT_MS = 30_000;
const SMALL_OUTPUT_BYTES = 64 * 1024;
const REGULAR_INDEX_ENTRY = /^(100644|100755) [0-9a-f]+ 0\t/;

/**
 * The path git knows a file by. A backslash is a separator only on Windows;
 * elsewhere it is part of a name, and `a\\b.ts` is a different file from
 * `a/b.ts`, so rewriting it there would verify and stage the wrong one.
 */
export function gitPathFor(filePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? filePath.replaceAll("\\", "/") : filePath;
}

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

/**
 * The one index entry for `gitPath` (its mode, blob and stage, as `ls-files -s`
 * prints them), or null unless it is a regular file with no conflict.
 */
async function readRegularIndexEntry(cwd: string, gitPath: string): Promise<string | null> {
  const { stdout } = await runGitForBytes(cwd, ["ls-files", "-s", "-z", "--", gitPath], {
    timeoutMs: GIT_TIMEOUT_MS,
    maxStdoutBytes: SMALL_OUTPUT_BYTES,
  });
  const entries = stdout.toString("utf8").split("\0").filter(Boolean);
  if (entries.length !== 1) return null;
  const entry = entries[0]!;
  const regular =
    REGULAR_INDEX_ENTRY.test(entry) && entry.slice(entry.indexOf("\t") + 1) === gitPath;
  return regular ? entry : null;
}

/**
 * The side's diff as the pane reads it, but with fixed prefixes, so a user's
 * `diff.noprefix` or `diff.mnemonicPrefix` can't change how `git apply` reads
 * the paths. Context width, algorithm and the rest of the user's diff config
 * stay as they are: they decide where git's hunks start and end, and the
 * hunks have to come out the same as the ones the pane showed. Objects are
 * read as they are, never through replace refs (`runGitForBytes`), as the
 * apply reads them: a hunk the pane saw through a replacement then matches only
 * where the real object agrees, and is refused anywhere else rather than
 * placed by lines the index doesn't hold. Null when the
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

// The index moved under the patch: its lines aren't where they were, or the
// entry is gone.
function isIndexMismatch(error: GitCommandError): boolean {
  return /patch does not apply|patch failed|does not exist in index/i.test(error.stderr);
}

/**
 * Whether a hunk the renderer sent can't be trusted to hold the file's bytes.
 * The pane decodes its diff leniently, so a byte that isn't UTF-8 reaches it
 * as U+FFFD, and the same character written into the file afterwards would
 * then compare equal to it. A file that really holds U+FFFD is refused with it.
 */
function readLossily(read: readonly PatchHunk[]): boolean {
  return read.some((hunk) => hunk.lines.some((line) => line.includes("\uFFFD")));
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
 * Every write Daintree makes to one worktree's index runs one at a time under
 * the same key, so none of them lands between the read and the apply. Another
 * git process still can, as it can under `git add -p`. The entry is read again
 * just before the apply and a change refuses it, which leaves only the moment
 * between that read and git taking its own lock; a context line then refuses
 * a hunk whose place moved, while a zero-context hunk has none to check.
 */
export function applyReadHunks(
  cwd: string,
  gitPath: string,
  read: readonly PatchHunk[],
  direction: HunkStagingDirection
): Promise<GitHunkStagingResult> {
  return runExclusive(gitIndexWriteKey(cwd), async () => {
    if (readLossily(read)) return { status: "unsupported" };
    const entry = await readRegularIndexEntry(cwd, gitPath);
    if (entry === null) return { status: "unsupported" };

    const text = await readSideDiff(cwd, gitPath, direction);
    if (text === null) return { status: "unsupported" };
    const fresh = parseFilePatch(text);
    if (!fresh || fresh.hunks.length === 0 || !isPlainModification(fresh.header)) {
      return { status: "stale" };
    }

    const selected = matchHunks(fresh, read, { matchNewStart: direction === "unstage" });
    if (selected === null) return { status: "stale" };

    const patch = buildHunkPatch(fresh, selected, direction === "stage" ? "forward" : "reverse");
    const zeroContext = [...selected].some((index) => hasNoContext(fresh.hunks[index]!));
    if ((await readRegularIndexEntry(cwd, gitPath)) !== entry) return { status: "stale" };
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
        if (isIndexMismatch(error)) return { status: "stale" };
      }
      throw error;
    }
    return { status: "applied" };
  });
}
