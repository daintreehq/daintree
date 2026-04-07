import type { TerminalInstance } from "@/store";
import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";
import type { TabGroupLocation } from "@/types";
import { generateAgentCommand } from "@shared/types";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { agentSettingsClient, systemClient } from "@/clients";

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
        const [agentSettings, tmpDir] = await Promise.all([
          agentSettingsClient.get(),
          systemClient.getTmpDir().catch(() => ""),
        ]);
        const entry = agentSettings?.agents?.[panel.agentId] ?? {};
        const clipboardDirectory = tmpDir ? `${tmpDir}/canopy-clipboard` : undefined;
        return generateAgentCommand(agentConfig.command, entry, panel.agentId, {
          interactive: true,
          clipboardDirectory,
          modelId: panel.agentModelId,
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

function buildKindSpecificOptions(panel: TerminalInstance): Partial<AddPanelOptions> {
  const kind = panel.kind ?? "terminal";

  if (kind === "browser") {
    return { browserUrl: panel.browserUrl, browserConsoleOpen: panel.browserConsoleOpen };
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
      devPreviewConsoleOpen: panel.devPreviewConsoleOpen,
    };
  }

  return {};
}

/**
 * Build a synchronous snapshot of a panel's config for last-closed fallback.
 * Copies the same fields as buildPanelDuplicateOptions but preserves the
 * existing command verbatim (no async agent command regeneration).
 * Does not include location — callers inject it at use time.
 */
export function buildPanelSnapshotOptions(panel: TerminalInstance): AddPanelOptions {
  const kind = panel.kind ?? "terminal";
  return {
    kind,
    type: panel.type,
    agentId: panel.agentId,
    cwd: panel.cwd || "",
    worktreeId: panel.worktreeId,
    exitBehavior: panel.exitBehavior,
    isInputLocked: panel.isInputLocked,
    agentModelId: panel.agentModelId,
    agentLaunchFlags: panel.agentLaunchFlags ? [...panel.agentLaunchFlags] : undefined,
    command: panel.command,
    ...buildKindSpecificOptions(panel),
  };
}

/**
 * Build the full AddPanelOptions needed to duplicate a panel.
 * Callers pass the target location since it may differ from the source.
 * Target location must be "grid" or "dock" (not "trash").
 */
export async function buildPanelDuplicateOptions(
  sourcePanel: TerminalInstance,
  targetLocation: TabGroupLocation
): Promise<AddPanelOptions> {
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
    agentModelId: sourcePanel.agentModelId,
    agentLaunchFlags: sourcePanel.agentLaunchFlags,
    command,
    ...buildKindSpecificOptions(sourcePanel),
  };
}
