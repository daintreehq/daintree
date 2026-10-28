// eager-import-allow: reads device-answer settings to report idle status without loading the optional listener service
import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { store } from "../../store.js";
import {
  getDeviceAnswerService,
  peekDeviceAnswerService,
} from "../../services/deviceAnswer/index.js";
import { sanitizeDeviceAnswerSettings } from "../../services/deviceAnswer/deviceAnswerSettings.js";
import { DEVICE_ANSWER_METHOD_CHANNELS } from "./deviceAnswer.preload.js";
import type {
  DeviceAnswerStatus,
  SetDeviceAnswerPayload,
} from "../../../shared/types/ipc/deviceAnswer.js";

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
