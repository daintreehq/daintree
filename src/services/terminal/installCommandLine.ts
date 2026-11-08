import type { AgentInstallOS } from "@shared/config/agentRegistry";

// What a surface needs to offer an install command for a terminal. Kept apart
// from the opener, which loads the panel store and the terminal service only
// once someone clicks.

/** What a staged install command is meant to make available, so it can be re-checked. */
export type InstallTarget =
  { kind: "prerequisite"; tool: string } | { kind: "agent"; agentId: string };

/**
 * The one line a block's commands are typed as, or null when they can't be
 * one. A POSIX shell runs them in order with `&&`, the same line the banner
 * shows. Windows has no join that holds in every shell a terminal there may
 * run (Windows PowerShell has no `&&`, and `;` would run the next step after a
 * failed one), so a Windows block of several commands offers each on its own.
 */
export function installLineForCommands(
  commands: readonly string[] | undefined,
  os: AgentInstallOS
): string | null {
  if (!commands || commands.length === 0) return null;
  if (commands.length > 1 && os === "windows") return null;
  const line = commands.map((command) => command.trim()).join(" && ");
  return isStageableInstallLine(line) ? line : null;
}

/**
 * Whether a command can be typed at a prompt without running anything: one
 * line once its ends are trimmed (they never are typed), and no control
 * character inside it (a newline or carriage return would submit it, a tab
 * would complete it).
 */
export function isStageableInstallLine(line: string): boolean {
  const typed = line.trim();
  return typed.length > 0 && !/\p{Cc}/u.test(typed);
}
