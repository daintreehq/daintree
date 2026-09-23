/**
 * The marks on a sidebar row that are pictures rather than controls — the
 * lifecycle tick, the collapsed alarm, the external-worktree icon — are not
 * focusable, so a keyboard user never lands on them. They land on the card's
 * select button instead, and that button is described by each mark's words.
 * Every mark renders a hidden node under one of these ids for it to point at.
 */
export type RowDescriptionPart = "lifecycle" | "alarm" | "external";

/**
 * Worktree ids are paths, and a path can hold a space, which would split one
 * IDREF into two — so the id is encoded.
 */
export function worktreeRowDescriptionId(worktreeId: string, part: RowDescriptionPart): string {
  return `worktree-${part}-${encodeURIComponent(worktreeId)}`;
}

/**
 * The select button's `aria-describedby`: one id per mark actually on the row,
 * in the order the row's questions rank — is something asking for me, is
 * something wrong, where does it live. A reference to a mark that is not
 * mounted would be a dangling IDREF, so each part is passed only when its mark
 * renders.
 */
export function selectButtonDescribedBy(
  worktreeId: string,
  mounted: Record<RowDescriptionPart, boolean>
): string | undefined {
  const parts = (["lifecycle", "alarm", "external"] as const).filter((part) => mounted[part]);
  if (parts.length === 0) return undefined;
  return parts.map((part) => worktreeRowDescriptionId(worktreeId, part)).join(" ");
}
