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
import { AppError } from "../../utils/errorTypes.js";
import { hostInstanceId } from "../../services/hostInstance.js";
import type { HostSettingsLeaves } from "./HostSettingsControl.js";

function digest(value: HostSettingValue): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The named settings, through the setters this machine's own Settings uses:
 * Canopy's guarded mode change and its model, the agent defaults, and the idle-terminal
 * service, each telling this machine's views as it always does. Loaded on
 * demand, so a host nobody edits pays nothing.
 */
export async function loadHostSettingsLeaves(): Promise<HostSettingsLeaves> {
  const [canopy, defaults, idle] = await Promise.all([
    import("../../ipc/handlers/canopy.js"),
    import("../../services/agentDefaults.js"),
    import("../../services/IdleTerminalNotificationService.js"),
  ]);
  const idleService = idle.getIdleTerminalNotificationService();

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

      // `canopyModel` names the one model there is: writing it changes nothing.
      if (mode !== undefined) {
        const state = canopy.canopyModeState();
        canopy.changeCanopyMode(mode, state.modeRevision, state.hostEpoch);
      }
      // Agent defaults and Canopy tell every view themselves; idle alerts don't.
      return { reconcile: idleChanged };
    },
  };
}
