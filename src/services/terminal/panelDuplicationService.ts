import type { TerminalInstance } from "@/store";
import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";
import type { TabGroupLocation } from "@/types";
import { generateAgentCommand } from "@shared/types";
import {
  getAgentConfig,
  isRegisteredAgent,
  getMergedPreset,
  sanitizeAgentEnv,
} from "@/config/agents";
import { agentSettingsClient, systemClient } from "@/clients";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";

export interface ResolvedCommand {
  command: string | undefined;
  env: Record<string, string> | undefined;
  /** Resolved preset, or undefined if the saved presetId is stale/deleted. */
  preset: import("@/config/agents").AgentPreset | undefined;
  /** True when the caller requested a preset but it no longer resolves. */
  presetWasStale: boolean;
}

/**
 * Generate the startup command for a panel being duplicated.
 * For agent panels, re-generates the command from current settings and
 * merges globalEnv + preset env the same way useAgentLauncher does (global
 * first, preset overrides). For all others, copies the existing command.
 */
async function resolveCommandForPanel(panel: TerminalInstance): Promise<ResolvedCommand> {
  if (panel.launchAgentId && isRegisteredAgent(panel.launchAgentId)) {
    const agentConfig = getAgentConfig(panel.launchAgentId);
    if (agentConfig) {
      try {
        const [agentSettings, tmpDir] = await Promise.all([
          agentSettingsClient.get(),
          systemClient.getTmpDir().catch(() => ""),
        ]);
        const entry = agentSettings?.agents?.[panel.launchAgentId] ?? {};
        const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[panel.launchAgentId];
        const preset = panel.agentPresetId
          ? getMergedPreset(
              panel.launchAgentId,
              panel.agentPresetId,
              entry.customPresets,
              ccrPresets
            )
          : undefined;
        const presetWasStale = !!panel.agentPresetId && !preset;
        const effectiveEntry = preset
          ? {
              ...entry,
              ...(preset.dangerousEnabled !== undefined && {
                dangerousEnabled: preset.dangerousEnabled,
              }),
              ...(preset.customFlags !== undefined && { customFlags: preset.customFlags }),
              ...(preset.inlineMode !== undefined && { inlineMode: preset.inlineMode }),
            }
          : entry;
        const clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
        const command = generateAgentCommand(
          agentConfig.command,
          effectiveEntry,
          panel.launchAgentId,
          {
            interactive: true,
            clipboardDirectory,
            modelId: panel.agentModelId,
            presetArgs: preset?.args?.join(" "),
          }
        );
        // Mirror useAgentLauncher.ts: global env first, preset env wins on
        // conflicts. Critical for duplicates — dropping globalEnv here
        // silently routes the duplicated panel to the default backend.
        const sanitizedGlobal = sanitizeAgentEnv(entry.globalEnv as Record<string, unknown>);
        const sanitizedPreset = preset?.env;
        const mergedEnv =
          sanitizedGlobal || sanitizedPreset
            ? { ...sanitizedGlobal, ...sanitizedPreset }
            : undefined;
        return { command, env: mergedEnv, preset, presetWasStale };
      } catch (error) {
        console.warn(
          `Failed to get agent settings for ${panel.launchAgentId}, using existing command:`,
          error
        );
        return {
          command: panel.command ?? agentConfig.command,
          env: undefined,
          preset: undefined,
          presetWasStale: false,
        };
      }
    }
  }
  return { command: panel.command, env: undefined, preset: undefined, presetWasStale: false };
}

function buildBrowserOptions(panel: TerminalInstance) {
  return {
    browserUrl: panel.browserUrl,
    browserConsoleOpen: panel.browserConsoleOpen,
  };
}

function buildDevPreviewOptions(panel: TerminalInstance) {
  return {
    devCommand: panel.devCommand,
    browserUrl: panel.browserUrl,
    devPreviewConsoleOpen: panel.devPreviewConsoleOpen,
  };
}

/**
 * Build a synchronous snapshot of a panel's config for last-closed fallback.
 * Copies the same fields as buildPanelDuplicateOptions but preserves the
 * existing command verbatim (no async agent command regeneration).
 * Does not include location — callers inject it at use time.
 *
 * Called synchronously from `trashPanel` / `trashPanelGroup` — must not throw.
 * Returns `null` for broken agent-running terminals (missing `command` or
 * `agentId`). Callers should treat `null` as "don't overwrite lastClosedConfig" —
 * silently dropping agent identity (the #5211 bare-shell bug) is worse than no
 * snapshot.
 */
export function buildPanelSnapshotOptions(panel: TerminalInstance): AddPanelOptions | null {
  const kind = panel.kind ?? "terminal";

  if (panel.launchAgentId && kind === "terminal") {
    if (!panel.command) {
      return null;
    }
    return {
      kind: "terminal",
      launchAgentId: panel.launchAgentId,
      command: panel.command,
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      isInputLocked: panel.isInputLocked,
      agentModelId: panel.agentModelId,
      agentLaunchFlags: panel.agentLaunchFlags ? [...panel.agentLaunchFlags] : undefined,
    };
  }

  if (kind === "browser") {
    return {
      kind: "browser",
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      isInputLocked: panel.isInputLocked,
      ...buildBrowserOptions(panel),
    };
  }

  if (kind === "dev-preview") {
    return {
      kind: "dev-preview",
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      isInputLocked: panel.isInputLocked,
      ...buildDevPreviewOptions(panel),
    };
  }

  return {
    kind: "terminal",
    launchAgentId: panel.launchAgentId,
    title: panel.title,
    cwd: panel.cwd || "",
    worktreeId: panel.worktreeId,
    exitBehavior: panel.exitBehavior,
    isInputLocked: panel.isInputLocked,
    agentModelId: panel.agentModelId,
    agentPresetId: panel.agentPresetId,
    agentPresetColor: panel.agentPresetColor,
    agentLaunchFlags: panel.agentLaunchFlags ? [...panel.agentLaunchFlags] : undefined,
    command: panel.command,
  };
}

/**
 * Build the full AddPanelOptions needed to duplicate a panel.
 * Callers pass the target location since it may differ from the source.
 * Target location must be "grid" or "dock" (not "trash").
 *
 * Throws when an agent panel cannot be duplicated because its `command` or
 * `agentId` is unresolvable — callers already wrap this in try/catch.
 */
export async function buildPanelDuplicateOptions(
  sourcePanel: TerminalInstance,
  targetLocation: TabGroupLocation
): Promise<AddPanelOptions> {
  const kind = sourcePanel.kind ?? "terminal";
  const { command, env, presetWasStale } = await resolveCommandForPanel(sourcePanel);

  if (sourcePanel.launchAgentId && kind === "terminal") {
    if (!command) {
      throw new Error(`Cannot duplicate agent terminal: command is missing`);
    }
    // When the saved preset no longer resolves (deleted custom preset, CCR
    // route removed from config), null out the preset-derived fields so the
    // duplicate doesn't lie about its identity — blue "Claude (Pro)" title
    // with default env is the split-brain the review flagged.
    const agentConfig = getAgentConfig(sourcePanel.launchAgentId);
    const fallbackTitle = agentConfig?.name ?? sourcePanel.title;
    const agentPresetId = presetWasStale ? undefined : sourcePanel.agentPresetId;
    const agentPresetColor = presetWasStale ? undefined : sourcePanel.agentPresetColor;
    const title = presetWasStale ? fallbackTitle : sourcePanel.title;
    return {
      kind: "terminal",
      launchAgentId: sourcePanel.launchAgentId,
      command,
      title,
      cwd: sourcePanel.cwd || "",
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      exitBehavior: sourcePanel.exitBehavior,
      isInputLocked: sourcePanel.isInputLocked,
      agentModelId: sourcePanel.agentModelId,
      agentPresetId,
      agentPresetColor,
      agentLaunchFlags: sourcePanel.agentLaunchFlags,
      env,
    };
  }

  if (kind === "browser") {
    return {
      kind: "browser",
      cwd: sourcePanel.cwd || "",
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      exitBehavior: sourcePanel.exitBehavior,
      isInputLocked: sourcePanel.isInputLocked,
      ...buildBrowserOptions(sourcePanel),
    };
  }

  if (kind === "dev-preview") {
    return {
      kind: "dev-preview",
      cwd: sourcePanel.cwd || "",
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      exitBehavior: sourcePanel.exitBehavior,
      isInputLocked: sourcePanel.isInputLocked,
      ...buildDevPreviewOptions(sourcePanel),
    };
  }

  return {
    kind: "terminal",
    launchAgentId: sourcePanel.launchAgentId,
    cwd: sourcePanel.cwd || "",
    title: sourcePanel.title,
    worktreeId: sourcePanel.worktreeId,
    location: targetLocation,
    exitBehavior: sourcePanel.exitBehavior,
    isInputLocked: sourcePanel.isInputLocked,
    agentModelId: sourcePanel.agentModelId,
    agentPresetId: sourcePanel.agentPresetId,
    agentPresetColor: sourcePanel.agentPresetColor,
    agentLaunchFlags: sourcePanel.agentLaunchFlags,
    env,
    command,
  };
}
