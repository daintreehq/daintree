/**
 * Whether an install command needs a shell to run as written. The installer
 * splits a command on whitespace and spawns it with `shell: false`, so shell
 * syntax reaches the program as literal arguments: `curl … -o f && f` hands
 * curl `&&` and `f` as extra URLs, a pipe or redirect connects nothing, and a
 * quote stays part of its word. Such a command is copy-only.
 *
 * Deliberately conservative: a `;` inside a URL counts too, which costs only a
 * one-click button. A lone `&` counts only as its own word (cmd.exe's
 * separator, or a POSIX background job), so a URL query string doesn't.
 */
export function requiresShell(command: string): boolean {
  return /[|;<>`"'\r\n]|&&|\$\(|(?:^|\s)&(?:\s|$)/.test(command);
}
