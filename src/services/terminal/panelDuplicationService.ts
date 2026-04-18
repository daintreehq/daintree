import type { TerminalInstance } from "@/store";
import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";
import type { TabGroupLocation } from "@/types";
import { generateAgentCommand } from "@shared/types";
import {
  getAgentConfig,
  isRegisteredAgent,
  getMergedFlavor,
  sanitizeAgentEnv,
} from "@/config/agents";
import { agentSettingsClient, systemClient } from "@/clients";
import { useCcrFlavorsStore } from "@/store/ccrFlavorsStore";

export interface ResolvedCommand {
  command: string | undefined;
  env: Record<string, string> | undefined;
  /** Resolved flavor, or undefined if the saved flavorId is stale/deleted. */
  flavor: import("@/config/agents").AgentFlavor | undefined;
  /** True when the caller requested a flavor but it no longer resolves. */
  flavorWasStale: boolean;
}

/**
 * Generate the startup command for a panel being duplicated.
 * For agent panels, re-generates the command from current settings and
 * merges globalEnv + flavor env the same way useAgentLauncher does (global
 * first, flavor overrides). For all others, copies the existing command.
 */
async function resolveCommandForPanel(panel: TerminalInstance): Promise<ResolvedCommand> {
  if (panel.agentId && isRegisteredAgent(panel.agentId)) {
    const agentConfig = getAgentConfig(panel.agentId);
    if (agentConfig) {
      try {
        const [agentSettings, tmpDir] = await Promise.all([
          agentSettingsClient.get(),
          systemClient.getTmpDir().catch(() => ""),
        ]);
        const entry = agentSettings?.agents?.[panel.agentId] ?? {};
        const ccrFlavors = useCcrFlavorsStore.getState().ccrFlavorsByAgent[panel.agentId];
        const flavor = panel.agentFlavorId
          ? getMergedFlavor(panel.agentId, panel.agentFlavorId, entry.customFlavors, ccrFlavors)
          : undefined;
        const flavorWasStale = !!panel.agentFlavorId && !flavor;
        const effectiveEntry = flavor
          ? {
              ...entry,
              ...(flavor.dangerousEnabled !== undefined && {
                dangerousEnabled: flavor.dangerousEnabled,
              }),
              ...(flavor.customFlags !== undefined && { customFlags: flavor.customFlags }),
              ...(flavor.inlineMode !== undefined && { inlineMode: flavor.inlineMode }),
            }
          : entry;
        const clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
        const command = generateAgentCommand(agentConfig.command, effectiveEntry, panel.agentId, {
          interactive: true,
          clipboardDirectory,
          modelId: panel.agentModelId,
          flavorArgs: flavor?.args?.join(" "),
        });
        // Mirror useAgentLauncher.ts: global env first, flavor env wins on
        // conflicts. Critical for duplicates — dropping globalEnv here
        // silently routes the duplicated panel to the default backend.
        const sanitizedGlobal = sanitizeAgentEnv(entry.globalEnv as Record<string, unknown>);
        const sanitizedFlavor = flavor?.env;
        const mergedEnv =
          sanitizedGlobal || sanitizedFlavor
            ? { ...sanitizedGlobal, ...sanitizedFlavor }
            : undefined;
        return { command, env: mergedEnv, flavor, flavorWasStale };
      } catch (error) {
        console.warn(
          `Failed to get agent settings for ${panel.agentId}, using existing command:`,
          error
        );
        return {
          command: panel.command ?? agentConfig.command,
          env: undefined,
          flavor: undefined,
          flavorWasStale: false,
        };
      }
    }
  }
  return { command: panel.command, env: undefined, flavor: undefined, flavorWasStale: false };
}

function buildBrowserOptions(panel: TerminalInstance) {
  return {
    browserUrl: panel.browserUrl,
    browserConsoleOpen: panel.browserConsoleOpen,
  };
}

function buildNotesOptions(panel: TerminalInstance) {
  return {
    notePath: panel.notePath,
    noteId: panel.noteId,
    scope: panel.scope,
    createdAt: Date.now(),
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
 * Returns `null` for broken agent panels (missing `command` or `agentId`).
 * Callers should treat `null` as "don't overwrite lastClosedConfig". Returning
 * a terminal-kind fallback is unsafe: `addPanel` re-derives `kind: "agent"`
 * from `agentId` on reopen (core.ts), resurrecting the #5211 bare-shell bug.
 */
export function buildPanelSnapshotOptions(panel: TerminalInstance): AddPanelOptions | null {
  const kind = panel.kind ?? "terminal";

  if (kind === "agent") {
    if (!panel.agentId || !panel.command) {
      return null;
    }
    return {
      kind: "agent",
      type: panel.type,
      agentId: panel.agentId,
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
      type: panel.type,
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      isInputLocked: panel.isInputLocked,
      ...buildBrowserOptions(panel),
    };
  }

  if (kind === "notes") {
    return {
      kind: "notes",
      type: panel.type,
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      isInputLocked: panel.isInputLocked,
      ...buildNotesOptions(panel),
    };
  }

  if (kind === "dev-preview") {
    return {
      kind: "dev-preview",
      type: panel.type,
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      isInputLocked: panel.isInputLocked,
      ...buildDevPreviewOptions(panel),
    };
  }

  return {
    kind: "terminal",
    type: panel.type,
    agentId: panel.agentId,
    title: panel.title,
    cwd: panel.cwd || "",
    worktreeId: panel.worktreeId,
    exitBehavior: panel.exitBehavior,
    isInputLocked: panel.isInputLocked,
    agentModelId: panel.agentModelId,
    agentFlavorId: panel.agentFlavorId,
    agentFlavorColor: panel.agentFlavorColor,
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
  const { command, env, flavorWasStale } = await resolveCommandForPanel(sourcePanel);

  if (kind === "agent") {
    if (!sourcePanel.agentId || !command) {
      throw new Error(
        `Cannot duplicate agent panel: ${!sourcePanel.agentId ? "agentId" : "command"} is missing`
      );
    }
    // When the saved flavor no longer resolves (deleted custom flavor, CCR
    // route removed from config), null out the flavor-derived fields so the
    // duplicate doesn't lie about its identity — blue "Claude (Pro)" title
    // with vanilla env is the split-brain the review flagged.
    const agentConfig = getAgentConfig(sourcePanel.agentId);
    const fallbackTitle = agentConfig?.name ?? sourcePanel.title;
    const agentFlavorId = flavorWasStale ? undefined : sourcePanel.agentFlavorId;
    const agentFlavorColor = flavorWasStale ? undefined : sourcePanel.agentFlavorColor;
    const title = flavorWasStale ? fallbackTitle : sourcePanel.title;
    return {
      kind: "agent",
      type: sourcePanel.type,
      agentId: sourcePanel.agentId,
      command,
      title,
      cwd: sourcePanel.cwd || "",
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      exitBehavior: sourcePanel.exitBehavior,
      isInputLocked: sourcePanel.isInputLocked,
      agentModelId: sourcePanel.agentModelId,
      agentFlavorId,
      agentFlavorColor,
      agentLaunchFlags: sourcePanel.agentLaunchFlags,
      env,
    };
  }

  if (kind === "browser") {
    return {
      kind: "browser",
      type: sourcePanel.type,
      cwd: sourcePanel.cwd || "",
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      exitBehavior: sourcePanel.exitBehavior,
      isInputLocked: sourcePanel.isInputLocked,
      ...buildBrowserOptions(sourcePanel),
    };
  }

  if (kind === "notes") {
    return {
      kind: "notes",
      type: sourcePanel.type,
      cwd: sourcePanel.cwd || "",
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      exitBehavior: sourcePanel.exitBehavior,
      isInputLocked: sourcePanel.isInputLocked,
      ...buildNotesOptions(sourcePanel),
    };
  }

  if (kind === "dev-preview") {
    return {
      kind: "dev-preview",
      type: sourcePanel.type,
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
    type: sourcePanel.type,
    agentId: sourcePanel.agentId,
    cwd: sourcePanel.cwd || "",
    title: sourcePanel.title,
    worktreeId: sourcePanel.worktreeId,
    location: targetLocation,
    exitBehavior: sourcePanel.exitBehavior,
    isInputLocked: sourcePanel.isInputLocked,
    agentModelId: sourcePanel.agentModelId,
    agentFlavorId: sourcePanel.agentFlavorId,
    agentFlavorColor: sourcePanel.agentFlavorColor,
    agentLaunchFlags: sourcePanel.agentLaunchFlags,
    env,
    command,
  };
}
