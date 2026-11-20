import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaimDecisionsRelayPayload,
  ClaimDeployedDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsExportResult,
  DecisionsKitExportResult,
  DecisionsKitVerifyResult,
  DecisionsKeyErasurePayload,
  DecisionsLocalDeleteResult,
  DecisionsPolicy,
  DecisionsRelayCheck,
  DecisionsRelayDeleteResult,
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
  VerifyDecisionsRecoveryKitPayload,
} from "../../../../shared/types/decisions.js";
import type { IpcContext } from "../../types.js";
import type {
  DecisionsHostEnrollResult,
  DecisionsHostsResult,
  EnrollDecisionsHostPayload,
} from "../../../../shared/types/decisionsHosts.js";
import type {
  AnswerDecisionQuestionPayload,
  CancelDecisionQuestionByReferencePayload,
  DecisionQuestionMarkResult,
  MarkDecisionQuestionsPayload,
  DeclineDecisionQuestionPayload,
  DecisionAnswerResultRead,
  DecisionDeclineResultRead,
  DecisionFollowUpResultRead,
  DecisionQuestionAnswerResult,
  DecisionQuestionDeclineResult,
  DecisionQuestionFollowUpResult,
  GetDecisionAnswerResultPayload,
  GetDecisionDeclineResultPayload,
  GetDecisionFollowUpResultPayload,
  SendDecisionFollowUpPayload,
  CancelDecisionQuestionPayload,
  DecisionQuestionCancelResult,
  DecisionQuestionContentResult,
  DecisionQuestionImagePartResult,
  DecisionQuestionList,
  DecisionQuestionReference,
  DecisionQuestionSummariesResult,
  GetDecisionQuestionByReferencePayload,
  GetDecisionQuestionImageByReferencePayload,
  GetDecisionQuestionImagePayload,
  GetDecisionQuestionPayload,
  GetDecisionQuestionSummariesByReferencePayload,
  GetDecisionQuestionSummariesPayload,
} from "../../../../shared/types/decisionsQuestion.js";
import { DECISION_QUESTION_MARKS_PER_CALL } from "../../../../shared/types/decisionsQuestion.js";
import type {
  DecisionsInvolvementRead,
  DecisionsInvolvementSaveResult,
  SetDecisionsInvolvementPayload,
} from "../../../../shared/types/decisionsInvolvement.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
const saved = vi.hoisted(() => ({ value: undefined as unknown, host: undefined as unknown }));
// Counts evaluation of Decisions' entry module and of each library, none of
// which an off read may load.
const decisionsEntry = vi.hoisted(() => ({
  evaluated: 0,
  libraries: 0,
  getDecisionsStatus: vi.fn(async (): Promise<DecisionsStatus> => ({ state: "not-connected" })),
  getDecisionsPaneState: vi.fn((): PaneDecisionState | null => null),
  getDecisionQuestionContent: vi.fn(
    async (
      _projectId: string | null,
      _payload: GetDecisionQuestionPayload
    ): Promise<DecisionQuestionContentResult> => ({ result: "not-found" })
  ),
  getDecisionQuestionSummaries: vi.fn(
    async (
      _projectId: string | null,
      _payload: GetDecisionQuestionSummariesPayload
    ): Promise<DecisionQuestionSummariesResult> => ({ result: "read", summaries: [] })
  ),
  cancelDecisionQuestion: vi.fn(
    async (
      _projectId: string | null,
      _payload: CancelDecisionQuestionPayload
    ): Promise<DecisionQuestionCancelResult> => ({ result: "cancelling" })
  ),
  getDecisionQuestionImage: vi.fn(
    async (
      _projectId: string | null,
      _payload: GetDecisionQuestionImagePayload
    ): Promise<DecisionQuestionImagePartResult> => ({ result: "not-found" })
  ),
  getDecisionQuestionContentByReference: vi.fn(
    async (
      _payload: GetDecisionQuestionByReferencePayload
    ): Promise<DecisionQuestionContentResult> => ({
      result: "not-found",
    })
  ),
  getDecisionQuestionImageByReference: vi.fn(
    async (
      _payload: GetDecisionQuestionImageByReferencePayload
    ): Promise<DecisionQuestionImagePartResult> => ({ result: "not-found" })
  ),
  getDecisionQuestionSummariesByReference: vi.fn(
    async (
      _payload: GetDecisionQuestionSummariesByReferencePayload
    ): Promise<DecisionQuestionSummariesResult> => ({ result: "read", summaries: [] })
  ),
  cancelDecisionQuestionByReference: vi.fn(
    async (
      _payload: CancelDecisionQuestionByReferencePayload
    ): Promise<DecisionQuestionCancelResult> => ({ result: "cancelling" })
  ),
  markDecisionQuestions: vi.fn(
    async (_payload: MarkDecisionQuestionsPayload): Promise<DecisionQuestionMarkResult> => ({
      result: "marked",
      marked: 0,
    })
  ),
  answerDecisionQuestion: vi.fn(
    async (_payload: AnswerDecisionQuestionPayload): Promise<DecisionQuestionAnswerResult> => ({
      result: "submitted",
      answerId: "0190f0aa-1111-4222-8333-444455556666",
      outcome: { status: "sent" },
    })
  ),
  getDecisionAnswerResult: vi.fn(
    async (_payload: GetDecisionAnswerResultPayload): Promise<DecisionAnswerResultRead> => ({
      result: "not-found",
    })
  ),
  declineDecisionQuestion: vi.fn(
    async (_payload: DeclineDecisionQuestionPayload): Promise<DecisionQuestionDeclineResult> => ({
      result: "submitted",
      declineId: "0190f0aa-1111-4222-8333-44445555dddd",
      outcome: { status: "declined" },
    })
  ),
  getDecisionDeclineResult: vi.fn(
    async (_payload: GetDecisionDeclineResultPayload): Promise<DecisionDeclineResultRead> => ({
      result: "not-found",
    })
  ),
  sendDecisionFollowUp: vi.fn(
    async (_payload: SendDecisionFollowUpPayload): Promise<DecisionQuestionFollowUpResult> => ({
      result: "submitted",
      messageId: "0190f0aa-2222-4222-8333-444455550001",
      outcome: { status: "sent" },
    })
  ),
  getDecisionFollowUpResult: vi.fn(
    async (_payload: GetDecisionFollowUpResultPayload): Promise<DecisionFollowUpResultRead> => ({
      result: "not-found",
    })
  ),

  getDecisionsInvolvement: vi.fn(async (): Promise<DecisionsInvolvementRead> => ({
    result: "not-running",
  })),
  setDecisionsInvolvement: vi.fn(
    async (_payload: SetDecisionsInvolvementPayload): Promise<DecisionsInvolvementSaveResult> => ({
      result: "saved",
      revision: 1,
    })
  ),
  setDecisionsEnabled: vi.fn(async (enabled: boolean): Promise<DecisionsStatus> => ({
    state: enabled ? "not-connected" : "off",
  })),
  checkRelay: vi.fn(async (): Promise<DecisionsRelayCheck> => ({
    result: "invalid-url",
    reason: "not-https",
  })),
  claimRelay: vi.fn(
    async (_payload: ClaimDecisionsRelayPayload): Promise<DecisionsConnectResult> => ({
      result: "saved",
      status: { state: "not-connected", relayOrigin: "https://relay.example.com" },
    })
  ),
  prepareRelayDeploy: vi.fn(
    async (_readVoiceSettings: () => unknown): Promise<PreparedDecisionsRelayDeploy> => ({
      id: "deploy-1",
      hostChannel: "/tmp/daintree-deploy-AbC123/host.sock",
    })
  ),
  cancelRelayDeploy: vi.fn((_deployId: string) => {}),
  claimDeployedRelay: vi.fn(
    async (_payload: ClaimDeployedDecisionsRelayPayload): Promise<DecisionsConnectResult> => ({
      result: "saved",
      status: { state: "not-connected", relayOrigin: "https://relay.example.com" },
    })
  ),
  restoreIdentity: vi.fn(
    async (_payload: RestoreDecisionsIdentityPayload): Promise<DecisionsConnectResult> => ({
      result: "saved",
      status: { state: "not-connected", relayOrigin: "https://relay.example.com" },
    })
  ),
  disconnectRelay: vi.fn(async (): Promise<DecisionsStatus> => ({ state: "not-connected" })),
  exportData: vi.fn(
    async (
      _payload: ExportDecisionsDataPayload,
      _choose: (fileName: string) => Promise<string | null>
    ): Promise<DecisionsExportResult> => ({ result: "cancelled" })
  ),
  deleteRelayData: vi.fn(
    async (_payload: DeleteDecisionsRelayDataPayload): Promise<DecisionsRelayDeleteResult> => ({
      result: "deleted",
      origin: "https://relay.example.com",
    })
  ),
  deleteLocalData: vi.fn(async (): Promise<DecisionsLocalDeleteResult> => ({
    result: "deleted",
    status: { state: "not-connected" },
  })),
  getDecisionsPolicy: vi.fn((): DecisionsPolicy => ({
    gates: [],
    proxyAllowlisted: false,
    defaultQuestionExpiryMs: 1,
    maxQuestionExpiryMs: 2,
    askHumanAgents: [],
    revision: 0,
  })),
  setDecisionsProxyAllowlisted: vi.fn(async (allowed: boolean): Promise<DecisionsPolicy> => ({
    gates: [],
    proxyAllowlisted: allowed,
    defaultQuestionExpiryMs: 1,
    maxQuestionExpiryMs: 2,
    askHumanAgents: [],
    revision: 1,
  })),
  setDecisionsDefaultQuestionExpiry: vi.fn(async (ms: number | null): Promise<DecisionsPolicy> => ({
    gates: [],
    proxyAllowlisted: false,
    defaultQuestionExpiryMs: ms,
    maxQuestionExpiryMs: null,
    askHumanAgents: [],
    revision: 1,
  })),
  setDecisionsAgentAskHuman: vi.fn(
    async (payload: SetDecisionsAgentAskHumanPayload): Promise<DecisionsPolicy> => ({
      gates: [],
      proxyAllowlisted: false,
      defaultQuestionExpiryMs: 1,
      maxQuestionExpiryMs: 2,
      askHumanAgents: payload.enabled ? [payload.agentId] : [],
      revision: 1,
    })
  ),
  setDecisionsTerminalSnapshots: vi.fn(
    async (payload: SetDecisionsTerminalSnapshotsPayload): Promise<DecisionsStatus> =>
      payload.enabled
        ? { state: "connected", terminalSnapshots: true, revision: 1 }
        : { state: "connected", revision: 1 }
  ),
  setDecisionsHoldPhonePushes: vi.fn(async (enabled: boolean): Promise<DecisionsStatus> =>
    enabled
      ? { state: "connected", revision: 1 }
      : { state: "connected", holdPhonePushes: false, revision: 1 }
  ),
  setDecisionsAgentStoppedPushes: vi.fn(async (enabled: boolean): Promise<DecisionsStatus> =>
    enabled
      ? { state: "connected", agentStoppedPushes: true, revision: 1 }
      : { state: "connected", revision: 1 }
  ),
  // Asks for a path as the real entry does, and answers with what it was given.
  exportRecoveryKit: vi.fn(
    async (
      _payload: ExportDecisionsRecoveryKitPayload,
      choosePath: (defaultName: string) => Promise<string | null>
    ): Promise<DecisionsKitExportResult> => {
      const path = await choosePath("decisions-recovery-kit-relay.example.com.json");
      return path === null ? { result: "cancelled" } : { result: "saved", fileName: path };
    }
  ),
  verifyRecoveryKit: vi.fn(
    async (_payload: VerifyDecisionsRecoveryKitPayload): Promise<DecisionsKitVerifyResult> => ({
      result: "verified",
      status: { state: "not-connected", recoveryKitVerifiedAt: 1 },
    })
  ),
  revokeDevice: vi.fn(async (_deviceId: string) => ({ result: "revoked", keyEpoch: 2 })),
  rotateKeys: vi.fn(async () => ({ result: "rotated", keyEpoch: 2 })),
  listHosts: vi.fn(async (): Promise<DecisionsHostsResult> => ({
    result: "listed",
    autoEnroll: true,
    hosts: [],
  })),
  enrollDecisionsHost: vi.fn(async (_hostId: string): Promise<DecisionsHostEnrollResult> => ({
    result: "not-connected",
  })),
  setAutoEnrollHosts: vi.fn(async (enabled: boolean): Promise<DecisionsHostsResult> => ({
    result: "listed",
    autoEnroll: enabled,
    hosts: [],
  })),
  startSetupCheck: vi.fn(async (): Promise<unknown> => ({ result: "not-set-up" })),
  getSetupCheck: vi.fn((): unknown => null),
  cancelSetupCheck: vi.fn(async (_payload: { runId: string }): Promise<unknown> => null),
  getDecisionsModel: vi.fn((): unknown => ({ revision: 0, learning: false })),
  setDecisionsModel: vi.fn(async (_payload: unknown): Promise<unknown> => ({ learning: true })),
  startDecisionsModelEvaluation: vi.fn(async (): Promise<unknown> => ({ running: {} })),
  cancelDecisionsModelEvaluation: vi.fn((_payload: unknown): unknown => ({ running: null })),
  setDecisionsModelThreshold: vi.fn(async (_payload: unknown): Promise<unknown> => ({})),
  clearDecisionsModelHistory: vi.fn(async (): Promise<unknown> => ({})),
}));
const dialogMock = vi.hoisted(() => ({
  showSaveDialog: vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>>(
    async () => ({ canceled: true })
  ),
}));

// Views bound to a Remote Host, by webContents id.
const remoteViews = vi.hoisted(() => new Set<number>());
const getVoiceSettings = vi.hoisted(() => vi.fn(() => ({ enabled: false })));
vi.mock("../../../window/webviewSrcGate.js", () => ({
  isRemoteView: (webContentsId: number) => remoteViews.has(webContentsId),
}));
vi.mock("../voiceInput.js", () => ({ getVoiceSettings }));

// The export ops take their asking window from the context, which finds none here.
vi.mock("electron", () => ({ ipcMain: ipcMainMock, dialog: dialogMock, BrowserWindow: {} }));
vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) =>
      key === "decisions" ? saved.value : key === "decisionsHost" ? saved.host : undefined
    ),
    set: vi.fn(),
  },
}));
vi.mock("../../../services/decisions/index.js", () => {
  decisionsEntry.evaluated += 1;
  return {
    getDecisionsStatus: decisionsEntry.getDecisionsStatus,
    getDecisionsPaneState: decisionsEntry.getDecisionsPaneState,
    getDecisionQuestionContent: decisionsEntry.getDecisionQuestionContent,
    getDecisionQuestionSummaries: decisionsEntry.getDecisionQuestionSummaries,
    cancelDecisionQuestion: decisionsEntry.cancelDecisionQuestion,
    getDecisionQuestionImage: decisionsEntry.getDecisionQuestionImage,
    getDecisionQuestionContentByReference: decisionsEntry.getDecisionQuestionContentByReference,
    getDecisionQuestionImageByReference: decisionsEntry.getDecisionQuestionImageByReference,
    getDecisionQuestionSummariesByReference: decisionsEntry.getDecisionQuestionSummariesByReference,
    cancelDecisionQuestionByReference: decisionsEntry.cancelDecisionQuestionByReference,
    markDecisionQuestions: decisionsEntry.markDecisionQuestions,
    answerDecisionQuestion: decisionsEntry.answerDecisionQuestion,
    getDecisionAnswerResult: decisionsEntry.getDecisionAnswerResult,
    declineDecisionQuestion: decisionsEntry.declineDecisionQuestion,
    getDecisionDeclineResult: decisionsEntry.getDecisionDeclineResult,
    sendDecisionFollowUp: decisionsEntry.sendDecisionFollowUp,
    getDecisionFollowUpResult: decisionsEntry.getDecisionFollowUpResult,
    getDecisionsInvolvement: decisionsEntry.getDecisionsInvolvement,
    setDecisionsInvolvement: decisionsEntry.setDecisionsInvolvement,
    setDecisionsEnabled: decisionsEntry.setDecisionsEnabled,
    checkRelay: decisionsEntry.checkRelay,
    claimRelay: decisionsEntry.claimRelay,
    prepareRelayDeploy: decisionsEntry.prepareRelayDeploy,
    cancelRelayDeploy: decisionsEntry.cancelRelayDeploy,
    claimDeployedRelay: decisionsEntry.claimDeployedRelay,
    restoreIdentity: decisionsEntry.restoreIdentity,
    disconnectRelay: decisionsEntry.disconnectRelay,
    exportData: decisionsEntry.exportData,
    deleteRelayData: decisionsEntry.deleteRelayData,
    deleteLocalData: decisionsEntry.deleteLocalData,
    getDecisionsPolicy: decisionsEntry.getDecisionsPolicy,
    setDecisionsProxyAllowlisted: decisionsEntry.setDecisionsProxyAllowlisted,
    setDecisionsDefaultQuestionExpiry: decisionsEntry.setDecisionsDefaultQuestionExpiry,
    setDecisionsAgentAskHuman: decisionsEntry.setDecisionsAgentAskHuman,
    setDecisionsTerminalSnapshots: decisionsEntry.setDecisionsTerminalSnapshots,
    setDecisionsHoldPhonePushes: decisionsEntry.setDecisionsHoldPhonePushes,
    setDecisionsAgentStoppedPushes: decisionsEntry.setDecisionsAgentStoppedPushes,
    exportRecoveryKit: decisionsEntry.exportRecoveryKit,
    verifyRecoveryKit: decisionsEntry.verifyRecoveryKit,
    revokeDevice: decisionsEntry.revokeDevice,
    rotateKeys: decisionsEntry.rotateKeys,
    listHosts: decisionsEntry.listHosts,
    enrollDecisionsHost: decisionsEntry.enrollDecisionsHost,
    setAutoEnrollHosts: decisionsEntry.setAutoEnrollHosts,
    startSetupCheck: decisionsEntry.startSetupCheck,
    getSetupCheck: decisionsEntry.getSetupCheck,
    cancelSetupCheck: decisionsEntry.cancelSetupCheck,
    getDecisionsModel: decisionsEntry.getDecisionsModel,
    setDecisionsModel: decisionsEntry.setDecisionsModel,
    startDecisionsModelEvaluation: decisionsEntry.startDecisionsModelEvaluation,
    cancelDecisionsModelEvaluation: decisionsEntry.cancelDecisionsModelEvaluation,
    setDecisionsModelThreshold: decisionsEntry.setDecisionsModelThreshold,
    clearDecisionsModelHistory: decisionsEntry.clearDecisionsModelHistory,
  };
});
vi.mock("@daintreehq/decisions-protocol", () => {
  decisionsEntry.libraries += 1;
  return {};
});
vi.mock("@daintreehq/decisions-crypto", () => {
  decisionsEntry.libraries += 1;
  return {};
});
vi.mock("@daintreehq/decisions-client", () => {
  decisionsEntry.libraries += 1;
  return {};
});
vi.mock("@daintreehq/decisions-model", () => {
  decisionsEntry.libraries += 1;
  return {};
});

import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import { decisionsNamespace, registerDecisionsHandlers } from "../deviceAnswer.js";
import {
  _resetDecisionsModuleForTesting,
  sealDecisionsModule,
} from "../../../window/serviceRefs.js";

const getStatus = decisionsNamespace.ops.getStatus
  .handler as unknown as () => Promise<DecisionsStatus>;
const getPaneState = decisionsNamespace.ops.getPaneState.handler as unknown as (
  terminalId: string
) => Promise<PaneDecisionState | null>;
const getQuestionContent = decisionsNamespace.ops.getQuestionContent.handler as unknown as (
  ctx: { projectId: string | null },
  payload: GetDecisionQuestionPayload
) => Promise<DecisionQuestionContentResult>;
const getQuestionSummaries = decisionsNamespace.ops.getQuestionSummaries.handler as unknown as (
  ctx: { projectId: string | null },
  payload: GetDecisionQuestionSummariesPayload
) => Promise<DecisionQuestionSummariesResult>;
const cancelQuestion = decisionsNamespace.ops.cancelQuestion.handler as unknown as (
  ctx: { projectId: string | null },
  payload: CancelDecisionQuestionPayload
) => Promise<DecisionQuestionCancelResult>;
const getQuestionImage = decisionsNamespace.ops.getQuestionImage.handler as unknown as (
  ctx: { projectId: string | null },
  payload: GetDecisionQuestionImagePayload
) => Promise<DecisionQuestionImagePartResult>;
const listQuestions = decisionsNamespace.ops.listQuestions
  .handler as unknown as () => Promise<DecisionQuestionList>;
const getQuestionContentByReference = decisionsNamespace.ops.getQuestionContentByReference
  .handler as unknown as (
  payload: GetDecisionQuestionByReferencePayload
) => Promise<DecisionQuestionContentResult>;
const getQuestionImageByReference = decisionsNamespace.ops.getQuestionImageByReference
  .handler as unknown as (
  payload: GetDecisionQuestionImageByReferencePayload
) => Promise<DecisionQuestionImagePartResult>;
const getQuestionSummariesByReference = decisionsNamespace.ops.getQuestionSummariesByReference
  .handler as unknown as (
  payload: GetDecisionQuestionSummariesByReferencePayload
) => Promise<DecisionQuestionSummariesResult>;
const cancelQuestionByReference = decisionsNamespace.ops.cancelQuestionByReference
  .handler as unknown as (
  payload: CancelDecisionQuestionByReferencePayload
) => Promise<DecisionQuestionCancelResult>;
const markQuestions = decisionsNamespace.ops.markQuestions.handler as unknown as (
  payload: MarkDecisionQuestionsPayload
) => Promise<DecisionQuestionMarkResult>;
const answerQuestion = decisionsNamespace.ops.answerQuestion.handler as unknown as (
  payload: AnswerDecisionQuestionPayload
) => Promise<DecisionQuestionAnswerResult>;
const getAnswerResult = decisionsNamespace.ops.getAnswerResult.handler as unknown as (
  payload: GetDecisionAnswerResultPayload
) => Promise<DecisionAnswerResultRead>;
const declineQuestion = decisionsNamespace.ops.declineQuestion.handler as unknown as (
  payload: DeclineDecisionQuestionPayload
) => Promise<DecisionQuestionDeclineResult>;
const getDeclineResult = decisionsNamespace.ops.getDeclineResult.handler as unknown as (
  payload: GetDecisionDeclineResultPayload
) => Promise<DecisionDeclineResultRead>;
const sendFollowUp = decisionsNamespace.ops.sendFollowUp.handler as unknown as (
  payload: SendDecisionFollowUpPayload
) => Promise<DecisionQuestionFollowUpResult>;
const getFollowUpResult = decisionsNamespace.ops.getFollowUpResult.handler as unknown as (
  payload: GetDecisionFollowUpResultPayload
) => Promise<DecisionFollowUpResultRead>;
const getInvolvement = decisionsNamespace.ops.getInvolvement
  .handler as unknown as () => Promise<DecisionsInvolvementRead>;
const setInvolvement = decisionsNamespace.ops.setInvolvement.handler as unknown as (
  payload: SetDecisionsInvolvementPayload
) => Promise<DecisionsInvolvementSaveResult>;
const setEnabled = decisionsNamespace.ops.setEnabled.handler as unknown as (
  payload: SetDecisionsEnabledPayload
) => Promise<DecisionsStatus>;

const checkRelay = decisionsNamespace.ops.checkRelay.handler as unknown as (
  url: string
) => Promise<DecisionsRelayCheck>;

const claimRelay = decisionsNamespace.ops.claimRelay.handler as unknown as (
  payload: ClaimDecisionsRelayPayload
) => Promise<DecisionsConnectResult>;
const prepareRelayDeploy = decisionsNamespace.ops.prepareRelayDeploy.handler as unknown as (ctx: {
  webContentsId: number;
}) => Promise<PreparedDecisionsRelayDeploy>;
const cancelRelayDeploy = decisionsNamespace.ops.cancelRelayDeploy.handler as unknown as (
  deployId: string
) => Promise<void>;
const claimDeployedRelay = decisionsNamespace.ops.claimDeployedRelay.handler as unknown as (
  payload: ClaimDeployedDecisionsRelayPayload
) => Promise<DecisionsConnectResult>;
const restoreIdentity = decisionsNamespace.ops.restoreIdentity.handler as unknown as (
  payload: RestoreDecisionsIdentityPayload
) => Promise<DecisionsConnectResult>;
const disconnectRelay = decisionsNamespace.ops.disconnectRelay.handler as unknown as (
  payload?: DecisionsKeyErasurePayload
) => Promise<DecisionsStatus>;
const getPolicy = decisionsNamespace.ops.getPolicy
  .handler as unknown as () => Promise<DecisionsPolicy>;
const setProxyAllowlisted = decisionsNamespace.ops.setProxyAllowlisted.handler as unknown as (
  allowed: boolean
) => Promise<DecisionsPolicy>;
const setDefaultQuestionExpiry = decisionsNamespace.ops.setDefaultQuestionExpiry
  .handler as unknown as (ms: number | null) => Promise<DecisionsPolicy>;
const setAgentAskHuman = decisionsNamespace.ops.setAgentAskHuman.handler as unknown as (
  payload: SetDecisionsAgentAskHumanPayload
) => Promise<DecisionsPolicy>;
const setTerminalSnapshots = decisionsNamespace.ops.setTerminalSnapshots.handler as unknown as (
  payload: SetDecisionsTerminalSnapshotsPayload
) => Promise<DecisionsStatus>;
const setHoldPhonePushes = decisionsNamespace.ops.setHoldPhonePushes.handler as unknown as (
  enabled: boolean
) => Promise<DecisionsStatus>;
const setAgentStoppedPushes = decisionsNamespace.ops.setAgentStoppedPushes.handler as unknown as (
  enabled: boolean
) => Promise<DecisionsStatus>;

const listHosts = decisionsNamespace.ops.listHosts
  .handler as unknown as () => Promise<DecisionsHostsResult>;
const enrollHost = decisionsNamespace.ops.enrollHost.handler as unknown as (
  payload: EnrollDecisionsHostPayload
) => Promise<DecisionsHostEnrollResult>;
const setAutoEnrollHosts = decisionsNamespace.ops.setAutoEnrollHosts.handler as unknown as (
  enabled: boolean
) => Promise<DecisionsHostsResult>;

type ExportHandler = (
  ctx: { senderWindow: unknown },
  payload: ExportDecisionsDataPayload
) => Promise<DecisionsExportResult>;
const exportData = decisionsNamespace.ops.exportData.handler as unknown as ExportHandler;
const deleteRelayData = decisionsNamespace.ops.deleteRelayData.handler as unknown as (
  payload: DeleteDecisionsRelayDataPayload
) => Promise<DecisionsRelayDeleteResult>;
const deleteLocalData = decisionsNamespace.ops.deleteLocalData.handler as unknown as (
  payload?: DecisionsKeyErasurePayload
) => Promise<DecisionsLocalDeleteResult>;
/** A confirm that asked for the typed gate (#18064). */
const TYPED: DecisionsKeyErasurePayload = { oneClick: false, relayOrigin: null };
const EXPORT: ExportDecisionsDataPayload = { passphrase: "a long export passphrase" };
const RELAY_ORIGIN = "https://relay.example.com";
const exportRecoveryKit = decisionsNamespace.ops.exportRecoveryKit.handler as unknown as (
  ctx: Pick<IpcContext, "senderWindow">,
  payload: ExportDecisionsRecoveryKitPayload
) => Promise<DecisionsKitExportResult>;
const verifyRecoveryKit = decisionsNamespace.ops.verifyRecoveryKit.handler as unknown as (
  payload: VerifyDecisionsRecoveryKitPayload
) => Promise<DecisionsKitVerifyResult>;
const revokeDevice = decisionsNamespace.ops.revokeDevice.handler as unknown as (
  deviceId: string
) => Promise<unknown>;
const rotateKeys = decisionsNamespace.ops.rotateKeys.handler as unknown as () => Promise<unknown>;
const startSetupCheck = decisionsNamespace.ops.startSetupCheck
  .handler as unknown as () => Promise<unknown>;
const getSetupCheck = decisionsNamespace.ops.getSetupCheck
  .handler as unknown as () => Promise<unknown>;
const cancelSetupCheck = decisionsNamespace.ops.cancelSetupCheck.handler as unknown as (payload: {
  runId: string;
}) => Promise<unknown>;

const modelOps = decisionsNamespace.ops;
const getModel = modelOps.getModel.handler as unknown as () => Promise<unknown>;
const setModel = modelOps.setModel.handler as unknown as (payload: unknown) => Promise<unknown>;
const startModelEvaluation = modelOps.startModelEvaluation
  .handler as unknown as () => Promise<unknown>;
const cancelModelEvaluation = modelOps.cancelModelEvaluation.handler as unknown as (
  payload: unknown
) => Promise<unknown>;
const setModelThreshold = modelOps.setModelThreshold.handler as unknown as (
  payload: unknown
) => Promise<unknown>;
const clearModelHistory = modelOps.clearModelHistory.handler as unknown as () => Promise<unknown>;

const SECRET = "claim-secret-0123456789abcdef";
const PASSPHRASE = "correct horse battery staple";
const CLAIM: ClaimDecisionsRelayPayload = { url: "relay.example.com", claimSecret: SECRET };
const RESTORE: RestoreDecisionsIdentityPayload = {
  url: "relay.example.com",
  kit: '{"v":1}',
  passphrase: PASSPHRASE,
};

type SafeParse = { safeParse(value: unknown): { success: boolean } };

const INVOLVEMENT_CHANGE: SetDecisionsInvolvementPayload = {
  expectedRevision: 3,
  normalMode: "recommend",
  consultCount: 2,
  override: { mode: "involve-early", until: "2026-11-18T17:00:00.000Z" },
};

const QUESTION_ID = "0190f0aa11112222333344445555aa01";
const ATTACHMENT_ID = "attach_0001";

/** A person's answer to a Remote Host's question, as the view submits it (#17101). */
const ANSWER: AnswerDecisionQuestionPayload = {
  reference: {
    hostId: "host_studio",
    projectId: "project-b",
    terminalId: "pane-1",
    questionId: "0190f0aa11112222333344445555aa01",
  },
  answerId: "0190f0aa-1111-4222-8333-444455556666",
  expectedRevision: 0,
  selectedOptionIds: ["approve"],
  explicitApproval: true,
  reviewedAttachmentDigests: ["a".repeat(64)],
};

/** A person's dismissal of the same question (#17239). */
const DECLINE: DeclineDecisionQuestionPayload = {
  reference: ANSWER.reference,
  declineId: "0190f0aa-1111-4222-8333-44445555dddd",
  expectedRevision: 0,
};

/** A person's follow-up on a Remote Host's question, as the view submits it (#17238). */
const FOLLOW_UP: SendDecisionFollowUpPayload = {
  reference: ANSWER.reference,
  messageId: "0190f0aa-2222-4222-8333-444455550001",
  text: "Prefer the one already deployed.",
};

const DECISIONS_CHANNELS = [
  CHANNELS.DECISIONS_GET_STATUS,
  CHANNELS.DECISIONS_GET_PANE_STATE,
  CHANNELS.DECISIONS_GET_QUESTION_CONTENT,
  CHANNELS.DECISIONS_GET_QUESTION_SUMMARIES,
  CHANNELS.DECISIONS_CANCEL_QUESTION,
  CHANNELS.DECISIONS_LIST_QUESTIONS,
  CHANNELS.DECISIONS_GET_QUESTION_CONTENT_BY_REFERENCE,
  CHANNELS.DECISIONS_GET_QUESTION_IMAGE_BY_REFERENCE,
  CHANNELS.DECISIONS_GET_QUESTION_SUMMARIES_BY_REFERENCE,
  CHANNELS.DECISIONS_CANCEL_QUESTION_BY_REFERENCE,
  CHANNELS.DECISIONS_MARK_QUESTIONS,
  CHANNELS.DECISIONS_ANSWER_QUESTION,
  CHANNELS.DECISIONS_GET_ANSWER_RESULT,
  CHANNELS.DECISIONS_DECLINE_QUESTION,
  CHANNELS.DECISIONS_GET_DECLINE_RESULT,
  CHANNELS.DECISIONS_SEND_FOLLOW_UP,
  CHANNELS.DECISIONS_GET_FOLLOW_UP_RESULT,
  CHANNELS.DECISIONS_SET_ENABLED,
  CHANNELS.DECISIONS_CHECK_RELAY,
  CHANNELS.DECISIONS_CLAIM_RELAY,
  CHANNELS.DECISIONS_PREPARE_RELAY_DEPLOY,
  CHANNELS.DECISIONS_CANCEL_RELAY_DEPLOY,
  CHANNELS.DECISIONS_CLAIM_DEPLOYED_RELAY,
  CHANNELS.DECISIONS_RESTORE_IDENTITY,
  CHANNELS.DECISIONS_DISCONNECT_RELAY,
  CHANNELS.DECISIONS_EXPORT_DATA,
  CHANNELS.DECISIONS_DELETE_RELAY_DATA,
  CHANNELS.DECISIONS_DELETE_LOCAL_DATA,
  CHANNELS.DECISIONS_GET_POLICY,
  CHANNELS.DECISIONS_SET_PROXY_ALLOWLISTED,
  CHANNELS.DECISIONS_SET_DEFAULT_QUESTION_EXPIRY,
  CHANNELS.DECISIONS_SET_TERMINAL_SNAPSHOTS,
  CHANNELS.DECISIONS_SET_HOLD_PHONE_PUSHES,
  CHANNELS.DECISIONS_SET_AGENT_STOPPED_PUSHES,
  CHANNELS.DECISIONS_EXPORT_RECOVERY_KIT,
  CHANNELS.DECISIONS_VERIFY_RECOVERY_KIT,
  CHANNELS.DECISIONS_LIST_HOSTS,
  CHANNELS.DECISIONS_ENROLL_HOST,
  CHANNELS.DECISIONS_SET_AUTO_ENROLL_HOSTS,
  CHANNELS.DECISIONS_START_SETUP_CHECK,
  CHANNELS.DECISIONS_GET_SETUP_CHECK,
  CHANNELS.DECISIONS_CANCEL_SETUP_CHECK,
  CHANNELS.DECISIONS_GET_MODEL,
  CHANNELS.DECISIONS_SET_MODEL,
  CHANNELS.DECISIONS_START_MODEL_EVALUATION,
  CHANNELS.DECISIONS_CANCEL_MODEL_EVALUATION,
  CHANNELS.DECISIONS_SET_MODEL_THRESHOLD,
  CHANNELS.DECISIONS_CLEAR_MODEL_HISTORY,
];

describe("decisions IPC", () => {
  beforeEach(() => {
    saved.value = undefined;
    saved.host = undefined;
    _resetDecisionsModuleForTesting();
    decisionsEntry.getDecisionsStatus.mockClear();
    decisionsEntry.getDecisionsPaneState.mockClear();
    decisionsEntry.getDecisionQuestionContent.mockClear();
    decisionsEntry.getDecisionQuestionSummaries.mockClear();
    decisionsEntry.cancelDecisionQuestion.mockClear();
    decisionsEntry.getDecisionQuestionImage.mockClear();
    decisionsEntry.getDecisionQuestionContentByReference.mockClear();
    decisionsEntry.getDecisionQuestionImageByReference.mockClear();
    decisionsEntry.getDecisionQuestionSummariesByReference.mockClear();
    decisionsEntry.cancelDecisionQuestionByReference.mockClear();
    decisionsEntry.markDecisionQuestions.mockClear();
    decisionsEntry.answerDecisionQuestion.mockClear();
    decisionsEntry.getDecisionAnswerResult.mockClear();
    decisionsEntry.declineDecisionQuestion.mockClear();
    decisionsEntry.getDecisionDeclineResult.mockClear();
    decisionsEntry.sendDecisionFollowUp.mockClear();
    decisionsEntry.getDecisionFollowUpResult.mockClear();
    decisionsEntry.getDecisionsInvolvement.mockClear();
    decisionsEntry.setDecisionsInvolvement.mockClear();
    decisionsEntry.setDecisionsEnabled.mockClear();
    decisionsEntry.checkRelay.mockClear();
    decisionsEntry.claimRelay.mockClear();
    decisionsEntry.prepareRelayDeploy.mockClear();
    decisionsEntry.cancelRelayDeploy.mockClear();
    decisionsEntry.claimDeployedRelay.mockClear();
    getVoiceSettings.mockClear();
    remoteViews.clear();
    decisionsEntry.restoreIdentity.mockClear();
    decisionsEntry.disconnectRelay.mockClear();
    decisionsEntry.exportData.mockClear();
    decisionsEntry.deleteRelayData.mockClear();
    decisionsEntry.deleteLocalData.mockClear();
    decisionsEntry.exportRecoveryKit.mockClear();
    decisionsEntry.verifyRecoveryKit.mockClear();
    dialogMock.showSaveDialog.mockClear();
    decisionsEntry.getDecisionsPolicy.mockClear();
    decisionsEntry.setDecisionsProxyAllowlisted.mockClear();
    decisionsEntry.setDecisionsDefaultQuestionExpiry.mockClear();
    decisionsEntry.setDecisionsTerminalSnapshots.mockClear();
    decisionsEntry.setDecisionsHoldPhonePushes.mockClear();
    decisionsEntry.setDecisionsAgentStoppedPushes.mockClear();
    decisionsEntry.revokeDevice.mockClear();
    decisionsEntry.rotateKeys.mockClear();
    decisionsEntry.startSetupCheck.mockClear();
    decisionsEntry.getSetupCheck.mockClear();
    decisionsEntry.cancelSetupCheck.mockClear();
    decisionsEntry.getDecisionsModel.mockClear();
    decisionsEntry.setDecisionsModel.mockClear();
    decisionsEntry.startDecisionsModelEvaluation.mockClear();
    decisionsEntry.cancelDecisionsModelEvaluation.mockClear();
    decisionsEntry.setDecisionsModelThreshold.mockClear();
    decisionsEntry.clearDecisionsModelHistory.mockClear();
    vi.mocked(store.set).mockClear();
  });
  afterEach(() => {
    _resetDecisionsModuleForTesting();
  });

  it("registers the reads and the switch, and removes them on cleanup", () => {
    const cleanup = registerDecisionsHandlers();
    for (const channel of DECISIONS_CHANNELS) {
      expect(ipcMainMock.handle).toHaveBeenCalledWith(channel, expect.any(Function));
    }

    cleanup();
    for (const channel of DECISIONS_CHANNELS) {
      expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(channel);
    }
  });

  // These run before the positive control below (vitest keeps declared order):
  // a module, once evaluated, stays evaluated.
  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
    ["a non-boolean switch", { enabled: "true" }],
  ])(
    "answers off from the store with the setting %s, loading none of Decisions",
    async (_label, value) => {
      saved.value = value;

      await expect(getStatus()).resolves.toEqual({ state: "off" });

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
      expect(store.set).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
    ["a non-boolean switch", { enabled: "true" }],
  ])(
    "reads no pane state with the setting %s, loading none of Decisions",
    async (_label, value) => {
      saved.value = value;

      await expect(getPaneState("pane-a")).resolves.toBeNull();

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
    ["a non-boolean switch", { enabled: "true" }],
  ])(
    "reads no question with the setting %s, saying it's off, loading none of Decisions",
    async (_label, value) => {
      saved.value = value;
      const ctx = { projectId: "project-1" };

      await expect(
        getQuestionContent(ctx, { terminalId: "pane-a", questionId: QUESTION_ID })
      ).resolves.toEqual({ result: "off" });
      await expect(
        getQuestionSummaries(ctx, { terminalId: "pane-a", questionIds: [QUESTION_ID] })
      ).resolves.toEqual({ result: "off" });
      await expect(
        getQuestionImage(ctx, {
          terminalId: "pane-a",
          questionId: QUESTION_ID,
          attachmentId: ATTACHMENT_ID,
          offset: 0,
        })
      ).resolves.toEqual({ result: "off" });

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
  ])(
    "cancels no question with the setting %s, saying it's off, loading none of Decisions",
    async (_label, value) => {
      saved.value = value;

      await expect(
        cancelQuestion(
          { projectId: "project-1" },
          { terminalId: "pane-a", questionId: QUESTION_ID }
        )
      ).resolves.toEqual({ result: "off" });

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  describe("this computer's questions while off (#17229)", () => {
    const REFERENCE: DecisionQuestionReference = {
      hostId: "host_1",
      projectId: "project-b",
      terminalId: "pane-closed",
      questionId: QUESTION_ID,
    };

    it("lists what Decisions last installed, loading none of it, whatever the switch says", async () => {
      const { setDecisionQuestions } = await import("../../../services/decisionsQuestionList.js");
      saved.value = { enabled: false };
      expect((await listQuestions()).questions).toEqual([]);

      const changed = setDecisionQuestions([
        {
          reference: REFERENCE,
          alias: 3,
          agentKind: "claude",
          projectLabel: null,
          worktreeId: "w1",
          worktreeRoot: "/repo",
          requirement: "human-required",
          askedAt: "2026-11-02T10:00:00.000Z",
          expiresAt: null,
          settledAt: null,
          standing: { kind: "waiting", reason: "open" },
          replyRequest: null,
          stall: null,
        },
      ]);
      // Whatever the switch reads now: the list is what Decisions last installed.
      await expect(listQuestions()).resolves.toBe(changed);
      saved.value = { enabled: true };
      await expect(listQuestions()).resolves.toBe(changed);
      setDecisionQuestions([]);

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    });

    it.each([
      ["absent", undefined],
      ["off", { enabled: false }],
    ])(
      "reads and cancels nothing by reference with the setting %s, saying it's off, loading none of Decisions",
      async (_label, value) => {
        saved.value = value;
        // An enrolled Host's own lifetime never opens this computer's list.
        saved.host = { deviceId: "dev_host_1", ownerOffAt: null, revokedAt: null };

        await expect(getQuestionContentByReference({ reference: REFERENCE })).resolves.toEqual({
          result: "off",
        });
        await expect(
          getQuestionImageByReference({
            reference: REFERENCE,
            attachmentId: ATTACHMENT_ID,
            offset: 0,
          })
        ).resolves.toEqual({ result: "off" });
        await expect(getQuestionSummariesByReference({ references: [REFERENCE] })).resolves.toEqual(
          { result: "off" }
        );
        await expect(cancelQuestionByReference({ reference: REFERENCE })).resolves.toEqual({
          result: "off",
        });
        await expect(
          markQuestions({ action: "clear", questions: [{ reference: REFERENCE, ask: null }] })
        ).resolves.toEqual({ result: "off" });

        expect(decisionsEntry.evaluated).toBe(0);
        expect(decisionsEntry.libraries).toBe(0);
      }
    );
  });

  it("cancels no question once quit has sealed the loader, without loading it", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(
      cancelQuestion({ projectId: "project-1" }, { terminalId: "pane-a", questionId: QUESTION_ID })
    ).resolves.toEqual({ result: "not-running" });

    expect(decisionsEntry.evaluated).toBe(0);
  });

  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
  ])(
    "signs and reads no person's answer with the setting %s, saying it's off, loading none of Decisions (#17101)",
    async (_label, value) => {
      saved.value = value;
      // An enrolled Host's own Decisions never signs the person's answer.
      saved.host = { deviceId: "dev_host_1", ownerOffAt: null, revokedAt: null };

      await expect(answerQuestion(ANSWER)).resolves.toEqual({ result: "off" });
      await expect(getAnswerResult({ answerId: ANSWER.answerId })).resolves.toEqual({
        result: "off",
      });
      await expect(sendFollowUp(FOLLOW_UP)).resolves.toEqual({ result: "off" });
      await expect(getFollowUpResult({ messageId: FOLLOW_UP.messageId })).resolves.toEqual({
        result: "off",
      });

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
  ])(
    "signs and reads no person's dismissal with the setting %s, saying it's off, loading none of Decisions (#17239)",
    async (_label, value) => {
      saved.value = value;

      await expect(declineQuestion(DECLINE)).resolves.toEqual({ result: "off" });
      await expect(getDeclineResult({ declineId: DECLINE.declineId })).resolves.toEqual({
        result: "off",
      });

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  it.each([
    [
      "serving its panes",
      { deviceId: "dev_host_1", ownerOffAt: null, revokedAt: null },
      "not-owner",
    ],
    ["turned off by its owner", { deviceId: "dev_host_1", ownerOffAt: 1, revokedAt: null }, "off"],
    ["revoked", { deviceId: "dev_host_1", ownerOffAt: null, revokedAt: 1 }, "off"],
  ] as const)(
    "on an enrolled Remote Host %s, says its key never signs a dismissal, loading none of Decisions (#17239)",
    async (_label, host, said) => {
      saved.value = { enabled: false };
      saved.host = host;

      await expect(declineQuestion(DECLINE)).resolves.toEqual(
        said === "not-owner" ? { result: "refused", reason: "not-owner" } : { result: "off" }
      );
      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  it("signs no person's dismissal once quit has sealed the loader, without loading it (#17239)", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(declineQuestion(DECLINE)).resolves.toEqual({ result: "not-running" });
    await expect(getDeclineResult({ declineId: DECLINE.declineId })).resolves.toEqual({
      result: "not-running",
    });
    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("signs no person's answer once quit has sealed the loader, without loading it (#17101)", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(answerQuestion(ANSWER)).resolves.toEqual({ result: "not-running" });
    await expect(getAnswerResult({ answerId: ANSWER.answerId })).resolves.toEqual({
      result: "not-running",
    });
    await expect(sendFollowUp(FOLLOW_UP)).resolves.toEqual({ result: "not-running" });
    await expect(getFollowUpResult({ messageId: FOLLOW_UP.messageId })).resolves.toEqual({
      result: "not-running",
    });
    expect(decisionsEntry.evaluated).toBe(0);
  });

  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
  ])(
    "reads and changes no involvement preference with the setting %s, saying it's off, loading none of Decisions (#17237)",
    async (_label, value) => {
      saved.value = value;

      await expect(getInvolvement()).resolves.toEqual({ result: "off" });
      await expect(setInvolvement(INVOLVEMENT_CHANGE)).resolves.toEqual({ result: "off" });

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  it.each([
    [
      "serving its panes",
      { deviceId: "dev_host_1", ownerOffAt: null, revokedAt: null },
      "not-owner",
    ],
    ["turned off by its owner", { deviceId: "dev_host_1", ownerOffAt: 1, revokedAt: null }, "off"],
    ["revoked", { deviceId: "dev_host_1", ownerOffAt: null, revokedAt: 1 }, "off"],
  ] as const)(
    "on an enrolled Remote Host %s, says its key never signs the involvement preference, loading none of Decisions (#17237)",
    async (_label, host, said) => {
      saved.value = { enabled: false };
      saved.host = host;

      await expect(setInvolvement(INVOLVEMENT_CHANGE)).resolves.toEqual(
        said === "not-owner" ? { result: "refused", reason: "not-owner" } : { result: "off" }
      );
      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  it("changes no involvement preference once quit has sealed the loader, without loading it (#17237)", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(getInvolvement()).resolves.toEqual({ result: "not-running" });
    await expect(setInvolvement(INVOLVEMENT_CHANGE)).resolves.toEqual({ result: "not-running" });
    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("reads no question once quit has sealed the loader, without loading it", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();
    const ctx = { projectId: "project-1" };

    await expect(
      getQuestionContent(ctx, { terminalId: "pane-a", questionId: QUESTION_ID })
    ).resolves.toEqual({ result: "not-running" });
    await expect(
      getQuestionSummaries(ctx, { terminalId: "pane-a", questionIds: [] })
    ).resolves.toEqual({ result: "not-running" });
    await expect(
      getQuestionImage(ctx, {
        terminalId: "pane-a",
        questionId: QUESTION_ID,
        attachmentId: ATTACHMENT_ID,
        offset: 0,
      })
    ).resolves.toEqual({ result: "not-running" });

    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("reads no pane state once quit has sealed the loader, without loading it", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(getPaneState("pane-a")).resolves.toBeNull();

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.getDecisionsPaneState).not.toHaveBeenCalled();
  });

  it("reports a saved consent time with the switch off, loading none of Decisions", async () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };

    await expect(getStatus()).resolves.toEqual({ state: "off", consentedAt: 1_761_955_200_000 });

    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("turns off with nothing on by answering from the store, loading none of Decisions", async () => {
    saved.value = { enabled: false };

    await expect(setEnabled({ enabled: false })).resolves.toEqual({ state: "off" });

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses to turn on before the person has agreed, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: false, consentedAt: "yes" }]) {
      saved.value = value;

      await expect(setEnabled({ enabled: true })).rejects.toThrow(/agree/);
      await expect(setEnabled({ enabled: true, consent: false })).rejects.toThrow(/agree/);
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses to check a relay while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(checkRelay("https://relay.example.com")).rejects.toMatchObject({
        code: "PERMISSION",
      });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("refuses to check a relay once quit has sealed the loader, without loading it", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(checkRelay("https://relay.example.com")).rejects.toMatchObject({
      code: "CANCELLED",
    });

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.checkRelay).not.toHaveBeenCalled();
  });

  it("refuses to claim, restore or disconnect while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(claimRelay(CLAIM)).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(restoreIdentity(RESTORE)).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(disconnectRelay(TYPED)).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("refuses a guided deploy and its claim while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(prepareRelayDeploy({ webContentsId: 1 })).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(claimDeployedRelay({ deployId: "deploy-1" })).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(cancelRelayDeploy("deploy-1")).resolves.toBeUndefined();
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("refuses a guided deploy from a window whose terminals run on a Remote Host", async () => {
    saved.value = { enabled: true };
    remoteViews.add(7);

    await expect(prepareRelayDeploy({ webContentsId: 7 })).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringMatching(/local project window/),
    });

    expect(decisionsEntry.evaluated).toBe(0);
    expect(getVoiceSettings).not.toHaveBeenCalled();
  });

  it("refuses to read the policy or change the allowlist while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(getPolicy()).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(setProxyAllowlisted(true)).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(setDefaultQuestionExpiry(null)).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(setAgentAskHuman({ agentId: "claude", enabled: true })).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(setTerminalSnapshots({ enabled: true, consent: true })).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(setHoldPhonePushes(false)).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(setAgentStoppedPushes(true)).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(setAgentStoppedPushes(false)).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses every decision model op while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(getModel()).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(
        setModel({ learning: true, adapter: "claude", consent: true })
      ).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(startModelEvaluation()).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(cancelModelEvaluation({ runId: "run-1" })).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(
        setModelThreshold({ threshold: 0.8, evaluatedAt: 1_761_955_200_000 })
      ).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(clearModelHistory()).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses to save or verify a recovery kit while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }]) {
      saved.value = value;

      await expect(
        exportRecoveryKit({ senderWindow: null }, { passphrase: PASSPHRASE })
      ).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(
        verifyRecoveryKit({ kit: '{"v":1}', passphrase: PASSPHRASE })
      ).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(dialogMock.showSaveDialog).not.toHaveBeenCalled();
  });

  it("refuses to save or verify a recovery kit once quit has sealed the loader", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(
      exportRecoveryKit({ senderWindow: null }, { passphrase: PASSPHRASE })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      verifyRecoveryKit({ kit: '{"v":1}', passphrase: PASSPHRASE })
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("refuses to revoke a device or rotate the keys while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }]) {
      saved.value = value;

      await expect(revokeDevice("dev_phone_1")).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(rotateKeys()).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("refuses to list, enroll or change how Remote Hosts are enrolled while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(listHosts()).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(enrollHost({ hostId: "studio" })).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(setAutoEnrollHosts(false)).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses to check setup while off, and reads or cancels nothing, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }]) {
      saved.value = value;

      await expect(startSetupCheck()).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(getSetupCheck()).resolves.toBeNull();
      await expect(cancelSetupCheck({ runId: "run-1" })).resolves.toBeNull();
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("refuses to claim, restore or disconnect once quit has sealed the loader", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(claimRelay(CLAIM)).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(restoreIdentity(RESTORE)).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(disconnectRelay(TYPED)).rejects.toMatchObject({ code: "CANCELLED" });

    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("refuses to export or delete data while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(exportData({ senderWindow: null }, EXPORT)).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(deleteRelayData({ origin: RELAY_ORIGIN })).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(deleteLocalData(TYPED)).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(dialogMock.showSaveDialog).not.toHaveBeenCalled();
  });

  it("refuses to export or delete data once quit has sealed the loader", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(exportData({ senderWindow: null }, EXPORT)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(deleteRelayData({ origin: RELAY_ORIGIN })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(deleteLocalData(TYPED)).rejects.toMatchObject({ code: "CANCELLED" });

    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("answers off once quit has sealed the loader, without loading it", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(getStatus()).resolves.toEqual({ state: "off" });

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("hands each decision model op to Decisions itself once on", async () => {
    saved.value = { enabled: true };
    const preferences = { learning: true, adapter: "codex", consent: true };
    const threshold = { threshold: 0.8, evaluatedAt: 1_761_955_200_000 };

    await getModel();
    await setModel(preferences);
    await startModelEvaluation();
    await cancelModelEvaluation({ runId: "run-1" });
    await setModelThreshold(threshold);
    await clearModelHistory();

    expect(decisionsEntry.getDecisionsModel).toHaveBeenCalledOnce();
    expect(decisionsEntry.setDecisionsModel).toHaveBeenCalledExactlyOnceWith(preferences);
    expect(decisionsEntry.startDecisionsModelEvaluation).toHaveBeenCalledOnce();
    expect(decisionsEntry.cancelDecisionsModelEvaluation).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
    });
    expect(decisionsEntry.setDecisionsModelThreshold).toHaveBeenCalledExactlyOnceWith(threshold);
    expect(decisionsEntry.clearDecisionsModelHistory).toHaveBeenCalledOnce();
    // The settings are Decisions' own to write, behind its transitions.
    expect(store.set).not.toHaveBeenCalled();
  });

  it("takes how a key erasure was confirmed, and nothing else (#18064)", () => {
    for (const op of [
      decisionsNamespace.ops.disconnectRelay,
      decisionsNamespace.ops.deleteLocalData,
    ]) {
      const schema = op.schema as SafeParse;
      expect(schema.safeParse({ oneClick: true, relayOrigin: RELAY_ORIGIN }).success).toBe(true);
      expect(schema.safeParse({ oneClick: false, relayOrigin: null }).success).toBe(true);
      for (const value of [
        undefined,
        {},
        { oneClick: true },
        { oneClick: "yes", relayOrigin: null },
        { oneClick: true, relayOrigin: 42 },
        { oneClick: true, relayOrigin: null, origin: "x" },
      ]) {
        expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
      }
    }
  });

  it("takes only the model's own preferences, a confidence for an evaluation, and a run id", () => {
    const setSchema = decisionsNamespace.ops.setModel.schema as SafeParse;
    for (const value of [
      { learning: false, adapter: null },
      { learning: true, adapter: "claude", consent: true },
      { learning: true, adapter: "gemini" },
    ]) {
      expect(setSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
    for (const value of [
      undefined,
      { learning: true },
      { learning: "true", adapter: null },
      { learning: true, adapter: "openai" },
      { learning: true, adapter: "claude", consent: "yes" },
      { learning: true, adapter: "claude", modelConsentedAt: 1 },
      { learning: true, adapter: "claude", command: "sh" },
    ]) {
      expect(setSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    const thresholdSchema = decisionsNamespace.ops.setModelThreshold.schema as SafeParse;
    for (const value of [
      { threshold: 0.8, evaluatedAt: 1_761_955_200_000 },
      { threshold: null, evaluatedAt: 1_761_955_200_000 },
      { threshold: 0, evaluatedAt: 1 },
    ]) {
      expect(thresholdSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
    for (const value of [
      { threshold: 1.2, evaluatedAt: 1 },
      { threshold: -0.1, evaluatedAt: 1 },
      { threshold: Number.NaN, evaluatedAt: 1 },
      { threshold: 0.8 },
      { threshold: 0.8, evaluatedAt: 0 },
      { threshold: 0.8, evaluatedAt: 1.5 },
      { threshold: 0.8, evaluatedAt: 1, calibration: {} },
    ]) {
      expect(thresholdSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    const cancelSchema = decisionsNamespace.ops.cancelModelEvaluation.schema as SafeParse;
    expect(cancelSchema.safeParse({ runId: "run-1" }).success).toBe(true);
    for (const value of [{}, { runId: "" }, { runId: "x".repeat(65) }, "run-1"]) {
      expect(cancelSchema.safeParse(value).success).toBe(false);
    }
  });

  it("asks Decisions itself once the setting is on, loading its entry once", async () => {
    saved.value = { enabled: true };
    decisionsEntry.getDecisionsStatus
      .mockResolvedValueOnce({ state: "not-connected" })
      .mockResolvedValueOnce({ state: "revoked" });

    await expect(getStatus()).resolves.toEqual({ state: "not-connected" });
    await expect(getStatus()).resolves.toEqual({ state: "revoked" });

    expect(decisionsEntry.evaluated).toBe(1);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("runs, reads and cancels the setup check through Decisions itself once the setting is on", async () => {
    saved.value = { enabled: true };
    const running = { runId: "run-1", revision: 3, state: "running" };
    const cancelled = { runId: "run-1", revision: 4, state: "cancelled" };
    decisionsEntry.startSetupCheck.mockResolvedValueOnce({ result: "started", run: running });
    decisionsEntry.getSetupCheck.mockReturnValueOnce(running);
    decisionsEntry.cancelSetupCheck.mockResolvedValueOnce(cancelled);

    await expect(startSetupCheck()).resolves.toEqual({ result: "started", run: running });
    await expect(getSetupCheck()).resolves.toEqual(running);
    await expect(cancelSetupCheck({ runId: "run-1" })).resolves.toEqual(cancelled);

    expect(decisionsEntry.cancelSetupCheck).toHaveBeenCalledExactlyOnceWith({ runId: "run-1" });
  });

  it("takes only a bounded run id to cancel", () => {
    const schema = decisionsNamespace.ops.cancelSetupCheck.schema as SafeParse;
    expect(schema.safeParse({ runId: "0b8c7a2e-0f3d-4c8b-9a51-2f0e6d1c9b7a" }).success).toBe(true);
    for (const bad of [
      {},
      { runId: "" },
      { runId: "x".repeat(65) },
      { runId: 7 },
      { runId: "a", extra: 1 },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("asks Decisions itself for a pane's state once the setting is on", async () => {
    saved.value = { enabled: true };
    const state: PaneDecisionState = {
      terminalId: "pane-a",
      openQuestions: [],
      waitingAnswers: [],
      needsAttention: [],
      revision: 4,
    };
    decisionsEntry.getDecisionsPaneState.mockReturnValueOnce(state);

    await expect(getPaneState("pane-a")).resolves.toBe(state);
    await expect(getPaneState("pane-b")).resolves.toBeNull();

    expect(decisionsEntry.getDecisionsPaneState.mock.calls).toEqual([["pane-a"], ["pane-b"]]);
  });

  it("reads a question for the asking view's own project once the setting is on", async () => {
    saved.value = { enabled: true };
    const payload = { terminalId: "pane-a", questionId: QUESTION_ID };
    const summaries = { terminalId: "pane-a", questionIds: [QUESTION_ID] };

    await expect(getQuestionContent({ projectId: "project-1" }, payload)).resolves.toEqual({
      result: "not-found",
    });
    await expect(getQuestionSummaries({ projectId: null }, summaries)).resolves.toEqual({
      result: "read",
      summaries: [],
    });

    expect(decisionsEntry.getDecisionQuestionContent).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      payload
    );
    expect(decisionsEntry.getDecisionQuestionSummaries).toHaveBeenCalledExactlyOnceWith(
      null,
      summaries
    );
  });

  it("cancels a question for the asking view's own project once the setting is on, passing on what main says", async () => {
    saved.value = { enabled: true };
    const payload = { terminalId: "pane-a", questionId: QUESTION_ID };
    decisionsEntry.cancelDecisionQuestion.mockResolvedValueOnce({
      result: "refused",
      reason: "answered",
    });

    await expect(cancelQuestion({ projectId: "project-1" }, payload)).resolves.toEqual({
      result: "refused",
      reason: "answered",
    });
    await expect(cancelQuestion({ projectId: null }, payload)).resolves.toEqual({
      result: "cancelling",
    });

    expect(decisionsEntry.cancelDecisionQuestion.mock.calls).toEqual([
      ["project-1", payload],
      [null, payload],
    ]);
  });

  it("cancels a question on an enrolled Host, whatever the owner's switch says there", async () => {
    saved.value = { enabled: false };
    saved.host = { deviceId: "dev_host_1", ownerOffAt: null, revokedAt: null };
    const payload = { terminalId: "pane-a", questionId: QUESTION_ID };

    await expect(cancelQuestion({ projectId: "project-1" }, payload)).resolves.toEqual({
      result: "cancelling",
    });
    expect(decisionsEntry.cancelDecisionQuestion).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      payload
    );

    // A revoked Host serves no panes, so nothing more reaches Decisions.
    saved.host = { deviceId: "dev_host_1", ownerOffAt: null, revokedAt: 1 };
    await expect(cancelQuestion({ projectId: "project-1" }, payload)).resolves.toEqual({
      result: "off",
    });
    expect(decisionsEntry.cancelDecisionQuestion).toHaveBeenCalledTimes(1);
  });

  describe("this computer's questions, by reference (#17229)", () => {
    const REFERENCE: DecisionQuestionReference = {
      hostId: "host_1",
      projectId: "project-b",
      terminalId: "pane-closed",
      questionId: QUESTION_ID,
    };

    it("passes the reference to Decisions once on, with no view's project in it", async () => {
      saved.value = { enabled: true };
      const image = { reference: REFERENCE, attachmentId: ATTACHMENT_ID, offset: 0 };
      const content: DecisionQuestionContentResult = { result: "unreadable" };
      const part: DecisionQuestionImagePartResult = {
        result: "unavailable",
        reason: "fetch-failed",
      };
      const summaries: DecisionQuestionSummariesResult = {
        result: "read",
        summaries: [{ questionId: QUESTION_ID, result: "read", line: "Ship it?" }],
      };
      const cancel: DecisionQuestionCancelResult = { result: "refused", reason: "answered" };
      decisionsEntry.getDecisionQuestionContentByReference.mockResolvedValueOnce(content);
      decisionsEntry.getDecisionQuestionImageByReference.mockResolvedValueOnce(part);
      decisionsEntry.getDecisionQuestionSummariesByReference.mockResolvedValueOnce(summaries);
      decisionsEntry.cancelDecisionQuestionByReference.mockResolvedValueOnce(cancel);

      await expect(getQuestionContentByReference({ reference: REFERENCE })).resolves.toBe(content);
      await expect(getQuestionImageByReference(image)).resolves.toBe(part);
      await expect(getQuestionSummariesByReference({ references: [REFERENCE] })).resolves.toBe(
        summaries
      );
      await expect(cancelQuestionByReference({ reference: REFERENCE })).resolves.toBe(cancel);

      expect(decisionsEntry.getDecisionQuestionContentByReference).toHaveBeenCalledExactlyOnceWith({
        reference: REFERENCE,
      });
      expect(decisionsEntry.getDecisionQuestionImageByReference).toHaveBeenCalledExactlyOnceWith(
        image
      );
      expect(
        decisionsEntry.getDecisionQuestionSummariesByReference
      ).toHaveBeenCalledExactlyOnceWith({ references: [REFERENCE] });
      expect(decisionsEntry.cancelDecisionQuestionByReference).toHaveBeenCalledExactlyOnceWith({
        reference: REFERENCE,
      });
    });

    it("hands the person's marks to Decisions once on, as they were sent (#17895)", async () => {
      saved.value = { enabled: true };
      const payload: MarkDecisionQuestionsPayload = {
        action: "seen",
        questions: [{ reference: REFERENCE, ask: "msg_agent_0001" }],
      };
      const marked: DecisionQuestionMarkResult = { result: "marked", marked: 1 };
      decisionsEntry.markDecisionQuestions.mockResolvedValueOnce(marked);
      await expect(markQuestions(payload)).resolves.toBe(marked);
      expect(decisionsEntry.markDecisionQuestions).toHaveBeenCalledExactlyOnceWith(payload);
    });

    it("takes marks for whole references, a page at a time, and nothing else (#17895)", () => {
      const schema = decisionsNamespace.ops.markQuestions.schema as SafeParse;
      const one = { reference: REFERENCE, ask: null };
      for (const action of ["seen", "clear", "restore"]) {
        expect(schema.safeParse({ action, questions: [one] }).success).toBe(true);
      }
      expect(
        schema.safeParse({
          action: "clear",
          questions: Array(DECISION_QUESTION_MARKS_PER_CALL).fill(one),
        }).success
      ).toBe(true);
      for (const bad of [
        { action: "clear", questions: [] },
        { action: "clear", questions: Array(DECISION_QUESTION_MARKS_PER_CALL + 1).fill(one) },
        { action: "answer", questions: [one] },
        { action: "clear", questions: [{ reference: REFERENCE }] },
        { action: "clear", questions: [{ ...one, ask: "" }] },
        { action: "clear", questions: [{ ...one, extra: 1 }] },
        {
          action: "clear",
          questions: [{ reference: { ...REFERENCE, questionId: "../q" }, ask: null }],
        },
        { action: "clear", questions: [one], projectId: "project-2" },
      ]) {
        expect(schema.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
      }
    });

    it("takes a whole reference and nothing else", () => {
      const content = decisionsNamespace.ops.getQuestionContentByReference.schema as SafeParse;
      const cancel = decisionsNamespace.ops.cancelQuestionByReference.schema as SafeParse;
      const image = decisionsNamespace.ops.getQuestionImageByReference.schema as SafeParse;
      const summaries = decisionsNamespace.ops.getQuestionSummariesByReference.schema as SafeParse;
      for (const schema of [content, cancel]) {
        expect(schema.safeParse({ reference: REFERENCE }).success).toBe(true);
        for (const bad of [
          {},
          REFERENCE,
          { reference: { ...REFERENCE, hostId: "" } },
          { reference: { ...REFERENCE, projectId: "" } },
          { reference: { ...REFERENCE, terminalId: "" } },
          { reference: { ...REFERENCE, questionId: "../q" } },
          { reference: { ...REFERENCE, extra: 1 } },
          { reference: REFERENCE, projectId: "project-2" },
        ]) {
          expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
        }
      }
      expect(
        image.safeParse({ reference: REFERENCE, attachmentId: ATTACHMENT_ID, offset: 0 }).success
      ).toBe(true);
      expect(
        image.safeParse({ reference: REFERENCE, attachmentId: "../a", offset: 0 }).success
      ).toBe(false);
      expect(summaries.safeParse({ references: Array(64).fill(REFERENCE) }).success).toBe(true);
      expect(summaries.safeParse({ references: Array(65).fill(REFERENCE) }).success).toBe(false);
    });
  });

  describe("the person's answer (#17101)", () => {
    it("passes the answer to Decisions once on, and hands back what it says", async () => {
      saved.value = { enabled: true };
      const refused: DecisionQuestionAnswerResult = { result: "refused", reason: "not-owner" };
      const read: DecisionAnswerResultRead = {
        result: "read",
        questionId: QUESTION_ID,
        expectedRevision: 0,
        outcome: { status: "unsupported", by: "relay" },
      };
      decisionsEntry.answerDecisionQuestion.mockResolvedValueOnce(refused);
      decisionsEntry.getDecisionAnswerResult.mockResolvedValueOnce(read);

      await expect(answerQuestion(ANSWER)).resolves.toBe(refused);
      await expect(getAnswerResult({ answerId: ANSWER.answerId })).resolves.toBe(read);

      expect(decisionsEntry.answerDecisionQuestion).toHaveBeenCalledExactlyOnceWith(ANSWER);
      expect(decisionsEntry.getDecisionAnswerResult).toHaveBeenCalledExactlyOnceWith({
        answerId: ANSWER.answerId,
      });
    });

    it("takes a whole reference, an answer id and the answer's fields within the protocol's bounds, and nothing else", () => {
      const answer = decisionsNamespace.ops.answerQuestion.schema as SafeParse;
      const result = decisionsNamespace.ops.getAnswerResult.schema as SafeParse;
      expect(answer.safeParse(ANSWER).success).toBe(true);
      expect(
        answer.safeParse({
          ...ANSWER,
          answerId: "a".repeat(64),
          expectedRevision: Number.MAX_SAFE_INTEGER,
          selectedOptionIds: Array(12).fill("x".repeat(64)),
          text: "x".repeat(16 * 1024),
          reason: "x".repeat(2_000),
          reviewedAttachmentDigests: Array(8).fill("a".repeat(64)),
        }).success
      ).toBe(true);
      expect(answer.safeParse({ ...ANSWER, selectedOptionIds: [] }).success).toBe(true);
      for (const bad of [
        {},
        { ...ANSWER, reference: undefined },
        { ...ANSWER, reference: { ...ANSWER.reference, questionId: "../q" } },
        { ...ANSWER, reference: { ...ANSWER.reference, hostId: "" } },
        { ...ANSWER, answerId: undefined },
        { ...ANSWER, answerId: "short" },
        { ...ANSWER, answerId: "a".repeat(65) },
        { ...ANSWER, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
        { ...ANSWER, selectedOptionIds: [""] },
        { ...ANSWER, answerId: "has spaces in it" },
        { ...ANSWER, expectedRevision: -1 },
        { ...ANSWER, expectedRevision: 1.5 },
        { ...ANSWER, selectedOptionIds: Array(13).fill("a") },
        { ...ANSWER, selectedOptionIds: ["x".repeat(65)] },
        { ...ANSWER, text: "x".repeat(16 * 1024 + 1) },
        { ...ANSWER, reason: "x".repeat(2_001) },
        { ...ANSWER, reviewedAttachmentDigests: ["A".repeat(64)] },
        { ...ANSWER, reviewedAttachmentDigests: Array(9).fill("a".repeat(64)) },
        { ...ANSWER, source: "person" },
        { ...ANSWER, provenance: "human-desktop" },
      ]) {
        expect(answer.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
      }
      expect(result.safeParse({ answerId: ANSWER.answerId }).success).toBe(true);
      for (const bad of [{}, { answerId: "../x" }, { answerId: ANSWER.answerId, extra: 1 }]) {
        expect(result.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe("the person's dismissal (#17239)", () => {
    it("passes the dismissal to Decisions once on, and hands back what it says", async () => {
      saved.value = { enabled: true };
      const refused: DecisionQuestionDeclineResult = { result: "refused", reason: "not-owner" };
      const read: DecisionDeclineResultRead = {
        result: "read",
        questionId: QUESTION_ID,
        expectedRevision: 0,
        outcome: { status: "unsupported", by: "asking-desktop" },
      };
      decisionsEntry.declineDecisionQuestion.mockResolvedValueOnce(refused);
      decisionsEntry.getDecisionDeclineResult.mockResolvedValueOnce(read);

      await expect(declineQuestion(DECLINE)).resolves.toBe(refused);
      await expect(getDeclineResult({ declineId: DECLINE.declineId })).resolves.toBe(read);

      expect(decisionsEntry.declineDecisionQuestion).toHaveBeenCalledExactlyOnceWith(DECLINE);
      expect(decisionsEntry.getDecisionDeclineResult).toHaveBeenCalledExactlyOnceWith({
        declineId: DECLINE.declineId,
      });
    });

    it("takes a whole reference, a decline id and a revision, and nothing else", () => {
      const decline = decisionsNamespace.ops.declineQuestion.schema as SafeParse;
      const result = decisionsNamespace.ops.getDeclineResult.schema as SafeParse;
      expect(decline.safeParse(DECLINE).success).toBe(true);
      expect(
        decline.safeParse({
          ...DECLINE,
          declineId: "a".repeat(64),
          expectedRevision: Number.MAX_SAFE_INTEGER,
        }).success
      ).toBe(true);
      for (const bad of [
        {},
        { ...DECLINE, reference: undefined },
        { ...DECLINE, reference: { ...DECLINE.reference, questionId: "../q" } },
        { ...DECLINE, reference: { ...DECLINE.reference, hostId: "" } },
        { ...DECLINE, declineId: undefined },
        { ...DECLINE, declineId: "short" },
        { ...DECLINE, declineId: "a".repeat(65) },
        { ...DECLINE, declineId: "has spaces in it" },
        { ...DECLINE, expectedRevision: undefined },
        { ...DECLINE, expectedRevision: -1 },
        { ...DECLINE, expectedRevision: 1.5 },
        { ...DECLINE, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
        // A decline carries no words and says nothing of who signs it.
        { ...DECLINE, text: "not now" },
        { ...DECLINE, decline: true },
        { ...DECLINE, signerDeviceId: "dev_owner" },
      ]) {
        expect(decline.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
      }
      expect(result.safeParse({ declineId: DECLINE.declineId }).success).toBe(true);
      for (const bad of [{}, { declineId: "../x" }, { declineId: DECLINE.declineId, extra: 1 }]) {
        expect(result.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe("the person's follow-up (#17238)", () => {
    it("passes the follow-up to Decisions once on, and hands back what it says", async () => {
      saved.value = { enabled: true };
      const refused: DecisionQuestionFollowUpResult = { result: "refused", reason: "not-owner" };
      const read: DecisionFollowUpResultRead = {
        result: "read",
        questionId: QUESTION_ID,
        outcome: { status: "unsupported", by: "asking-desktop" },
      };
      decisionsEntry.sendDecisionFollowUp.mockResolvedValueOnce(refused);
      decisionsEntry.getDecisionFollowUpResult.mockResolvedValueOnce(read);

      await expect(sendFollowUp(FOLLOW_UP)).resolves.toBe(refused);
      await expect(getFollowUpResult({ messageId: FOLLOW_UP.messageId })).resolves.toBe(read);

      expect(decisionsEntry.sendDecisionFollowUp).toHaveBeenCalledExactlyOnceWith(FOLLOW_UP);
      expect(decisionsEntry.getDecisionFollowUpResult).toHaveBeenCalledExactlyOnceWith({
        messageId: FOLLOW_UP.messageId,
      });
    });

    it("takes a whole reference, a message id and words within the protocol's bound, and nothing else", () => {
      const send = decisionsNamespace.ops.sendFollowUp.schema as SafeParse;
      const result = decisionsNamespace.ops.getFollowUpResult.schema as SafeParse;
      expect(send.safeParse(FOLLOW_UP).success).toBe(true);
      expect(
        send.safeParse({ ...FOLLOW_UP, messageId: "a".repeat(64), text: "x".repeat(16 * 1024) })
          .success
      ).toBe(true);
      for (const bad of [
        {},
        { ...FOLLOW_UP, reference: undefined },
        { ...FOLLOW_UP, reference: { ...FOLLOW_UP.reference, questionId: "../q" } },
        { ...FOLLOW_UP, messageId: undefined },
        { ...FOLLOW_UP, messageId: "short" },
        { ...FOLLOW_UP, messageId: "has spaces in it" },
        { ...FOLLOW_UP, text: undefined },
        { ...FOLLOW_UP, text: "" },
        { ...FOLLOW_UP, text: " \n\t" },
        { ...FOLLOW_UP, text: "x".repeat(16 * 1024 + 1) },
        // Only words: never a reply request, images or a signer of its own.
        { ...FOLLOW_UP, expectsReply: true },
        { ...FOLLOW_UP, images: [] },
        { ...FOLLOW_UP, signerDeviceId: "dev_phone_1" },
      ]) {
        expect(send.safeParse(bad).success, JSON.stringify(bad).slice(0, 120)).toBe(false);
      }
      expect(result.safeParse({ messageId: FOLLOW_UP.messageId }).success).toBe(true);
      for (const bad of [{}, { messageId: "../x" }, { messageId: FOLLOW_UP.messageId, extra: 1 }]) {
        expect(result.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe("the person's involvement preference (#17237)", () => {
    it("passes the read and the change to Decisions once on, and hands back what it says", async () => {
      saved.value = { enabled: true };
      const conflict: DecisionsInvolvementSaveResult = { result: "conflict", latestRevision: 5 };
      const read: DecisionsInvolvementRead = {
        result: "read",
        role: "owner",
        settable: true,
        preference: {
          status: "unavailable",
          reason: "not-set",
          revision: 7,
          lastSyncedAt: "2026-11-18T09:00:00.000Z",
          stale: false,
        },
      };
      decisionsEntry.getDecisionsInvolvement.mockResolvedValueOnce(read);
      decisionsEntry.setDecisionsInvolvement.mockResolvedValueOnce(conflict);

      await expect(getInvolvement()).resolves.toBe(read);
      await expect(setInvolvement(INVOLVEMENT_CHANGE)).resolves.toBe(conflict);

      expect(decisionsEntry.getDecisionsInvolvement).toHaveBeenCalledOnce();
      expect(decisionsEntry.setDecisionsInvolvement).toHaveBeenCalledExactlyOnceWith(
        INVOLVEMENT_CHANGE
      );
    });

    it("takes a change within the library's bounds, and nothing else", () => {
      const schema = decisionsNamespace.ops.setInvolvement.schema as SafeParse;
      expect(schema.safeParse(INVOLVEMENT_CHANGE).success).toBe(true);
      for (const good of [
        { ...INVOLVEMENT_CHANGE, override: null },
        { ...INVOLVEMENT_CHANGE, consultCount: 1 },
        { ...INVOLVEMENT_CHANGE, consultCount: 8 },
        { ...INVOLVEMENT_CHANGE, expectedRevision: 0 },
        { ...INVOLVEMENT_CHANGE, expectedRevision: Number.MAX_SAFE_INTEGER - 1 },
        { ...INVOLVEMENT_CHANGE, normalMode: "involve-early" },
        {
          ...INVOLVEMENT_CHANGE,
          override: { mode: "recommend", until: "2026-11-18T17:00:00.123Z" },
        },
      ]) {
        expect(schema.safeParse(good).success, JSON.stringify(good)).toBe(true);
      }
      for (const bad of [
        {},
        { ...INVOLVEMENT_CHANGE, consultCount: 0 },
        { ...INVOLVEMENT_CHANGE, consultCount: 9 },
        { ...INVOLVEMENT_CHANGE, consultCount: 1.5 },
        { ...INVOLVEMENT_CHANGE, expectedRevision: -1 },
        { ...INVOLVEMENT_CHANGE, expectedRevision: Number.MAX_SAFE_INTEGER },
        { ...INVOLVEMENT_CHANGE, expectedRevision: 2.5 },
        { ...INVOLVEMENT_CHANGE, override: { mode: "ask", until: "2026-11-18T17:00:00.000Z" } },
        { ...INVOLVEMENT_CHANGE, override: { mode: "recommend" } },
        { ...INVOLVEMENT_CHANGE, normalMode: "ask" },
        { ...INVOLVEMENT_CHANGE, override: undefined },
        { ...INVOLVEMENT_CHANGE, override: { mode: "recommend", until: "2026-11-18T17:00:00Z" } },
        {
          ...INVOLVEMENT_CHANGE,
          override: { mode: "recommend", until: "2026-11-18T17:00:00.000+01:00" },
        },
        { ...INVOLVEMENT_CHANGE, override: { ...INVOLVEMENT_CHANGE.override, extra: 1 } },
        { ...INVOLVEMENT_CHANGE, setOn: "computer" },
        { ...INVOLVEMENT_CHANGE, revision: 4 },
      ]) {
        expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });
  });

  it("takes only a pane and a question id to cancel, never a project", () => {
    const cancel = decisionsNamespace.ops.cancelQuestion.schema as SafeParse;
    expect(cancel.safeParse({ terminalId: "pane-a", questionId: QUESTION_ID }).success).toBe(true);
    for (const bad of [
      {},
      { terminalId: "pane-a" },
      { questionId: QUESTION_ID },
      { terminalId: "", questionId: QUESTION_ID },
      { terminalId: "x".repeat(257), questionId: QUESTION_ID },
      { terminalId: "pane-a", questionId: "q_short" },
      { terminalId: "pane-a", questionId: "../q" },
      { terminalId: "pane-a", questionId: QUESTION_ID, projectId: "project-2" },
    ]) {
      expect(cancel.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("reads a question's image for the asking view's own project once the setting is on", async () => {
    saved.value = { enabled: true };
    const payload = {
      terminalId: "pane-a",
      questionId: QUESTION_ID,
      attachmentId: ATTACHMENT_ID,
      offset: 0,
    };
    const image: DecisionQuestionImagePartResult = {
      result: "read",
      part: {
        attachmentId: ATTACHMENT_ID,
        mime: "image/png",
        sha256: "b".repeat(64),
        size: 3,
        offset: 0,
        bytes: new Uint8Array([1, 2, 3]),
      },
    };
    decisionsEntry.getDecisionQuestionImage.mockResolvedValueOnce(image);

    await expect(getQuestionImage({ projectId: "project-1" }, payload)).resolves.toBe(image);

    expect(decisionsEntry.getDecisionQuestionImage).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      payload
    );
  });

  it("takes only a pane, a question, an attachment and an offset in it for an image, never a project", () => {
    const image = decisionsNamespace.ops.getQuestionImage.schema as SafeParse;
    const ok = { terminalId: "pane-a", questionId: QUESTION_ID, attachmentId: ATTACHMENT_ID };
    expect(image.safeParse({ ...ok, offset: 0 }).success).toBe(true);
    expect(image.safeParse({ ...ok, offset: 20 * 1024 * 1024 }).success).toBe(true);
    for (const bad of [
      ok,
      { ...ok, offset: -1 },
      { ...ok, offset: 1.5 },
      { ...ok, offset: 20 * 1024 * 1024 + 1 },
      { ...ok, offset: 0, attachmentId: "short" },
      { ...ok, offset: 0, attachmentId: "../attach_0001" },
      { ...ok, offset: 0, attachmentId: "a".repeat(65) },
      { ...ok, offset: 0, questionId: "../q" },
      { ...ok, offset: 0, projectId: "project-2" },
    ]) {
      expect(image.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes only a pane and bounded question ids, never a project", () => {
    const content = decisionsNamespace.ops.getQuestionContent.schema as SafeParse;
    const summaries = decisionsNamespace.ops.getQuestionSummaries.schema as SafeParse;
    expect(content.safeParse({ terminalId: "pane-a", questionId: QUESTION_ID }).success).toBe(true);
    expect(
      summaries.safeParse({ terminalId: "pane-a", questionIds: Array(64).fill(QUESTION_ID) })
        .success
    ).toBe(true);
    for (const bad of [
      {},
      { terminalId: "", questionId: QUESTION_ID },
      { terminalId: "pane-a", questionId: "../q" },
      { terminalId: "pane-a", questionId: QUESTION_ID, projectId: "project-2" },
    ]) {
      expect(content.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [
      { terminalId: "pane-a" },
      { terminalId: "pane-a", questionIds: Array(65).fill(QUESTION_ID) },
      { terminalId: "pane-a", questionIds: ["q 1"] },
      { terminalId: "pane-a", questionIds: [], projectId: "project-2" },
    ]) {
      expect(summaries.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("checks a relay through Decisions itself once the setting is on", async () => {
    saved.value = { enabled: true };
    const observed: DecisionsRelayCheck = {
      result: "unreachable",
      origin: "https://relay.example.com",
      endpoint: "health",
      reason: "dns",
    };
    decisionsEntry.checkRelay.mockResolvedValueOnce(observed);

    await expect(checkRelay("relay.example.com")).resolves.toBe(observed);

    expect(decisionsEntry.checkRelay).toHaveBeenCalledExactlyOnceWith("relay.example.com");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("takes only a bounded string as the relay URL", () => {
    const schema = decisionsNamespace.ops.checkRelay.schema as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(schema.safeParse("https://relay.example.com").success).toBe(true);
    for (const value of [undefined, 42, { url: "https://relay.example.com" }, "x".repeat(2049)]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("opens a guided deploy's channel with the voice settings reader, reading nothing yet", async () => {
    saved.value = { enabled: true };

    await expect(prepareRelayDeploy({ webContentsId: 1 })).resolves.toEqual({
      id: "deploy-1",
      hostChannel: "/tmp/daintree-deploy-AbC123/host.sock",
    });

    expect(decisionsEntry.prepareRelayDeploy).toHaveBeenCalledExactlyOnceWith(getVoiceSettings);
    expect(getVoiceSettings).not.toHaveBeenCalled();
  });

  it("cancels a deploy and claims its relay through Decisions itself", async () => {
    saved.value = { enabled: true };
    const payload = { deployId: "deploy-1", acceptWeakStorage: true };

    await cancelRelayDeploy("deploy-1");
    await expect(claimDeployedRelay(payload)).resolves.toMatchObject({ result: "saved" });

    expect(decisionsEntry.cancelRelayDeploy).toHaveBeenCalledExactlyOnceWith("deploy-1");
    expect(decisionsEntry.claimDeployedRelay).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("takes only a deploy id, never a secret, to claim a deployed relay", () => {
    const schema = decisionsNamespace.ops.claimDeployedRelay.schema as SafeParse;

    expect(schema.safeParse({ deployId: "deploy-1" }).success).toBe(true);
    expect(schema.safeParse({ deployId: "deploy-1", acceptWeakStorage: true }).success).toBe(true);
    for (const value of [
      {},
      { deployId: "deploy-1", acceptWeakStorage: "yes" },
      { deployId: "" },
      { deployId: "x".repeat(129) },
      { deployId: "deploy-1", claimSecret: "claim-secret-0123456789abcdef" },
      { deployId: "deploy-1", url: "https://relay.example.com" },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("claims, restores and disconnects through Decisions itself once the setting is on", async () => {
    saved.value = { enabled: true };

    await expect(claimRelay(CLAIM)).resolves.toMatchObject({ result: "saved" });
    await expect(restoreIdentity(RESTORE)).resolves.toMatchObject({ result: "saved" });
    const confirmed = { oneClick: true, relayOrigin: RELAY_ORIGIN };
    await expect(disconnectRelay(confirmed)).resolves.toEqual({ state: "not-connected" });

    expect(decisionsEntry.claimRelay).toHaveBeenCalledExactlyOnceWith(CLAIM);
    expect(decisionsEntry.restoreIdentity).toHaveBeenCalledExactlyOnceWith(RESTORE);
    // How the person confirmed reaches main, which rechecks a one-click confirm (#18064).
    expect(decisionsEntry.disconnectRelay).toHaveBeenCalledExactlyOnceWith(confirmed);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("exports through Decisions itself, picking the file over the window that asked", async () => {
    saved.value = { enabled: true };
    const window = { isDestroyed: () => false };
    let chosen: Array<string | null> = [];
    decisionsEntry.exportData.mockImplementationOnce(async (_payload, choose) => {
      dialogMock.showSaveDialog
        .mockResolvedValueOnce({ canceled: false, filePath: "/exports/history.dxz.json" })
        .mockResolvedValueOnce({ canceled: true, filePath: "/exports/ignored.json" });
      chosen = [
        await choose("decisions-export-2026-11-01.dxz.json"),
        await choose("decisions-export-2026-11-01.dxz.json"),
      ];
      return { result: "cancelled" };
    });

    await exportData({ senderWindow: window }, EXPORT);

    expect(decisionsEntry.exportData).toHaveBeenCalledWith(EXPORT, expect.any(Function));
    expect(chosen).toEqual(["/exports/history.dxz.json", null]);
    expect(dialogMock.showSaveDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ defaultPath: "decisions-export-2026-11-01.dxz.json" })
    );
  });

  it("opens the export's dialog on its own when the window that asked has gone, or there is none", async () => {
    saved.value = { enabled: true };
    const choosing = async (
      _payload: ExportDecisionsDataPayload,
      choose: (fileName: string) => Promise<string | null>
    ): Promise<DecisionsExportResult> => {
      await choose("decisions-export-2026-11-01.dxz.json");
      return { result: "cancelled" };
    };
    decisionsEntry.exportData.mockImplementationOnce(choosing).mockImplementationOnce(choosing);

    await exportData({ senderWindow: { isDestroyed: () => true } }, EXPORT);
    await exportData({ senderWindow: null }, EXPORT);

    expect(dialogMock.showSaveDialog).toHaveBeenCalledTimes(2);
    for (const call of dialogMock.showSaveDialog.mock.calls) {
      expect(call).toEqual([
        expect.objectContaining({ defaultPath: "decisions-export-2026-11-01.dxz.json" }),
      ]);
    }
  });

  it("deletes relay and local data through Decisions itself once the setting is on", async () => {
    saved.value = { enabled: true };

    await expect(deleteRelayData({ origin: RELAY_ORIGIN })).resolves.toMatchObject({
      result: "deleted",
    });
    const confirmed = { oneClick: true, relayOrigin: null };
    await expect(deleteLocalData(confirmed)).resolves.toMatchObject({ result: "deleted" });

    expect(decisionsEntry.deleteRelayData).toHaveBeenCalledExactlyOnceWith({
      origin: RELAY_ORIGIN,
    });
    expect(decisionsEntry.deleteLocalData).toHaveBeenCalledExactlyOnceWith(confirmed);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("takes an export passphrase and a relay to delete from only within their bounds", () => {
    const exportSchema = decisionsNamespace.ops.exportData.schema as SafeParse;
    const deleteSchema = decisionsNamespace.ops.deleteRelayData.schema as SafeParse;

    expect(exportSchema.safeParse(EXPORT).success).toBe(true);
    for (const value of [
      { passphrase: "" },
      { passphrase: "x".repeat(1025) },
      { ...EXPORT, plaintext: true },
      {},
    ]) {
      expect(exportSchema.safeParse(value).success).toBe(false);
    }
    expect(deleteSchema.safeParse({ origin: RELAY_ORIGIN }).success).toBe(true);
    for (const value of [
      { origin: "x".repeat(2049) },
      { origin: RELAY_ORIGIN, scope: "everything" },
      {},
    ]) {
      expect(deleteSchema.safeParse(value).success).toBe(false);
    }
  });

  it("reads the policy and changes the allowlist through Decisions itself once on", async () => {
    saved.value = { enabled: true };

    await expect(getPolicy()).resolves.toMatchObject({ proxyAllowlisted: false });
    await expect(setProxyAllowlisted(true)).resolves.toMatchObject({ proxyAllowlisted: true });

    expect(decisionsEntry.getDecisionsPolicy).toHaveBeenCalledOnce();
    expect(decisionsEntry.setDecisionsProxyAllowlisted).toHaveBeenCalledExactlyOnceWith(true);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("changes the default expiry through Decisions itself once on, never included", async () => {
    saved.value = { enabled: true };

    await expect(setDefaultQuestionExpiry(null)).resolves.toMatchObject({
      defaultQuestionExpiryMs: null,
    });
    await expect(setDefaultQuestionExpiry(3_600_000)).resolves.toMatchObject({
      defaultQuestionExpiryMs: 3_600_000,
    });
    expect(decisionsEntry.setDecisionsDefaultQuestionExpiry.mock.calls).toEqual([
      [null],
      [3_600_000],
    ]);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("switches one agent's ask_human through Decisions itself once on", async () => {
    saved.value = { enabled: true };

    await expect(setAgentAskHuman({ agentId: "claude", enabled: true })).resolves.toMatchObject({
      askHumanAgents: ["claude"],
    });
    expect(decisionsEntry.setDecisionsAgentAskHuman).toHaveBeenCalledExactlyOnceWith({
      agentId: "claude",
      enabled: true,
    });
    expect(store.set).not.toHaveBeenCalled();
  });

  it("changes terminal snapshots through Decisions itself once on", async () => {
    saved.value = { enabled: true };

    await expect(setTerminalSnapshots({ enabled: true, consent: true })).resolves.toMatchObject({
      terminalSnapshots: true,
    });
    await expect(setTerminalSnapshots({ enabled: false })).resolves.not.toHaveProperty(
      "terminalSnapshots"
    );
    expect(decisionsEntry.setDecisionsTerminalSnapshots.mock.calls).toEqual([
      [{ enabled: true, consent: true }],
      [{ enabled: false }],
    ]);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("changes holding phone pushes through Decisions itself once on, and takes only a boolean (#17240)", async () => {
    saved.value = { enabled: true };

    await expect(setHoldPhonePushes(false)).resolves.toMatchObject({ holdPhonePushes: false });
    await expect(setHoldPhonePushes(true)).resolves.not.toHaveProperty("holdPhonePushes");
    expect(decisionsEntry.setDecisionsHoldPhonePushes.mock.calls).toEqual([[false], [true]]);
    expect(store.set).not.toHaveBeenCalled();

    const schema = decisionsNamespace.ops.setHoldPhonePushes.schema as SafeParse;
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(false).success).toBe(true);
    for (const value of [undefined, "false", 0, { enabled: false }]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("changes agent-stopped pushes through Decisions itself once on, and takes only a boolean (#17319)", async () => {
    saved.value = { enabled: true };

    await expect(setAgentStoppedPushes(true)).resolves.toMatchObject({ agentStoppedPushes: true });
    await expect(setAgentStoppedPushes(false)).resolves.not.toHaveProperty("agentStoppedPushes");
    expect(decisionsEntry.setDecisionsAgentStoppedPushes.mock.calls).toEqual([[true], [false]]);
    expect(store.set).not.toHaveBeenCalled();

    const schema = decisionsNamespace.ops.setAgentStoppedPushes.schema as SafeParse;
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(false).success).toBe(true);
    for (const value of [undefined, "true", 1, { enabled: true }]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("takes the switch and an agreement for terminal snapshots, never a time of its own", () => {
    const schema = decisionsNamespace.ops.setTerminalSnapshots.schema as SafeParse;
    for (const value of [
      { enabled: true, consent: true },
      { enabled: true },
      { enabled: false },
      { enabled: false, consent: false },
    ]) {
      expect(schema.safeParse(value).success).toBe(true);
    }
    for (const value of [
      undefined,
      true,
      { consent: true },
      { enabled: "true", consent: true },
      { enabled: true, consent: "yes" },
      { enabled: true, consent: true, terminalSnapshotsConsentedAt: 1 },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("takes one agent id and a boolean to switch it, never a list", () => {
    const schema = decisionsNamespace.ops.setAgentAskHuman.schema as SafeParse;
    for (const value of [
      { agentId: "claude", enabled: true },
      { agentId: "acme.agent-2", enabled: false },
    ]) {
      expect(schema.safeParse(value).success).toBe(true);
    }
    for (const value of [
      undefined,
      "claude",
      ["claude"],
      { agentId: "claude" },
      { agentId: "claude", enabled: "true" },
      { agentId: "", enabled: true },
      { agentId: "x".repeat(257), enabled: true },
      { agentId: "claude", enabled: true, askHumanAgents: ["codex"] },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("takes only whole milliseconds or null for the default expiry", () => {
    const schema = decisionsNamespace.ops.setDefaultQuestionExpiry.schema as SafeParse;
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(3_600_000).success).toBe(true);
    for (const value of [undefined, "never", 0, -1, 1.5, { ms: 1 }]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("lists, enrolls and switches Remote Host enrollment through Decisions itself once on", async () => {
    saved.value = { enabled: true };

    await expect(listHosts()).resolves.toMatchObject({ result: "listed" });
    await expect(enrollHost({ hostId: "studio" })).resolves.toEqual({ result: "not-connected" });
    await expect(setAutoEnrollHosts(false)).resolves.toMatchObject({ autoEnroll: false });

    expect(decisionsEntry.listHosts).toHaveBeenCalledOnce();
    expect(decisionsEntry.enrollDecisionsHost).toHaveBeenCalledExactlyOnceWith("studio", false);
    expect(decisionsEntry.setAutoEnrollHosts).toHaveBeenCalledExactlyOnceWith(false);
    // The fixed-key storage only when Enroll's confirmation said so.
    await enrollHost({ hostId: "wsl", allowWeakStorage: true });
    expect(decisionsEntry.enrollDecisionsHost).toHaveBeenLastCalledWith("wsl", true);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("takes only a host id to enroll, and only a boolean for automatic enrollment", () => {
    const enrollSchema = decisionsNamespace.ops.enrollHost.schema as SafeParse;
    expect(enrollSchema.safeParse({ hostId: "studio" }).success).toBe(true);
    for (const value of [
      undefined,
      "studio",
      { hostId: "" },
      { hostId: "x".repeat(257) },
      { hostId: "studio", replace: "dev" },
    ]) {
      expect(enrollSchema.safeParse(value).success).toBe(false);
    }
    const autoSchema = decisionsNamespace.ops.setAutoEnrollHosts.schema as SafeParse;
    expect(autoSchema.safeParse(false).success).toBe(true);
    expect(autoSchema.safeParse(true).success).toBe(true);
    for (const value of [undefined, "false", 0, { autoEnrollHosts: false }]) {
      expect(autoSchema.safeParse(value).success).toBe(false);
    }
  });

  it("takes only a boolean for the allowlist, and nothing that could carry a gate", () => {
    const schema = decisionsNamespace.ops.setProxyAllowlisted.schema as SafeParse;

    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(false).success).toBe(true);
    for (const value of [undefined, "true", 1, { proxyAllowlisted: true }, { gates: [] }]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("revokes and rotates through Decisions itself once the setting is on", async () => {
    saved.value = { enabled: true };

    decisionsEntry.revokeDevice.mockResolvedValueOnce({
      result: "unconfirmed",
      origin: "https://relay.example.com",
    } as never);
    decisionsEntry.rotateKeys.mockResolvedValueOnce({ result: "rotated", keyEpoch: 7 } as never);

    await expect(revokeDevice("dev_phone_1")).resolves.toEqual({
      result: "unconfirmed",
      origin: "https://relay.example.com",
    });
    await expect(rotateKeys()).resolves.toEqual({ result: "rotated", keyEpoch: 7 });

    expect(decisionsEntry.revokeDevice).toHaveBeenCalledExactlyOnceWith("dev_phone_1");
    expect(decisionsEntry.rotateKeys).toHaveBeenCalledOnce();
  });

  it("takes only a bounded string as the device to revoke", () => {
    const schema = decisionsNamespace.ops.revokeDevice.schema as SafeParse;

    expect(schema.safeParse("dev_phone_1").success).toBe(true);
    for (const value of [undefined, "", 42, { deviceId: "dev_phone_1" }, "x".repeat(129)]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("takes a claim secret only within the relay's own bounds", () => {
    const schema = decisionsNamespace.ops.claimRelay.schema as SafeParse;

    expect(schema.safeParse(CLAIM).success).toBe(true);
    expect(schema.safeParse({ ...CLAIM, acceptWeakStorage: true }).success).toBe(true);
    for (const value of [
      { ...CLAIM, claimSecret: "too-short" },
      { ...CLAIM, claimSecret: "x".repeat(257) },
      { ...CLAIM, url: "x".repeat(2049) },
      { ...CLAIM, extra: true },
      { url: CLAIM.url },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("takes a recovery kit only up to its size cap", () => {
    const schema = decisionsNamespace.ops.restoreIdentity.schema as SafeParse;

    expect(schema.safeParse(RESTORE).success).toBe(true);
    for (const value of [
      { ...RESTORE, kit: "" },
      { ...RESTORE, kit: "x".repeat(256 * 1024 + 1) },
      { ...RESTORE, passphrase: "" },
      { ...RESTORE, extra: true },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("logs and answers a malformed claim without the secret it carried", async () => {
    saved.value = { enabled: true };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerDecisionsHandlers();
    const registered = ipcMainMock.handle.mock.calls.find(
      ([channel]) => channel === CHANNELS.DECISIONS_CLAIM_RELAY
    )?.[1] as (event: unknown, payload: unknown) => Promise<unknown>;
    try {
      const failure = await registered(
        { sender: { id: 1 }, senderFrame: null },
        { ...CLAIM, unexpected: SECRET }
      ).then(
        () => null,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(Error);
      expect(errors.mock.calls.map(([first]) => String(first))).toContain(
        `[IPC] Validation failed for ${CHANNELS.DECISIONS_CLAIM_RELAY}:`
      );
      expect(String((failure as Error).message)).not.toContain(SECRET);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET);
      expect(decisionsEntry.claimRelay).not.toHaveBeenCalled();
    } finally {
      cleanup();
      errors.mockRestore();
    }
  });

  it("turns on with consent through Decisions itself, recording the consent", async () => {
    saved.value = { enabled: false };

    await expect(setEnabled({ enabled: true, consent: true })).resolves.toEqual({
      state: "not-connected",
    });

    expect(decisionsEntry.setDecisionsEnabled).toHaveBeenCalledWith(true, { consent: true });
  });

  it("turns on again without asking once consent is saved, and off through Decisions", async () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };
    await expect(setEnabled({ enabled: true })).resolves.toEqual({ state: "not-connected" });
    expect(decisionsEntry.setDecisionsEnabled).toHaveBeenLastCalledWith(true, { consent: false });

    saved.value = { enabled: true, consentedAt: 1_761_955_200_000 };
    await expect(setEnabled({ enabled: false })).resolves.toEqual({ state: "off" });
    expect(decisionsEntry.setDecisionsEnabled).toHaveBeenLastCalledWith(false, { consent: false });
  });

  it("answers off without loading once quit has sealed the loader", async () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };
    sealDecisionsModule();

    await expect(setEnabled({ enabled: true })).resolves.toEqual({
      state: "off",
      consentedAt: 1_761_955_200_000,
    });
    expect(decisionsEntry.setDecisionsEnabled).not.toHaveBeenCalled();
  });

  it("saves a recovery kit through a save dialog on the window that asked", async () => {
    saved.value = { enabled: true };
    const window = { isDestroyed: () => false };
    dialogMock.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: "/chosen/kit.json",
    });

    await expect(
      exportRecoveryKit({ senderWindow: window as never }, { passphrase: PASSPHRASE })
    ).resolves.toEqual({ result: "saved", fileName: "/chosen/kit.json" });

    expect(decisionsEntry.exportRecoveryKit).toHaveBeenCalledWith(
      { passphrase: PASSPHRASE },
      expect.any(Function)
    );
    expect(dialogMock.showSaveDialog).toHaveBeenCalledExactlyOnceWith(
      window,
      expect.objectContaining({ defaultPath: "decisions-recovery-kit-relay.example.com.json" })
    );
    expect(JSON.stringify(dialogMock.showSaveDialog.mock.calls)).not.toContain(PASSPHRASE);
  });

  it("opens the dialog on its own when the asking window is gone, and passes on a cancel", async () => {
    saved.value = { enabled: true };
    dialogMock.showSaveDialog.mockResolvedValueOnce({ canceled: true });

    await expect(
      exportRecoveryKit(
        { senderWindow: { isDestroyed: () => true } as never },
        { passphrase: PASSPHRASE }
      )
    ).resolves.toEqual({ result: "cancelled" });
    expect(dialogMock.showSaveDialog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: expect.any(String) })
    );
  });

  it("verifies a recovery kit through Decisions itself", async () => {
    saved.value = { enabled: true };
    const payload = { kit: '{"v":1}', passphrase: PASSPHRASE };

    await expect(verifyRecoveryKit(payload)).resolves.toMatchObject({ result: "verified" });
    expect(decisionsEntry.verifyRecoveryKit).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("takes a kit's passphrase only at the library's floor and within bounds", () => {
    const exporting = decisionsNamespace.ops.exportRecoveryKit.schema as SafeParse;
    const verifying = decisionsNamespace.ops.verifyRecoveryKit.schema as SafeParse;

    expect(exporting.safeParse({ passphrase: "x".repeat(12) }).success).toBe(true);
    for (const value of [
      { passphrase: "x".repeat(11) },
      { passphrase: "x".repeat(1025) },
      { passphrase: PASSPHRASE, extra: true },
      {},
    ]) {
      expect(exporting.safeParse(value).success).toBe(false);
    }
    expect(exporting.safeParse({ passphrase: "x".repeat(1024) }).success).toBe(true);
    expect(verifying.safeParse({ kit: '{"v":1}', passphrase: "x" }).success).toBe(true);
    expect(verifying.safeParse({ kit: '{"v":1}', passphrase: "x".repeat(1024) }).success).toBe(
      true
    );
    for (const value of [
      { kit: "", passphrase: PASSPHRASE },
      { kit: "x".repeat(256 * 1024 + 1), passphrase: PASSPHRASE },
      { kit: '{"v":1}', passphrase: "" },
      { kit: '{"v":1}', passphrase: "x".repeat(1025) },
      { kit: '{"v":1}', passphrase: PASSPHRASE, extra: true },
    ]) {
      expect(verifying.safeParse(value).success).toBe(false);
    }
  });

  it("logs and answers a short kit passphrase without the passphrase itself", async () => {
    saved.value = { enabled: true };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerDecisionsHandlers();
    const registered = ipcMainMock.handle.mock.calls.find(
      ([channel]) => channel === CHANNELS.DECISIONS_EXPORT_RECOVERY_KIT
    )?.[1] as (event: unknown, payload: unknown) => Promise<unknown>;
    const short = "elevenchars";
    try {
      const failure = await registered(
        { sender: { id: 1 }, senderFrame: null },
        {
          passphrase: short,
        }
      ).then(
        () => null,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(Error);
      expect(errors.mock.calls.map(([first]) => String(first))).toContain(
        `[IPC] Validation failed for ${CHANNELS.DECISIONS_EXPORT_RECOVERY_KIT}:`
      );
      expect(String((failure as Error).message)).not.toContain(short);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(short);
      expect(decisionsEntry.exportRecoveryKit).not.toHaveBeenCalled();
    } finally {
      cleanup();
      errors.mockRestore();
    }
  });
});
