import type * as React from "react";
import type { WorktreeLabelToken } from "@shared/theme/worktreeColors";

type LabelColorStyle = React.CSSProperties & { "--worktree-label-color": string };

/** Feeds a label's token to `.worktree-label-bar` / `.worktree-label-swatch`, which derive the ink in sidebar.css. */
export function worktreeLabelColorStyle(token: WorktreeLabelToken): LabelColorStyle {
  return { "--worktree-label-color": `var(--theme-${token})` };
}
