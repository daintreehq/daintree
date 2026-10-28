import { pluginAgentMcpClient } from "@/clients/pluginAgentMcpClient";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import { isAgentRecipeType, isPluginRecipe, type TerminalRecipe } from "@shared/types/project";

/** The settings tab that holds each plugin's agent tools for the project. */
const AGENT_TOOLS_SETTINGS_TAB = "project:plugins";
/** The settings tab with Daintree's MCP server switch, which agent tools ride on. */
const MCP_SETTINGS_TAB = "mcp";

/**
 * Whether a run of these steps is held to the recipe's `requiresAgentTools`
 * (#13797): only a plugin recipe declares it, and only an agent step uses the
 * tools — a run that opens just the plugin's panel has nothing to refuse.
 */
export function recipeRunNeedsAgentTools(
  recipe: TerminalRecipe,
  indices: readonly number[]
): boolean {
  if (recipe.requiresAgentTools !== true || !isPluginRecipe(recipe)) return false;
  return indices.some((index) => {
    const terminal = recipe.terminals[index];
    return terminal !== undefined && isAgentRecipeType(terminal.type);
  });
}

/** Why a recipe that needs its plugin's agent tools can't start, and where that's fixed. */
export interface PluginAgentToolsProblem {
  message: string;
  /** The settings tab that turns them on, when there is one to open. */
  settingsTab?: string;
}

/**
 * Why a recipe that needs its plugin's agent tools can't start here, or null
 * when they're on (#13797). Reads the project's existing access, the same
 * answer every agent launch gets, and never changes it.
 *
 * Fails closed: an unreadable answer is a reason not to start, since starting
 * agents without the tools is exactly what the recipe asked to be spared.
 */
export async function pluginAgentToolsProblem(
  pluginInstanceId: string
): Promise<PluginAgentToolsProblem | null> {
  const fallbackName = pluginManifestIdFromInstanceKey(pluginInstanceId);
  let snapshot;
  try {
    snapshot = await pluginAgentMcpClient.listProjectPlugins();
  } catch {
    return {
      message: `Couldn't check whether ${fallbackName}'s agent tools are on in this project, so this recipe didn't start.`,
    };
  }
  const entry = snapshot.plugins.find((plugin) => plugin.pluginInstanceId === pluginInstanceId);
  const name = entry?.pluginDisplayName ?? fallbackName;
  if (entry === undefined || !entry.available || entry.access === "off") {
    return {
      message: `This recipe needs agent tools from ${name}, but they're switched off in this project. Turn them on in Project settings → Plugins, then try again.`,
      settingsTab: AGENT_TOOLS_SETTINGS_TAB,
    };
  }
  if (!snapshot.mcpServerEnabled) {
    return {
      message: `This recipe needs agent tools from ${name}, but Daintree's MCP server is off. Turn it on in Settings → MCP, then try again.`,
      settingsTab: MCP_SETTINGS_TAB,
    };
  }
  return null;
}
