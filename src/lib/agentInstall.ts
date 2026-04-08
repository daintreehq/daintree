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
  return blocks && blocks.length > 0 ? blocks[0] : null;
}

export function getInstallCommand(block: AgentInstallBlock): string | null {
  if (!block.commands || block.commands.length === 0) return null;
  return block.commands.join("\n");
}
