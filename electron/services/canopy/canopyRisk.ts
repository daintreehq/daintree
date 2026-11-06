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
 * One option value: plain characters, escapes and quoted parts (`/repo`,
 * `/My\ Repo`, `"/My Repo"`, `core.x="y z"`), never opening with a dash. Each
 * step takes one plain character, one escape or one whole quoted part, each
 * with its own first character, so a value can only be read one way and a
 * long row of options can't backtrack.
 */
const VALUE = String.raw`(?=[^\s-])(?:\\[^\n]|[^\s"'\\]|"(?:\\[^\n]|[^"\\])*"|'[^']*')+`;

/**
 * `git` and the global options that can sit before its subcommand, so an agent
 * working in a worktree through `git -C <path>` reads like a bare `git`. A
 * fixed list: `git --help push --force` is not a push.
 */
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+${VALUE}|--(?:git-dir|work-tree|namespace)(?:=|\s+)${VALUE}|--(?:no-pager|paginate|no-optional-locks)|-[pP])(?=\s))*\s+`;

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
    // PowerShell's -Recurse or -Force (any prefix it accepts), and cmd's /s
    // (alone or as `/s/q`).
    pattern:
      /\b(?:Remove-Item|rd|rmdir)\b[^|;&\n]*\s(?:-(?:r[a-z]*|fo[a-z]*)\b|\/s(?=\s|$|\/q\b))/i,
    reason: "Deletes files for good",
  },
  {
    // A force push, a remote branch delete, or a refspec that forces (`+main`)
    // or deletes (`:main`, but not an emoji `:tada:` after the command).
    pattern: git(
      String.raw`push\b${ARGS}\s(?:--force\b|--delete\b|-(?=[a-z]*[fd])[a-z]+(?![\w-])|["']?(?:\+\w|:(?!\w+:)\w))`
    ),
    reason: "Overwrites the remote branch",
  },
  { pattern: git(String.raw`reset\b${ARGS}\s--hard\b`), reason: "Discards uncommitted changes" },
  {
    pattern: git(String.raw`clean\b${ARGS}\s(?:-[a-z]*f|--force\b)`),
    reason: "Deletes untracked files for good",
  },
  {
    // Case matters: `-d` refuses an unmerged branch, so only `-D` or a delete
    // with a force (`-d -f`, `--delete --force`, `-df`) loses work.
    pattern: git(
      String.raw`branch\b(?:(?=${ARGS}\s-[A-Za-z]*D)|(?=${ARGS}\s(?:-[A-Za-z]*d|--delete\b))(?=${ARGS}\s(?:-[A-Za-z]*f|--force\b)))`,
      ""
    ),
    reason: "Deletes a branch with unmerged work",
  },
  {
    pattern: git(String.raw`(?:checkout|restore)\s+(?:--\s+)?\.(?=[\s)]|$)`),
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
