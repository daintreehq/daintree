/**
 * Per-worktree color identity system.
 *
 * Assigns each active worktree a unique accent color from a CVD-safe subset of
 * the existing category-* OKLCH theme tokens. Colors are assigned by
 * sorted-index (worktrees sorted by path) so assignment is deterministic for a
 * given set of worktrees.
 */

/**
 * 8-color CVD-safe palette ordered for maximum adjacent perceptual distance.
 * Skips: green (status-success conflict), slate (too neutral), rose (status-danger conflict).
 */
export const WORKTREE_COLOR_PALETTE = [
  "category-blue",
  "category-orange",
  "category-teal",
  "category-pink",
  "category-amber",
  "category-violet",
  "category-indigo",
  "category-cyan",
] as const;

export type WorktreeColorToken = (typeof WORKTREE_COLOR_PALETTE)[number];

/**
 * Compute a mapping from worktree ID to its CSS variable color string.
 * Worktrees are sorted by path for deterministic assignment.
 * Returns null when there are 0 or 1 worktrees (single-worktree suppression).
 */
export function computeWorktreeColorMap(
  worktrees: ReadonlyMap<string, { path: string }>
): Record<string, string> | null {
  if (worktrees.size <= 1) return null;

  const sorted = Array.from(worktrees.entries()).sort((a, b) => a[1].path.localeCompare(b[1].path));

  const map: Record<string, string> = {};
  for (const [i, entry] of sorted.entries()) {
    const token = WORKTREE_COLOR_PALETTE[i % WORKTREE_COLOR_PALETTE.length]!;
    map[entry[0]] = `var(--theme-${token})`;
  }
  return map;
}

/**
 * Colours a user can pin to a worktree as a label. Deliberately short: most of
 * the hue wheel already means something on a worktree card (green success,
 * amber/orange warning, rose danger, slate the keyboard cursor), and cyan,
 * indigo and purple sit too close to these to separate as a 3px line (#13408).
 *
 * The token is what gets stored, not a hex value, so a label follows the theme
 * and the colour-vision overrides. The name stays the same whatever hue a
 * colour-vision mode remaps it to.
 */
export const WORKTREE_LABEL_COLORS = [
  { name: "teal", label: "Teal", token: "category-teal" },
  { name: "blue", label: "Blue", token: "category-blue" },
  { name: "violet", label: "Violet", token: "category-violet" },
  { name: "pink", label: "Pink", token: "category-pink" },
] as const;

export type WorktreeLabelColorName = (typeof WORKTREE_LABEL_COLORS)[number]["name"];
export type WorktreeLabelToken = (typeof WORKTREE_LABEL_COLORS)[number]["token"];

export const WORKTREE_LABEL_COLOR_NAMES = WORKTREE_LABEL_COLORS.map((c) => c.name) as [
  WorktreeLabelColorName,
  ...WorktreeLabelColorName[],
];

export function isWorktreeLabelToken(value: unknown): value is WorktreeLabelToken {
  return WORKTREE_LABEL_COLORS.some((c) => c.token === value);
}

export function worktreeLabelTokenForName(name: WorktreeLabelColorName): WorktreeLabelToken {
  return WORKTREE_LABEL_COLORS.find((c) => c.name === name)!.token;
}

export function worktreeLabelDisplayName(token: WorktreeLabelToken): string {
  return WORKTREE_LABEL_COLORS.find((c) => c.token === token)!.label;
}

/**
 * Overlay user labels onto the automatic map. A label shows even when there is
 * only one worktree; clearing it hands the worktree back to the automatic
 * colour, single-worktree suppression included. Returns `autoMap` itself when
 * nothing is labelled, so the reference stays stable for consumers.
 */
export function applyWorktreeLabelColors(
  autoMap: Record<string, string> | null,
  labels: Readonly<Record<string, WorktreeLabelToken>>
): Record<string, string> | null {
  const entries = Object.entries(labels);
  if (entries.length === 0) return autoMap;
  const result: Record<string, string> = { ...(autoMap ?? {}) };
  for (const [id, token] of entries) {
    result[id] = `var(--theme-${token})`;
  }
  return result;
}
