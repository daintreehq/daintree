import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import type { RebaseSequence, RepoState } from "../../../shared/types/git.js";
import {
  MAILBOX_APPLY_MARKER,
  OPERATION_SENTINEL_NAMES,
  getRepoOperationState,
} from "../../utils/gitRepoOperationState.js";
import { resolveGitDirFromFs } from "../../utils/gitUtils.js";
import { readRebaseSequence } from "../../utils/parseRebaseTodo.js";

export interface RepoOperationState {
  state: RepoState;
  rebaseStep: number | null;
  rebaseTotalSteps: number | null;
  rebaseSequence: RebaseSequence | null;
}

async function pathExists(p: string): Promise<boolean> {
  return fs.promises
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function readTextOrNull(p: string): Promise<string | null> {
  return fs.promises.readFile(p, "utf8").catch(() => null);
}

async function readRebaseProgress(
  gitDir: string,
  backend: "merge" | "apply"
): Promise<{ step: number | null; total: number | null }> {
  const dir = path.join(gitDir, backend === "merge" ? "rebase-merge" : "rebase-apply");
  const [stepRaw, totalRaw] = await Promise.all([
    readTextOrNull(path.join(dir, backend === "merge" ? "msgnum" : "next")),
    readTextOrNull(path.join(dir, backend === "merge" ? "end" : "last")),
  ]);
  const toInt = (raw: string | null): number | null => {
    if (raw == null) return null;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  };
  return { step: toInt(stepRaw), total: toInt(totalRaw) };
}

// Uncached on purpose: the sentinel checks below must look at the git dir the
// worktree has now, and the filesystem read is cheaper than a spawn anyway.
export async function resolveGitDir(git: SimpleGit, cwd: string): Promise<string> {
  const fromFs = await resolveGitDirFromFs(cwd);
  if (fromFs !== null) return fromFs;
  const raw = (await git.revparse(["--git-dir"])).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

export async function detectRepoOperationState(
  gitDir: string,
  hasUnmerged: boolean
): Promise<RepoOperationState> {
  const results = await Promise.all(
    OPERATION_SENTINEL_NAMES.map((name) => pathExists(path.join(gitDir, name)))
  );
  const has = (name: (typeof OPERATION_SENTINEL_NAMES)[number]) =>
    results[OPERATION_SENTINEL_NAMES.indexOf(name)] ?? false;

  // Checked before the rebase branch: an am session's `next`/`last` count
  // patches, not commits being replayed, and Continue/Abort must run `git am`.
  if (has("rebase-apply") && (await pathExists(path.join(gitDir, MAILBOX_APPLY_MARKER)))) {
    return {
      state: "APPLYING_MAILBOX",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    };
  }
  if (has("rebase-merge") || has("rebase-apply")) {
    const backend: "merge" | "apply" = has("rebase-merge") ? "merge" : "apply";
    const [{ step, total }, sequence] = await Promise.all([
      readRebaseProgress(gitDir, backend),
      // Only the merge backend stores per-commit todo/done; apply uses numbered
      // patches with no subject metadata. Null degrades the renderer cleanly.
      backend === "merge" ? readRebaseSequence(gitDir).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      state: "REBASING",
      rebaseStep: step,
      rebaseTotalSteps: total,
      rebaseSequence: sequence,
    };
  }
  if (has("CHERRY_PICK_HEAD")) {
    return {
      state: "CHERRY_PICKING",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    };
  }
  if (has("REVERT_HEAD")) {
    return { state: "REVERTING", rebaseStep: null, rebaseTotalSteps: null, rebaseSequence: null };
  }
  if (has("MERGE_HEAD")) {
    return { state: "MERGING", rebaseStep: null, rebaseTotalSteps: null, rebaseSequence: null };
  }
  return {
    state: hasUnmerged ? "DIRTY" : "CLEAN",
    rebaseStep: null,
    rebaseTotalSteps: null,
    rebaseSequence: null,
  };
}

/**
 * The file `state`'s operation writes once, as it starts, and keeps untouched
 * until it ends, relative to the git dir.
 *
 * Everything else in the operation's state moves while it runs: a rebase
 * rewrites `msgnum`, `done` and the todo on every step, and a multi-commit
 * cherry-pick or revert rewrites `CHERRY_PICK_HEAD`/`REVERT_HEAD` for each
 * commit it stops on, so those are not the operation, only where it is.
 *
 * - A rebase's `orig-head` (both backends).
 * - A `git am` session's `applying`, the marker it writes in `rebase-apply/` as
 *   it starts. It writes no `orig-head`, and its `next` moves with each patch.
 * - A multi-commit cherry-pick or revert's `sequencer/head`, the HEAD it
 *   started from, which is also what git's own `--abort` rolls back to. A
 *   single-commit one runs without a sequencer and has only its `*_HEAD`.
 * - A merge's `MERGE_HEAD`.
 */
async function operationAnchor(gitDir: string, state: RepoState): Promise<string | null> {
  switch (state) {
    case "REBASING":
      return (await pathExists(path.join(gitDir, "rebase-merge")))
        ? "rebase-merge/orig-head"
        : "rebase-apply/orig-head";
    case "CHERRY_PICKING":
    case "REVERTING":
      if (await pathExists(path.join(gitDir, "sequencer"))) return "sequencer/head";
      return state === "CHERRY_PICKING" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD";
    case "MERGING":
      return "MERGE_HEAD";
    case "APPLYING_MAILBOX":
      return "rebase-apply/applying";
    default:
      return null;
  }
}

/**
 * Identify the operation `state` names (#17559): the same answer for every
 * read across its whole life, and a different one once it is replaced.
 *
 * The anchor's content alone is not enough: abort a merge and start it again
 * from the same commit and `MERGE_HEAD` holds the same OID, yet the conflict
 * work in the new one is not what anybody agreed to discard. So the file's
 * own identity goes in too. A restart writes a new file, which gets a new
 * inode or modification time; nothing during one operation rewrites it.
 *
 * `null` when the operation has no anchor or it cannot be read (it ended
 * mid-read). Null never matches a pin, so an operation this cannot identify
 * is one no pin can approve.
 */
export async function readRepoOperationId(
  gitDir: string,
  state: RepoState
): Promise<string | null> {
  const anchor = await operationAnchor(gitDir, state);
  if (anchor === null) return null;
  const file = path.join(gitDir, ...anchor.split("/"));
  let handle: fs.promises.FileHandle | undefined;
  try {
    // One handle for both reads, opened and closed here: the identity and the
    // content come from the same file, never one from a replacement. Nothing
    // is held open past this read, which on Windows would leave the anchor
    // undeletable for the git client that owns it.
    handle = await fs.promises.open(file, "r");
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return null;
    const content = await handle.readFile("utf8");
    // An open handle keeps reading a file another client has since unlinked,
    // so the answer counts only while the path still names that same file.
    const current = await fs.promises.stat(file, { bigint: true });
    if (current.ino !== stat.ino || current.dev !== stat.dev) return null;
    return createHash("sha256")
      .update([state, anchor, String(stat.ino), String(stat.mtimeNs), content].join("\0"))
      .digest("hex")
      .slice(0, 32);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** {@link readRepoOperationId} for a caller that has not classified the state itself. */
export async function readCurrentRepoOperationId(gitDir: string): Promise<string | null> {
  const state = await getRepoOperationState(gitDir);
  return state === undefined ? null : readRepoOperationId(gitDir, state);
}
