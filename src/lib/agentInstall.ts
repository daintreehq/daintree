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

export function isBlockExecutable(block: AgentInstallBlock): boolean {
  if (!block.commands || block.commands.length === 0) return false;
  return block.commands.every((cmd) => !isManualOnlyCommand(cmd));
}
