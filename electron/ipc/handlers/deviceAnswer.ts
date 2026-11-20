// eager-import-allow: reads the device-answer and Decisions settings to report idle status without loading either optional service
import { dialog } from "electron";
import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { store } from "../../store.js";
import {
  decisionsHostServes,
  decisionsServesPanes,
  loadDecisionsModule,
} from "../../window/serviceRefs.js";
import {
  getDeviceAnswerService,
  peekDeviceAnswerService,
} from "../../services/deviceAnswer/index.js";
import { sanitizeDeviceAnswerSettings } from "../../services/deviceAnswer/deviceAnswerSettings.js";
import { DEVICE_ANSWER_METHOD_CHANNELS } from "./deviceAnswer.preload.js";
import { sshLoginTarget } from "../../utils/machineName.js";
import { isRemoteView } from "../../window/webviewSrcGate.js";
import { getVoiceSettings } from "./voiceInput.js";
import { composerDrafts } from "../../services/composerDrafts.js";
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
  DecisionsKeyErasurePayload,
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
  DecisionsHostAttentionRequest,
  DecisionsHostAttentionResult,
  MarkDecisionsAnswerHandledPayload,
  ReassignDecisionsAnswerPayload,
} from "../../../shared/types/decisionsAttention.js";
import type {
  CancelDecisionsModelEvaluationPayload,
  DecisionsModelState,
  SetDecisionsModelPayload,
  SetDecisionsModelThresholdPayload,
} from "../../../shared/types/decisionsModel.js";
import type {
  AnswerDecisionQuestionPayload,
  CancelDecisionQuestionByReferencePayload,
  CancelDecisionQuestionPayload,
  DeclineDecisionQuestionPayload,
  DecisionAnswerResultRead,
  DecisionDeclineResultRead,
  DecisionFollowUpResultRead,
  DecisionQuestionAnswerResult,
  DecisionQuestionCancelResult,
  DecisionQuestionContentResult,
  DecisionQuestionDeclineResult,
  DecisionQuestionFollowUpResult,
  DecisionQuestionImagePartResult,
  DecisionQuestionList,
  DecisionQuestionMarkResult,
  DecisionQuestionPaneResult,
  DecisionQuestionSummariesResult,
  GetDecisionQuestionByReferencePayload,
  GetDecisionQuestionImageByReferencePayload,
  GetDecisionQuestionImagePayload,
  GetDecisionQuestionPayload,
  GetDecisionQuestionSummariesByReferencePayload,
  GetDecisionQuestionSummariesPayload,
  GetDecisionAnswerResultPayload,
  GetDecisionDeclineResultPayload,
  GetDecisionFollowUpResultPayload,
  SendDecisionFollowUpPayload,
  MarkDecisionQuestionsPayload,
} from "../../../shared/types/decisionsQuestion.js";
import type {
  DecisionsInvolvementRead,
  DecisionsInvolvementSaveResult,
  SetDecisionsInvolvementPayload,
} from "../../../shared/types/decisionsInvolvement.js";
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

// How the person confirmed erasing the keys (#18064); main rechecks a one-click confirm.
const keyErasureSchema = z
  .object({
    oneClick: z.boolean(),
    relayOrigin: z.string().max(2048).nullable(),
    keys: z.string().max(256).nullable(),
  })
  .strict();

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

// A view's whole set of draft keys, as its draft store keys them.
const composerDraftKeysSchema = z.array(z.string().min(1).max(1024)).max(10_000);

/** The views whose drafts are dropped when they close. */
const composerDraftViews = new Set<string>();

// Only the shape here; main refuses any id no agent could have.
const agentAskHumanSchema = z
  .object({ agentId: z.string().min(1).max(256), enabled: z.boolean() })
  .strict();

// A run id main minted (a UUID); a cancel names the run it means to end.
const cancelSetupCheckSchema = z.object({ runId: z.string().min(1).max(64) }).strict();

// A question id as the library mints it.
const questionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

/** An attention item's token, as main minted it: a SHA-256 digest of ids and states. */
const attentionTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A destination's run as main listed it: a SHA-256 digest of the pane's run identity. */
const destinationRunSchema = z.string().regex(/^[0-9a-f]{64}$/);

const reassignAnswerSchema = z
  .object({
    questionId: questionIdSchema,
    terminalId: z.string().min(1).max(256),
    run: destinationRunSchema,
    expected: attentionTokenSchema.optional(),
  })
  .strict();

const markAnswerHandledSchema = z
  .object({ questionId: questionIdSchema, expected: attentionTokenSchema.optional() })
  .strict();

const questionTerminalIdSchema = z.string().min(1).max(256);

const getQuestionContentSchema = z
  .object({ terminalId: questionTerminalIdSchema, questionId: questionIdSchema })
  .strict();

const cancelQuestionSchema = z
  .object({ terminalId: questionTerminalIdSchema, questionId: questionIdSchema })
  .strict();

const attachmentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// Where in an image (at most 20 MiB) a part starts.
const imageOffsetSchema = z
  .number()
  .int()
  .min(0)
  .max(20 * 1024 * 1024);

const getQuestionImageSchema = z
  .object({
    terminalId: questionTerminalIdSchema,
    questionId: questionIdSchema,
    attachmentId: attachmentIdSchema,
    offset: imageOffsetSchema,
  })
  .strict();

// A question by the machine, project, terminal and id it names (#17229); main checks the machine is this one.
const questionReferenceSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256),
    terminalId: questionTerminalIdSchema,
    questionId: questionIdSchema,
  })
  .strict();

const questionByReferenceSchema = z.object({ reference: questionReferenceSchema }).strict();

// One of a Remote Host's stopped deliveries (#18031): a resume or Mark handled names the item it confirmed.
const hostAttentionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), reference: questionReferenceSchema }).strict(),
  z.object({ action: z.literal("copy"), reference: questionReferenceSchema }).strict(),
  z
    .object({
      action: z.literal("resume"),
      reference: questionReferenceSchema,
      expected: attentionTokenSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("handled"),
      reference: questionReferenceSchema,
      expected: attentionTokenSchema,
    })
    .strict(),
]);

const getQuestionImageByReferenceSchema = z
  .object({
    reference: questionReferenceSchema,
    attachmentId: attachmentIdSchema,
    offset: imageOffsetSchema,
  })
  .strict();

// The client's page, `DECISION_QUESTION_MARKS_PER_CALL`, as a literal: this module loads at
// startup, and importing a value from the Decisions types would add that module to it.
const MARKS_PER_CALL = 500;

// What the person did with questions' current asks on this computer (#17895), a page at a time.
const markQuestionsSchema = z
  .object({
    action: z.enum(["seen", "clear", "restore"]),
    questions: z
      .array(
        z
          .object({
            reference: questionReferenceSchema,
            ask: z.string().min(1).max(256).nullable(),
          })
          .strict()
      )
      .min(1)
      .max(MARKS_PER_CALL),
  })
  .strict();

const getQuestionSummariesByReferenceSchema = z
  .object({ references: z.array(questionReferenceSchema).max(64) })
  .strict();

// An answer id the view mints (a UUID fits), in the protocol's id shape.
const answerIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// The person's answer (#17101), within the protocol's own bounds, which the
// library checks again, with the question's rules, before anything is signed.
const answerQuestionSchema = z
  .object({
    reference: questionReferenceSchema,
    answerId: answerIdSchema,
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    selectedOptionIds: z.array(z.string().min(1).max(64)).max(12),
    text: z
      .string()
      .max(16 * 1024)
      .optional(),
    explicitApproval: z.boolean().optional(),
    reason: z.string().max(2_000).optional(),
    reviewedAttachmentDigests: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(8),
  })
  .strict();

const getAnswerResultSchema = z.object({ answerId: answerIdSchema }).strict();

// The person's decline (#17239): the question as an answer names it, the
// revision the person read, and an id the view mints, in the same shape.
const declineQuestionSchema = z
  .object({
    reference: questionReferenceSchema,
    declineId: answerIdSchema,
    expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const getDeclineResultSchema = z.object({ declineId: answerIdSchema }).strict();

// The person's follow-up (#17238): words only, as from a phone, within the
// protocol's message bound, which the library checks again in UTF-8 bytes.
const sendFollowUpSchema = z
  .object({
    reference: questionReferenceSchema,
    messageId: answerIdSchema,
    text: z
      .string()
      .max(16 * 1024)
      .refine((text) => text.trim() !== ""),
  })
  .strict();

const getFollowUpResultSchema = z.object({ messageId: answerIdSchema }).strict();

const involvementModeSchema = z.enum(["involve-early", "recommend"]);

// The library's own input bounds (`SetInvolvementInput`), which it checks again before signing.
const setInvolvementSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    normalMode: involvementModeSchema,
    consultCount: z.number().int().min(1).max(8),
    override: z
      .object({ mode: involvementModeSchema, until: z.iso.datetime({ precision: 3 }) })
      .strict()
      .nullable(),
  })
  .strict();

// A pane holds at most ten open questions; the cap leaves room for the settled ones a list names.
const getQuestionSummariesSchema = z
  .object({
    terminalId: questionTerminalIdSchema,
    questionIds: z.array(questionIdSchema).max(64),
  })
  .strict();

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
    // A pane's question with its content opened (#17097), and the opening
    // lines its list names. `host`, like the pane state, so a view on a Remote
    // Host reads the Host's store; scoped to the asking view's project, which
    // comes from the request's context, never from the renderer.
    getQuestionContent: opValidated(
      CHANNELS.DECISIONS_GET_QUESTION_CONTENT,
      getQuestionContentSchema,
      async (ctx, payload: GetDecisionQuestionPayload): Promise<DecisionQuestionContentResult> => {
        if (!decisionsServesPanes(store.get("decisions"), store.get("decisionsHost"))) {
          return { result: "off" };
        }
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionQuestionContent(ctx.projectId, payload);
      },
      { withContext: true }
    ),
    // One of a question's images, fetched and checked on the machine that
    // owns the pane (#17100); scoped like the content, and only ever returned
    // to the view that asked.
    getQuestionImage: opValidated(
      CHANNELS.DECISIONS_GET_QUESTION_IMAGE,
      getQuestionImageSchema,
      async (
        ctx,
        payload: GetDecisionQuestionImagePayload
      ): Promise<DecisionQuestionImagePartResult> => {
        if (!decisionsServesPanes(store.get("decisions"), store.get("decisionsHost"))) {
          return { result: "off" };
        }
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionQuestionImage(ctx.projectId, payload);
      },
      { withContext: true }
    ),
    getQuestionSummaries: opValidated(
      CHANNELS.DECISIONS_GET_QUESTION_SUMMARIES,
      getQuestionSummariesSchema,
      async (
        ctx,
        payload: GetDecisionQuestionSummariesPayload
      ): Promise<DecisionQuestionSummariesResult> => {
        if (!decisionsServesPanes(store.get("decisions"), store.get("decisionsHost"))) {
          return { result: "off" };
        }
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionQuestionSummaries(ctx.projectId, payload);
      },
      { withContext: true }
    ),
    // A person withdrawing a pane's question from its view (#17099). `host`,
    // so a Remote Host's pane has its question withdrawn by the Host that
    // asked it; scoped like the reads, to the asking view's project from the
    // request's context. Never starts Decisions.
    cancelQuestion: opValidated(
      CHANNELS.DECISIONS_CANCEL_QUESTION,
      cancelQuestionSchema,
      async (
        ctx,
        payload: CancelDecisionQuestionPayload
      ): Promise<DecisionQuestionCancelResult> => {
        if (!decisionsServesPanes(store.get("decisions"), store.get("decisionsHost"))) {
          return { result: "off" };
        }
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.cancelDecisionQuestion(ctx.projectId, payload);
      },
      { withContext: true }
    ),
    // Every question this computer's Decisions holds (#17229), ids, labels,
    // times and statuses only, and each read or withdrawn by its reference.
    // `shell`: this computer's own, for any of its windows whatever project it
    // shows. The list is the leaf Decisions installs into while it runs, so
    // reading it never loads Decisions; it is empty while Decisions is off.
    // Imported on demand, so Decisions adds no module to startup.
    listQuestions: op(CHANNELS.DECISIONS_LIST_QUESTIONS, async (): Promise<DecisionQuestionList> =>
      (await import("../../services/decisionsQuestionList.js")).getDecisionQuestionList()
    ),
    getQuestionContentByReference: opValidated(
      CHANNELS.DECISIONS_GET_QUESTION_CONTENT_BY_REFERENCE,
      questionByReferenceSchema,
      async (
        payload: GetDecisionQuestionByReferencePayload
      ): Promise<DecisionQuestionContentResult> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionQuestionContentByReference(payload);
      }
    ),
    // The pane that asked a question, as it shows now (#18037): `shell`, read on the machine that
    // owns it, this computer or the Remote Host that asked, for this computer's person only. Never
    // the relay: it doesn't wait on terminal snapshots being on. Never starts Decisions.
    getQuestionPaneByReference: opValidated(
      CHANNELS.DECISIONS_GET_QUESTION_PANE_BY_REFERENCE,
      questionByReferenceSchema,
      async (payload: GetDecisionQuestionByReferencePayload): Promise<DecisionQuestionPaneResult> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionQuestionPaneByReference(payload);
      }
    ),
    getQuestionImageByReference: opValidated(
      CHANNELS.DECISIONS_GET_QUESTION_IMAGE_BY_REFERENCE,
      getQuestionImageByReferenceSchema,
      async (
        payload: GetDecisionQuestionImageByReferencePayload
      ): Promise<DecisionQuestionImagePartResult> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionQuestionImageByReference(payload);
      }
    ),
    getQuestionSummariesByReference: opValidated(
      CHANNELS.DECISIONS_GET_QUESTION_SUMMARIES_BY_REFERENCE,
      getQuestionSummariesByReferenceSchema,
      async (
        payload: GetDecisionQuestionSummariesByReferencePayload
      ): Promise<DecisionQuestionSummariesResult> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionQuestionSummariesByReference(payload);
      }
    ),
    cancelQuestionByReference: opValidated(
      CHANNELS.DECISIONS_CANCEL_QUESTION_BY_REFERENCE,
      questionByReferenceSchema,
      async (
        payload: CancelDecisionQuestionByReferencePayload
      ): Promise<DecisionQuestionCancelResult> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.cancelDecisionQuestionByReference(payload);
      }
    ),
    // The person seeing, clearing or restoring questions (#17895): `shell`,
    // kept on this computer whichever machine asked, and never sent to the
    // relay, a Host or a terminal. No action, MCP tool or plugin surface
    // reaches it. Never starts Decisions.
    markQuestions: opValidated(
      CHANNELS.DECISIONS_MARK_QUESTIONS,
      markQuestionsSchema,
      async (payload: MarkDecisionQuestionsPayload): Promise<DecisionQuestionMarkResult> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.markDecisionQuestions(payload);
      }
    ),
    // The person's answer to a question (#17101), from Daintree's own view:
    // `shell`, so this computer signs it with its owner key whichever machine
    // asked, and a Remote Host window's answer never reaches the Host, whose
    // key never signs one. The question is named by the reference its content
    // was read with. There is no action, MCP tool or plugin surface for it.
    // Never starts Decisions.
    answerQuestion: opValidated(
      CHANNELS.DECISIONS_ANSWER_QUESTION,
      answerQuestionSchema,
      async (payload: AnswerDecisionQuestionPayload): Promise<DecisionQuestionAnswerResult> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.answerDecisionQuestion(payload);
      }
    ),
    getAnswerResult: opValidated(
      CHANNELS.DECISIONS_GET_ANSWER_RESULT,
      getAnswerResultSchema,
      async (payload: GetDecisionAnswerResultPayload): Promise<DecisionAnswerResultRead> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionAnswerResult(payload);
      }
    ),
    // The person's decline (#17239), from Daintree's own view: `shell` like
    // their answer, so this computer signs it with its owner key whichever
    // machine asked. No action, MCP tool or plugin surface reaches it. An
    // enrolled Remote Host serves its panes with the owner's switch off here,
    // and its key never signs for the person: it says so, without loading
    // anything, so its view offers withdrawing instead. Never starts Decisions.
    declineQuestion: opValidated(
      CHANNELS.DECISIONS_DECLINE_QUESTION,
      declineQuestionSchema,
      async (payload: DeclineDecisionQuestionPayload): Promise<DecisionQuestionDeclineResult> => {
        if (!decisionsOn()) {
          return decisionsHostServes(store.get("decisionsHost"))
            ? { result: "refused", reason: "not-owner" }
            : { result: "off" };
        }
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.declineDecisionQuestion(payload);
      }
    ),
    getDeclineResult: opValidated(
      CHANNELS.DECISIONS_GET_DECLINE_RESULT,
      getDeclineResultSchema,
      async (payload: GetDecisionDeclineResultPayload): Promise<DecisionDeclineResultRead> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionDeclineResult(payload);
      }
    ),
    // The person's follow-up on a question's thread (#17238), from Daintree's
    // own view: `shell`, signed by this computer's owner key as their answer
    // is, whichever machine asked. No action, MCP tool or plugin surface.
    // Never starts Decisions.
    sendFollowUp: opValidated(
      CHANNELS.DECISIONS_SEND_FOLLOW_UP,
      sendFollowUpSchema,
      async (payload: SendDecisionFollowUpPayload): Promise<DecisionQuestionFollowUpResult> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.sendDecisionFollowUp(payload);
      }
    ),
    getFollowUpResult: opValidated(
      CHANNELS.DECISIONS_GET_FOLLOW_UP_RESULT,
      getFollowUpResultSchema,
      async (payload: GetDecisionFollowUpResultPayload): Promise<DecisionFollowUpResultRead> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionFollowUpResult(payload);
      }
    ),

    // The person's involvement preference (#17237), from Daintree's own view:
    // `shell`, so this computer reads its own copy and signs a change with its
    // owner key whichever machine a window is attached to. There is no
    // action, MCP tool or plugin surface for it: agents read the preference
    // in force through `get_involvement` and never change it. Never starts
    // Decisions.
    getInvolvement: op(
      CHANNELS.DECISIONS_GET_INVOLVEMENT,
      async (): Promise<DecisionsInvolvementRead> => {
        if (!decisionsOn()) return { result: "off" };
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.getDecisionsInvolvement();
      }
    ),
    setInvolvement: opValidated(
      CHANNELS.DECISIONS_SET_INVOLVEMENT,
      setInvolvementSchema,
      async (payload: SetDecisionsInvolvementPayload): Promise<DecisionsInvolvementSaveResult> => {
        // An enrolled Remote Host serves its panes with the owner's switch off
        // here, and its key never signs the person's preference.
        if (!decisionsOn()) {
          return decisionsHostServes(store.get("decisionsHost"))
            ? { result: "refused", reason: "not-owner" }
            : { result: "off" };
        }
        const decisions = await loadDecisions();
        if (!decisions) return { result: "not-running" };
        return decisions.setDecisionsInvolvement(payload);
      }
    ),
    // Which terminals this view's hybrid input holds a draft for (#16282): an
    // answer waits behind one. Kept whatever the switch says, so turning
    // Decisions on never starts from an empty picture.
    reportComposerDrafts: opValidated(
      CHANNELS.DECISIONS_REPORT_COMPOSER_DRAFTS,
      composerDraftKeysSchema,
      (ctx, keys: string[]): void => {
        const { endpoint } = ctx;
        if (endpoint.isClosed()) return;
        const viewId = endpoint.endpointId;
        if (!composerDraftViews.has(viewId)) {
          composerDraftViews.add(viewId);
          endpoint.onClose(() => {
            composerDraftViews.delete(viewId);
            composerDrafts.dropView(viewId);
          });
        }
        composerDrafts.report(viewId, keys);
      },
      { withContext: true }
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
    disconnectRelay: opValidated(
      CHANNELS.DECISIONS_DISCONNECT_RELAY,
      keyErasureSchema,
      async (payload: DecisionsKeyErasurePayload): Promise<DecisionsStatus> => {
        refuseWhileOff("disconnect a relay");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.disconnectRelay(payload);
      }
    ),
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
    deleteLocalData: opValidated(
      CHANNELS.DECISIONS_DELETE_LOCAL_DATA,
      keyErasureSchema,
      async (payload: DecisionsKeyErasurePayload): Promise<DecisionsLocalDeleteResult> => {
        refuseWhileOff("delete its data");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.deleteLocalData(payload);
      }
    ),
    // The trusted gates (#16013) and the default question expiry (#16122).
    // Read and changed only while on: Settings shows them behind the switch,
    // and reading them loads Decisions. No op registers or edits a gate, and
    // whether a question without one may take a proxy answer follows the
    // decision model's own choice (#18062).
    getPolicy: op(CHANNELS.DECISIONS_GET_POLICY, async (): Promise<DecisionsPolicy> => {
      refuseWhileOff("read its policy");
      const decisions = await loadDecisions();
      if (!decisions) throw setupCancelled();
      return decisions.getDecisionsPolicy();
    }),
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
    // Holding a new question's phone push while the person is here (#17240).
    setHoldPhonePushes: opValidated(
      CHANNELS.DECISIONS_SET_HOLD_PHONE_PUSHES,
      z.boolean(),
      async (enabled: boolean): Promise<DecisionsStatus> => {
        refuseWhileOff("change when your phone is notified");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setDecisionsHoldPhonePushes(enabled);
      }
    ),
    // Telling the phone when one of this computer's agents stops while the person is away (#17319).
    setAgentStoppedPushes: opValidated(
      CHANNELS.DECISIONS_SET_AGENT_STOPPED_PUSHES,
      z.boolean(),
      async (enabled: boolean): Promise<DecisionsStatus> => {
        refuseWhileOff("change when your phone is notified");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.setDecisionsAgentStoppedPushes(enabled);
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
    // A Remote Host's stopped delivery (#18031), read and acted on on that
    // Host alone; one no Host lists never reaches this computer's delivery.
    hostAttention: opValidated(
      CHANNELS.DECISIONS_HOST_ATTENTION,
      hostAttentionSchema,
      async (request: DecisionsHostAttentionRequest): Promise<DecisionsHostAttentionResult> => {
        refuseWhileOff("resolve a Remote Host's delivery");
        const decisions = await loadDecisions();
        if (!decisions) throw setupCancelled();
        return decisions.actOnHostAttention(request);
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
