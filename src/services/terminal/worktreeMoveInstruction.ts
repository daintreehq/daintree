/**
 * The one sentence a cross-worktree move is allowed to put into a live agent
 * session (#11853), and only when the user asks for it.
 */
export function buildWorktreeMoveInstruction(worktreePath: string): string {
  return `Please continue in the directory ${worktreePath}`;
}

/**
 * Join whatever the user already had in the input bar with the instruction.
 *
 * Sending the draft along is the point, not a side effect to avoid (#11867), so
 * the draft is reproduced byte for byte — trailing spaces can be a deliberate
 * Markdown hard break, and rewriting the user's own text to make room for ours
 * is not this function's call. Only the newlines that are missing get added.
 */
export function composeDraftWithInstruction(draft: string, instruction: string): string {
  if (draft.trim() === "") return instruction;
  const trailingNewlines = /\n*$/.exec(draft)?.[0].length ?? 0;
  return `${draft}${"\n".repeat(Math.max(0, 2 - trailingNewlines))}${instruction}`;
}
