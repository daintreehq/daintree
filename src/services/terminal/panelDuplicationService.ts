import type { TerminalInstance } from "@/store";
import type { AddTerminalOptions } from "@/store/slices/terminalRegistry/types";
import type { TabGroupLocation } from "@/types";
import { generateAgentCommand } from "@shared/types";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { agentSettingsClient } from "@/clients";

/**
 * Generate the startup command for a panel being duplicated.
 * For agent panels, re-generates the command from current settings.
 * For all others, copies the existing command.
 */
async function resolveCommandForPanel(panel: TerminalInstance): Promise<string | undefined> {
  if (panel.agentId && isRegisteredAgent(panel.agentId)) {
    const agentConfig = getAgentConfig(panel.agentId);
    if (agentConfig) {
      try {
        const agentSettings = await agentSettingsClient.get();
        const entry = agentSettings?.agents?.[panel.agentId] ?? {};
        return generateAgentCommand(agentConfig.command, entry, panel.agentId, {
          interactive: true,
        });
      } catch (error) {
        console.warn(
          `Failed to get agent settings for ${panel.agentId}, using existing command:`,
          error
        );
        return panel.command ?? agentConfig.command;
      }
    }
  }
  return panel.command;
}

function buildKindSpecificOptions(panel: TerminalInstance): Partial<AddTerminalOptions> {
  const kind = panel.kind ?? "terminal";

  if (kind === "browser") {
    return { browserUrl: panel.browserUrl };
  }

  if (kind === "notes") {
    return {
      notePath: panel.notePath,
      noteId: panel.noteId,
      scope: panel.scope,
      createdAt: Date.now(),
    };
  }

  if (kind === "dev-preview") {
    return {
      devCommand: panel.devCommand,
      browserUrl: panel.browserUrl,
    };
  }

  return {};
}

/**
 * Build the full AddTerminalOptions needed to duplicate a panel.
 * Callers pass the target location since it may differ from the source.
 * Target location must be "grid" or "dock" (not "trash").
 */
export async function buildPanelDuplicateOptions(
  sourcePanel: TerminalInstance,
  targetLocation: TabGroupLocation
): Promise<AddTerminalOptions> {
  const kind = sourcePanel.kind ?? "terminal";
  const command = await resolveCommandForPanel(sourcePanel);

  return {
    kind,
    type: sourcePanel.type,
    agentId: sourcePanel.agentId,
    cwd: sourcePanel.cwd || "",
    worktreeId: sourcePanel.worktreeId,
    location: targetLocation,
    exitBehavior: sourcePanel.exitBehavior,
    isInputLocked: sourcePanel.isInputLocked,
    command,
    ...buildKindSpecificOptions(sourcePanel),
  };
}
