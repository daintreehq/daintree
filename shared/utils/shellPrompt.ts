// Shell prompt shapes, read off the line the cursor sits on. Main uses them to
// tell a returned shell prompt from agent output; the renderer uses them to
// tell when a fresh shell is ready for typed input.

export const SINGLE_CHAR_SHELL_PROMPT_PATTERN = /^\s*[>›❯⟩$#%]\s*$/;
export const SHELL_ONLY_SINGLE_CHAR_PROMPT_PATTERN = /^\s*[$#%]\s*$/;
export const AGENT_ONLY_SINGLE_CHAR_PROMPT_PATTERN = /^\s*[>❯›]\s*$/;
export const POSIX_USER_HOST_PROMPT_PATTERN = /^\s*[A-Za-z0-9_.-]+@\S+(?:\s+[^\r\n]*)?\s*[#$%>]\s*$/;
export const DECORATED_SHELL_PROMPT_PATTERN = /^\s*[➜➤➟➔❯›]\s+.*$/;
// Same as above but without the `❯`/`›` glyphs. While an agent owns the
// terminal those glyphs are the agent's own composer/input prompt (Codex uses
// `›`, Claude uses `❯`), not a returned shell prompt — matching them there let
// agent echo lines masquerade as a prompt return and demote a live agent
// (#10911). Real oh-my-zsh prompts (`➜` etc.) still count. The process-group
// probe and process-tree evidence are the authoritative demotion signals while
// an agent is committed.
export const DECORATED_SHELL_PROMPT_PATTERN_NO_AGENT_GLYPHS = /^\s*[➜➤➟➔]\s+.*$/;
export const MAC_BASH_PROMPT_PATTERN = /^\s*\S+:\S+\s+\S+\s*[#$%>]\s*$/;
export const POWERSHELL_PROMPT_PATTERN = /^\s*PS\s+\S.*>\s*$/i;
// cmd.exe default (`$P$G`) — `C:\repo>`. Only cmd's own `^C` echo may follow
// the `>` (a Ctrl+C that lands after a TUI agent quit), and the path excludes
// the characters Windows forbids in one (control characters and a second `:`
// included), so an echoed batch line (`C:\repo>npm test`) or a redirect in
// output can't pass for a prompt.
export const CMD_PROMPT_PATTERN = /^\s*[A-Za-z]:\\[^<>:|"*?\p{Cc}]*>(?:\^C)*\s*$/u;

export const SHELL_PROMPT_PATTERNS = [
  SINGLE_CHAR_SHELL_PROMPT_PATTERN,
  // `user@host:/path $` style — bash default with hostname. Path token may
  // contain `/`, `:`, `~`, etc., so use \S+ rather than \w/.- only.
  POSIX_USER_HOST_PROMPT_PATTERN,
  DECORATED_SHELL_PROMPT_PATTERN,
  // macOS bash default — `host:cwd user$` (no `@`, `:` separator). Two
  // whitespace-separated tokens followed by a single trailing prompt char so
  // command output like `cat <foo>` or `foo > bar.txt` doesn't false-positive.
  MAC_BASH_PROMPT_PATTERN,
  // PowerShell default — `PS C:\repo>` or `PS /home/user>`.
  POWERSHELL_PROMPT_PATTERN,
  CMD_PROMPT_PATTERN,
] as const;

/** Whether a cursor line reads as an interactive shell prompt. */
export function isShellPromptLine(line: string): boolean {
  return SHELL_PROMPT_PATTERNS.some((pattern) => pattern.test(line));
}
