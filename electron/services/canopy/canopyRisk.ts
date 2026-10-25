/**
 * Commands that can't be taken back, recognised from the text an approval
 * quotes off the screen. The local reader's own risk reading is a weak signal
 * at its small size (Light reads `rm -rf /` as no risk at all), and a risky
 * approval is the one answered with a second keypress, so this only ever
 * raises an approval to caution: it never lowers what the reader said, and a
 * command it doesn't know changes nothing.
 */

interface RiskyCommand {
  pattern: RegExp;
  /** At most ~8 words, fixed: what the person is being asked to allow. */
  reason: string;
}

const RISKY: readonly RiskyCommand[] = [
  {
    pattern: /\brm\s+(?:-[a-z-]*[rf][a-z-]*\s+|--(?:recursive|force)\b)/i,
    reason: "Deletes files for good",
  },
  {
    pattern: /\bgit\s+push\b[^|;&\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/i,
    reason: "Overwrites the remote branch",
  },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Discards uncommitted changes" },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: "Deletes untracked files for good" },
  { pattern: /\bgit\s+branch\s+-D\b/i, reason: "Deletes a branch with unmerged work" },
  {
    pattern: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/i,
    reason: "Discards uncommitted changes",
  },
  { pattern: /\bdrop\s+(?:table|database|schema)\b/i, reason: "Deletes data for good" },
  { pattern: /\btruncate\s+table\b/i, reason: "Deletes data for good" },
  {
    pattern: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
    reason: "Runs a downloaded script",
  },
  { pattern: /\bsudo\b/i, reason: "Runs with administrator rights" },
  { pattern: /\b(?:chmod|chown)\s+-R\b/i, reason: "Changes permissions across a tree" },
  { pattern: /\b(?:mkfs|dd\s+if=|diskutil\s+erase)/i, reason: "Can erase a disk" },
  {
    pattern: /\b(?:kubectl\s+delete|terraform\s+destroy|docker\s+system\s+prune)\b/i,
    reason: "Deletes infrastructure",
  },
  { pattern: /\b(?:npm|pnpm|yarn)\s+publish\b/i, reason: "Publishes a release" },
];

/** Why a quoted command should take a second press, or null when nothing here says so. */
export function irreversibleReason(
  ...quoted: ReadonlyArray<string | null | undefined>
): string | null {
  for (const text of quoted) {
    if (!text) continue;
    for (const { pattern, reason } of RISKY) if (pattern.test(text)) return reason;
  }
  return null;
}
