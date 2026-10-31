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

/**
 * One option value: a quoted path, or a word that starts with neither a quote
 * nor a dash. The two never overlap, and a value never reads as the next
 * option, so a long row of options can't be split two ways and backtrack.
 */
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'-]\S*)`;

/**
 * `git` and the global options that can sit before its subcommand (`-C <path>`,
 * `-c key=value`, `--git-dir=<path>`, `--work-tree <path>`, `--no-pager`), so
 * an agent working in a worktree through `git -C` is read like a bare `git`.
 */
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+${VALUE}|--(?:git-dir|work-tree|namespace)\s+${VALUE}|--[a-z][a-z-]*(?:=${VALUE})?|-[A-Za-z]))*\s+`;

/** The rest of the command, up to the next pipe, `;`, `&` or line end. */
const ARGS = String.raw`[^|;&\n]*`;

function git(subcommand: string, flags = "i"): RegExp {
  return new RegExp(GIT + subcommand, flags);
}

const RISKY: readonly RiskyCommand[] = [
  {
    pattern: /\brm\s+(?:-[a-z-]*[rf][a-z-]*\s+|--(?:recursive|force)\b)/i,
    reason: "Deletes files for good",
  },
  {
    // PowerShell's -Recurse/-Force (any unambiguous prefix) and cmd's /s.
    pattern: /\b(?:Remove-Item|rd|rmdir)\b[^|;&\n]*\s(?:-(?:r[a-z]*|fo[a-z]*)|\/s)\b/i,
    reason: "Deletes files for good",
  },
  {
    // A force push, a remote branch delete, or a refspec that forces (`+main`)
    // or deletes (`:main`).
    pattern: git(String.raw`push\b${ARGS}\s(?:--force\b|--force-with-lease\b|-f\b|--delete\b|-d\b|[+:][A-Za-z_])`),
    reason: "Overwrites the remote branch",
  },
  { pattern: git(String.raw`reset\b${ARGS}\s--hard\b`), reason: "Discards uncommitted changes" },
  {
    pattern: git(String.raw`clean\b${ARGS}\s(?:-[a-z]*f|--force\b)`),
    reason: "Deletes untracked files for good",
  },
  {
    // Case matters here: `-d` refuses an unmerged branch, so only `-D` or a
    // delete with a force (`-d -f`, `--delete --force`, `-df`) loses work.
    pattern: git(
      String.raw`branch\b(?:(?=${ARGS}\s-[A-Za-z]*D)|(?=${ARGS}\s(?:-[A-Za-z]*d|--delete\b))(?=${ARGS}\s(?:-[A-Za-z]*f|--force\b)))`,
      ""
    ),
    reason: "Deletes a branch with unmerged work",
  },
  {
    pattern: git(String.raw`(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)`),
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
