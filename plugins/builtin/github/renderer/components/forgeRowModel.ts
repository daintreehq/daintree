import type { Issue, PR } from "@shared/types/forge";
import type { Worktree } from "@shared/types/worktree";

/**
 * What the BACKGROUND of a forge row does — a click beside the title, and the
 * plain Enter that is its keyboard twin.
 *
 * Not the whole row: the title is a control of its own and opens the forge,
 * as Cmd/Ctrl+Enter does. This covers the other action, and it used to live
 * twice — once in the row for the pointer and once in the list shell for Enter
 * — reached through two different worktree access paths. Two copies of a
 * decision tree that has to agree is a divergence bug with a lit fuse, so both
 * paths now run this one derivation.
 */
export type ForgeRowPrimaryAction =
  { kind: "switch"; worktreeId: string } | { kind: "create" } | { kind: "open" };

export interface ForgeRowModel {
  /** The worktree this resource already has locally, when there is one. */
  worktree?: Worktree;
  /** Whether that worktree is the one the project view is currently standing in. */
  isActiveWorktree: boolean;
  primaryAction: ForgeRowPrimaryAction;
}

/**
 * Index the view's worktrees by the resource number each one was made for.
 *
 * Every mounted row used to linearly scan the whole worktree map for itself.
 * Virtualization kept that cheap enough not to show up, but it also meant the
 * match rule lived in the row, where the list shell could not reuse it and no
 * test could reach it.
 *
 * Two worktrees can legitimately name the same resource — a second one made
 * before the first was cleaned up. The old scan took whichever the map handed
 * it first, which is stable only by luck. The active worktree wins here, so
 * the row you are standing in is never the one that loses the tie.
 */
export function buildWorktreeIndex(
  worktrees: Iterable<Worktree>,
  type: "issue" | "pr",
  activeWorktreeId: string | null
): Map<number, Worktree> {
  const index = new Map<number, Worktree>();
  for (const wt of worktrees) {
    const number = type === "issue" ? wt.issueNumber : wt.prNumber;
    if (number === undefined || number === null) continue;
    const existing = index.get(number);
    if (existing === undefined) {
      index.set(number, wt);
      continue;
    }
    if (existing.id !== activeWorktreeId && wt.id === activeWorktreeId) {
      index.set(number, wt);
    }
  }
  return index;
}

/**
 * The background action's contract.
 *
 * A closed issue or a merged PR has nothing to make locally, so it falls
 * through to the forge rather than swallowing the activation.
 */
export function deriveRowModel(
  item: Pick<Issue | PR, "state">,
  worktree: Worktree | undefined,
  activeWorktreeId: string | null
): ForgeRowModel {
  if (worktree) {
    return {
      worktree,
      isActiveWorktree: worktree.id === activeWorktreeId,
      primaryAction: { kind: "switch", worktreeId: worktree.id },
    };
  }
  return {
    isActiveWorktree: false,
    primaryAction: item.state === "open" ? { kind: "create" } : { kind: "open" },
  };
}

/**
 * The full, honest description of a local worktree, for a tooltip and an
 * accessible name.
 *
 * The worktree is matched by resource NUMBER, not by branch, so its branch can
 * legitimately diverge from the PR's head ref — renamed, switched, or detached
 * after the fact. That is why this names the worktree and its branch rather
 * than letting the row imply the PR's head ref is what is checked out locally.
 */
export function describeWorktree(wt: Worktree, isActive: boolean): string {
  const lead = isActive ? "Active worktree" : "Worktree";
  if (wt.isDetached) {
    const at = wt.head ? ` (detached at ${wt.head.slice(0, 7)})` : " (detached HEAD)";
    return `${lead}: ${wt.name}${at}`;
  }
  if (wt.branch && wt.branch !== wt.name) {
    return `${lead}: ${wt.name} on ${wt.branch}`;
  }
  return `${lead}: ${wt.name}`;
}
