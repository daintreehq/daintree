import { createHash } from "node:crypto";
import type {
  HostSettingKey,
  HostSettingValue,
  HostSettingsPatch,
} from "../../../shared/types/hostSettings.js";
import { hostSettingRefusal } from "../../../shared/types/hostSettings.js";
import { CANOPY_MODEL } from "../../../shared/types/ipc/canopy.js";
import {
  isStorableDefaultAgent,
  type AgentDefaultsPatch,
} from "../../../shared/types/ipc/agentDefaults.js";
import { resolveResumeOnRestart } from "../../../shared/types/agentSettings.js";
import {
  isIdleShellThresholdMinutes,
  type IdleBackgroundAutoCloseConfig,
} from "../../../shared/types/ipc/idleBackgroundAutoClose.js";
import { AppError } from "../../utils/errorTypes.js";
import { hostInstanceId } from "../../services/hostInstance.js";
import type { HostSettingsLeaves } from "./HostSettingsControl.js";

/** Variables in name order, so the same set always reads, and digests, the same. */
function sortedEnv(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

function digest(value: HostSettingValue): string {
  const canonical = typeof value === "object" && value !== null ? sortedEnv(value) : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical ?? null))
    .digest("hex")
    .slice(0, 32);
}

const DEFAULT_LEAK_RESTART_THRESHOLD_MB = 8192;

/**
 * The named settings, through the setters this machine's own Settings uses:
 * Canopy's guarded mode change and its model, the agent defaults, and the
 * idle-terminal and idle-project services, each telling this machine's views
 * as it always does. Leaves the store holds directly are written the way
 * their own Settings writes them, one dot-path at a time, and the views are
 * brought in line by `reconcile`. Loaded on demand, so a host nobody edits
 * pays nothing.
 */
export async function loadHostSettingsLeaves(): Promise<HostSettingsLeaves> {
  const [canopy, defaults, idle, idleBackground, { store }, { getPtyClient }] = await Promise.all([
    import("../../ipc/handlers/canopy.js"),
    import("../../services/agentDefaults.js"),
    import("../../services/IdleTerminalNotificationService.js"),
    import("../../services/IdleBackgroundAutoCloseService.js"),
    import("../../store.js"),
    import("../../window/serviceRefs.js"),
  ]);
  const idleService = idle.getIdleTerminalNotificationService();
  const idleBackgroundService = idleBackground.getIdleBackgroundAutoCloseService();
  const leaf = (value: HostSettingValue) => ({ value, revision: digest(value) });

  const read = (key: HostSettingKey): { value: HostSettingValue; revision: string } => {
    switch (key) {
      case "canopyMode": {
        const state = canopy.canopyModeState();
        // Canopy counts its own changes; the digest alone can't see "on → unset → on".
        return { value: state.mode, revision: `${state.modeRevision}` };
      }
      case "canopyModel": {
        const value = CANOPY_MODEL;
        return { value, revision: digest(value) };
      }
      case "agentDefaults.defaultAgent":
      case "agentDefaults.assistantAgentId": {
        const leaf = key === "agentDefaults.defaultAgent" ? "defaultAgent" : "assistantAgentId";
        const value = defaults.readAgentDefaults()[leaf] ?? null;
        return { value, revision: digest(value) };
      }
      case "idleTerminalNotify.enabled": {
        const value = idleService.getConfig().enabled;
        return { value, revision: digest(value) };
      }
      case "idleTerminalNotify.thresholdMinutes": {
        const value = idleService.getConfig().thresholdMinutes;
        return { value, revision: digest(value) };
      }
      case "agentSettings.resumeOnRestart":
        return leaf(resolveResumeOnRestart(store.get("agentSettings")));
      case "agentSettings.globalUseAltScreen":
        return leaf(store.get("agentSettings")?.globalUseAltScreen === true);
      case "globalEnvironmentVariables":
        return leaf(sortedEnv(store.get("globalEnvironmentVariables")));
      case "terminalConfig.resourceMonitoringEnabled":
        return leaf(store.get("terminalConfig")?.resourceMonitoringEnabled === true);
      case "terminalConfig.memoryLeakDetectionEnabled": {
        // Off unless set, or following resource monitoring, as this host's views read it.
        const config = store.get("terminalConfig");
        return leaf(
          config?.memoryLeakDetectionEnabled ?? config?.resourceMonitoringEnabled === true
        );
      }
      case "terminalConfig.memoryLeakAutoRestartThresholdMb":
        return leaf(
          store.get("terminalConfig")?.memoryLeakAutoRestartThresholdMb ??
            DEFAULT_LEAK_RESTART_THRESHOLD_MB
        );
      case "sessionRestore.enabled":
        return leaf(store.get("sessionRestore")?.enabled !== false);
      case "idleBackgroundAutoClose.enabled":
        return leaf(idleBackgroundService.getConfig().enabled);
      case "idleBackgroundAutoClose.thresholdMinutes":
        return leaf(idleBackgroundService.getConfig().thresholdMinutes);
      case "idleBackgroundAutoClose.includeIdleShells":
        return leaf(idleBackgroundService.getConfig().includeIdleShells);
      case "idleBackgroundAutoClose.idleShellThresholdMinutes":
        return leaf(idleBackgroundService.getConfig().idleShellThresholdMinutes);
    }
  };

  return {
    instanceId: hostInstanceId,
    read,
    refusal: hostSettingRefusal,
    write: (patch: HostSettingsPatch) => {
      const mode = patch.canopyMode;
      // Every refusal comes before the first write, so a patch lands whole or not at all.
      if (mode !== undefined) canopy.checkCanopyModeRate();
      if (mode === "on" && canopy.canopyModeState().mode === "hidden") {
        throw new AppError({
          code: "PERMISSION",
          message: "Canopy is hidden",
          userMessage: "Show Canopy on this host before turning it on.",
        });
      }
      // Every value was checked by `refusal` before the write queue was entered.
      const agentPatch: AgentDefaultsPatch = {};
      const defaultAgent = patch["agentDefaults.defaultAgent"];
      if (defaultAgent === null || isStorableDefaultAgent(defaultAgent)) {
        agentPatch.defaultAgent = defaultAgent;
      }
      if (patch["agentDefaults.assistantAgentId"] !== undefined) {
        agentPatch.assistantAgentId = patch["agentDefaults.assistantAgentId"];
      }
      if (Object.keys(agentPatch).length > 0) defaults.setAgentDefaults(agentPatch);

      const idlePatch: { enabled?: boolean; thresholdMinutes?: number } = {};
      if (patch["idleTerminalNotify.enabled"] !== undefined) {
        idlePatch.enabled = patch["idleTerminalNotify.enabled"];
      }
      if (patch["idleTerminalNotify.thresholdMinutes"] !== undefined) {
        idlePatch.thresholdMinutes = patch["idleTerminalNotify.thresholdMinutes"];
      }
      const idleChanged = Object.keys(idlePatch).length > 0;
      if (idleChanged) idleService.updateConfig(idlePatch);

      let storeChanged = false;
      const resume = patch["agentSettings.resumeOnRestart"];
      if (resume !== undefined) {
        store.set("agentSettings.resumeOnRestart", resume);
        storeChanged = true;
      }
      const altScreen = patch["agentSettings.globalUseAltScreen"];
      if (altScreen !== undefined) {
        store.set("agentSettings.globalUseAltScreen", altScreen);
        storeChanged = true;
      }
      const env = patch.globalEnvironmentVariables;
      if (env !== undefined) {
        store.set("globalEnvironmentVariables", sortedEnv(env));
        storeChanged = true;
      }
      const monitoring = patch["terminalConfig.resourceMonitoringEnabled"];
      if (monitoring !== undefined) {
        store.set("terminalConfig.resourceMonitoringEnabled", monitoring);
        getPtyClient()?.setResourceMonitoring(monitoring);
        storeChanged = true;
      }
      const leak = patch["terminalConfig.memoryLeakDetectionEnabled"];
      if (leak !== undefined) {
        store.set("terminalConfig.memoryLeakDetectionEnabled", leak);
        storeChanged = true;
      }
      const leakThreshold = patch["terminalConfig.memoryLeakAutoRestartThresholdMb"];
      if (leakThreshold !== undefined) {
        store.set("terminalConfig.memoryLeakAutoRestartThresholdMb", leakThreshold);
        storeChanged = true;
      }
      const restore = patch["sessionRestore.enabled"];
      if (restore !== undefined) {
        store.set("sessionRestore", { enabled: restore });
        storeChanged = true;
      }
      const sleepPatch: Partial<IdleBackgroundAutoCloseConfig> = {};
      if (patch["idleBackgroundAutoClose.enabled"] !== undefined) {
        sleepPatch.enabled = patch["idleBackgroundAutoClose.enabled"];
      }
      if (patch["idleBackgroundAutoClose.thresholdMinutes"] !== undefined) {
        sleepPatch.thresholdMinutes = patch["idleBackgroundAutoClose.thresholdMinutes"];
      }
      if (patch["idleBackgroundAutoClose.includeIdleShells"] !== undefined) {
        sleepPatch.includeIdleShells = patch["idleBackgroundAutoClose.includeIdleShells"];
      }
      const shellThreshold = patch["idleBackgroundAutoClose.idleShellThresholdMinutes"];
      if (isIdleShellThresholdMinutes(shellThreshold)) {
        sleepPatch.idleShellThresholdMinutes = shellThreshold;
      }
      const sleepChanged = Object.keys(sleepPatch).length > 0;
      if (sleepChanged) idleBackgroundService.updateConfig(sleepPatch);

      // `canopyModel` names the one model there is: writing it changes nothing.
      if (mode !== undefined) {
        const state = canopy.canopyModeState();
        canopy.changeCanopyMode(mode, state.modeRevision, state.hostEpoch);
      }
      // Agent defaults and Canopy tell every view themselves; the rest don't.
      return { reconcile: idleChanged || storeChanged || sleepChanged };
    },
  };
}
