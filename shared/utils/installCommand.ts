/**
 * Whether an install command needs a shell to run as written. The installer
 * splits a command on whitespace and spawns it with `shell: false`, so shell
 * syntax reaches the program as literal arguments: `curl … -o f && f` hands
 * curl `&&` and `f` as extra URLs, a pipe or redirect connects nothing, and a
 * quote stays part of its word. Such a command is copy-only.
 *
 * Expansions count for the same reason: `$HOME`, `%LOCALAPPDATA%` and a
 * home-relative `~/` reach the program as written.
 *
 * Deliberately conservative: a `;` inside a URL counts too, which costs only a
 * one-click button. A lone `&` counts only as its own word (cmd.exe's
 * separator, or a POSIX background job), so a URL query string doesn't; `~`
 * only as a home path, so a version range (`--version ~14.1`) doesn't.
 */
const SHELL_SYNTAX = /[|;<>`"'$\r\n]|&&|(?:^|\s)&(?=\s|$)|(?:^|\s)~(?=[/\\\s]|$)/;
// cmd.exe's `%NAME%`, looked for outside URLs so percent-encoding doesn't count.
const CMD_VARIABLE = /%\w+%/;
const URL_WORD = /\bhttps?:\/\/\S+/gi;

export function requiresShell(command: string): boolean {
  return SHELL_SYNTAX.test(command) || CMD_VARIABLE.test(command.replace(URL_WORD, ""));
}
