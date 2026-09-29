import fs from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import type { RebaseSequence, RepoState } from "../../../shared/types/git.js";
import { OPERATION_SENTINEL_NAMES } from "../../utils/gitRepoOperationState.js";
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
