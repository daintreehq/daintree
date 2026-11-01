// eager-import-allow: reads the device-answer and Decisions settings to report idle status without loading either optional service
import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { store } from "../../store.js";
import { loadDecisionsModule } from "../../window/serviceRefs.js";
import {
  getDeviceAnswerService,
  peekDeviceAnswerService,
} from "../../services/deviceAnswer/index.js";
import { sanitizeDeviceAnswerSettings } from "../../services/deviceAnswer/deviceAnswerSettings.js";
import { DEVICE_ANSWER_METHOD_CHANNELS } from "./deviceAnswer.preload.js";
import { sshLoginTarget } from "../../utils/machineName.js";
import type {
  DeviceAnswerStatus,
  SetDeviceAnswerPayload,
} from "../../../shared/types/ipc/deviceAnswer.js";
import type { DecisionsStatus } from "../../../shared/types/decisions.js";

/**
 * What Settings shows before the service was ever made: read straight from
 * the store, so opening Settings with the feature off loads none of it.
 */
function idleStatus(): DeviceAnswerStatus {
  const saved = sanitizeDeviceAnswerSettings(store.get("deviceAnswer"));
  return {
    enabled: false,
    listening: false,
    port: saved.port,
    tailnetHost: saved.tailnetHost,
    sshTarget: sshLoginTarget(),
    error: null,
    pairing: null,
    devices: saved.devices.map(({ tokenHash: _tokenHash, ...device }) => device),
    recentAnswers: saved.answers,
  };
}

const setEnabledSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().optional(),
    tailnetHost: z.string().max(300).nullable().optional(),
  })
  .strict();

export const deviceAnswerNamespace = defineIpcNamespace({
  name: "deviceAnswer",
  ops: {
    getStatus: op(
      DEVICE_ANSWER_METHOD_CHANNELS.getStatus,
      async (): Promise<DeviceAnswerStatus> => {
        const running = peekDeviceAnswerService();
        if (running) return running.getStatus();
        if (store.get("deviceAnswer")?.enabled === true)
          return (await getDeviceAnswerService()).getStatus();
        return idleStatus();
      }
    ),
    setEnabled: opValidated(
      DEVICE_ANSWER_METHOD_CHANNELS.setEnabled,
      setEnabledSchema,
      async (payload: SetDeviceAnswerPayload): Promise<DeviceAnswerStatus> =>
        (await getDeviceAnswerService()).setEnabled(payload)
    ),
    createPairingCode: op(
      DEVICE_ANSWER_METHOD_CHANNELS.createPairingCode,
      async (): Promise<DeviceAnswerStatus> => (await getDeviceAnswerService()).createPairingCode()
    ),
    cancelPairingCode: op(
      DEVICE_ANSWER_METHOD_CHANNELS.cancelPairingCode,
      async (): Promise<DeviceAnswerStatus> =>
        peekDeviceAnswerService()?.cancelPairingCode() ?? idleStatus()
    ),
    revokeDevice: opValidated(
      DEVICE_ANSWER_METHOD_CHANNELS.revokeDevice,
      z.string().min(1).max(100),
      async (deviceId: string): Promise<DeviceAnswerStatus> =>
        (await getDeviceAnswerService()).revokeDevice(deviceId)
    ),
  },
});

export function registerDeviceAnswerHandlers(): () => void {
  return deviceAnswerNamespace.register();
}

/**
 * Decisions' status read (#16001). It is declared here, beside the other
 * feature that answers agents from a phone, rather than in a module of its
 * own, so that Decisions adds no module to main's startup graph: this one
 * loads anyway, and the read imports nothing that isn't already loaded (the
 * channel comes from `CHANNELS`, not `decisions.preload.ts`, for that reason).
 * With the switch off it answers from the store; Decisions itself loads only
 * once it is on. Registered on every platform, unlike the device-answer ops.
 */
export const decisionsNamespace = defineIpcNamespace({
  name: "decisions",
  ops: {
    getStatus: op(CHANNELS.DECISIONS_GET_STATUS, async (): Promise<DecisionsStatus> => {
      if (store.get("decisions")?.enabled !== true) return { state: "off" };
      const decisions = await loadDecisionsModule(
        () => import("../../services/decisions/index.js")
      );
      // Null only once quit has begun, when nothing of Decisions runs.
      return decisions ? decisions.getDecisionsStatus() : { state: "off" };
    }),
  },
});

export function registerDecisionsHandlers(): () => void {
  return decisionsNamespace.register();
}
