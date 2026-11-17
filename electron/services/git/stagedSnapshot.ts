import { createHash } from "node:crypto";
import type { GitStagedSnapshot } from "../../../shared/types/git.js";
import { runGitForBytes, type RunGitOptions } from "./reviewPoint/runGit.js";

/**
 * The staged changes a Commit & push confirm shows, and the identity the commit
 * made under it is held to (#17563).
 *
 * The identity is the base commit plus git's raw diff between it and the index:
 * every staged path with its modes and blob ids. With the base pinned, that is
 * the index's tree. It is read without writing anything: `write-tree` would
 * name the tree directly, but it takes `index.lock` (and dies when an agent's
 * git holds it) and writes objects, on what is a read.
 *
 * The same form is read back from a commit as the raw diff against its parent.
 * The two agree byte for byte because commits here run with no hooks
 * (`createHardenedGit`), so a commit's tree is the index it was made from, and
 * because intent-to-add entries, which `git commit` leaves out, are left out of
 * the index side too.
 *
 * Bytes, not decoded text, go into the hash: two paths that differ only in
 * bytes that aren't valid UTF-8 must not share an identity.
 */

const RAW_DIFF_ARGS = [
  "--raw",
  "-z",
  "--no-abbrev",
  "--no-renames",
  "--ignore-submodules=none",
] as const;

const READ_LIMITS: Pick<RunGitOptions, "timeoutMs" | "maxStdoutBytes"> = {
  timeoutMs: 30_000,
  maxStdoutBytes: 64 * 1024 * 1024,
};

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function requireOid(oid: string): string {
  const lower = oid.toLowerCase();
  if (!OID.test(lower)) throw new Error("Expected a full commit id");
  return lower;
}

function identityOf(baseOid: string, raw: Buffer): string {
  return createHash("sha256").update(`staged-v1\0${baseOid}\0`).update(raw).digest("hex");
}

/** The paths in `-z --raw` output: each record is `:<meta>\0<path>\0` with renames off. */
function pathsOf(raw: Buffer): string[] {
  const fields = raw.toString("utf8").split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (!fields[i]!.startsWith(":")) throw new Error("Unexpected git diff output");
    paths.push(fields[i + 1]!);
  }
  return paths;
}

/** What is staged on top of `baseOid` in the worktree at `cwd`. */
export async function readStagedSnapshot(
  cwd: string,
  baseOid: string
): Promise<GitStagedSnapshot> {
  const base = requireOid(baseOid);
  const { stdout } = await runGitForBytes(
    cwd,
    ["diff-index", "--cached", ...RAW_DIFF_ARGS, "--ita-invisible-in-index", base, "--"],
    READ_LIMITS
  );
  return { identity: identityOf(base, stdout), paths: pathsOf(stdout) };
}

/**
 * The identity of what `commitOid` contains over `parentOid`, in the form
 * {@link readStagedSnapshot} gives the index.
 */
export async function readCommitStagedIdentity(
  cwd: string,
  parentOid: string,
  commitOid: string
): Promise<string> {
  const parent = requireOid(parentOid);
  const commit = requireOid(commitOid);
  const { stdout } = await runGitForBytes(
    cwd,
    ["diff-tree", "-r", ...RAW_DIFF_ARGS, parent, commit, "--"],
    READ_LIMITS
  );
  return identityOf(parent, stdout);
}
