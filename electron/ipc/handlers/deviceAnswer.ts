// eager-import-allow: reads the device-answer and Decisions settings to report idle status without loading either optional service
import { dialog } from "electron";
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
  ApproveDecisionsPairingPayload,
  ClaimDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsDevicesResult,
  DecisionsExportResult,
  DecisionsLocalDeleteResult,
  DecisionsPairingApproveResult,
  DecisionsPairingDeclineResult,
  DecisionsPairingStartResult,
  DecisionsPairingState,
  DecisionsPolicy,
  DecisionsRelayCheck,
  DecisionsRelayDeleteResult,
  DecisionsStatus,
  DeleteDecisionsRelayDataPayload,
  ExportDecisionsDataPayload,
  PaneDecisionState,
  RestoreDecisionsIdentityPayload,
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

// The relay's own bounds on a claim secret. Validation failures log field
// paths and limits, never the values.
const claimRelaySchema = z
  .object({
    url: z.string().max(2048),
    claimSecret: z.string().min(16).max(256),
    acceptWeakStorage: z.boolean().optional(),
  })
  .strict();

// A kit is a few KiB; main checks its size again in bytes before reading it.
const restoreIdentitySchema = z
  .object({
    url: z.string().max(2048),
    kit: z
      .string()
      .min(1)
      .max(256 * 1024),
    passphrase: z.string().min(1).max(1024),
    acceptWeakStorage: z.boolean().optional(),
  })
  .strict();

// A pairing id is one the relay minted for this computer; a code is the six
// digits the person compared.
const pairingIdSchema = z.string().min(1).max(128);
const approvePairingSchema = z
  .object({ pairingId: pairingIdSchema, code: z.string().regex(/^\d{6}$/) })
  .strict();

// The passphrase's shortest length is the library's, checked by Decisions
// itself, since importing its shared constant here would make it eager.
const exportDataSchema = z.object({ passphrase: z.string().min(1).max(1024) }).strict();

const deleteRelayDataSchema = z.object({ origin: z.string().max(2048) }).strict();

function refuseWhileOff(action: string): void {
  if (!decisionsOn()) {
    throw new AppError({ code: "PERMISSION", message: `Turn on Decisions to ${action}` });
  }
}

function setupCancelled(): AppError {
  return new AppError({
    code: "CANCELLED",
    message: "Decisions has stopped, so nothing was changed",
  });
}

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
    // A relay URL's unsigned check (#16005). The requests go from here, never
    // the renderer. Only while on: checking loads Decisions, and turning it
    // off or quitting cancels a check in flight.
    checkRelay: opValidated(
      CHANNELS.DECISIONS_CHECK_RELAY,
      z.string().max(2048),
      async (url: string): Promise<DecisionsRelayCheck> => {
        if (!decisionsOn()) {
          throw new AppError({ code: "PERMISSION", message: "Turn on Decisions to check a relay" });
        }
        const decisions = await loadDecisions();
        if (!decisions) {
          throw new AppError({ code: "CANCELLED", message: "The relay check was cancelled" });
        }
        return decisions.checkRelay(url);
      }
    ),
    // Claiming a relay, restoring an identity and disconnecting (#16006). Only
    // while on: each needs the running lifetime's key store, and each runs
    // behind the switch's transitions in main.
    claimRelay: opValidated(
      CHANNELS.DECISIONS_CLAIM_RELAY,
      claimRelaySchema,
      async (payload: ClaimDecisionsRelayPayload): Promise<DecisionsConnectResult> => {
        refuseWhileOff("claim a relay");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.claimRelay(payload);
      }
    ),
    restoreIdentity: opValidated(
      CHANNELS.DECISIONS_RESTORE_IDENTITY,
      restoreIdentitySchema,
      async (payload: RestoreDecisionsIdentityPayload): Promise<DecisionsConnectResult> => {
        refuseWhileOff("restore an identity");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.restoreIdentity(payload);
      }
    ),
    disconnectRelay: op(CHANNELS.DECISIONS_DISCONNECT_RELAY, async (): Promise<DecisionsStatus> => {
      refuseWhileOff("disconnect a relay");
      const decisions = await loadDecisions();
      if (!decisions) throw setupCancelled();
      return decisions.disconnectRelay();
    }),
    // The paired devices and pairing a phone (#16009). Only while on: each
    // signs with the identity the running lifetime's key store holds.
    listDevices: op(CHANNELS.DECISIONS_LIST_DEVICES, async (): Promise<DecisionsDevicesResult> => {
      refuseWhileOff("list paired devices");
      const decisions = await loadDecisions();
      if (!decisions) throw setupCancelled();
      return decisions.listDevices();
    }),
    startPairing: op(
      CHANNELS.DECISIONS_START_PAIRING,
      async (): Promise<DecisionsPairingStartResult> => {
        refuseWhileOff("pair a phone");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.startPairing();
      }
    ),
    getPairing: opValidated(
      CHANNELS.DECISIONS_GET_PAIRING,
      pairingIdSchema,
      async (pairingId: string): Promise<DecisionsPairingState> => {
        refuseWhileOff("pair a phone");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.readPairing(pairingId);
      }
    ),
    approvePairing: opValidated(
      CHANNELS.DECISIONS_APPROVE_PAIRING,
      approvePairingSchema,
      async (payload: ApproveDecisionsPairingPayload): Promise<DecisionsPairingApproveResult> => {
        refuseWhileOff("pair a phone");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.approvePairing(payload);
      }
    ),
    declinePairing: opValidated(
      CHANNELS.DECISIONS_DECLINE_PAIRING,
      pairingIdSchema,
      async (pairingId: string): Promise<DecisionsPairingDeclineResult> => {
        refuseWhileOff("decline a pairing");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.declinePairing(pairingId);
      }
    ),
    // Exporting the decision history, and deleting the relay's stored content
    // or this computer's Decisions data (#16025). Only while on, behind the
    // switch's transitions in main. The export's save dialog opens over the
    // window that asked.
    exportData: opValidated(
      CHANNELS.DECISIONS_EXPORT_DATA,
      exportDataSchema,
      async (ctx, payload: ExportDecisionsDataPayload): Promise<DecisionsExportResult> => {
        refuseWhileOff("export its data");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.exportData(payload, async (fileName) => {
          const options = {
            title: "Export decision history",
            defaultPath: fileName,
            filters: [{ name: "Decisions export", extensions: ["json"] }],
          };
          const window = ctx.senderWindow;
          const chosen =
            window && !window.isDestroyed()
              ? await dialog.showSaveDialog(window, options)
              : await dialog.showSaveDialog(options);
          return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
        });
      },
      { withContext: true }
    ),
    deleteRelayData: opValidated(
      CHANNELS.DECISIONS_DELETE_RELAY_DATA,
      deleteRelayDataSchema,
      async (payload: DeleteDecisionsRelayDataPayload): Promise<DecisionsRelayDeleteResult> => {
        refuseWhileOff("delete the relay's data");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.deleteRelayData(payload);
      }
    ),
    deleteLocalData: op(
      CHANNELS.DECISIONS_DELETE_LOCAL_DATA,
      async (): Promise<DecisionsLocalDeleteResult> => {
        refuseWhileOff("delete its data");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.deleteLocalData();
      }
    ),
    // The trusted gates and the proxy allowlist (#16013). Read and changed
    // only while on: Settings shows them behind the switch, and reading them
    // loads Decisions. No op registers or edits a gate.
    getPolicy: op(CHANNELS.DECISIONS_GET_POLICY, async (): Promise<DecisionsPolicy> => {
      refuseWhileOff("read its policy");
      const decisions = await loadDecisions();
      if (!decisions) throw setupCancelled();
      return decisions.getDecisionsPolicy();
    }),
    setProxyAllowlisted: opValidated(
      CHANNELS.DECISIONS_SET_PROXY_ALLOWLISTED,
      z.boolean(),
      async (allowed: boolean): Promise<DecisionsPolicy> => {
        refuseWhileOff("change who may answer");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setDecisionsProxyAllowlisted(allowed);
      }
    ),
  },
});

export function registerDecisionsHandlers(): () => void {
  return decisionsNamespace.register();
}
