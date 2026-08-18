import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";
import {
  isPtyPanel,
  isBrowserPanel,
  isDevPreviewPanel,
  type PanelInstance,
  type PanelKind,
} from "@shared/types/panel";
import type { TabGroupLocation } from "@/types";
import {
  generateAgentCommand,
  mintAssignedSessionId,
  stripAssignedSessionIdArgs,
} from "@shared/types";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { agentSettingsClient, systemClient } from "@/clients";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { getWorktreePathIndex } from "@/store/storeAccessors";
import { classifyLaunchRootAlignment } from "@/utils/worktreeAlignment";
import {
  buildAgentLaunchFlagsForRuntimeSettings,
  resolveAgentRuntimeSettings,
} from "@/utils/agentRuntimeSettings";

/**
 * Ownership rung for a duplicated panel's title. A duplicate keeps an
 * explicitly-named title pinned (otherwise agent detection immediately
 * rewrites "X (copy)" back to the registry name), but demotes `"user"` to
 * `"custom"` — the human named the source panel, not the copy, so automation
 * may still rename it and the task title still composes.
 */
function duplicateTitleMode(
  panel: import("@shared/types/panel").PtyPanelData
): import("@shared/types/panel").PanelTitleMode | undefined {
  const mode = panel.titleMode ?? "default";
  return mode === "default" ? undefined : "custom";
}

export interface ResolvedCommand {
  command: string | undefined;
  env: Record<string, string> | undefined;
  agentLaunchFlags: string[] | undefined;
  /** Resolved preset, or undefined if the saved presetId is stale/deleted. */
  preset: import("@/config/agents").AgentPreset | undefined;
  /** True when the caller requested a preset but it no longer resolves. */
  presetWasStale: boolean;
  /**
   * Session id minted for the duplicate (#11782), when its agent accepts one at
   * launch. Always a NEW id — never the source pane's, which still belongs to
   * the conversation being copied from.
   */
  agentSessionId: string | undefined;
}

/**
 * Generate the startup command for a panel being duplicated.
 * For agent panels, re-generates the command from current settings and
 * merges globalEnv + preset env the same way useAgentLauncher does (global
 * first, preset overrides). For all others, copies the existing command.
 */
async function resolveCommandForPanel(panel: PanelInstance): Promise<ResolvedCommand> {
  if (isPtyPanel(panel) && panel.launchAgentId && isRegisteredAgent(panel.launchAgentId)) {
    const agentConfig = getAgentConfig(panel.launchAgentId);
    if (agentConfig) {
      try {
        const [agentSettings, tmpDir] = await Promise.all([
          agentSettingsClient.get(),
          systemClient.getTmpDir().catch(() => ""),
        ]);
        const entry = agentSettings?.agents?.[panel.launchAgentId] ?? {};
        const ccrPresets = useCcrPresetsStore.getState().ccrPresetsByAgent[panel.launchAgentId];
        const projectPresets =
          useProjectPresetsStore.getState().presetsByAgent[panel.launchAgentId];
        const runtimeSettings = resolveAgentRuntimeSettings({
          agentId: panel.launchAgentId,
          presetId: panel.agentPresetId,
          entry,
          ccrPresets,
          projectPresets,
        });
        const { preset, presetWasStale, effectiveEntry } = runtimeSettings;
        const globalSkipPermissions = agentSettings?.globalSkipPermissions ?? false;
        const globalUseAltScreen = agentSettings?.globalUseAltScreen ?? false;
        const clipboardDirectory = tmpDir ? `${tmpDir}/daintree-clipboard` : undefined;
        // A duplicate is a NEW conversation, so it mints its own id (#11782).
        // Inheriting the source pane's would aim both panes at one conversation
        // and the CLI would reject the second launch outright.
        const agentSessionId = mintAssignedSessionId(panel.launchAgentId);
        const command = generateAgentCommand(
          agentConfig.command,
          effectiveEntry,
          panel.launchAgentId,
          {
            interactive: true,
            clipboardDirectory,
            modelId: panel.agentModelId,
            presetArgs: preset?.args?.join(" "),
            globalSkipPermissions,
            globalUseAltScreen,
            sessionId: agentSessionId,
          }
        );
        const agentLaunchFlags = buildAgentLaunchFlagsForRuntimeSettings(
          effectiveEntry,
          panel.launchAgentId,
          preset,
          { modelId: panel.agentModelId, globalSkipPermissions, globalUseAltScreen }
        );
        return {
          command,
          env: runtimeSettings.env,
          agentLaunchFlags,
          preset,
          presetWasStale,
          agentSessionId,
        };
      } catch (error) {
        console.warn(
          `Failed to get agent settings for ${panel.launchAgentId}, using existing command:`,
          error
        );
        return {
          // Reusing the source's command verbatim would clone its assigned
          // session id along with it, so strip that back off (#11782) and let
          // this copy launch as the fresh conversation it is.
          command: stripAssignedSessionIdArgs(
            panel.command ?? agentConfig.command,
            panel.launchAgentId
          ),
          env: undefined,
          agentLaunchFlags: panel.agentLaunchFlags,
          preset: undefined,
          presetWasStale: false,
          agentSessionId: undefined,
        };
      }
    }
  }
  return {
    command: isPtyPanel(panel) ? panel.command : undefined,
    env: undefined,
    agentLaunchFlags: isPtyPanel(panel) ? panel.agentLaunchFlags : undefined,
    preset: undefined,
    presetWasStale: false,
    agentSessionId: undefined,
  };
}

function buildBrowserOptions(panel: import("@shared/types/panel").BrowserPanelData) {
  return {
    browserUrl: panel.browserUrl,
    browserConsoleOpen: panel.browserConsoleOpen,
  };
}

function buildDevPreviewOptions(panel: import("@shared/types/panel").DevPreviewPanelData) {
  return {
    devCommand: panel.devCommand,
    browserUrl: panel.browserUrl,
    devPreviewConsoleOpen: panel.devPreviewConsoleOpen,
  };
}

/**
 * Working directory for a panel that inherits its worktree rather than choosing
 * one. A duplicate is a brand new process, so it belongs in the worktree it is
 * filed under — not the directory the source process kept after a cross-worktree
 * drag left `cwd` and `worktreeId` pointing at different worktrees (#11854).
 *
 * Only a genuine mismatch is rerooted. A launch root already inside the filed
 * worktree is left alone, because a subdirectory is a deliberate choice there —
 * `UpdateCwdDialog` and an explicit `terminal.spawn` cwd both produce one, and
 * collapsing them to the worktree root would discard what the user picked.
 * `classifyLaunchRootAlignment` makes that call segment-aware, so it survives
 * nested worktrees and Windows separators where `startsWith` would not.
 *
 * Takes the filing id and the inherited fallback together so no branch can
 * resolve one without the other. Soft-degrades to the inherited `cwd` when the
 * panel has no worktree, no view store is mounted, or the id no longer resolves:
 * the id is inherited rather than asserted by a caller, so a stale one must not
 * fail the launch (#11655).
 */
export function resolveInheritedPanelCwd(panel: { cwd?: string; worktreeId?: string }): string {
  const fallback = panel.cwd || "";
  if (!panel.worktreeId) return fallback;

  const index = getWorktreePathIndex();
  const filedPath = index?.get(panel.worktreeId);
  if (!index || !filedPath) return fallback;

  const worktrees = Array.from(index, ([id, path]) => ({ id, path }));
  return classifyLaunchRootAlignment(fallback, worktrees, panel.worktreeId) === "aligned"
    ? fallback
    : filedPath;
}

/**
 * Build a synchronous snapshot of a panel's config for last-closed fallback.
 * Copies the same fields as buildPanelDuplicateOptions but preserves the
 * existing command verbatim (no async agent command regeneration).
 * Does not include location — callers inject it at use time.
 *
 * Keeps `cwd` verbatim rather than resolving it against `worktreeId` the way
 * `buildPanelDuplicateOptions` does. This snapshot is stored and reopened much
 * later, so resolving here would freeze one answer and destroy the fallback the
 * late resolve needs: if the filed worktree is deleted between trash and reopen,
 * a baked-in path points at the deleted worktree while the untouched `cwd` still
 * points somewhere real. `terminal.duplicate` resolves at reopen instead (#11854).
 *
 * Called synchronously from `trashPanel` / `trashPanelGroup` — must not throw.
 * Returns `null` for broken agent-running terminals (missing `command` or
 * `agentId`). Callers should treat `null` as "don't overwrite lastClosedConfig" —
 * silently dropping agent identity (the #5211 bare-shell bug) is worse than no
 * snapshot.
 */
export function buildPanelSnapshotOptions(panel: PanelInstance): AddPanelOptions | null {
  const kind = panel.kind;

  if (isPtyPanel(panel) && panel.launchAgentId && kind === "terminal") {
    if (!panel.command) {
      return null;
    }
    return {
      kind: "terminal",
      launchAgentId: panel.launchAgentId,
      // Reopening starts a new conversation, so the assigning flag must not
      // ride along — it is one-shot and the relaunch would be rejected
      // outright (#11782).
      command: stripAssignedSessionIdArgs(panel.command, panel.launchAgentId),
      title: panel.title,
      // Reopen-last restores the same terminal — the ownership rung carries
      // verbatim so a renamed title stays pinned across close/reopen.
      titleMode: panel.titleMode,
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      isInputLocked: panel.isInputLocked,
      agentModelId: panel.agentModelId,
      agentPresetId: panel.agentPresetId,
      agentPresetColor: panel.agentPresetColor,
      originalPresetId: panel.originalPresetId,
      isUsingFallback: panel.isUsingFallback,
      fallbackChainIndex: panel.fallbackChainIndex,
      agentLaunchFlags: panel.agentLaunchFlags ? [...panel.agentLaunchFlags] : undefined,
    };
  }

  if (isBrowserPanel(panel)) {
    return {
      kind: "browser",
      cwd: "",
      worktreeId: panel.worktreeId,
      ...buildBrowserOptions(panel),
    };
  }

  if (isDevPreviewPanel(panel)) {
    return {
      kind: "dev-preview",
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      ...buildDevPreviewOptions(panel),
    };
  }

  if (kind === "review") {
    return {
      kind: "review",
      worktreeId: panel.worktreeId,
    };
  }

  if (isPtyPanel(panel)) {
    return {
      kind: "terminal",
      launchAgentId: panel.launchAgentId,
      title: panel.title,
      titleMode: panel.titleMode,
      cwd: panel.cwd || "",
      worktreeId: panel.worktreeId,
      exitBehavior: panel.exitBehavior,
      isInputLocked: panel.isInputLocked,
      agentModelId: panel.agentModelId,
      agentPresetId: panel.agentPresetId,
      agentPresetColor: panel.agentPresetColor,
      agentLaunchFlags: panel.agentLaunchFlags ? [...panel.agentLaunchFlags] : undefined,
      // Same one-shot rule as the agent branch above (#11782).
      command: panel.command
        ? stripAssignedSessionIdArgs(panel.command, panel.launchAgentId)
        : panel.command,
    };
  }

  return null;
}

/**
 * Kinds `buildPanelDuplicateOptions` can actually duplicate. Gates the
 * "Duplicate panel as new tab" affordance so kinds without a duplicate
 * recipe (file panels, plugin panels) never show a dead button.
 */
export function canDuplicatePanelKind(kind: PanelKind | undefined): boolean {
  switch (kind ?? "terminal") {
    case "terminal":
    case "browser":
    case "dev-preview":
    case "review":
      return true;
    default:
      return false;
  }
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
  sourcePanel: PanelInstance,
  targetLocation: TabGroupLocation
): Promise<AddPanelOptions> {
  const kind = sourcePanel.kind;
  const { command, env, agentLaunchFlags, preset, presetWasStale, agentSessionId } =
    await resolveCommandForPanel(sourcePanel);

  if (isPtyPanel(sourcePanel) && sourcePanel.launchAgentId && kind === "terminal") {
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
    const agentPresetColor = presetWasStale
      ? undefined
      : (preset?.color ?? sourcePanel.agentPresetColor);
    const title = presetWasStale ? fallbackTitle : sourcePanel.title;
    return {
      kind: "terminal",
      launchAgentId: sourcePanel.launchAgentId,
      command,
      title,
      // Keep explicit names pinned on the copy — without this, detection
      // rewrites "X (copy)" back to the registry name moments after spawn.
      titleMode: presetWasStale ? undefined : duplicateTitleMode(sourcePanel),
      cwd: resolveInheritedPanelCwd(sourcePanel),
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      exitBehavior: sourcePanel.exitBehavior,
      isInputLocked: sourcePanel.isInputLocked,
      agentModelId: sourcePanel.agentModelId,
      agentPresetId,
      agentPresetColor,
      agentLaunchFlags,
      agentSessionId,
      env,
    };
  }

  if (isBrowserPanel(sourcePanel)) {
    return {
      kind: "browser",
      cwd: "",
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      ...buildBrowserOptions(sourcePanel),
    };
  }

  if (isDevPreviewPanel(sourcePanel)) {
    return {
      kind: "dev-preview",
      cwd: resolveInheritedPanelCwd(sourcePanel),
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
      exitBehavior: sourcePanel.exitBehavior,
      ...buildDevPreviewOptions(sourcePanel),
    };
  }

  if (kind === "review") {
    return {
      kind: "review",
      worktreeId: sourcePanel.worktreeId,
      location: targetLocation,
    };
  }

  if (isPtyPanel(sourcePanel)) {
    return {
      kind: "terminal",
      launchAgentId: sourcePanel.launchAgentId,
      cwd: resolveInheritedPanelCwd(sourcePanel),
      title: sourcePanel.title,
      titleMode: duplicateTitleMode(sourcePanel),
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

  throw new Error(`Cannot duplicate panel of kind "${kind}"`);
}
