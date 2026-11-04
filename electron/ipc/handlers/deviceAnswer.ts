// eager-import-allow: reads the device-answer and Decisions settings to report idle status without loading either optional service
import { dialog } from "electron";
import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { store } from "../../store.js";
import { decisionsServesPanes, loadDecisionsModule } from "../../window/serviceRefs.js";
import {
  getDeviceAnswerService,
  peekDeviceAnswerService,
} from "../../services/deviceAnswer/index.js";
import { sanitizeDeviceAnswerSettings } from "../../services/deviceAnswer/deviceAnswerSettings.js";
import { DEVICE_ANSWER_METHOD_CHANNELS } from "./deviceAnswer.preload.js";
import { sshLoginTarget } from "../../utils/machineName.js";
import { isRemoteView } from "../../window/webviewSrcGate.js";
import { getVoiceSettings } from "./voiceInput.js";
import type {
  DeviceAnswerStatus,
  SetDeviceAnswerPayload,
} from "../../../shared/types/ipc/deviceAnswer.js";
import type {
  ApproveDecisionsPairingPayload,
  CancelDecisionsSetupCheckPayload,
  ClaimDecisionsRelayPayload,
  ClaimDeployedDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsDevicesResult,
  DecisionsExportResult,
  DecisionsKitExportResult,
  DecisionsKitVerifyResult,
  DecisionsLocalDeleteResult,
  DecisionsPairingApproveResult,
  DecisionsPairingDeclineResult,
  DecisionsPairingStartResult,
  DecisionsPairingState,
  DecisionsPolicy,
  DecisionsRelayCheck,
  DecisionsRelayDeleteResult,
  DecisionsRelayRemoval,
  DecisionsRevokeDeviceResult,
  DecisionsRotateKeysResult,
  DecisionsSetupCheckRun,
  DecisionsSetupCheckStartResult,
  DecisionsStatus,
  DeleteDecisionsRelayDataPayload,
  ExportDecisionsDataPayload,
  ExportDecisionsRecoveryKitPayload,
  PaneDecisionState,
  PreparedDecisionsRelayDeploy,
  RestoreDecisionsIdentityPayload,
  SetDecisionsAgentAskHumanPayload,
  SetDecisionsEnabledPayload,
  SetDecisionsTerminalSnapshotsPayload,
  StartDecisionsRelayRemovalPayload,
  VerifyDecisionsRecoveryKitPayload,
} from "../../../shared/types/decisions.js";
import {
  isRelayRemovalTerminalId,
  isRemovableRelayOrigin,
} from "../../../shared/config/relayRemoval.js";
import type {
  DecisionsHostEnrollResult,
  DecisionsHostsResult,
  EnrollDecisionsHostPayload,
} from "../../../shared/types/decisionsHosts.js";
import type {
  DecisionsAnswerDestinations,
  DecisionsAnswerOutcome,
  DecisionsAttentionList,
  MarkDecisionsAnswerHandledPayload,
  ReassignDecisionsAnswerPayload,
} from "../../../shared/types/decisionsAttention.js";
import type {
  CancelDecisionsModelEvaluationPayload,
  DecisionsModelState,
  SetDecisionsModelPayload,
  SetDecisionsModelThresholdPayload,
} from "../../../shared/types/decisionsModel.js";
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

// A guided deploy's id is one main minted for it.
const relayDeployIdSchema = z.string().min(1).max(128);
const claimDeployedRelaySchema = z
  .object({ deployId: relayDeployIdSchema, acceptWeakStorage: z.boolean().optional() })
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
// A device id as the relay listed it.
const deviceIdSchema = z.string().min(1).max(128);

// The passphrase's shortest length is the library's, checked by Decisions
// itself, since importing its shared constant here would make it eager.
const exportDataSchema = z.object({ passphrase: z.string().min(1).max(1024) }).strict();

const deleteRelayDataSchema = z.object({ origin: z.string().max(2048) }).strict();

const startRelayRemovalSchema = z
  .object({
    terminalId: z.string().refine(isRelayRemovalTerminalId, "Not a relay removal terminal id"),
    origin: z.string().refine(isRemovableRelayOrigin, "Not a relay origin the removal can take"),
    deleteLocalHistory: z.boolean(),
  })
  .strict();

// The library's own passphrase floor for a kit, counted as it counts it.
const exportRecoveryKitSchema = z.object({ passphrase: z.string().min(12).max(1024) }).strict();

const verifyRecoveryKitSchema = z
  .object({
    kit: z
      .string()
      .min(1)
      .max(256 * 1024),
    passphrase: z.string().min(1).max(1024),
  })
  .strict();

// A host id as the host list keeps it.
const enrollHostSchema = z
  .object({ hostId: z.string().min(1).max(256), allowWeakStorage: z.boolean().optional() })
  .strict();

// Turning on needs `consent`, checked by main; the time it records is main's own.
const setTerminalSnapshotsSchema = z
  .object({ enabled: z.boolean(), consent: z.boolean().optional() })
  .strict();

// Only the shape here; main refuses any id no agent could have.
const agentAskHumanSchema = z
  .object({ agentId: z.string().min(1).max(256), enabled: z.boolean() })
  .strict();

// A run id main minted (a UUID); a cancel names the run it means to end.
const cancelSetupCheckSchema = z.object({ runId: z.string().min(1).max(64) }).strict();

// A question id as the library mints it.
const questionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

const reassignAnswerSchema = z
  .object({ questionId: questionIdSchema, terminalId: z.string().min(1).max(256) })
  .strict();

const markAnswerHandledSchema = z.object({ questionId: questionIdSchema }).strict();

// The decision model's CLIs, named here rather than imported from the
// setting's module, which would make it eager; the sanitiser drops any other.
const modelAdapterSchema = z.enum(["claude", "codex", "gemini"]).nullable();

const setModelSchema = z
  .object({ learning: z.boolean(), adapter: modelAdapterSchema, consent: z.boolean().optional() })
  .strict();

// A confidence from 0 to 1, for the evaluation it was chosen from.
const setModelThresholdSchema = z
  .object({
    threshold: z.number().min(0).max(1).nullable(),
    evaluatedAt: z.number().int().positive(),
  })
  .strict();

// A run id main minted (a UUID).
const cancelModelEvaluationSchema = z.object({ runId: z.string().min(1).max(64) }).strict();

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
        // An enrolled Host's panes have state of their own (#16022), whatever its switch says.
        if (!decisionsServesPanes(store.get("decisions"), store.get("decisionsHost"))) return null;
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
    // The guided relay deploy (#16199). Its CLI runs in a pane on this
    // computer and connects to a channel main opens here, so a window whose
    // terminals run on a Remote Host can't start one.
    prepareRelayDeploy: op(
      CHANNELS.DECISIONS_PREPARE_RELAY_DEPLOY,
      async (ctx): Promise<PreparedDecisionsRelayDeploy> => {
        refuseWhileOff("deploy a relay");
        if (isRemoteView(ctx.webContentsId)) {
          throw new AppError({
            code: "UNSUPPORTED",
            message: "Run the guided deploy from a local project window",
          });
        }
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.prepareRelayDeploy(getVoiceSettings);
      },
      { withContext: true }
    ),
    cancelRelayDeploy: opValidated(
      CHANNELS.DECISIONS_CANCEL_RELAY_DEPLOY,
      relayDeployIdSchema,
      async (deployId: string): Promise<void> => {
        if (!decisionsOn()) return;
        const decisions = await loadDecisions();
        decisions?.cancelRelayDeploy(deployId);
      }
    ),
    claimDeployedRelay: opValidated(
      CHANNELS.DECISIONS_CLAIM_DEPLOYED_RELAY,
      claimDeployedRelaySchema,
      async (payload: ClaimDeployedDecisionsRelayPayload): Promise<DecisionsConnectResult> => {
        refuseWhileOff("claim a relay");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.claimDeployedRelay(payload);
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
    // A guided removal from Cloudflare (#16202), watched from before its pane
    // opens. Only while on: what it forgets is the running lifetime's identity.
    startRelayRemoval: opValidated(
      CHANNELS.DECISIONS_START_RELAY_REMOVAL,
      startRelayRemovalSchema,
      async (payload: StartDecisionsRelayRemovalPayload): Promise<DecisionsRelayRemoval> => {
        refuseWhileOff("remove a relay");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.startRelayRemoval(payload);
      }
    ),
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
    // The trusted gates, the proxy allowlist (#16013) and the default question
    // expiry (#16122). Read and changed only while on: Settings shows them
    // behind the switch, and reading them loads Decisions. No op registers or
    // edits a gate.
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
    // Only the shape here; main refuses any value Settings doesn't offer.
    setDefaultQuestionExpiry: opValidated(
      CHANNELS.DECISIONS_SET_DEFAULT_QUESTION_EXPIRY,
      z.number().int().positive().nullable(),
      async (ms: number | null): Promise<DecisionsPolicy> => {
        refuseWhileOff("change how long questions wait");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setDecisionsDefaultQuestionExpiry(ms);
      }
    ),
    // Which agents' launches get ask_human (#16223), one agent at a time, so
    // two windows switching different agents never undo each other.
    setAgentAskHuman: opValidated(
      CHANNELS.DECISIONS_SET_AGENT_ASK_HUMAN,
      agentAskHumanSchema,
      async (payload: SetDecisionsAgentAskHumanPayload): Promise<DecisionsPolicy> => {
        refuseWhileOff("change which agents can ask you");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setDecisionsAgentAskHuman(payload);
      }
    ),
    // What the phone may show of a pane that asked (#16228). Only while on,
    // like every preference behind the switch.
    setTerminalSnapshots: opValidated(
      CHANNELS.DECISIONS_SET_TERMINAL_SNAPSHOTS,
      setTerminalSnapshotsSchema,
      async (payload: SetDecisionsTerminalSnapshotsPayload): Promise<DecisionsStatus> => {
        refuseWhileOff("change what your phone shows");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setDecisionsTerminalSnapshots(payload);
      }
    ),
    // Saving and verifying a recovery kit (#16007). The save dialog belongs to
    // the window that asked; the kit is made and written in main, and the
    // passphrase goes no further than locking it.
    exportRecoveryKit: opValidated(
      CHANNELS.DECISIONS_EXPORT_RECOVERY_KIT,
      exportRecoveryKitSchema,
      async (
        ctx,
        payload: ExportDecisionsRecoveryKitPayload
      ): Promise<DecisionsKitExportResult> => {
        refuseWhileOff("save a recovery kit");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.exportRecoveryKit(payload, async (defaultName) => {
          const options: Electron.SaveDialogOptions = {
            title: "Save Decisions recovery kit",
            defaultPath: defaultName,
            filters: [{ name: "Decisions recovery kit", extensions: ["json"] }],
            properties: ["createDirectory", "showOverwriteConfirmation"],
          };
          const parent = ctx.senderWindow;
          const { canceled, filePath } =
            parent && !parent.isDestroyed()
              ? await dialog.showSaveDialog(parent, options)
              : await dialog.showSaveDialog(options);
          return canceled || !filePath ? null : filePath;
        });
      },
      { withContext: true }
    ),
    verifyRecoveryKit: opValidated(
      CHANNELS.DECISIONS_VERIFY_RECOVERY_KIT,
      verifyRecoveryKitSchema,
      async (payload: VerifyDecisionsRecoveryKitPayload): Promise<DecisionsKitVerifyResult> => {
        refuseWhileOff("verify a recovery kit");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.verifyRecoveryKit(payload);
      }
    ),
    // Revoking a paired device, which rotates the key, and rotating it alone
    // (#16010). Settings confirms a revocation before it sends this.
    revokeDevice: opValidated(
      CHANNELS.DECISIONS_REVOKE_DEVICE,
      deviceIdSchema,
      async (deviceId: string): Promise<DecisionsRevokeDeviceResult> => {
        refuseWhileOff("revoke a device");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.revokeDevice(deviceId);
      }
    ),
    rotateKeys: op(CHANNELS.DECISIONS_ROTATE_KEYS, async (): Promise<DecisionsRotateKeysResult> => {
      refuseWhileOff("rotate the keys");
      const decisions = await loadDecisions();
      if (!decisions) throw setupCancelled();
      return decisions.rotateKeys();
    }),
    // Remote Hosts as Decisions devices (#16021). Only while on: enrolling
    // signs with the running lifetime's owner identity. Listing asks no Host
    // and no relay; it shows what was last observed.
    listHosts: op(CHANNELS.DECISIONS_LIST_HOSTS, async (): Promise<DecisionsHostsResult> => {
      refuseWhileOff("list Remote Hosts");
      const decisions = await loadDecisions();
      if (!decisions) throw setupCancelled();
      return decisions.listHosts();
    }),
    enrollHost: opValidated(
      CHANNELS.DECISIONS_ENROLL_HOST,
      enrollHostSchema,
      async (payload: EnrollDecisionsHostPayload): Promise<DecisionsHostEnrollResult> => {
        refuseWhileOff("enroll a Remote Host");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.enrollDecisionsHost(payload.hostId, payload.allowWeakStorage === true);
      }
    ),
    setAutoEnrollHosts: opValidated(
      CHANNELS.DECISIONS_SET_AUTO_ENROLL_HOSTS,
      z.boolean(),
      async (enabled: boolean): Promise<DecisionsHostsResult> => {
        refuseWhileOff("change how Remote Hosts are enrolled");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setAutoEnrollHosts(enabled);
      }
    ),
    // The setup check (#16024): the whole loop, run when the person asks,
    // its progress read and pushed, and called off. Reading and cancelling
    // answer null while off, without loading Decisions.
    startSetupCheck: op(
      CHANNELS.DECISIONS_START_SETUP_CHECK,
      async (): Promise<DecisionsSetupCheckStartResult> => {
        refuseWhileOff("check setup");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.startSetupCheck();
      }
    ),
    getSetupCheck: op(
      CHANNELS.DECISIONS_GET_SETUP_CHECK,
      async (): Promise<DecisionsSetupCheckRun | null> => {
        if (!decisionsOn()) return null;
        const decisions = await loadDecisions();
        return decisions ? decisions.getSetupCheck() : null;
      }
    ),
    cancelSetupCheck: opValidated(
      CHANNELS.DECISIONS_CANCEL_SETUP_CHECK,
      cancelSetupCheckSchema,
      async (payload: CancelDecisionsSetupCheckPayload): Promise<DecisionsSetupCheckRun | null> => {
        if (!decisionsOn()) return null;
        const decisions = await loadDecisions();
        return decisions ? decisions.cancelSetupCheck(payload) : null;
      }
    ),
    // Answers that need a person (#16020), read and acted on through the
    // running lifetime's delivery: nothing here starts one. Choose destination
    // is confirmed in the renderer, naming both panes, before it is sent.
    listAttention: op(
      CHANNELS.DECISIONS_LIST_ATTENTION,
      async (): Promise<DecisionsAttentionList> => {
        refuseWhileOff("list answers that need attention");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.listDecisionsAttention();
      }
    ),
    copyAnswer: opValidated(
      CHANNELS.DECISIONS_COPY_ANSWER,
      questionIdSchema,
      async (questionId: string): Promise<string> => {
        refuseWhileOff("copy an answer");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.copyDecisionsAnswer(questionId);
      }
    ),
    resumeAnswer: opValidated(
      CHANNELS.DECISIONS_RESUME_ANSWER,
      questionIdSchema,
      async (questionId: string): Promise<DecisionsAnswerOutcome> => {
        refuseWhileOff("resume an agent for an answer");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.resumeDecisionsAnswer(questionId);
      }
    ),
    listAnswerDestinations: opValidated(
      CHANNELS.DECISIONS_LIST_ANSWER_DESTINATIONS,
      questionIdSchema,
      async (questionId: string): Promise<DecisionsAnswerDestinations> => {
        refuseWhileOff("choose where an answer goes");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.listDecisionsAnswerDestinations(questionId);
      }
    ),
    reassignAnswer: opValidated(
      CHANNELS.DECISIONS_REASSIGN_ANSWER,
      reassignAnswerSchema,
      async (payload: ReassignDecisionsAnswerPayload): Promise<DecisionsAnswerOutcome> => {
        refuseWhileOff("send an answer to another terminal");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.reassignDecisionsAnswer(payload);
      }
    ),
    markAnswerHandled: opValidated(
      CHANNELS.DECISIONS_MARK_ANSWER_HANDLED,
      markAnswerHandledSchema,
      async (payload: MarkDecisionsAnswerHandledPayload): Promise<DecisionsAnswerOutcome> => {
        refuseWhileOff("mark an answer handled");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.markDecisionsAnswerHandled(payload);
      }
    ),
    // The decision model (#16027): its preferences, evaluation and history.
    // Only while on, like the rest; with learning off the model's history can
    // still be cleared. Learning turns on only with the person's agreement,
    // which main checks again.
    getModel: op(CHANNELS.DECISIONS_GET_MODEL, async (): Promise<DecisionsModelState> => {
      refuseWhileOff("read its decision model");
      const decisions = await loadDecisions();
      if (!decisions) throw setupCancelled();
      return decisions.getDecisionsModel();
    }),
    setModel: opValidated(
      CHANNELS.DECISIONS_SET_MODEL,
      setModelSchema,
      async (payload: SetDecisionsModelPayload): Promise<DecisionsModelState> => {
        refuseWhileOff("change its decision model");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setDecisionsModel(payload);
      }
    ),
    startModelEvaluation: op(
      CHANNELS.DECISIONS_START_MODEL_EVALUATION,
      async (): Promise<DecisionsModelState> => {
        refuseWhileOff("evaluate its decision model");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.startDecisionsModelEvaluation();
      }
    ),
    cancelModelEvaluation: opValidated(
      CHANNELS.DECISIONS_CANCEL_MODEL_EVALUATION,
      cancelModelEvaluationSchema,
      async (payload: CancelDecisionsModelEvaluationPayload): Promise<DecisionsModelState> => {
        refuseWhileOff("cancel an evaluation");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.cancelDecisionsModelEvaluation(payload);
      }
    ),
    setModelThreshold: opValidated(
      CHANNELS.DECISIONS_SET_MODEL_THRESHOLD,
      setModelThresholdSchema,
      async (payload: SetDecisionsModelThresholdPayload): Promise<DecisionsModelState> => {
        refuseWhileOff("choose when its decision model answers");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setDecisionsModelThreshold(payload);
      }
    ),
    // Settings confirms this before it is sent.
    clearModelHistory: op(
      CHANNELS.DECISIONS_CLEAR_MODEL_HISTORY,
      async (): Promise<DecisionsModelState> => {
        refuseWhileOff("clear its decision model's history");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.clearDecisionsModelHistory();
      }
    ),
  },
});

export function registerDecisionsHandlers(): () => void {
  return decisionsNamespace.register();
}
