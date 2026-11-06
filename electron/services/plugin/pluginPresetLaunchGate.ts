import { createHash } from "node:crypto";

import { type AgentPreset, getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import {
  resolveDangerousMode,
  resolveEffectiveBypass,
  type AgentSettings,
} from "../../../shared/types/agentSettings.js";
import type { BuiltInPluginCapability, PluginScopeKey } from "../../../shared/types/plugin.js";
import { resolveLaunchAccount } from "../../../shared/utils/agentAccounts.js";
import {
  AGENT_LAUNCH_PRESET_CAPABILITY,
  pluginPresetLaunchRequest,
  presetLaunchContent,
  type HostApprovedPluginPresetLaunch,
  type PluginPresetLaunchSummary,
} from "../../../shared/utils/agentPresetLaunchConsent.js";
import {
  applyPresetBehaviorOverrides,
  getMergedPreset,
  getMergedPresetIdentities,
  getMergedPresets,
} from "../../../shared/utils/agentPresets.js";

/** The three layers a launch merges presets from, as main reads them. */
export interface PresetLaunchSources {
  settings: AgentSettings | null;
  ccrPresets: AgentPreset[] | undefined;
  projectPresets: AgentPreset[] | undefined;
}

export interface PluginPresetLaunchGateDeps {
  /** Read the presets a launch of `agentId` in this project would merge. */
  readSources(agentId: string, projectId: string | null): Promise<PresetLaunchSources>;
  /** The project an unbound dispatch lands in: the focused view's, or none. */
  ambientProjectId(): string | null;
  ensurePresetLaunchAllowed(
    pluginId: string,
    pluginDisplayName: string,
    summary: PluginPresetLaunchSummary,
    fingerprint: string,
    declaredCapabilities: readonly BuiltInPluginCapability[],
    scopeKey: PluginScopeKey
  ): Promise<void>;
}

export interface PluginPresetLaunchCaller {
  pluginId: string;
  displayName: string;
  declaredCapabilities: readonly BuiltInPluginCapability[];
  /** The instance's own binding, never a parameter the plugin set. */
  scopeKey: PluginScopeKey;
}

export type PluginPresetLaunchGateResult =
  /** Not a preset-only launch, or the plugin doesn't declare the capability: dispatch as is. */
  | { kind: "pass" }
  | { kind: "approved"; approval: HostApprovedPluginPresetLaunch }
  | { kind: "refused"; result: ActionDispatchResult };

/**
 * Main's half of a plugin launching an agent on a preset (#16324): find the
 * preset the launch would use, ask the person about it once, and hand back
 * the approval the renderer checks the launch against.
 *
 * Main reads the presets itself rather than asking the view, so the dialog
 * shows what is on disk and in settings now, not a view's last poll. The view
 * may still resolve something else (a repo pull it hasn't read yet, another
 * focused project); its launch then refuses on the content check rather than
 * running what nobody approved.
 */
export async function gatePluginPresetLaunch(
  caller: PluginPresetLaunchCaller,
  actionId: string,
  args: unknown,
  projectId: string | null,
  deps: PluginPresetLaunchGateDeps
): Promise<PluginPresetLaunchGateResult> {
  const request = pluginPresetLaunchRequest(actionId, args);
  if (request === null) return { kind: "pass" };
  // Without the capability the renderer's refusal stands, word for word.
  if (!caller.declaredCapabilities.includes(AGENT_LAUNCH_PRESET_CAPABILITY)) {
    return { kind: "pass" };
  }
  const { agentId, presetId } = request;
  const agentConfig = getEffectiveAgentConfig(agentId);
  if (!agentConfig) {
    return refused(`"${agentId.slice(0, 100)}" is not an agent this host can launch on a preset`);
  }

  const sources = await deps.readSources(agentId, projectId ?? deps.ambientProjectId());
  const entry = sources.settings?.agents?.[agentId] ?? {};
  const preset = getMergedPreset(
    agentId,
    presetId,
    entry.customPresets,
    sources.ccrPresets,
    sources.projectPresets
  );
  if (!preset) {
    return refused(
      `${agentConfig.name} has no preset "${presetId.slice(0, 100)}". Ask for one of its presets by id.`
    );
  }
  const source =
    getMergedPresetIdentities(
      agentId,
      entry.customPresets,
      sources.ccrPresets,
      sources.projectPresets
    ).find((identity) => identity.id === preset.id)?.source ?? "custom";
  const content = presetLaunchContent(preset);
  const fingerprint = createHash("sha256").update(JSON.stringify([source, content])).digest("hex");

  const merged = getMergedPresets(
    agentId,
    entry.customPresets,
    sources.ccrPresets ?? agentConfig.presets ?? [],
    sources.projectPresets
  );
  const record = args as Record<string, unknown>;
  const account = resolveLaunchAccount(
    agentId,
    entry,
    typeof record.worktreeId === "string" ? record.worktreeId : undefined,
    typeof record.accountId === "string" || record.accountId === null
      ? record.accountId
      : undefined,
    preset.accountId
  );
  const summary: PluginPresetLaunchSummary = {
    agentId,
    agentName: agentConfig.name,
    presetId: preset.id,
    presetName: preset.name,
    source,
    args: preset.args ?? [],
    ...(preset.customFlags !== undefined ? { customFlags: preset.customFlags } : {}),
    dangerousMode: resolveDangerousMode(preset),
    skipsPermissions: resolveEffectiveBypass(
      applyPresetBehaviorOverrides(entry, preset),
      agentId,
      sources.settings?.globalSkipPermissions
    ),
    ...(account.kind === "account" ? { accountName: account.account.name } : {}),
    envNames: Object.keys(preset.env ?? {}).sort(),
    fallbackNames: (preset.fallbacks ?? []).map(
      (id) => merged.find((candidate) => candidate.id === id)?.name ?? id
    ),
    fallbackOnRateLimit: preset.fallbackOnRateLimit === true,
  };

  await deps.ensurePresetLaunchAllowed(
    caller.pluginId,
    caller.displayName,
    summary,
    fingerprint,
    caller.declaredCapabilities,
    caller.scopeKey
  );
  return { kind: "approved", approval: { agentId, presetId: preset.id, content } };
}

function refused(message: string): PluginPresetLaunchGateResult {
  return { kind: "refused", result: { ok: false, error: { code: "VALIDATION_ERROR", message } } };
}

/**
 * The gate's production wiring, imported only when a plugin names a preset,
 * so a host where no plugin does pays nothing for it.
 */
export async function createPluginPresetLaunchGateDeps(): Promise<PluginPresetLaunchGateDeps> {
  const [
    { store },
    { CcrConfigService },
    { projectStore },
    { resolveTargetWebContents },
    { getProjectForWebContents },
    { getPluginCapabilityConsentService },
  ] = await Promise.all([
    import("../../store.js"),
    import("../CcrConfigService.js"),
    import("../ProjectStore.js"),
    import("./rendererTargeting.js"),
    import("../../window/webContentsRegistry.js"),
    import("../plugin-capability/instances.js"),
  ]);
  return {
    readSources: async (agentId, projectId) => {
      // Discovered presets exist for Claude only, as the view holds them.
      const ccr = agentId === "claude" ? await CcrConfigService.getInstance().loadAndApply() : [];
      const path = projectId ? projectStore.getProjectById(projectId)?.path : undefined;
      const projectPresets = path ? (await projectStore.readInRepoPresets(path))[agentId] : undefined;
      return {
        settings: store.get("agentSettings") ?? null,
        ccrPresets: ccr.length > 0 ? ccr : undefined,
        projectPresets,
      };
    },
    ambientProjectId: () => {
      try {
        const webContents = resolveTargetWebContents(null, "Plugin preset launch");
        return webContents ? getProjectForWebContents(webContents.id) : null;
      } catch {
        return null;
      }
    },
    ensurePresetLaunchAllowed: (...params) =>
      getPluginCapabilityConsentService().ensurePresetLaunchAllowed(...params),
  };
}
