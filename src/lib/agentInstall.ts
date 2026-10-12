import type {
  AgentConfig,
  AgentInstallBlock,
  AgentInstallOS,
} from "../../shared/config/agentRegistry";
import { isMac, isWindows, isLinux } from "./platform";

export function detectOS(): AgentInstallOS {
  if (isMac()) return "macos";
  if (isWindows()) return "windows";
  if (isLinux()) return "linux";
  return "generic";
}

export function getInstallBlocksForCurrentOS(agent: AgentConfig): AgentInstallBlock[] | null {
  if (!agent.install?.byOs) {
    return null;
  }

  const currentOS = detectOS();
  const blocks = agent.install.byOs[currentOS];

  if (blocks && blocks.length > 0) {
    return blocks;
  }

  const genericBlocks = agent.install.byOs.generic;
  if (genericBlocks && genericBlocks.length > 0) {
    return genericBlocks;
  }

  return null;
}

export function getDefaultInstallBlock(agent: AgentConfig): AgentInstallBlock | null {
  const blocks = getInstallBlocksForCurrentOS(agent);
  return blocks && blocks.length > 0 ? (blocks[0] ?? null) : null;
}

export function getInstallCommand(block: AgentInstallBlock): string | null {
  if (!block.commands || block.commands.length === 0) return null;
  return block.commands.join("\n");
}

export function isManualOnlyCommand(command: string): boolean {
  return /\|\s*(bash|sh|zsh)\b/.test(command) || /\|\s*iex\b/.test(command);
}

// For `curl … | bash` / `irm … | iex`-style commands, return the install
// script URL so the UI can offer an inspect-before-running affordance.
// Returns undefined for commands without a pipe-to-shell or without a URL.
export function extractInspectUrl(command: string): string | undefined {
  if (!isManualOnlyCommand(command)) return undefined;
  const match = command.match(/https?:\/\/[^\s|]+/);
  if (!match) return undefined;
  // Trim trailing punctuation that often surrounds inline URLs, e.g. the `)`
  // in `bash <(curl https://x/install.sh)`.
  return match[0].replace(/[)\]'">]+$/, "");
}

/**
 * A leading `sudo` has no pipe for `isManualOnlyCommand` to catch, but running
 * it with piped stdio hangs forever on a password prompt the user can never
 * see. Kept separate from `isManualOnlyCommand` so `extractInspectUrl` keeps
 * meaning "pipes a remote script into a shell". Mirrors the main-side gate in
 * `AgentInstallService`; this copy only decides whether to render a button,
 * main refuses independently.
 */
export function requiresElevation(command: string): boolean {
  return /^\s*sudo\b/i.test(command);
}

/** `npm install -g …` and its spellings: the one install that writes npm's global prefix. */
export function isNpmGlobalInstall(command: string): boolean {
  return (
    /^\s*npm(?:\.cmd)?\s+(?:install|i|add)(?:\s|$)/.test(command) &&
    /\s(?:-g|--global)(?:\s|$)/.test(command)
  );
}

/**
 * A global npm install refused because npm's prefix belongs to root: a system
 * Node (apt, NodeSource, the nodejs.org macOS installer) installs global
 * packages under /usr. npm reports EACCES, or EPERM where the OS itself says
 * no; the output is npm's own error report.
 */
export function isNpmGlobalPermissionFailure(command: string, output: string): boolean {
  return isNpmGlobalInstall(command) && /\b(?:EACCES|EPERM)\b/.test(output);
}

/** npm's documented fix for that refusal: a global prefix in the user's own home. */
export const NPM_USER_PREFIX_COMMAND = "npm config set prefix ~/.npm-global";

/**
 * The first install method for this OS that doesn't go through npm's global
 * prefix — what to offer when that prefix refuses the install.
 */
export function findNonNpmInstallBlock(
  blocks: readonly AgentInstallBlock[] | null | undefined
): AgentInstallBlock | null {
  return (
    blocks?.find((block) => {
      const commands = block.commands ?? [];
      return commands.length > 0 && !commands.some(isNpmGlobalInstall);
    }) ?? null
  );
}

export function isBlockExecutable(block: AgentInstallBlock): boolean {
  if (!block.commands || block.commands.length === 0) return false;
  return block.commands.every((cmd) => !isManualOnlyCommand(cmd) && !requiresElevation(cmd));
}
