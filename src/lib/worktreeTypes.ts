import { BRANCH_TYPES, BRANCH_TYPE_IDS, type BranchTypeId } from "@shared/config/branchPrefixes";

/**
 * A worktree's type: a branch type from the shared registry, an agent's branch
 * with no work type, or one of the states that are not about the branch name.
 * Kept free of store imports so the filter store can validate persisted ids
 * against it without a cycle.
 */
export type WorktreeTypeId = BranchTypeId | "agent" | "main" | "detached" | "other";

/** Every worktree type, in grouped-sidebar section order. */
export const WORKTREE_TYPE_IDS: readonly WorktreeTypeId[] = [
  "main",
  ...BRANCH_TYPE_IDS,
  "agent",
  "detached",
  "other",
];

const GROUP_NAMES = new Map<WorktreeTypeId, string>([
  ["main", "Main"],
  ...BRANCH_TYPES.map((type) => [type.id, type.groupName] as const),
  ["agent", "Agents"],
  ["detached", "Detached HEAD"],
  ["other", "Other"],
]);

const LABELS = new Map<WorktreeTypeId, string>([
  ["main", "Main"],
  ...BRANCH_TYPES.map((type) => [type.id, type.displayName] as const),
  ["agent", "Agent"],
  ["detached", "Detached"],
  ["other", "Other"],
]);

/** The section heading for a type when the sidebar groups by type. */
export function getWorktreeTypeGroupName(id: WorktreeTypeId): string {
  return GROUP_NAMES.get(id) ?? id;
}

/** The short name a filter chip shows for a type. */
export function getWorktreeTypeLabel(id: WorktreeTypeId): string {
  return LABELS.get(id) ?? id;
}

const WORKTREE_TYPE_ID_SET: ReadonlySet<string> = new Set(WORKTREE_TYPE_IDS);

export function isWorktreeTypeId(value: unknown): value is WorktreeTypeId {
  return typeof value === "string" && WORKTREE_TYPE_ID_SET.has(value);
}
