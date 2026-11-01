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
import type {
  DecisionsStatus,
  PaneDecisionState,
  SetDecisionsEnabledPayload,
} from "../../../shared/types/decisions.js";
import { AppError } from "../../utils/errorTypes.js";

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

function decisionsOn(): boolean {
  return store.get("decisions")?.enabled === true;
}

/** The saved consent time, by the same test the setting's sanitiser applies. */
function savedConsentTime(): number | undefined {
  const value: unknown = store.get("decisions")?.consentedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Off, read straight from the store. A relay isn't shown while off, so it isn't read. */
function offStatus(): DecisionsStatus {
  const consentedAt = savedConsentTime();
  return consentedAt === undefined ? { state: "off" } : { state: "off", consentedAt };
}

function loadDecisions() {
  return loadDecisionsModule(() => import("../../services/decisions/index.js"));
}

const setDecisionsEnabledSchema = z
  .object({ enabled: z.boolean(), consent: z.boolean().optional() })
  .strict();

/**
 * Decisions' status read (#16001), pane read (#16016) and switch (#16004).
 * They are declared here, beside the other feature that answers agents from a
 * phone, rather than in a module of their own, so that Decisions adds no
 * module to main's startup graph: this one loads anyway, and the ops import
 * nothing that isn't already loaded (the channels come from `CHANNELS`, not
 * `decisions.preload.ts`, for that reason). With the switch off they answer
 * from the store; Decisions itself loads only once it is on, or being turned
 * on. Registered on every platform, unlike the device-answer ops.
 */
export const decisionsNamespace = defineIpcNamespace({
  name: "decisions",
  ops: {
    getStatus: op(CHANNELS.DECISIONS_GET_STATUS, async (): Promise<DecisionsStatus> => {
      if (!decisionsOn()) return offStatus();
      const decisions = await loadDecisions();
      // Null only once quit has begun, when nothing of Decisions runs.
      return decisions ? decisions.getDecisionsStatus() : offStatus();
    }),
    // A pane's state for its chrome to show on mount (#16016); `host`, so a
    // view on a Remote Host reads its panes from the Host. Off answers null
    // from the store, and on never starts anything: until the service runs
    // there is nothing to show, and its first push follows.
    getPaneState: opValidated(
      CHANNELS.DECISIONS_GET_PANE_STATE,
      z.string().min(1).max(256),
      async (terminalId: string): Promise<PaneDecisionState | null> => {
        if (!decisionsOn()) return null;
        const decisions = await loadDecisions();
        return decisions ? decisions.getDecisionsPaneState(terminalId) : null;
      }
    ),
    // Turning on is the one change that loads Decisions while the switch reads
    // off, and only after the person has agreed to what it sends. Turning off
    // while nothing is on loads nothing.
    setEnabled: opValidated(
      CHANNELS.DECISIONS_SET_ENABLED,
      setDecisionsEnabledSchema,
      async (payload: SetDecisionsEnabledPayload): Promise<DecisionsStatus> => {
        if (!payload.enabled && !decisionsOn()) return offStatus();
        if (payload.enabled && payload.consent !== true && savedConsentTime() === undefined) {
          throw new AppError({
            code: "PERMISSION",
            message: "Decisions turns on only after you agree to what it sends",
          });
        }
        const decisions = await loadDecisions();
        if (!decisions) return offStatus();
        return decisions.setDecisionsEnabled(payload.enabled, {
          consent: payload.consent === true,
        });
      }
    ),
  },
});

export function registerDecisionsHandlers(): () => void {
  return decisionsNamespace.register();
}
