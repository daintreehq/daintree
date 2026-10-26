import {
  HOST_SETTING_KEYS,
  isHostSettingKey,
  type HostSettingsReadPayload,
  type HostSettingsSnapshot,
  type HostSettingsUpdatePayload,
  type HostSettingsUpdateResult,
} from "../../../shared/types/hostSettings.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { reconcileAfterConfigWrite, runConfigWrite } from "../../services/configBundleRuntime.js";
import { AppError } from "../../utils/errorTypes.js";
import { HostSettingsControl } from "./HostSettingsControl.js";
import { loadHostSettingsLeaves } from "./hostLeaves.js";
import { SettingsControlUpdateSchema } from "./linkMethods.js";

let control: HostSettingsControl | null = null;

/**
 * This machine's own named settings, for Settings in a window attached to
 * another host (#14706): that window's ordinary IPC goes to its host, so
 * "This Mac" is read and changed here through the same guarded path a Shell
 * uses on a host, against the revisions it read.
 */
function localControl(): HostSettingsControl {
  control ??= new HostSettingsControl({
    load: loadHostSettingsLeaves,
    runWrite: runConfigWrite,
    reconcile: reconcileAfterConfigWrite,
  });
  return control;
}

function thisMachineName(): string {
  return process.platform === "darwin" ? "This Mac" : "This machine";
}

export async function readLocalSettings(
  payload: HostSettingsReadPayload
): Promise<HostSettingsSnapshot> {
  if (payload.keys !== undefined && !payload.keys.every(isHostSettingKey)) {
    throw new AppError({ code: "VALIDATION", message: "Unknown host setting" });
  }
  const keys =
    payload.keys === undefined
      ? [...HOST_SETTING_KEYS]
      : HOST_SETTING_KEYS.filter((key) => payload.keys!.includes(key));
  if (keys.length === 0) throw new AppError({ code: "VALIDATION", message: "No settings named" });
  const reading = await localControl().read(keys);
  return {
    hostId: LOCAL_HOST_ID,
    hostName: thisMachineName(),
    scope: "host",
    unavailable: [],
    ...reading,
  };
}

export async function updateLocalSettings(
  payload: HostSettingsUpdatePayload
): Promise<HostSettingsUpdateResult> {
  const parsed = SettingsControlUpdateSchema.safeParse({
    patch: payload?.patch,
    expect: payload?.expect,
  });
  if (!parsed.success) {
    throw new AppError({
      code: "VALIDATION",
      message: "Invalid settings change",
      userMessage: "That isn't a setting, or a value, this machine takes.",
    });
  }
  const reply = await localControl().update(parsed.data);
  return {
    hostId: LOCAL_HOST_ID,
    hostName: thisMachineName(),
    scope: "host",
    outcome: reply.outcome,
    confirmedBy: "reply",
    instanceId: reply.instanceId,
    settings: reply.settings,
  };
}
