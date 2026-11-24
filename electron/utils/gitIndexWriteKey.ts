import path from "node:path";

/**
 * The `runExclusive` key every Daintree write to one worktree's index takes,
 * so two never interleave: a hunk stage reads the index and then applies to
 * it, and a write landing in between could leave a change applied twice.
 */
export function gitIndexWriteKey(cwd: string): string {
  return `git-index-batches:${path.resolve(cwd)}`;
}
