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
