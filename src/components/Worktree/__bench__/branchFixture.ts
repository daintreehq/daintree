import type { BranchInfo } from "@shared/types";

const PREFIXES = ["feature", "fix", "chore", "release", "hotfix", "renovate", "experiment"];
const WORDS = [
  "auth",
  "billing",
  "branch",
  "cache",
  "dashboard",
  "editor",
  "login",
  "migration",
  "picker",
  "render",
  "search",
  "session",
  "sidebar",
  "terminal",
  "voxel",
  "terrain",
  "worktree",
  "upgrade",
];
const REMOTES = ["origin", "upstream"];

/**
 * A deterministic large-repo branch list: team-namespaced topic branches,
 * conventional prefixes, ticket numbers, dependency-bot branches and a slice of
 * remote-tracking refs, so fuzzy queries hit a realistic mix of near and far
 * candidates.
 */
export function makeBranches(n: number): BranchInfo[] {
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

  const out: BranchInfo[] = [{ name: "main", current: true, commit: "c0" }];
  for (let i = 1; i < n; i++) {
    const shape = rnd();
    let name: string;
    if (shape < 0.35) {
      name = `team-${Math.floor(rnd() * 40)}/${pick(WORDS)}-${pick(WORDS)}-${i}`;
    } else if (shape < 0.7) {
      name = `${pick(PREFIXES)}/${pick(WORDS)}-${Math.floor(rnd() * 9000) + 1000}`;
    } else if (shape < 0.85) {
      name = `${pick(["alice", "bob", "carol", "dmitri", "eun-ji"])}/${pick(WORDS)}_${pick(WORDS)}${i}`;
    } else {
      name = `renovate/${pick(WORDS)}-${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 10)}.x`;
    }
    const branch: BranchInfo = { name, current: false, commit: `c${i}` };
    if (rnd() < 0.2) {
      branch.remote = pick(REMOTES);
      branch.name = `${branch.remote}/${name}`;
    }
    out.push(branch);
  }
  return out;
}

/** Ten-character queries, typed one keystroke at a time by the bench. */
export const TYPED_QUERIES = [
  "team-3 bra",
  "feat/voxel",
  "fix login ",
  "renovate/u",
  "origin/fea",
  "terminl pk",
  "dashbord 4",
  "worktree-s",
];
