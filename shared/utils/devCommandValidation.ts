// npm's `run` consumes the first `--` and requires it to forward flags to the
// script. pnpm, yarn, and bun forward extra args directly — pnpm passes an
// explicit `--` through verbatim to the script, where Vite/Next treat
// everything after a bare `--` as positional and silently drop the injected
// flags (yarn 1 strips it with a deprecation warning; bun takes args inline).
export function scriptFlagSeparator(command: string): string {
  return command.trimStart().startsWith("npm ") ? " -- " : " ";
}

export function getInvalidCommandMessage(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "No dev command configured";
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return "Multi-line commands are not allowed";
  }
  return null;
}
