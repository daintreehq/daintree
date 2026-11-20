import { Notification } from "electron";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname } from "node:path";
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  broadcastToProjectRenderers,
  broadcastToRenderer,
  hasBroadcastAudience,
} from "../../ipc/utils.js";
import type { MainProcessToastPayload } from "../../../shared/types/ipc/maps.js";
import { isDiskSpaceFault } from "./storageRecovery.js";
import { getAllAppWebContents } from "../../window/webContentsRegistry.js";
import {
  getDecisionsHostsPort,
  getMcpServerServiceRef,
  getPtyClient,
  getRunAttentionServiceRef,
  watchDecisionsHostsPort,
} from "../../window/serviceRefs.js";
import { readUserPresence } from "../userPresence.js";
import { isScheduledQuietNow } from "../../../shared/utils/quietHours.js";
import { mcpPaneConfigService } from "../McpPaneConfigService.js";
import { events } from "../events.js";
import { setDecisionAttention } from "../runAnswerAttentionSource.js";
import {
  getDecisionQuestionList,
  onDecisionQuestionsChanged,
  setDecisionQuestions,
} from "../decisionsQuestionList.js";
import { QuestionNotifier, type QuestionNotifications } from "./questionNotifications.js";
import { ThreadNotifier } from "./threadNotifications.js";
import type { MetaStore } from "./attentionList.js";
import type { HostServedQuestions, QuestionInboxFacts } from "./DecisionsService.js";
import {
  applyQuestionMarks,
  markKey,
  parseQuestionMarks,
  QUESTION_MARKS_META_KEY,
  serializeQuestionMarks,
  withInbox,
} from "./questionMarks.js";
import type {
  DecisionsHostQuestionRead,
  DecisionsHostQuestions,
  DecisionsHostsPort,
  HostCallOutcome,
} from "../../types/decisionsHosts.js";
import type { HostQuestionList } from "../../remote/decisions/questionSchemas.js";
import type { agentNotificationService } from "../AgentNotificationService.js";
import {
  BridgeError,
  enrollHost,
  verifiedDevices,
  type RelayConfig,
} from "@daintreehq/decisions-client";
import { newId } from "@daintreehq/decisions-crypto";
import {
  DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH,
  type ApproveDecisionsPairingPayload,
  type ClaimDecisionsRelayPayload,
  type ClaimDeployedDecisionsRelayPayload,
  type DecisionsConnectResult,
  type DecisionsDevicesResult,
  type DecisionsExportResult,
  type DecisionsKitExportResult,
  type DecisionsKitVerifyResult,
  type DecisionsKeyErasurePayload,
  type DecisionsLocalDeleteResult,
  type DecisionsPairingApproveResult,
  type DecisionsPairingDeclineResult,
  type DecisionsPairingStartResult,
  type DecisionsPairingState,
  type DecisionsPolicy,
  type DecisionsRelayCheck,
  type DecisionsRelayDeleteResult,
  type DecisionsRelayRequestFailure,
  type DecisionsRelayRemoval,
  type DecisionsRelayRemovalLocal,
  type DecisionsRevokeDeviceResult,
  type DecisionsRotateKeysResult,
  type DecisionsSettings,
  type SetDecisionsAgentAskHumanPayload,
  type SetDecisionsTerminalSnapshotsPayload,
  type CancelDecisionsSetupCheckPayload,
  type DecisionsSetupCheckRun,
  type DecisionsSetupCheckStartResult,
  type DecisionsStatus,
  type DeleteDecisionsRelayDataPayload,
  type ExportDecisionsDataPayload,
  type ExportDecisionsRecoveryKitPayload,
  type PaneDecisionState,
  type PreparedDecisionsRelayDeploy,
  type RestoreDecisionsIdentityPayload,
  type StartDecisionsRelayRemovalPayload,
  type VerifyDecisionsRecoveryKitPayload,
} from "../../../shared/types/decisions.js";
import type {
  CancelDecisionsModelEvaluationPayload,
  DecisionsModelHistory,
  DecisionsModelState,
  SetDecisionsModelPayload,
  SetDecisionsModelThresholdPayload,
} from "../../../shared/types/decisionsModel.js";
import type {
  DecisionsHostEnrollResult,
  DecisionsHostQuestionPolicy,
  DecisionsHostRecord,
  DecisionsHostRuntime,
  DecisionsHostsResult,
} from "../../../shared/types/decisionsHosts.js";
import type { HeldHost, OwnerStateAnnouncement } from "../../types/decisionsHosts.js";
import type {
  DecisionsAnswerDestinations,
  DecisionsAnswerOutcome,
  DecisionsAttentionList,
  DecisionsHostAttentionAnswer,
  DecisionsHostAttentionRequest,
  DecisionsHostAttentionResult,
  MarkDecisionsAnswerHandledPayload,
  ReassignDecisionsAnswerPayload,
} from "../../../shared/types/decisionsAttention.js";
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
  DecisionQuestionListItem,
  DecisionQuestionMarkResult,
  DecisionQuestionReference,
  DecisionQuestionSummariesResult,
  DecisionQuestionSummary,
  GetDecisionQuestionByReferencePayload,
  GetDecisionQuestionImageByReferencePayload,
  GetDecisionQuestionImagePayload,
  GetDecisionQuestionPayload,
  GetDecisionQuestionSummariesByReferencePayload,
  GetDecisionQuestionSummariesPayload,
  GetDecisionAnswerResultPayload,
  GetDecisionDeclineResultPayload,
  GetDecisionFollowUpResultPayload,
  MarkDecisionQuestionsPayload,
  SendDecisionFollowUpPayload,
} from "../../../shared/types/decisionsQuestion.js";
import type {
  DecisionsInvolvementRead,
  DecisionsInvolvementSaveResult,
  SetDecisionsInvolvementPayload,
} from "../../../shared/types/decisionsInvolvement.js";
import { AppError } from "../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  HOST_DEFAULT_QUESTION_EXPIRY_MS,
  isQuestionExpiryChoice,
} from "../../../shared/config/decisionsQuestionExpiry.js";
import {
  MAX_ASK_HUMAN_AGENTS,
  isAskHumanAgentId,
} from "../../../shared/config/decisionsAskHumanAgents.js";
import { OWNER_RW_FILE_MODE, resilientAtomicWriteFile } from "../../utils/fs.js";
import {
  normalizeRelayOrigin,
  readDecisionsSettings,
  writeDecisionsSettings,
} from "./decisionsSettings.js";
import type { AnswerDelivery, PaneSignal } from "./answerDelivery.js";
import type { ReportedStop } from "./agentStoppedPushes.js";
import type {
  DecisionsAgentStoppedDeps,
  DecisionsDeliveryDeps,
  DecisionsPresenceDeps,
  DecisionsService,
  DecisionsServiceOptions,
  DecisionsSnapshotDeps,
} from "./DecisionsService.js";
import { onNotificationSettingsWritten } from "../../utils/notificationSettingsPatch.js";
import type { DaintreeLocalStore } from "./daintreeLocalStore.js";
import { buildDecisionsArchive, type DecisionsArchive } from "./dataExport.js";
import {
  decisionModelFiles,
  describeEvaluation,
  thresholdSupported,
  type DecisionModelRuntime,
} from "./decisionModel.js";
import { decisionsKeyFilePath, keyFileVersion, onKeyFileWritten } from "./keyStore.js";
import { HostEnroller, type HostEnrollerOwner } from "./hostEnrollment.js";
import { HostRecords } from "./hostEnrollmentRecords.js";
import { RelayDeploySessions } from "./relayDeploySession.js";
import { relayDeployPrefill } from "./relayDeployPrefill.js";
import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import {
  hostLifetimeSettings,
  hostRecordServes,
  hostRuntimeOf,
  readHostRecord,
  writeHostRecord,
} from "./hostRecord.js";
import { openDecisionsMcpRoute, type DecisionsMcpRouteSources } from "./mcpRoute.js";
import { OwnerDevices } from "./pairing.js";
import type { RelayBinding } from "./relayConnection.js";
import { RelayCheckCancelledError, checkDecisionsRelay } from "./relayCheck.js";
import { deleteDecisionsRelayData } from "./relayData.js";
import { erasingKeyFilePath, type LocalEraseOutcome } from "./localData.js";
import {
  claimDecisionsRelay,
  restoreDecisionsIdentity,
  type RelaySetupOptions,
  type RelaySetupOutcome,
  type SetupKeyStore,
} from "./relayIdentity.js";
import { RelayRemovals, type RemovedRelayRecord } from "./relayRemoval.js";
import { takeRelayRemovalLaunch } from "../pty/relayRemovalLaunches.js";
import { SetupCheck } from "./setupCheck.js";
import { SetupDiagnostics } from "./setupDiagnostic.js";
import { composerDrafts } from "../composerDrafts.js";
import { decisionsPolicyOf, type PolicySettings } from "./workflowGates.js";
import {
  checkRecoveryKit,
  makeRecoveryKit,
  recordedIdentity,
  type RecordedIdentity,
} from "./recoveryKit.js";

/**
 * Nothing imports this module until the saved setting reads as on (the boot
 * task and the status read check it first), and it loads the service itself
 * only when it is first needed. Every runtime change to the switch goes
 * through `setDecisionsEnabled`, which writes the setting and then starts or
 * stops the service to match.
 */
let service: DecisionsService | null = null;
let creating: Promise<DecisionsService> | null = null;
let shutDown = false;
let transitions: Promise<unknown> = Promise.resolve();
/** Relay checks in flight. Turning off or quitting aborts them, so none outlives the switch. */
const relayChecks = new Set<AbortController>();
/**
 * Claims, restores and disconnects run behind the switch's transitions, so
 * turning off waits for one to settle (its requests have deadlines) rather
 * than cutting a claim off mid-flight. Quitting aborts their requests.
 */
const setups = new Set<AbortController>();
/** Counts status changes, so a read that lands after a newer push can't roll it back. */
let statusRevision = 0;
let statusPushes: Promise<void> = Promise.resolve();
/**
 * The owner's devices and pairing invitations for the identity the setting
 * records (#16009). Forgotten whenever that identity changes or Decisions
 * stops, which aborts its requests and drops every invitation it held.
 */
let ownerDevices: OwnerDevices | null = null;

function forgetOwnerDevices(): void {
  ownerDevices?.dispose();
  ownerDevices = null;
}

/**
 * Enrolls the Remote Hosts this computer connects to (#16021), for as long
 * as an enabled lifetime runs: started when the service's status leaves
 * off, stopped when it returns there. What it shows rides on the status
 * push, as the policy does, so Settings reads the Hosts again with it.
 */
function makeHostEnroller(): HostEnroller {
  return new HostEnroller({
    watchPort: watchDecisionsHostsPort,
    owner: () => hostEnrollmentOwner(),
    autoEnroll: () => (service?.getSettings() ?? readDecisionsSettings(store)).autoEnrollHosts,
    onChanged: () => publishStatus(),
  });
}
let hostEnroller = makeHostEnroller();

/** The guided relay deploy Settings started, whose result rides on the status push (#16199). */
function makeRelayDeploys(): RelayDeploySessions {
  return new RelayDeploySessions({
    onChange: () => publishStatus(),
    claimRelay: (claim, stillWanted) =>
      runSetup((options) => claimDecisionsRelay(claim, options), stillWanted),
  });
}
let relayDeploys = makeRelayDeploys();
/** One record keeper per store and installation, so its writes run one at a time. */
let hostRecords: {
  store: DaintreeLocalStore;
  installationId: string;
  records: HostRecords;
} | null = null;

function hostRecordsFor(localStore: DaintreeLocalStore, installationId: string): HostRecords {
  if (hostRecords?.store !== localStore || hostRecords.installationId !== installationId) {
    hostRecords = {
      store: localStore,
      installationId,
      records: new HostRecords(localStore, installationId),
    };
  }
  return hostRecords.records;
}

/** The owner's devices for Host enrollment; anything that stops it reads as not set up. */
async function ownerDevicesForHosts(): Promise<OwnerDevices | DecisionsRelayRequestFailure> {
  try {
    return await ownerDevicesFor();
  } catch {
    return { result: "not-set-up" };
  }
}

/** This computer as the owner that enrolls Hosts: only with a relay identity of its own, unrevoked. */
function hostEnrollmentOwner(): HostEnrollerOwner | null {
  const running = service;
  if (shutDown || running === null || running.getRole() !== "owner") return null;
  const settings = running.getSettings();
  if (
    settings === null ||
    !settings.enabled ||
    settings.relayOrigin === null ||
    settings.installationId === null ||
    settings.deviceId === null ||
    settings.revokedAt !== null
  ) {
    return null;
  }
  const { relayOrigin, installationId, deviceId } = settings;
  const localStore = running.getStore();
  return {
    key: `${relayOrigin}\n${installationId}\n${deviceId}`,
    installationId,
    deviceId,
    connected: running.getStatus().state === "connected",
    records: localStore ? hostRecordsFor(localStore, installationId) : null,
    devices: async () => {
      const devices = await ownerDevicesForHosts();
      return devices instanceof OwnerDevices
        ? devices.withClient((client) => verifiedDevices(client))
        : devices;
    },
    enroll: async (request) => {
      const devices = await ownerDevicesForHosts();
      // It seals the current key, so it takes its turn among key rotations (#16010).
      return devices instanceof OwnerDevices
        ? devices.withCurrentKeys(async (client) => ({
            response: (await enrollHost(client, request)).response,
          }))
        : devices;
    },
  };
}

function hostEnrollerFollows(state: DecisionsStatus["state"]): void {
  if (state === "off") {
    hostEnroller.stop();
    return;
  }
  hostEnroller.start();
  // Connecting is when Hosts already up get their attempt: setup finishing among them.
  if (state === "connected") hostEnroller.sweep();
}
/** Counts policy changes, so a policy read that lands after a newer change can't roll it back. */
let policyRevision = 0;
/** Counts decision model changes (#16027), for the same reason. */
let modelRevision = 0;
/**
 * Recovery kit exports between making the kit and writing it. The save
 * dialog is a person's to close, so it is never awaited behind the
 * transitions: turning off, disconnecting or quitting cancels the export
 * instead, and whatever the dialog answers later is ignored.
 */
const kitExports = new Set<AbortController>();
/**
 * The setup check's diagnostic terminals (#16024): delivery routes their
 * pane ids to them, and their questions' image comes from them.
 */
const setupDiagnostics = new SetupDiagnostics();
/** The setup check running now, at most one. */
let setupCheck: SetupCheck | null = null;
/** The check whose runs `lastSetupRun` keeps; null once forgotten with the identity it ran on. */
let shownCheck: SetupCheck | null = null;
/** The latest run, finished or not, for Settings to show. */
let lastSetupRun: DecisionsSetupCheckRun | null = null;
let setupCheckRevision = 0;
/**
 * Moves whenever a change ends what a check checks (turning off, a
 * disconnect, a deletion, quit), so a start still waiting on the service when
 * one lands makes no check.
 */
let setupCheckEpoch = 0;
/** How long turning off, a disconnect, a deletion or quit waits for a check's cleanup. */
const SETUP_CHECK_CANCEL_MS = 5_000;
/** The guided relay removals of this run (#16202), made on the first one. */
let relayRemovals: RelayRemovals | null = null;

function publishPaneState(projectId: string, state: PaneDecisionState): void {
  broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
    name: "terminal:decision-state",
    payload: state,
  });
}

/** This computer's own questions as its owner lifetime last listed them, while it lists any. */
let ownQuestions: readonly DecisionQuestionListItem[] = [];
/** What its questions in Needs you ask now, and the person's marks (#17895), as read with them. */
let ownInbox: QuestionInboxFacts | null = null;
/** The asks the list last published was told, by `markKey`: those it didn't have to guess. */
let listedAsks: ReadonlyMap<string, string | null> = new Map();
/** The owner lifetime lists questions now: its store is read. */
let listingQuestions = false;
/** Follows the Remote Hosts client's port for its Hosts' questions (#17230), while listing. */
let unfollowHostQuestions: (() => void) | null = null;

/**
 * Every question this computer asked (#17229), and those its enrolled Remote
 * Hosts last reported (#17230), for main's own consumers and every window
 * here: the list is this computer's, so a remote Shell's views never get it.
 * Ids, labels, times and statuses only; never any content.
 */
function publishQuestions(
  questions: readonly DecisionQuestionListItem[],
  listing = true,
  inbox?: QuestionInboxFacts
): void {
  ownQuestions = listing ? questions : [];
  ownInbox = listing ? (inbox ?? null) : null;
  listingQuestions = listing;
  if (listing) followHostQuestions();
  else stopFollowingHostQuestions();
  refreshQuestionList();
}

function refreshQuestionList(): void {
  const hosts = listingQuestions ? (getDecisionsHostsPort()?.hostQuestions() ?? []) : [];
  const questions = listingQuestions ? listedQuestions(hosts) : [];
  // Once quit begins the list only empties, for main's consumers; the windows are going.
  if (shutDown && questions.length > 0) return;
  const changed = setDecisionQuestions(questions, shutDown ? [] : awayHostNames(hosts));
  if (changed === null || shutDown) return;
  sendToLocalViews("decisions:questions-changed", changed);
}

/** Lists the Hosts' questions again whenever they, their links or the port itself change. */
function followHostQuestions(): void {
  if (unfollowHostQuestions !== null) return;
  let offPort: (() => void) | null = null;
  const unwatch = watchDecisionsHostsPort((port) => {
    offPort?.();
    offPort = port?.onHostQuestionsChanged(refreshQuestionList) ?? null;
    refreshQuestionList();
  });
  unfollowHostQuestions = () => {
    unwatch();
    offPort?.();
    offPort = null;
  };
}

function stopFollowingHostQuestions(): void {
  unfollowHostQuestions?.();
  unfollowHostQuestions = null;
}

/** When a question was asked, for ordering; one with no readable time goes last. */
function askedAtMs(question: DecisionQuestionListItem): number {
  const ms = Date.parse(question.askedAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * This computer's questions with every enrolled Host's, and what each in
 * Needs you asks now with the person's mark on it (#17895): this computer's
 * own read with its rows, a Host's as it reported them, else as its list
 * shows them.
 */
function listedQuestions(hosts: readonly DecisionsHostQuestions[]): DecisionQuestionListItem[] {
  const ownHostId = service?.getSettings()?.hostId ?? null;
  const asks = new Map<string, string | null>();
  if (ownHostId !== null) {
    for (const [questionId, ask] of ownInbox?.asks ?? []) {
      asks.set(markKey({ hostId: ownHostId, questionId }), ask);
    }
  }
  for (const host of hosts) {
    if (host.questionHostId === ownHostId) continue;
    for (const [questionId, ask] of host.asks ?? []) {
      asks.set(markKey({ hostId: host.questionHostId, questionId }), ask);
    }
  }
  listedAsks = asks;
  const listed = withInbox(
    withHostQuestions(ownQuestions, hosts, ownHostId),
    asks,
    ownInbox?.marks ?? new Map()
  );
  const closings = ownInbox?.closings;
  if (closings === undefined || closings.size === 0) return listed;
  // A withdrawal or decline queued here, for this computer's question or a Host's, while it is still open.
  return listed.map((item) => {
    const closing = closings.get(item.reference.questionId);
    return closing !== undefined && openStanding(item) ? { ...item, closing } : item;
  });
}

/** Still out for an answer, so a withdrawal or decline can be under way for it. */
function openStanding(item: DecisionQuestionListItem): boolean {
  const { standing } = item;
  return (standing.kind === "waiting" && standing.reason === "open") || standing.kind === "queued";
}

/**
 * The Hosts whose questions the list holds now (#18049), by host-list id,
 * so a Remote Host's window can tell whether its Host's are among them: none
 * while it lists none.
 */
function inboxHostIds(): string[] {
  if (!listingQuestions) return [];
  const ownHostId = service?.getSettings()?.hostId ?? null;
  return (getDecisionsHostsPort()?.hostQuestions() ?? [])
    .filter((host) => host.questionHostId !== ownHostId)
    .map((host) => host.hostId);
}

/**
 * Each enrolled Host this computer heard from but can't reach now, by name,
 * whether or not it listed a question (#18022): the inbox can't call itself
 * clear while one is away. Never this computer's own.
 */
function awayHostNames(hosts: readonly DecisionsHostQuestions[]): string[] {
  const ownHostId = service?.getSettings()?.hostId ?? null;
  const names = new Set<string>();
  for (const host of hosts) {
    if (host.questionHostId !== ownHostId && !host.connected) names.add(host.name);
  }
  return [...names];
}

/**
 * This computer's questions with every enrolled Host's, each named by its
 * Host, oldest first across machines: aliases repeat from one machine to the
 * next, so only the time orders them. A Host whose questions name this
 * computer's own id is never listed.
 */
function withHostQuestions(
  own: readonly DecisionQuestionListItem[],
  hosts: readonly DecisionsHostQuestions[],
  ownHostId: string | null
): readonly DecisionQuestionListItem[] {
  const theirs: DecisionQuestionListItem[] = [];
  for (const host of hosts) {
    if (host.questionHostId === ownHostId) continue;
    const remoteHost = { hostId: host.hostId, name: host.name, connected: host.connected };
    for (const question of host.questions) theirs.push({ ...question, remoteHost });
  }
  if (theirs.length === 0) return own;
  // A stable sort: questions asked at the same moment keep this computer's first, then each Host's order.
  return [...own, ...theirs].sort((a, b) => {
    const at = askedAtMs(a);
    const bt = askedAtMs(b);
    return at === bt ? 0 : at < bt ? -1 : 1;
  });
}

/** What this Remote Host's lifetime serves its owner's Shell of its questions (#17230); null while none. */
let hostServedQuestions: HostQuestionList | null = null;
const hostQuestionListeners = new Set<() => void>();

function publishHostQuestions(list: HostServedQuestions | null): void {
  hostServedQuestions =
    list === null ? null : { hostId: list.hostId, questions: [...list.questions], asks: list.asks };
  for (const listener of [...hostQuestionListeners]) {
    try {
      listener();
    } catch (err) {
      console.warn("[Decisions] A Host question listener threw:", err);
    }
  }
}

/**
 * This Remote Host's own questions (#17230), content-free, as its lifetime
 * last listed them, for the owner's Shell that enrolled it; null while no
 * Host lifetime lists any.
 */
export function decisionsHostQuestions(): HostQuestionList | null {
  return hostServedQuestions;
}

/** Calls `listener` whenever this Host's own questions may have changed. */
export function onDecisionsHostQuestionsChanged(listener: () => void): () => void {
  hostQuestionListeners.add(listener);
  return () => {
    hostQuestionListeners.delete(listener);
  };
}

/** The owner lifetime's question notifications, the latest made; following only while they can show one. */
let questionNotifier: QuestionNotifier | null = null;

/**
 * Desktop notifications for the questions agents ask (#17232), and for the
 * follow-ups that want a reply and the answers delivery stops on (#17235),
 * from the list every window here reads, so a Remote Host's questions notify
 * once they are listed too. Raised by the agent notification service, which
 * owns this computer's notification settings and sounds: loaded on demand,
 * since Decisions can start before the startup task that loads it has run.
 */
function notifyQuestions(store: MetaStore): QuestionNotifications {
  let presenter: typeof agentNotificationService | null = null;
  const questions = { get: getDecisionQuestionList, onChange: onDecisionQuestionsChanged };
  const readOpeningLine = async (reference: DecisionQuestionReference) => {
    const read = await getDecisionQuestionSummariesByReference({ references: [reference] });
    const summary = read.result === "read" ? read.summaries[0] : undefined;
    return summary?.result === "read" ? summary.line : null;
  };
  const prepare = async (reference: DecisionQuestionReference) => {
    presenter ??= (await import("../AgentNotificationService.js")).agentNotificationService;
    await presenter.prepareDecisionQuestion(reference.projectId);
  };
  const notificationsOn = (projectId: string) =>
    presenter?.decisionQuestionNotificationsOn(projectId) ?? false;
  const close = (key: string) => presenter?.closeDecisionQuestion(key);
  const asked = new QuestionNotifier({
    // Presence holds the phone only while a question can show here (#17240).
    onFollowing: () => service?.presenceChanged(),
    store,
    questions,
    readOpeningLine,
    prepare,
    notificationsOn,
    show: (question, openingLine, key) =>
      presenter?.notifyDecisionQuestion(question, openingLine, key),
    close,
  });
  const thread = new ThreadNotifier({
    store,
    questions,
    readOpeningLine,
    prepare,
    notificationsOn,
    showReply: (question, openingLine, key) =>
      presenter?.notifyDecisionReply(question, openingLine, key),
    showStall: (question, key) => presenter?.notifyDecisionStall(question, key),
    close,
  });
  questionNotifier = asked;
  void asked.start();
  void thread.start();
  return {
    stop: () => {
      asked.stop();
      thread.stop();
    },
  };
}

/**
 * Settings belong to this machine's own windows, never to a remote Shell's,
 * so what they show goes to the local views only.
 */
function sendToLocalViews(name: string, payload: unknown): void {
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.EVENTS_PUSH, { name, payload });
    } catch {
      // A view mid-teardown.
    }
  }
}

function sendStatus(status: DecisionsStatus): void {
  sendToLocalViews("decisions:status-changed", status);
}

/** The person was told Decisions stopped for storage; cleared once it connects or turns off (#16605). */
let storageOutageNoticed = false;

/** The warning for Decisions stopped for storage; null while it isn't. */
function storageOutageToast(
  running: DecisionsService,
  status: DecisionsStatus
): MainProcessToastPayload | null {
  if (status.state !== "not-connected" || status.problem !== "storage") return null;
  const reason = running.getStore()?.faultReason() ?? null;
  return {
    type: "warning",
    title: "Decisions connection lost",
    message: isDiskSpaceFault(reason)
      ? "The local Decisions database stopped accepting writes while disk space ran low, so agents can't ask you questions through Decisions. It tries again by itself once there's space; if it stays disconnected, turn Decisions off and on in Settings."
      : reason === "storage-busy"
        ? "The local Decisions database was too busy to accept a write, so agents can't ask you questions through Decisions. It tries again by itself shortly; if it stays disconnected, turn Decisions off and on in Settings."
        : "The local Decisions database isn't accepting writes, so agents can't ask you questions through Decisions. Turn Decisions off and on in Settings to try again.",
    rateLimitKey: "decisions-storage",
    rateLimitLabel: "Decisions",
    replaceKey: "decisions-storage",
  };
}

/**
 * Agents lose `ask_human` while Decisions is stopped for storage, and nothing
 * outside Settings showed it (#16605): the first time it stops for that, a
 * warning says so, once, until it connects again or turns off. A window that
 * wasn't ready to show it is told when it is (`noteDecisionsRendererReady`).
 */
function noticeStorageOutage(running: DecisionsService, status: DecisionsStatus): void {
  if (status.state === "connected" || status.state === "off") {
    storageOutageNoticed = false;
    return;
  }
  if (shutDown || storageOutageNoticed) return;
  const toast = storageOutageToast(running, status);
  // With no window at all, the next stop tries again, as does the next window ready.
  if (toast === null || !hasBroadcastAudience(CHANNELS.NOTIFICATION_SHOW_TOAST, toast)) return;
  storageOutageNoticed = true;
  try {
    broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, toast);
  } catch (error) {
    console.warn("[Decisions] The storage warning couldn't be shown:", error);
  }
}

/**
 * A renderer reported first-interactive, so its toast listener is mounted:
 * while Decisions is stopped for storage, that renderer is told, since a
 * warning sent while it was loading (or before it existed) never reached it.
 * Only that one: a window already told isn't told again.
 */
export function noteDecisionsRendererReady(webContentsId: number): void {
  const running = service;
  if (shutDown || running === null) return;
  const toast = storageOutageToast(running, running.getStatus());
  if (toast === null) return;
  const view = getAllAppWebContents().find((wc) => wc.id === webContentsId && !wc.isDestroyed());
  if (!view) return;
  try {
    view.send(CHANNELS.NOTIFICATION_SHOW_TOAST, toast);
    storageOutageNoticed = true;
  } catch {
    // A view torn down mid-send.
  }
}

/**
 * The store is being replaced (#16605). A setup check mid-question holds the
 * old store and connection, so it is called off as Cancel would: Settings
 * shows it cancelled, and nothing is recorded.
 */
function cancelSetupCheckForStore(): void {
  void setupCheck?.cancel().catch(() => {});
}

/** Reads free space now: whether there is room to write again, null when it couldn't be read. */
async function checkDiskSpace(): Promise<boolean | null> {
  const { checkDiskSpaceNow } = await import("../DiskSpaceMonitor.js");
  const status = await checkDiskSpaceNow();
  return status === null ? null : !status.writesSuppressed;
}

/**
 * The relay's devices changed (#16010): a device was revoked or the key
 * rotated, here or as the ledger reports it. Settings reads the list again;
 * nothing about the devices is sent with it.
 */
function publishDevicesChanged(): void {
  if (shutDown) return;
  sendToLocalViews("decisions:devices-changed", null);
}

/**
 * Something the status shows changed: push it to Settings. The revision moves
 * now and each push reads the status when its turn comes, in order, so the
 * last push is the newest and changes that come quicker than that arrive as
 * one. Nothing is pushed once quitting.
 */
function publishStatus(): void {
  if (shutDown) return;
  statusRevision += 1;
  statusPushes = statusPushes
    .then(async () => {
      if (shutDown) return;
      const status = await getDecisionsStatus();
      if (!shutDown) sendStatus(status);
    })
    .catch(() => {});
}

// Whether a verified kit still holds every key is read from the key file, so
// each change to the file is pushed to Settings: a rotation's new key, from
// any route, makes the next erasure ask for the stronger confirmation (#18064).
onKeyFileWritten(() => publishStatus());

/**
 * The relay revoked the identity a connection ran on. Recorded against that
 * identity alone, so a revocation that lands after a disconnect, or after
 * another relay was set up, changes nothing.
 */
function recordRevocation(relay: RelayBinding): void {
  const current = readDecisionsSettings(store);
  if (
    current.relayOrigin !== relay.relayOrigin ||
    current.installationId !== relay.installationId ||
    current.deviceId !== relay.deviceId ||
    current.revokedAt !== null
  ) {
    return;
  }
  let saved: DecisionsSettings;
  try {
    saved = writeDecisionsSettings(store, { ...current, revokedAt: Date.now() });
  } catch {
    // Shown as revoked all the same; the next lifetime sees the relay refuse again.
    console.warn("[Decisions] The relay's revocation couldn't be recorded in settings");
    return;
  }
  service?.updateSettings(saved);
  publishStatus();
}

/**
 * Where `/mcp/decisions` reads a pane's bearer and run from, and holds the
 * listener through. Only a Decisions bearer (#16012) gets in: a control-surface
 * bearer, a plugin grant, a help or API-key token is never one.
 */
function mcpRouteSources(running: () => DecisionsService | null): DecisionsMcpRouteSources {
  return {
    bearerFor: (token) => mcpPaneConfigService.getDecisionsBearerForToken(token),
    principalFor: (paneId) => mcpPaneConfigService.getDecisionsPrincipal(paneId),
    hostId: () => running()?.getSettings()?.hostId ?? null,
    getPtyClient,
    projectName: async (projectId) => {
      const { projectStore } = await import("../ProjectStore.js");
      return projectStore.getProjectById(projectId)?.name ?? null;
    },
    machineName: () => hostname(),
    holdListener: async (id, route) => {
      // With the MCP server off nothing else loads its module, and the route
      // still needs the listener.
      const mcp =
        getMcpServerServiceRef() ?? (await import("../McpServerService.js")).mcpServerService;
      return mcp.holdListener(id, route);
    },
  };
}

/** Main's pane events that may let a pane take an answer now. */
function watchPanes(onPane: (signal: PaneSignal) => void): () => void {
  const offs = [
    events.on("agent:state-changed", ({ terminalId, state }) => {
      if (terminalId && state === "waiting") onPane("settled");
    }),
    events.on("agent:detected", () => onPane("appeared")),
    events.on("agent-session:attributed", () => onPane("session")),
    events.on("agent:spawned", () => onPane("appeared")),
    events.on("terminal:restored", () => onPane("appeared")),
    composerDrafts.onCleared(() => onPane("composer")),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/**
 * What delivery reaches in the rest of main (#16017). The MCP server loads
 * only once a lifetime with a relay first delivers.
 */
const deliveryDeps: DecisionsDeliveryDeps = {
  // The principal the pane's questions were asked under, which a tier-off pane holds too (#16012).
  principalFor: (paneId) => mcpPaneConfigService.getDecisionsPrincipal(paneId),
  getPtyClient: () => getPtyClient(),
  hasComposerDraft: (paneId) => composerDrafts.hasDraft(paneId),
  diagnostics: setupDiagnostics,
  holdWakes: async () => {
    const { mcpServerService } = await import("../McpServerService.js");
    return mcpServerService.holdWakes();
  },
  watchPanes,
  resume: {
    resumeSession: async (request) => {
      const { resumeAgentSessionAsPaneLive } = await import("../viewless/index.js");
      return resumeAgentSessionAsPaneLive(request);
    },
    waitForPrompt: async (terminalId, options) => {
      const { waitForAgentAtPromptLive } = await import("../viewless/index.js");
      return waitForAgentAtPromptLive(terminalId, options);
    },
    isDirectory: async (path) => (await stat(path)).isDirectory(),
  },
  labels: {
    projectName: async (projectId) => {
      const { projectStore } = await import("../ProjectStore.js");
      return projectStore.getProjectById(projectId)?.name ?? null;
    },
    listTerminals: async () => (await getPtyClient()?.getAllTerminalsAsync()) ?? [],
    getTerminal: async (terminalId) => (await getPtyClient()?.getTerminalAsync(terminalId)) ?? null,
    hostName: (hostId) =>
      getDecisionsHostsPort()
        ?.hostQuestions()
        .find((host) => host.questionHostId === hostId)?.name ?? null,
  },
};

/** Main's pane events that can change what a pane's terminal snapshot shows (#16230), by pane id. */
function watchSnapshotPanes(onPane: (terminalId: string, state?: string) => void): () => void {
  const offs = [
    events.on("agent:state-changed", ({ terminalId, state }) => {
      if (terminalId) onPane(terminalId, state);
    }),
    events.on("terminal:title-changed", ({ id }) => onPane(id)),
    events.on("terminal:observed-title-changed", ({ id }) => onPane(id)),
    events.on("agent:detected", ({ terminalId }) => onPane(terminalId)),
    events.on("agent:spawned", ({ terminalId }) => onPane(terminalId)),
    events.on("agent:exited", ({ terminalId }) => onPane(terminalId)),
    events.on("terminal:trashed", ({ id }) => onPane(id)),
    events.on("terminal:restored", ({ id }) => onPane(id)),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/**
 * Main's pane and worktree events that can change what the run that asked a
 * question shows (#18029), each naming the pane or worktree it concerns: it
 * started, exited or was lost with its pty host, went to or came back from
 * the Trash, moved worktree, its agent came or went, or a worktree was
 * removed or came back. A pty client created later is followed from the next
 * subscription.
 */
function watchAskerPanes(
  onPane: (hint?: { paneId: string } | { worktreeId: string; missingOnly?: true }) => void
): () => void {
  const pane = (paneId: string | undefined) => {
    if (paneId) onPane({ paneId });
  };
  const offs = [
    events.on("terminal:lifecycle", ({ type, terminalId }) => {
      if (type === "spawned" || type === "exited") pane(terminalId);
    }),
    events.on("terminal:trashed", ({ id }) => pane(id)),
    events.on("terminal:restored", ({ id }) => pane(id)),
    events.on("terminal:trash-cleared", ({ id }) => pane(id)),
    events.on("terminal:worktree-changed", ({ id }) => pane(id)),
    events.on("agent:spawned", ({ terminalId }) => pane(terminalId)),
    events.on("agent:detected", ({ terminalId }) => pane(terminalId)),
    events.on("agent:exited", ({ terminalId }) => pane(terminalId)),
    events.on("agent:killed", ({ terminalId }) => pane(terminalId)),
    events.on("agent-session:attributed", ({ terminalId }) => pane(terminalId)),
    events.on("sys:worktree:remove", ({ worktreeId }) => onPane({ worktreeId })),
    events.on("sys:worktree:update", ({ id }) => onPane({ worktreeId: id, missingOnly: true })),
  ];
  const client = getPtyClient();
  if (client !== null && typeof client.on === "function") {
    const lost = (terminalId: string) => pane(terminalId);
    const incarnationLost = ({ terminalId }: { terminalId: string }) => pane(terminalId);
    const spawned = (terminalId: string) => pane(terminalId);
    // A pty host that gave up restarting names no pane: every asker is read again.
    const crashed = () => onPane();
    client.on("terminal-lost", lost);
    client.on("incarnation-lost", incarnationLost);
    client.on("spawn-result", spawned);
    client.on("host-crash", crashed);
    offs.push(() => {
      client.off("terminal-lost", lost);
      client.off("incarnation-lost", incarnationLost);
      client.off("spawn-result", spawned);
      client.off("host-crash", crashed);
    });
  }
  return () => {
    for (const off of offs) off();
  };
}

/** What observing the run that asked each open question reaches in the rest of main (#18029). */
const askerPresenceDeps: DecisionsServiceOptions["askerPresence"] = {
  hostId: () => service?.getSettings()?.hostId ?? null,
  principalFor: (paneId) => mcpPaneConfigService.getDecisionsPrincipal(paneId),
  getPtyClient: () => getPtyClient(),
  stat: (path) => stat(path),
  watch: watchAskerPanes,
};

/**
 * What terminal snapshots reach in the rest of main (#16230). An owner's
 * lifetime shares them under its own switch; a Host's, as its owner's Shell
 * last said.
 */
const snapshotDeps: DecisionsSnapshotDeps = {
  allowed: (role) => (role === "host" ? hostSnapshotsAllowed() : terminalSnapshotsAllowed()),
  principalFor: (paneId) => mcpPaneConfigService.getDecisionsPrincipal(paneId),
  getPtyClient: () => getPtyClient(),
  watchPanes: watchSnapshotPanes,
};

/** Settings → Notifications' own switch: what lets a question show here, and so presence be reported. */
function desktopNotificationsOn(): boolean {
  return store.get("notificationSettings")?.enabled !== false;
}

/**
 * Whether the person's presence may be reported now (#17240): Decisions on in
 * this run, holding phone pushes on, and #17232's question notifications able
 * to show a question here: turned on, supported by the system, and following
 * this lifetime's questions. Read each time, so it answers false as soon as
 * any of them stops holding; a setting that can't be read holds nothing.
 */
function presenceAllowed(): boolean {
  try {
    const settings = readDecisionsSettings(store);
    return (
      !shutDown &&
      settings.enabled &&
      settings.holdPhonePushes &&
      desktopNotificationsOn() &&
      questionNotifier?.following === true &&
      Notification.isSupported()
    );
  } catch {
    return false;
  }
}

const presenceDeps: DecisionsPresenceDeps = { allowed: presenceAllowed };

/**
 * Turns off of Decisions asked for and not yet through the queue: the switch
 * reads on in the store until its turn comes, and no agent-stopped push may
 * go out after the person turned it off (#17319).
 */
let decisionsOffsPending = 0;

/**
 * Whether the phone may be told that an agent stopped (#17319): Decisions on
 * in this run with no turn off on its way, and the switch on. Desktop
 * notifications and their per-event switches don't count: the switch stands
 * alone. Read each time; a setting that can't be read sends nothing.
 */
function agentStoppedPushesAllowed(): boolean {
  try {
    const settings = readDecisionsSettings(store);
    return (
      !shutDown && decisionsOffsPending === 0 && settings.enabled && settings.agentStoppedPushes
    );
  } catch {
    return false;
  }
}

/**
 * A Remote Host's agent as the agent-stopped batch names it (#17933): never
 * one of this computer's terminal ids, which hold no NUL, nor another Host's.
 */
function hostStopKey(hostId: string, terminalId: string): string {
  return `\0host\0${hostId}\0${terminalId}`;
}

function isHostStopKey(key: string): boolean {
  return key.startsWith("\0host\0");
}

/** Host stops kept to take back if the port goes; the oldest go first, taken back as they go. */
const MAX_HELD_HOST_STOPS = 4000;

/**
 * Hears connected Hosts' agents' stops through the Remote Hosts port, which
 * comes and goes with Remote Hosts itself. A port withdrawn takes back every
 * stop it passed on, as a link that ends does: none of them can be now.
 */
function watchHostStops(listener: (report: ReportedStop) => void): () => void {
  let offPort: (() => void) | null = null;
  const held = new Set<string>();
  const release = (): void => {
    offPort?.();
    offPort = null;
    for (const key of held) listener({ key, stopped: false });
    held.clear();
  };
  const unwatch = watchDecisionsHostsPort((port) => {
    release();
    if (port === null) return;
    offPort = port.onAgentStopChanges((hostId, change) => {
      const key = hostStopKey(hostId, change.terminalId);
      held.delete(key);
      if (change.stopped) {
        held.add(key);
        if (held.size > MAX_HELD_HOST_STOPS) {
          const evicted = held.values().next().value!;
          held.delete(evicted);
          listener({ key: evicted, stopped: false });
        }
      }
      listener({ key, stopped: change.stopped });
    });
  });
  return () => {
    unwatch();
    offPort?.();
    offPort = null;
    held.clear();
  };
}

const agentStoppedDeps: DecisionsAgentStoppedDeps = {
  allowed: agentStoppedPushesAllowed,
  presence: readUserPresence,
  // The schedule is global: a project's overrides never change it.
  quiet: () => {
    try {
      return isScheduledQuietNow(store.get("notificationSettings"));
    } catch {
      // Unreadable, it may say quiet: nothing is sent.
      return true;
    }
  },
  putAside: (terminalId) => {
    // The Host judged its own run's park and snooze, and takes the stop back if one comes later.
    if (isHostStopKey(terminalId)) return false;
    const attention = getRunAttentionServiceRef();
    if (!attention) return false;
    return attention.getParkRecord(terminalId) !== undefined || attention.isSnoozed(terminalId);
  },
  watchTransitions: (listener) =>
    events.on("agent:state-changed", (payload) =>
      listener({
        terminalId: payload.terminalId,
        state: payload.state,
        previousState: payload.previousState,
        terminalClosing: payload.terminalClosing === true,
      })
    ),
  // Put aside after its stop was seen: lifting it later brings back no alert for that stop.
  watchPutAside: (listener) => {
    const offs = [
      events.on("terminal:park-changed", (payload) => {
        if (payload.parked) listener(payload.id);
      }),
      events.on("terminal:snooze-changed", (payload) => {
        if (payload.snoozed) listener(payload.id);
      }),
    ];
    return () => offs.forEach((off) => off());
  },
  watchReportedStops: watchHostStops,
};

// Turning desktop notifications off ends presence at once, and on starts it;
// Settings shows which (#18061). Every write pushes, since a value remembered
// here would go stale when a configuration reload changes the store unheard.
// This module loads only once Decisions is on, so vanilla Daintree never listens.
onNotificationSettingsWritten(() => {
  service?.presenceChanged();
  publishStatus();
});

function serialize<T>(step: () => Promise<T>): Promise<T> {
  const run = transitions.then(step);
  transitions = run.catch(() => {});
  return run;
}

export function peekDecisionsService(): DecisionsService | null {
  return service;
}

export function getDecisionsService(): Promise<DecisionsService> {
  if (!creating) {
    // After quit nothing new is made; one already being made is disposed by the stop.
    if (shutDown) return Promise.reject(new Error("Decisions has stopped for this run"));
    const made = import("./DecisionsService.js").then(({ DecisionsService }) => {
      const sources = mcpRouteSources(() => next);
      const next: DecisionsService = new DecisionsService({
        publishPaneState,
        publishAnswerAttention: setDecisionAttention,
        publishQuestions,
        publishHostQuestions,
        notifyQuestions,
        onRelayRevoked: (relay, role) =>
          role === "host" ? void hostRevoked(relay) : recordRevocation(relay),
        forgetIdentity: forgetRecordedIdentity,
        openQuestions: (source, previousClosed) =>
          openDecisionsMcpRoute(source, sources, previousClosed),
        delivery: deliveryDeps,
        snapshots: snapshotDeps,
        presence: presenceDeps,
        askerPresence: askerPresenceDeps,
        agentStopped: agentStoppedDeps,
        onDevicesChanged: publishDevicesChanged,
        diagnostics: setupDiagnostics,
        onModelChanged: publishModelChanged,
        onQuestionPolicyChanged: publishHostRuntime,
        checkDiskSpace,
        onStoreReplacing: cancelSetupCheckForStore,
      });
      next.onStatusChanged((event) => {
        // A Host enrolls no Hosts: only an owner's lifetime does.
        hostEnrollerFollows(next.getRole() === "host" ? "off" : event.status.state);
        publishStatus();
        publishHostRuntime();
        noticeStorageOutage(next, event.status);
      });
      service = next;
      return next;
    });
    creating = made;
    // A failed load is retried by the next caller rather than remembered.
    made.catch(() => {
      if (creating === made) creating = null;
    });
  }
  return creating;
}

/**
 * Disk space is no longer critical (#16605): a store that stopped for it is
 * replaced and its connection made again. Never makes or starts the service.
 */
export async function decisionsDiskSpaceRecovered(): Promise<void> {
  if (shutDown) return;
  await (await settledService())?.diskSpaceRecovered();
}

async function settledService(): Promise<DecisionsService | null> {
  return service ?? (creating ? await creating.catch(() => null) : null);
}

/**
 * What Settings shows: the service's own state once it exists, otherwise what
 * the setting implies, with the relay and consent as saved.
 */
export async function getDecisionsStatus(): Promise<DecisionsStatus> {
  const revision = statusRevision;
  const settings = readDecisionsSettings(store);
  // An enrolled Host's own lifetime is its owner's, not this computer's switch (#16022).
  const owned = service !== null && service.getRole() !== "host" ? service : null;
  const observed = owned?.getStatus() ?? {
    state: !shutDown && settings.enabled ? ("not-connected" as const) : ("off" as const),
  };
  const keyFile = observed.state !== "off" && owned !== null ? await owned.hasKeyFile() : null;
  // A verification for keys known to be gone protects nothing.
  const kitVerifiedAt =
    settings.recoveryKit !== null && keyFile !== false ? settings.recoveryKit.verifiedAt : null;
  // Only a verification of the keys as the files hold them now covers them (#18064).
  const files = owned !== null && keyFile !== null ? await readKeyFiles(owned) : undefined;
  const kitCurrent =
    kitVerifiedAt !== null && keyFile === true && files !== undefined && filesCovered(files);
  const keysVersion = files !== undefined ? versionOfKeyFiles(files) : null;
  // Nor does a check of them.
  const checked = settings.setupCheck !== null && keyFile !== false ? settings.setupCheck : null;
  const deploy = relayDeploys.snapshot();
  return {
    ...observed,
    ...(settings.relayOrigin ? { relayOrigin: settings.relayOrigin } : {}),
    ...(settings.consentedAt !== null ? { consentedAt: settings.consentedAt } : {}),
    ...(settings.terminalSnapshots ? { terminalSnapshots: true } : {}),
    ...(settings.holdPhonePushes ? {} : { holdPhonePushes: false }),
    ...(settings.agentStoppedPushes ? { agentStoppedPushes: true } : {}),
    ...(desktopNotificationsOn() ? {} : { desktopNotifications: false }),
    ...(keyFile === true ? { keysStored: true } : {}),
    ...(kitVerifiedAt !== null ? { recoveryKitVerifiedAt: kitVerifiedAt } : {}),
    ...(kitCurrent ? { recoveryKitCurrent: true } : {}),
    ...(keysVersion !== null ? { keysVersion } : {}),
    ...(checked !== null
      ? { setupCheck: { checkedAt: checked.checkedAt, failedStep: checked.failedStep } }
      : {}),
    ...(deploy !== undefined ? { relayDeploy: deploy } : {}),
    ...(relayRemovals !== null ? { relayRemovals: relayRemovals.list() } : {}),
    revision,
  };
}

/**
 * The running lifetime's answer delivery, for the needs-attention list
 * (#16020). Never makes or starts the service: null until a connection with a
 * relay identity runs.
 */
function answerDelivery(): AnswerDelivery | null {
  return service?.getAnswerDelivery() ?? null;
}

/** A delivery that stopped under a call answers as not running; anything else is a fault. */
async function whileDelivering<T>(
  act: (delivery: AnswerDelivery) => Promise<T>,
  notRunning: T
): Promise<T> {
  const delivery = answerDelivery();
  if (delivery === null) return notRunning;
  try {
    return await act(delivery);
  } catch (error) {
    // The store refuses a stopped delivery's reads (`RetiredAttemptError`, named
    // here rather than imported, so the entry doesn't load the transport).
    const retired = error instanceof Error && error.name === "RetiredAttemptError";
    if (retired || answerDelivery() !== delivery) return notRunning;
    throw error;
  }
}

/**
 * A read that answers not running when its delivery stopped while it ran,
 * even if nothing threw: content opened as the delivery stopped may have
 * failed for that alone.
 */
async function whileReading<T>(
  read: (delivery: AnswerDelivery) => Promise<T>,
  notRunning: T
): Promise<T> {
  const delivery = answerDelivery();
  if (delivery === null) return notRunning;
  const result = await whileDelivering(read, notRunning);
  return answerDelivery() === delivery ? result : notRunning;
}

/** Every answer a person has to decide about, opened, oldest question first. */
export function listDecisionsAttention(): Promise<DecisionsAttentionList> {
  return whileDelivering<DecisionsAttentionList>(
    async (delivery) => ({ result: "listed", items: await delivery.attentionItems() }),
    { result: "not-running" }
  );
}

/** The delimited block of an answer needing attention, for the person to paste in themselves. */
export async function copyDecisionsAnswer(questionId: string): Promise<string> {
  const text = await whileDelivering((delivery) => delivery.copiedAnswer(questionId), null);
  if (text === null) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "No answer is waiting to be typed in for that question",
    });
  }
  return text;
}

export function resumeDecisionsAnswer(questionId: string): Promise<DecisionsAnswerOutcome> {
  return whileDelivering((delivery) => delivery.resumeAnswer(questionId), NOT_RUNNING);
}

export function listDecisionsAnswerDestinations(
  questionId: string
): Promise<DecisionsAnswerDestinations> {
  return whileDelivering((delivery) => delivery.answerDestinations(questionId), {
    result: "not-running",
  });
}

export function reassignDecisionsAnswer(
  payload: ReassignDecisionsAnswerPayload
): Promise<DecisionsAnswerOutcome> {
  return whileDelivering(
    (delivery) =>
      delivery.reassignAnswer(
        payload.questionId,
        { terminalId: payload.terminalId, run: payload.run },
        payload.expected
      ),
    NOT_RUNNING
  );
}

export function markDecisionsAnswerHandled(
  payload: MarkDecisionsAnswerHandledPayload
): Promise<DecisionsAnswerOutcome> {
  return whileDelivering(
    (delivery) => delivery.markHandled(payload.questionId, payload.expected),
    NOT_RUNNING
  );
}

const NOT_RUNNING: DecisionsAnswerOutcome = { result: "refused", reason: "not-running" };

/**
 * One of a Remote Host's stopped deliveries read or acted on from this
 * owner computer (#18031): only ever on the Host whose questions name the
 * reference, never on this computer's own delivery, whatever it holds under
 * the same id. Never makes or starts the service.
 */
export async function actOnHostAttention(
  request: DecisionsHostAttentionRequest
): Promise<DecisionsHostAttentionResult> {
  const onHost = hostRouteFor(request.reference)?.hostAttention(request) ?? null;
  if (onHost === null) return { result: "no-host" };
  const answered = await onHost;
  return answered.ok ? answered.value : { result: "unreachable", failure: answered.failure };
}

/**
 * One of this Remote Host's own stopped deliveries read or acted on by
 * reference for the owner's Shell that enrolled it (#18031): only while this
 * machine runs as a Host, and through the delivery its own windows act
 * through, so resolving it from either is done once. A resume or Mark handled
 * is taken only while the question still asks what the owner read it asking.
 */
export function hostServedAttention(
  request: DecisionsHostAttentionRequest
): Promise<DecisionsHostAttentionAnswer> {
  if (!servingAsHost()) return Promise.resolve({ result: "off" });
  const { reference } = request;
  const notRunning: DecisionsHostAttentionAnswer = { result: "not-running" };
  switch (request.action) {
    case "read":
      return whileReading<DecisionsHostAttentionAnswer>(
        async (delivery) => ({ result: "read", item: await delivery.attentionItem(reference) }),
        notRunning
      );
    case "copy":
      return whileReading<DecisionsHostAttentionAnswer>(
        async (delivery) => ({
          result: "copied",
          text: await delivery.copiedAnswer(reference.questionId, reference),
        }),
        notRunning
      );
    case "resume":
      return whileDelivering<DecisionsHostAttentionAnswer>(
        async (delivery) => ({
          result: "acted",
          outcome: await delivery.resumeAnswer(reference.questionId, {
            reference,
            expected: request.expected,
          }),
        }),
        notRunning
      );
    case "handled":
      return whileDelivering<DecisionsHostAttentionAnswer>(
        async (delivery) => ({
          result: "acted",
          outcome: await delivery.markHandled(reference.questionId, request.expected, reference),
        }),
        notRunning
      );
  }
}

/** A pane's state for its view to show on mount. Never makes or starts the service: null until it runs. */
export function getDecisionsPaneState(terminalId: string): PaneDecisionState | null {
  return service?.getPaneState(terminalId) ?? null;
}

/**
 * One question of a pane with its content opened (#17097), for the view of
 * the project that pane belongs to. Never makes or starts the service.
 */
export function getDecisionQuestionContent(
  projectId: string | null,
  payload: GetDecisionQuestionPayload
): Promise<DecisionQuestionContentResult> {
  return whileReading<DecisionQuestionContentResult>(
    (delivery) =>
      delivery.questionContent({ projectId, terminalId: payload.terminalId }, payload.questionId),
    { result: "not-running" }
  );
}

/** Part of one image of a pane's question, checked against its digest (#17100). Never makes or starts the service. */
export function getDecisionQuestionImage(
  projectId: string | null,
  payload: GetDecisionQuestionImagePayload
): Promise<DecisionQuestionImagePartResult> {
  return whileReading<DecisionQuestionImagePartResult>(
    (delivery) =>
      delivery.questionImage(
        { projectId, terminalId: payload.terminalId },
        payload.questionId,
        payload.attachmentId,
        payload.offset
      ),
    { result: "not-running" }
  );
}

/** The opening lines of a pane's questions (#17097). Never makes or starts the service. */
export function getDecisionQuestionSummaries(
  projectId: string | null,
  payload: GetDecisionQuestionSummariesPayload
): Promise<DecisionQuestionSummariesResult> {
  return whileReading<DecisionQuestionSummariesResult>(
    async (delivery) => ({
      result: "read",
      summaries: await delivery.questionSummaries(
        { projectId, terminalId: payload.terminalId },
        payload.questionIds
      ),
    }),
    { result: "not-running" }
  );
}

/**
 * One question with its content opened, by its reference (#17229), for any
 * window on this computer whatever project it shows: read on the Remote Host
 * that asked it when the reference names one (#17230). A Host whose link was
 * down before the read went out answers with what this computer last read of
 * the question over it (#17946), for the owner to dismiss it by. Never makes
 * or starts the service.
 */
export async function getDecisionQuestionContentByReference(
  payload: GetDecisionQuestionByReferencePayload
): Promise<DecisionQuestionContentResult> {
  const { reference } = payload;
  const route = hostRouteFor(reference);
  const onHost = route?.readHostQuestion(reference.hostId, { read: "content", reference });
  if (route && onHost) {
    const read = answeredByHost(await onHost);
    if (read.result !== "host-not-connected") return read;
    const lastRead = route.lastHostRead(reference);
    return lastRead === null ? read : { ...read, lastRead };
  }
  return readOwnQuestionContent(reference);
}

/** Part of one image of a question, by its reference (#17229), on its Host when a Host asked it. Never makes or starts the service. */
export async function getDecisionQuestionImageByReference(
  payload: GetDecisionQuestionImageByReferencePayload
): Promise<DecisionQuestionImagePartResult> {
  const { reference, attachmentId, offset } = payload;
  const onHost = hostRouteFor(reference)?.readHostQuestion(reference.hostId, {
    read: "image",
    reference,
    attachmentId,
    offset,
  });
  if (onHost) return answeredByHost(await onHost) as DecisionQuestionImagePartResult;
  return readOwnQuestionImage(payload);
}

/**
 * The opening lines of questions by their references (#17229), in the order
 * asked for, each question once; a Remote Host's read on that Host (#17230).
 * Never makes or starts the service.
 */
export async function getDecisionQuestionSummariesByReference(
  payload: GetDecisionQuestionSummariesByReferencePayload
): Promise<DecisionQuestionSummariesResult> {
  const seen = new Set<string>();
  const references: DecisionQuestionReference[] = [];
  for (const reference of payload.references) {
    if (seen.has(reference.questionId)) continue;
    seen.add(reference.questionId);
    references.push(reference);
  }
  // Each Host's references go to it in one read.
  const byHost = new Map<string, DecisionQuestionReference[]>();
  for (const reference of references) {
    if (hostRouteFor(reference) === null) continue;
    const named = byHost.get(reference.hostId);
    if (named) named.push(reference);
    else byHost.set(reference.hostId, [reference]);
  }
  const fromHosts = new Map<string, DecisionQuestionSummary>();
  await Promise.all(
    [...byHost].map(async ([questionHostId, named]) => {
      const onHost = hostRouteFor(named[0])?.readHostQuestion(questionHostId, {
        read: "summaries",
        references: named,
      });
      // No Host's questions name it: this computer's to answer, as one it doesn't hold.
      if (!onHost) return;
      const answered = await onHost;
      for (const reference of named) {
        fromHosts.set(reference.questionId, summaryFromHost(reference, answered));
      }
    })
  );
  if (fromHosts.size === 0) return readOwnQuestionSummaries(references);
  const own = references.filter((reference) => !fromHosts.has(reference.questionId));
  const ownRead: DecisionQuestionSummariesResult =
    own.length === 0 ? { result: "read", summaries: [] } : await readOwnQuestionSummaries(own);
  return {
    result: "read",
    summaries: references.map(
      (reference) =>
        fromHosts.get(reference.questionId) ??
        (ownRead.result === "read"
          ? ownRead.summaries.find((summary) => summary.questionId === reference.questionId)
          : undefined) ?? { questionId: reference.questionId, result: "unreadable" }
    ),
  };
}

/**
 * The Remote Hosts client's port when `reference` names a question another
 * machine asked (#17230): only an owner's lifetime reads its Hosts' questions,
 * and never through a reference naming this computer.
 */
function hostRouteFor(reference: DecisionQuestionReference): DecisionsHostsPort | null {
  const running = service;
  if (running === null || running.getRole() !== "owner") return null;
  const ownHostId = running.getSettings()?.hostId ?? null;
  if (ownHostId !== null && reference.hostId === ownHostId) return null;
  return getDecisionsHostsPort();
}

/**
 * A Host's answer as a read answers: a link that was down before the read
 * went out says the Host isn't connected; any other failure, a link that
 * went or timed out under the read included, is a failed read to retry.
 */
function answeredByHost<T>(answered: HostCallOutcome<T>): T | { result: "host-not-connected" } {
  if (answered.ok) return answered.value;
  if (answered.failure === "disconnected") return { result: "host-not-connected" };
  throw new Error(`The Remote Host didn't answer the read (${answered.failure})`);
}

/**
 * A Host's answer to a cancel: as a read's, except that a link that went or
 * timed out after the cancel went out says the Host isn't connected too, so
 * the person is told it may not have been withdrawn, and nothing sends it again.
 */
function cancelledByHost(
  answered: HostCallOutcome<DecisionQuestionCancelResult>
): DecisionQuestionCancelResult {
  if (!answered.ok && answered.failure === "outcome-unknown") {
    return { result: "host-not-connected" };
  }
  return answeredByHost(answered);
}

function summaryFromHost(
  reference: DecisionQuestionReference,
  answered: HostCallOutcome<DecisionQuestionSummariesResult>
): DecisionQuestionSummary {
  const { questionId } = reference;
  if (!answered.ok) {
    return answered.failure === "disconnected"
      ? { questionId, result: "host-not-connected" }
      : { questionId, result: "unreadable" };
  }
  if (answered.value.result !== "read") return { questionId, result: "unreadable" };
  return (
    answered.value.summaries.find((summary) => summary.questionId === questionId) ?? {
      questionId,
      result: "not-found",
    }
  );
}

function readOwnQuestionContent(
  reference: DecisionQuestionReference
): Promise<DecisionQuestionContentResult> {
  return whileReading<DecisionQuestionContentResult>(
    (delivery) => delivery.questionContent(referenceScope(reference), reference.questionId),
    { result: "not-running" }
  );
}

function readOwnQuestionImage(
  payload: GetDecisionQuestionImageByReferencePayload
): Promise<DecisionQuestionImagePartResult> {
  const { reference } = payload;
  return whileReading<DecisionQuestionImagePartResult>(
    (delivery) =>
      delivery.questionImage(
        referenceScope(reference),
        reference.questionId,
        payload.attachmentId,
        payload.offset
      ),
    { result: "not-running" }
  );
}

/** Opening lines of this machine's own questions, each reference once, in order. */
function readOwnQuestionSummaries(
  references: readonly DecisionQuestionReference[]
): Promise<DecisionQuestionSummariesResult> {
  return whileReading<DecisionQuestionSummariesResult>(
    async (delivery) => {
      const summaries: DecisionQuestionSummary[] = [];
      for (const reference of references) {
        summaries.push(
          ...(await delivery.questionSummaries(referenceScope(reference), [reference.questionId]))
        );
      }
      return { result: "read", summaries };
    },
    { result: "not-running" }
  );
}

/** This machine runs as a Remote Host now: only then does its owner's Shell read its questions. */
function servingAsHost(): boolean {
  return service?.getRole() === "host";
}

/**
 * One of this Remote Host's own questions read by reference for the owner's
 * Shell that enrolled it (#17230): on this machine only, never routed on to
 * another, and only while this machine runs as a Host, so a machine that has
 * since taken up an owner identity of its own never serves that owner's
 * questions over the link. Never makes or starts the service.
 */
export async function readHostServedQuestion(
  read: DecisionsHostQuestionRead
): Promise<
  DecisionQuestionContentResult | DecisionQuestionImagePartResult | DecisionQuestionSummariesResult
> {
  if (!servingAsHost()) return { result: "off" };
  switch (read.read) {
    case "content":
      return readOwnQuestionContent(read.reference);
    case "image":
      return readOwnQuestionImage(read);
    case "summaries": {
      const seen = new Set<string>();
      return readOwnQuestionSummaries(
        read.references.filter((reference) => {
          if (seen.has(reference.questionId)) return false;
          seen.add(reference.questionId);
          return true;
        })
      );
    }
  }
}

/** The reference's machine, project and terminal, read on this machine only. */
function referenceScope(reference: DecisionQuestionReference): {
  hostId: string;
  projectId: string;
  terminalId: string;
} {
  return {
    hostId: reference.hostId,
    projectId: reference.projectId,
    terminalId: reference.terminalId,
  };
}

/**
 * A person withdrawing one of a pane's questions from that pane's view
 * (#17099), for the view of the project the pane belongs to. Never makes or
 * starts the service. A connection that ended, or a store that stopped,
 * under the cancel answers as not running.
 */
export function cancelDecisionQuestion(
  projectId: string | null,
  payload: CancelDecisionQuestionPayload
): Promise<DecisionQuestionCancelResult> {
  return cancelling((running) => running.cancelQuestion(projectId, payload));
}

/**
 * A person withdrawing a question by its reference (#17229), from any window
 * on this computer: on the Remote Host that asked it when the reference names
 * one (#17230). A link that went before the Host answered says the Host isn't
 * connected, and the cancel isn't sent again. Never makes or starts the service.
 */
/** The person's marks being recorded, one at a time, so none is written over another's. */
let marking: Promise<unknown> = Promise.resolve();

/**
 * The person seeing, clearing or restoring questions on this computer
 * (#17895): recorded in the owner store, which republishes the list once it
 * commits. Nothing goes to the relay, a Host or a terminal. Each question is
 * marked only while the list shows it in Needs you at the ask it was shown
 * with, checked when its turn comes.
 */
export function markDecisionQuestions(
  payload: MarkDecisionQuestionsPayload
): Promise<DecisionQuestionMarkResult> {
  const run = marking.then(() => markQuestionsNow(payload));
  marking = run.catch(() => {});
  return run;
}

async function markQuestionsNow(
  payload: MarkDecisionQuestionsPayload
): Promise<DecisionQuestionMarkResult> {
  const running = service;
  const localStore = running?.getStore() ?? null;
  if (shutDown || running === null || running.getRole() !== "owner" || localStore === null) {
    return { result: "not-running" };
  }
  let text: string | null;
  try {
    text = await localStore.getMeta(QUESTION_MARKS_META_KEY);
  } catch {
    return { result: "failed" };
  }
  // The list read now, after the record: a store let go of meanwhile, Decisions turned off or
  // quit begun while the read waited its turn, lists nothing to mark.
  if (
    shutDown ||
    !listingQuestions ||
    running.getStore() !== localStore ||
    readDecisionsSettings(store).enabled !== true
  ) {
    return { result: "not-running" };
  }
  const record = parseQuestionMarks(text);
  const { marks, marked } = applyQuestionMarks(
    record,
    getDecisionQuestionList().questions,
    payload,
    running.getSettings()?.hostId ?? null,
    listedAsks
  );
  const next = serializeQuestionMarks(marks);
  // Unchanged writes nothing: a commit would only read the list again.
  if (next !== serializeQuestionMarks(record)) {
    try {
      await localStore.setMeta(QUESTION_MARKS_META_KEY, next);
    } catch {
      return { result: "failed" };
    }
  }
  return { result: "marked", marked };
}

export async function cancelDecisionQuestionByReference(
  payload: CancelDecisionQuestionByReferencePayload
): Promise<DecisionQuestionCancelResult> {
  const onHost = hostRouteFor(payload.reference)?.cancelHostQuestion(payload.reference);
  if (onHost) return cancelledByHost(await onHost);
  return cancelOwnQuestion(payload.reference);
}

/**
 * The person withdrawing one of this Remote Host's own questions by
 * reference, for the owner's Shell that enrolled it (#17230): only while
 * this machine runs as a Host, and never routed on to another machine.
 */
export async function cancelHostServedQuestion(
  reference: DecisionQuestionReference
): Promise<DecisionQuestionCancelResult> {
  if (!servingAsHost()) return { result: "off" };
  return cancelOwnQuestion(reference);
}

function cancelOwnQuestion(
  reference: DecisionQuestionReference
): Promise<DecisionQuestionCancelResult> {
  return cancelling((running) => running.cancelQuestionByReference(reference));
}

async function cancelling(
  cancel: (running: DecisionsService) => Promise<DecisionQuestionCancelResult>
): Promise<DecisionQuestionCancelResult> {
  const running = service;
  if (running === null) return { result: "not-running" };
  try {
    return await cancel(running);
  } catch (error) {
    if (error instanceof BridgeError && error.code === "not_found") {
      return { result: "refused", reason: "not-found" };
    }
    const ended =
      (error instanceof BridgeError && error.code === "forbidden") ||
      (error instanceof Error && error.name === "RetiredAttemptError");
    if (ended) return { result: "not-running" };
    throw error;
  }
}

/**
 * The person's answer from Daintree's own view (#17101), signed by this
 * computer when it is the owner's. Never makes or starts the service. A
 * connection that ended, or a store that stopped, under it answers as not
 * running: an answer it committed stays committed, and the same answer id
 * submitted again finds it.
 */
export function answerDecisionQuestion(
  payload: AnswerDecisionQuestionPayload
): Promise<DecisionQuestionAnswerResult> {
  return whileRunning((running) => running.answerQuestion(payload));
}

/** Where a person's answer stands, by its id (#17101). Never makes or starts the service. */
export function getDecisionAnswerResult(
  payload: GetDecisionAnswerResultPayload
): Promise<DecisionAnswerResultRead> {
  return whileRunning((running) => running.getAnswerResult(payload.answerId));
}

/**
 * The person's decline from Daintree's own view (#17239), signed by this
 * computer when it is the owner's, as their answer is. Never makes or starts
 * the service; a decline it committed stays committed, and the same decline
 * id submitted again finds it.
 */
export async function declineDecisionQuestion(
  payload: DeclineDecisionQuestionPayload
): Promise<DecisionQuestionDeclineResult> {
  if (!hostDeclineAdmitted(payload)) return { result: "refused", reason: "not-found" };
  return whileRunning((running) => running.declineQuestion(payload));
}

/**
 * The owner identity each decline of another machine's question was first
 * submitted under, by decline id (#17946), for as long as this process runs.
 */
const hostDeclineOwners = new Map<string, string>();

/**
 * Whether an owner's decline of another machine's question may be signed
 * (#17946). The library signs a decline of a question it holds no copy of by
 * its id and revision alone, so the reference is all that ties it to an
 * enrolled Host: it must name a Host reported to the owner this computer
 * speaks as now, and a decline first submitted under another owner identity
 * is never sent again under this one, whatever its Hosts report. A
 * reference naming this computer is the store's to check.
 */
function hostDeclineAdmitted({ reference, declineId }: DeclineDecisionQuestionPayload): boolean {
  const running = service;
  if (running === null || running.getRole() !== "owner") return true;
  const settings = running.getSettings();
  const ownHostId = settings?.hostId ?? null;
  if (ownHostId === null || reference.hostId === ownHostId) return true;
  const owner = `${settings?.installationId ?? ""}\n${settings?.deviceId ?? ""}`;
  const first = hostDeclineOwners.get(declineId);
  if (first !== undefined && first !== owner) return false;
  const reported = getDecisionsHostsPort()?.hostQuestions() ?? [];
  if (!reported.some((host) => host.questionHostId === reference.hostId)) return false;
  hostDeclineOwners.set(declineId, owner);
  return true;
}

/** Where a person's decline stands, by its id (#17239). Never makes or starts the service. */
export function getDecisionDeclineResult(
  payload: GetDecisionDeclineResultPayload
): Promise<DecisionDeclineResultRead> {
  return whileRunning((running) => running.getDeclineResult(payload.declineId));
}

/**
 * The person's follow-up from Daintree's own view (#17238), signed by this
 * computer when it is the owner's. Never makes or starts the service; a
 * follow-up committed before its connection ended stays committed, and the
 * same message id submitted again finds it.
 */
export function sendDecisionFollowUp(
  payload: SendDecisionFollowUpPayload
): Promise<DecisionQuestionFollowUpResult> {
  return whileRunning((running) => running.sendFollowUp(payload));
}

/** Where a person's follow-up stands, by its id (#17238). Never makes or starts the service. */
export function getDecisionFollowUpResult(
  payload: GetDecisionFollowUpResultPayload
): Promise<DecisionFollowUpResultRead> {
  return whileRunning((running) => running.getFollowUpResult(payload.messageId));
}

/**
 * The person's involvement preference for Daintree's own view (#17237).
 * Never makes or starts the service.
 */
export function getDecisionsInvolvement(): Promise<DecisionsInvolvementRead> {
  return whileRunning((running) => running.getInvolvement());
}

/**
 * The person's change to it from Daintree's own view, signed by this
 * computer when it is the owner's. Never makes or starts the service.
 */
export function setDecisionsInvolvement(
  payload: SetDecisionsInvolvementPayload
): Promise<DecisionsInvolvementSaveResult> {
  return whileRunning((running) => running.setInvolvement(payload));
}

async function whileRunning<T>(
  call: (running: DecisionsService) => Promise<T | { result: "not-running" }>
): Promise<T | { result: "not-running" }> {
  const running = service;
  if (running === null) return { result: "not-running" };
  try {
    return await call(running);
  } catch (error) {
    const ended =
      (error instanceof BridgeError && error.code === "forbidden") ||
      (error instanceof Error && error.name === "RetiredAttemptError");
    if (ended) return { result: "not-running" };
    throw error;
  }
}

/**
 * Checks a relay URL through its unsigned reads (#16005). Needs no identity
 * and never makes or starts the service, and runs beside the switch's
 * transitions rather than behind them, so turning off never waits on a slow
 * relay. Turning off or quitting cancels it: `RelayCheckCancelledError`.
 */
export async function checkRelay(url: string): Promise<DecisionsRelayCheck> {
  if (shutDown || !readDecisionsSettings(store).enabled) throw new RelayCheckCancelledError();
  const controller = new AbortController();
  relayChecks.add(controller);
  return checkDecisionsRelay(url, { signal: controller.signal }).finally(() =>
    relayChecks.delete(controller)
  );
}

function cancelRelayChecks(): void {
  for (const controller of relayChecks) controller.abort();
  relayChecks.clear();
}

function setupRefused(): AppError {
  return new AppError({ code: "CANCELLED", message: "Decisions is off, so nothing was changed" });
}

/** The running lifetime, starting it if boot hasn't yet. */
async function runningService(): Promise<DecisionsService> {
  const settings = readDecisionsSettings(store);
  if (shutDown || !settings.enabled) throw setupRefused();
  const running = await getDecisionsService();
  // The switch on here makes this computer the owner, ending a Host's lifetime if one ran.
  if (running.getSettings() === null || running.getRole() !== "owner") {
    await running.start(settings);
  }
  if (shutDown) throw setupRefused();
  return running;
}

/** The running lifetime's key store, starting the lifetime if boot hasn't yet. */
async function setupKeys(): Promise<{ service: DecisionsService; keys: SetupKeyStore }> {
  const running = await runningService();
  return { service: running, keys: running.getKeyStore() };
}

/**
 * Records a sealed identity in the setting: its origin and ids, and a host id
 * minted for this computer if it has none. The keys are saved first, so a
 * setting that fails to save leaves them for the next attempt to take up.
 * The identity is unverified unless the kit it was restored from holds it
 * whole; a claim always needs a kit saved and verified to finish (#16007).
 */
function recordIdentity(
  running: DecisionsService,
  config: RelayConfig,
  kitVerified: boolean,
  kitKeys: string | null
): DecisionsSettings {
  const current = readDecisionsSettings(store);
  const relayOrigin = normalizeRelayOrigin(config.relayOrigin);
  let saved: DecisionsSettings;
  try {
    saved = writeDecisionsSettings(store, {
      ...current,
      relayOrigin,
      installationId: config.installationId,
      deviceId: config.deviceId,
      hostId: current.hostId ?? newId(),
      // A new identity: nothing the relay refused, or a check saw, before applies to it.
      revokedAt: null,
      setupCheck: null,
      recoveryKit:
        kitVerified && relayOrigin !== null
          ? {
              verifiedAt: Date.now(),
              relayOrigin,
              installationId: config.installationId,
              deviceId: config.deviceId,
              ...(kitKeys !== null ? { keys: kitKeys } : {}),
            }
          : null,
    });
  } catch {
    throw new AppError({
      code: "PERSIST_FAILED",
      message:
        "The keys were saved, but the relay couldn't be recorded in settings. Try again to finish.",
    });
  }
  running.updateSettings(saved);
  forgetOwnerDevices();
  hostEnroller.forget();
  // Hosts connected already hear of this owner now, not at their next connection (#16022).
  getDecisionsHostsPort()?.announceOwnerState();
  return saved;
}

type SetupRun = (options: Pick<RelaySetupOptions, "keys" | "signal">) => Promise<RelaySetupOutcome>;

/**
 * The running lifetime's key file version in the key store's turn, or
 * undefined when it couldn't be read, which no verification is recorded
 * against (#18064).
 */
function keyVersionOf(running: DecisionsService): Promise<string | null | undefined> {
  return Promise.resolve()
    .then(() => running.getKeyStore().version())
    .catch(() => undefined);
}

/** `stillWanted`, when given, is asked as the setup's turn comes, before anything starts. */
function runSetup(run: SetupRun, stillWanted?: () => boolean): Promise<DecisionsConnectResult> {
  return serialize(async () => {
    if (stillWanted && !stillWanted()) {
      throw new AppError({ code: "CANCELLED", message: "The guided deploy was dropped" });
    }
    const { service: running, keys } = await setupKeys();
    const settings = readDecisionsSettings(store);
    if (settings.relayOrigin !== null) {
      return { result: "conflict", origin: settings.relayOrigin, unfinished: false };
    }
    const controller = new AbortController();
    setups.add(controller);
    try {
      const before = await keyVersionOf(running);
      const outcome = await run({ keys, signal: controller.signal });
      if ("failure" in outcome) return outcome.failure;
      // A restore's kit holds the keys it took up unchanged, or the ones it
      // saved to an empty file while the file is still exactly what it wrote;
      // no rotation runs before a relay is recorded.
      const after = outcome.kitVerified ? await keyVersionOf(running) : undefined;
      const kitKeys =
        typeof after === "string" &&
        (before === after ||
          (before === null && after === running.getKeyStore().lastWrittenVersion()))
          ? after
          : null;
      if (shutDown) throw setupRefused();
      recordIdentity(running, outcome.identity, outcome.kitVerified, kitKeys);
      return { result: "saved", status: await getDecisionsStatus() };
    } finally {
      setups.delete(controller);
      // A setup that failed can still have kept staged keys, which the status shows.
      publishStatus();
    }
  });
}

/**
 * Claims a fresh relay and becomes its owner (#16006). The secret goes no
 * further than the claim request: nothing keeps it.
 */
export function claimRelay(payload: ClaimDecisionsRelayPayload): Promise<DecisionsConnectResult> {
  return runSetup((options) => claimDecisionsRelay(payload, options));
}

/**
 * Opens the channel a guided relay deploy's CLI connects to (#16199). The
 * voice settings are read only when the CLI says hello, and only for the
 * answers they prefill: the keys go to the CLI over the channel and nowhere
 * else.
 */
export function prepareRelayDeploy(
  readVoiceSettings: () => VoiceInputSettings
): Promise<PreparedDecisionsRelayDeploy> {
  if (shutDown || !readDecisionsSettings(store).enabled) return Promise.reject(setupRefused());
  return relayDeploys.prepare(() => relayDeployPrefill(readVoiceSettings()));
}

/** Drops a guided deploy whose pane never opened, so its channel stops waiting. */
export function cancelRelayDeploy(deployId: string): void {
  relayDeploys.cancel(deployId);
}

/**
 * Claims the relay a guided deploy created, with the claim secret its CLI
 * handed over, which never leaves main: again, after the claim main made when
 * the deploy completed didn't save (#16200), joining one still in flight. The
 * secret is kept until a claim saves an identity, so a refusal can be tried
 * again this session.
 */
export async function claimDeployedRelay(
  payload: ClaimDeployedDecisionsRelayPayload
): Promise<DecisionsConnectResult> {
  const outcome = await relayDeploys.claim(payload);
  // The claim's own status was read before the deploy recorded how it ended.
  return outcome.result === "saved"
    ? { result: "saved", status: await getDecisionsStatus() }
    : outcome;
}

/** Restores the owner identity of a claimed relay from its recovery kit (#16006). */
export function restoreIdentity(
  payload: RestoreDecisionsIdentityPayload
): Promise<DecisionsConnectResult> {
  return runSetup((options) => restoreDecisionsIdentity(payload, options));
}

/**
 * Saves the setting without the relay's origin and ids, or a revocation of
 * that identity, keeping the switch, consent and preferences.
 */
function forgetRecordedIdentity(): DecisionsSettings {
  return writeDecisionsSettings(store, {
    ...readDecisionsSettings(store),
    relayOrigin: null,
    installationId: null,
    deviceId: null,
    hostId: null,
    revokedAt: null,
    recoveryKit: null,
    setupCheck: null,
  });
}

/** Whether the setting still records exactly the identity a removal started with. */
function stillRecords(record: RemovedRelayRecord): boolean {
  const current = readDecisionsSettings(store);
  return (
    current.relayOrigin === record.relayOrigin &&
    current.installationId === record.installationId &&
    current.deviceId === record.deviceId
  );
}

/**
 * Removes this computer's Decisions identity: the key file, then the relay's
 * origin and ids in the setting. The switch, consent and stored rows stay,
 * and nothing is sent to the relay, so everything on it is untouched. Keys
 * that can't be removed leave the setting as it was. A one-click confirm
 * removes nothing while the keys hold one no current kit covers (#18064).
 */
/**
 * How an erasure of the keys was confirmed (#18064). Settings always names
 * the relay it showed; with none named, the erasure isn't bound to one.
 */
type KeyErasure = Pick<DecisionsKeyErasurePayload, "oneClick"> &
  Partial<Pick<DecisionsKeyErasurePayload, "relayOrigin" | "keys">>;

export async function disconnectRelay(payload: KeyErasure): Promise<DecisionsStatus> {
  return (await disconnectRecorded(null, payload))!;
}

/**
 * Whether erasing the key file now loses nothing a verified kit doesn't
 * hold: there is no file, or the recorded verification is of exactly its
 * version (#18064).
 */
async function keysCoveredOrAbsent(running: DecisionsService): Promise<boolean> {
  return filesCovered(await readKeyFiles(running));
}

/**
 * The key file's version and that of keys an interrupted deletion set aside,
 * which come back before that deletion finishes; undefined when either
 * couldn't be read (#18064).
 */
async function readKeyFiles(
  running: DecisionsService
): Promise<{ held: string | null; setAside: string | null }> {
  const path = running.getKeyFilePath();
  // A file that can't be read is named as such, so a typed confirm of it still matches.
  const read = (at: string) => keyFileVersion(at).catch(() => "unreadable");
  const [held, setAside] = await Promise.all([read(path), read(erasingKeyFilePath(path))]);
  return { held, setAside };
}

/** Each key file there is is exactly what the recorded verification checked. */
function filesCovered(files: { held: string | null; setAside: string | null }): boolean {
  const verified = readDecisionsSettings(store).recoveryKit?.keys;
  const covered = (version: string | null) =>
    version === null || (verified !== undefined && version === verified);
  return covered(files.held) && covered(files.setAside);
}

/** Both files as one opaque version for Settings to name back; null when neither exists. */
function versionOfKeyFiles(files: { held: string | null; setAside: string | null }): string | null {
  if (files.held === null && files.setAside === null) return null;
  return `${files.held ?? "none"}.${files.setAside ?? "none"}`;
}

/**
 * The key files no longer hold what the person confirmed erasing; undefined
 * `confirmed` binds nothing (#18064).
 */
async function keysDifferFromConfirm(
  running: DecisionsService,
  confirmed: string | null | undefined
): Promise<boolean> {
  if (confirmed === undefined) return false;
  return versionOfKeyFiles(await readKeyFiles(running)) !== confirmed;
}

/** Another relay is recorded than the one the person confirmed for (#18064). */
function relayChangedSinceConfirm(expected: string | null | undefined): AppError | null {
  if (expected === undefined || readDecisionsSettings(store).relayOrigin === expected) return null;
  return new AppError({
    code: "FILE_CHANGED_SINCE_REVIEW",
    message:
      "The relay set up on this computer changed after you confirmed, so nothing was removed.",
  });
}

function keysChangedSinceConfirm(): AppError {
  return new AppError({
    code: "FILE_CHANGED_SINCE_REVIEW",
    message:
      "This computer's keys aren't what you confirmed removing: they changed, or no recovery kit verified here holds them now. Nothing was removed.",
  });
}

/**
 * Disconnects, or with `only` set, only while the setting still records that
 * identity, checked before anything is stopped and again in its turn: null
 * when it no longer does, with nothing changed. With `oneClick`, the keys go
 * only while a current kit covers them, checked once no write can land.
 */
function disconnectRecorded(
  only: RemovedRelayRecord | null,
  confirmed: KeyErasure
): Promise<DecisionsStatus | null> {
  if (only !== null && !stillRecords(only)) return Promise.resolve(null);
  // Refused before anything for the relay recorded now is cancelled.
  const early = relayChangedSinceConfirm(confirmed.relayOrigin);
  if (early) return Promise.reject(early);
  cancelKitExports();
  const checkStopped = endSetupCheck();
  return serialize(async () => {
    if (only !== null && !stillRecords(only)) return null;
    const changed = relayChangedSinceConfirm(confirmed.relayOrigin);
    if (changed) throw changed;
    const { service: running, keys } = await setupKeys();
    forgetOwnerDevices();
    hostEnroller.forget();
    // Its question is cancelled on these keys, before they go.
    await checkStopped;
    // The socket and delivery run on these keys, so they stop before the keys
    // go, and a rotation still saving a key finishes first, so none is
    // written after.
    await running.suspendConnection();
    try {
      await running.getKeyRotations().exclusive(async () => {
        // A rotation or another setup from another window may have landed while this waited its turn.
        if (
          (await keysDifferFromConfirm(running, confirmed.keys)) ||
          (confirmed.oneClick && !(await keysCoveredOrAbsent(running)))
        ) {
          throw keysChangedSinceConfirm();
        }
        await keys.clear();
      });
    } catch (error) {
      running.resumeConnection();
      publishStatus();
      throw error;
    }
    try {
      running.updateSettings(forgetRecordedIdentity());
    } finally {
      // The keys are gone even if the setting didn't save.
      publishStatus();
    }
    return getDecisionsStatus();
  });
}

async function fileHolds(path: string, text: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === text;
  } catch {
    return false;
  }
}

/** Picks where an export goes, given the archive's own file name; null when the person cancelled. */
export type ExportDestination = (fileName: string) => Promise<string | null>;

/**
 * Exports this computer's decision history (#16025) as the library's
 * encrypted archive, to a file the person picks. The archive is built behind
 * the switch's transitions, from the running lifetime's store and keys; the
 * save dialog waits outside them, so turning off or quitting never waits on
 * it, and an archive whose store has closed meanwhile is dropped unwritten,
 * so history deleted while the dialog was open is never written out. The
 * file is written whole or not at all, readable only by its owner.
 */
export async function exportData(
  payload: ExportDecisionsDataPayload,
  chooseDestination: ExportDestination
): Promise<DecisionsExportResult> {
  if (payload.passphrase.length < DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH) {
    throw new AppError({
      code: "VALIDATION",
      message: `The passphrase needs at least ${DECISIONS_EXPORT_PASSPHRASE_MIN_LENGTH} characters`,
    });
  }
  const prepared = await serialize(
    async (): Promise<
      | { archive: DecisionsArchive; running: DecisionsService; from: DaintreeLocalStore }
      | { failure: DecisionsExportResult }
    > => {
      const { service: running, keys } = await setupKeys();
      const localStore = running.getStore();
      if (!localStore) return { failure: { result: "store-unavailable" } };
      const built = await buildDecisionsArchive({
        store: localStore,
        keys,
        passphrase: payload.passphrase,
      });
      return "failure" in built ? built : { ...built, running, from: localStore };
    }
  );
  if ("failure" in prepared) return prepared.failure;
  const { archive } = prepared;
  const path = await chooseDestination(archive.fileName);
  if (path === null) return { result: "cancelled" };
  // Back behind the transitions, so no deletion runs between the check and the write.
  return serialize(async (): Promise<DecisionsExportResult> => {
    // The store it was read from has closed (turned off, even if on again
    // since; local data deleted; quit): the history it holds may be gone.
    if (shutDown || prepared.running.getStore() !== prepared.from) return { result: "cancelled" };
    try {
      await resilientAtomicWriteFile(path, archive.text, "utf-8", { mode: 0o600 });
    } catch {
      // The write can fail after the file is in place (syncing its folder), so
      // what is there decides what is said.
      if (!(await fileHolds(path, archive.text))) {
        throw new AppError({
          code: "PERSIST_FAILED",
          message:
            "The archive couldn't be written there, so nothing was saved. Try another folder.",
        });
      }
    }
    return {
      result: "saved",
      path,
      questions: archive.questions,
      auditEvents: archive.auditEvents,
    };
  });
}

/**
 * Deletes the relay's stored questions, answers and attachments (#16025),
 * for the relay the person confirmed. Runs behind the switch's transitions
 * like a setup: turning off waits for its answer, and quitting aborts it.
 * Nothing on this computer changes.
 */
export function deleteRelayData(
  payload: DeleteDecisionsRelayDataPayload
): Promise<DecisionsRelayDeleteResult> {
  return serialize(async () => {
    const { keys } = await setupKeys();
    const controller = new AbortController();
    setups.add(controller);
    try {
      return await deleteDecisionsRelayData({
        origin: payload.origin,
        settings: readDecisionsSettings(store),
        keys,
        signal: controller.signal,
      });
    } finally {
      setups.delete(controller);
    }
  });
}

/**
 * Deletes this computer's Decisions data (#16025): its stored history, its
 * keys and its record of the relay. Nothing is sent to the relay, so
 * everything on it stays. The switch and consent stay as they are. A
 * one-click confirm deletes nothing while the key file holds keys no current
 * kit covers (#18064).
 */
export async function deleteLocalData(payload: KeyErasure): Promise<DecisionsLocalDeleteResult> {
  return (await deleteLocalDataOf(null, payload))!;
}

/** Deletes local data, or with `only` set, only while the setting still records that identity (null otherwise). */
function deleteLocalDataOf(
  only: RemovedRelayRecord | null,
  confirmed: KeyErasure
): Promise<DecisionsLocalDeleteResult | null> {
  if (only !== null && !stillRecords(only)) return Promise.resolve(null);
  const early = relayChangedSinceConfirm(confirmed.relayOrigin);
  if (early) return Promise.reject(early);
  // Before the queue, as a disconnect does: a kit of keys being erased is never written.
  cancelKitExports();
  const checkStopped = endSetupCheck();
  return serialize(async () => {
    if (only !== null && !stillRecords(only)) return null;
    const changed = relayChangedSinceConfirm(confirmed.relayOrigin);
    if (changed) throw changed;
    let outcome: LocalEraseOutcome;
    // Its terminal closes and its question is cancelled in the store before the rows go.
    await checkStopped;
    // Its invitations and requests run on the keys this deletes, and the
    // Hosts' record goes with the rest.
    forgetOwnerDevices();
    hostEnroller.forget();
    try {
      const running = await runningService();
      outcome = await running.eraseLocalData(
        async () =>
          !(await keysDifferFromConfirm(running, confirmed.keys)) &&
          (!confirmed.oneClick || (await keysCoveredOrAbsent(running)))
      );
    } finally {
      // A device read while it ran may hold the key store it closed; the next one makes its own.
      forgetOwnerDevices();
      // The relay record and the keys may have gone, which every window shows.
      publishStatus();
    }
    if (outcome.result === "failed") return outcome;
    const status = await getDecisionsStatus();
    return outcome.result === "deleted"
      ? { result: "deleted", status }
      : { result: "incomplete", erased: outcome.erased, status };
  });
}

/**
 * Forgets a relay its guided removal took out of Cloudflare (#16202): a
 * disconnect, or with `deleteLocalHistory` a local data deletion, and only
 * while the setting records exactly the identity the removal started with.
 */
async function forgetRemovedRelay(
  record: RemovedRelayRecord,
  deleteLocalHistory: boolean
): Promise<DecisionsRelayRemovalLocal> {
  if (!stillRecords(record)) return "changed";
  if (shutDown || !readDecisionsSettings(store).enabled) return "off";
  try {
    if (!deleteLocalHistory) {
      // The guided removal had its own typed confirmation of the Worker's name.
      return (await disconnectRecorded(record, { oneClick: false })) === null
        ? "changed"
        : "forgotten";
    }
    const deleted = await deleteLocalDataOf(record, { oneClick: false });
    if (deleted === null) return "changed";
    return deleted.result === "failed" ? "failed" : deleted.result;
  } catch (error) {
    // Turned off, or quitting, while it waited its turn.
    if (error instanceof AppError && error.code === "CANCELLED") return "off";
    throw error;
  }
}

function relayRemovalsFor(): RelayRemovals {
  if (relayRemovals) return relayRemovals;
  const source = getPtyClient();
  if (!source) {
    throw new AppError({
      code: "UNSUPPORTED",
      message:
        "Terminals aren't available yet, so the removal can't be watched. Try again in a moment.",
    });
  }
  relayRemovals = new RelayRemovals({
    source,
    takeLaunch: takeRelayRemovalLaunch,
    forget: forgetRemovedRelay,
    isShuttingDown: () => shutDown,
    onChanged: () => publishStatus(),
    logWarn: (message) => console.warn(message),
  });
  return relayRemovals;
}

/**
 * Watches a guided removal of a relay from Cloudflare (#16202), before the
 * renderer opens its pane under `terminalId`. The identity recorded now is the
 * one forgotten if the removal exits 0, and only if it is still recorded then.
 */
export function startRelayRemoval(
  payload: StartDecisionsRelayRemovalPayload
): DecisionsRelayRemoval {
  if (shutDown) throw setupRefused();
  const settings = readDecisionsSettings(store);
  const record: RemovedRelayRecord | null =
    settings.relayOrigin !== null && settings.relayOrigin === payload.origin
      ? {
          relayOrigin: settings.relayOrigin,
          installationId: settings.installationId,
          deviceId: settings.deviceId,
        }
      : null;
  const removals = relayRemovalsFor();
  try {
    return removals.start(payload.terminalId, payload.origin, record, payload.deleteLocalHistory);
  } catch (error) {
    throw new AppError({
      code: "VALIDATION",
      message: formatErrorMessage(error, "The removal couldn't be watched"),
    });
  }
}

/**
 * The owner's devices for the identity the setting records, made on first
 * use in an enabled lifetime. Nothing set up yet is an observation, not an
 * error; Decisions off or quitting is refused like a setup.
 */
async function ownerDevicesFor(): Promise<OwnerDevices | DecisionsRelayRequestFailure> {
  const { service: running, keys } = await setupKeys();
  const settings = running.getSettings() ?? readDecisionsSettings(store);
  const { relayOrigin, installationId, deviceId } = settings;
  if (relayOrigin === null || installationId === null || deviceId === null) {
    return { result: "not-set-up" };
  }
  const record = { relayOrigin, installationId, deviceId };
  if (!ownerDevices?.matches(record)) {
    ownerDevices?.dispose();
    ownerDevices = new OwnerDevices({
      ...record,
      keys,
      rotations: running.getKeyRotations(),
      onListed: (devices) => hostEnroller.observeDevices(devices),
    });
  }
  return ownerDevices;
}

/** The phones and Hosts paired with this computer's relay identity (#16009). */
export async function listDevices(): Promise<DecisionsDevicesResult> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.list() : devices;
}

/** The Remote Hosts this computer enrolls, or could (#16021). Asks no Host and no relay. */
export async function listHosts(): Promise<DecisionsHostsResult> {
  await runningService();
  return { ...(await hostEnroller.list()), inboxHostIds: inboxHostIds() };
}

/** Enroll, from Settings: enrolls one connected Host now, whatever automatic enrollment says. */
export async function enrollDecisionsHost(
  hostId: string,
  allowWeakStorage = false
): Promise<DecisionsHostEnrollResult> {
  await runningService();
  return hostEnroller.enroll(hostId, { allowWeakStorage });
}

/**
 * Turns automatic Host enrollment on or off. Turning it on offers every
 * connected Host not yet tried on its current connection its attempt.
 */
export function setAutoEnrollHosts(enabled: boolean): Promise<DecisionsHostsResult> {
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (shutDown || !current.enabled) throw setupRefused();
    const saved = writeDecisionsSettings(store, { ...current, autoEnrollHosts: enabled });
    service?.updateSettings(saved);
    if (saved.autoEnrollHosts) hostEnroller.sweep();
    publishStatus();
    return hostEnroller.list();
  });
}

/** Rises with each turn off of terminal snapshots, so a turn on queued before one never lands after it. */
let terminalSnapshotsOffs = 0;

/**
 * Turns terminal snapshots on or off (#16228). Each turn on needs the
 * person's agreement given just then, and records when; only while on.
 * Off is saved to the store before the queue, since a claim or a start ahead
 * of it can take many seconds and snapshots stop the moment they're turned
 * off. The service hears of it in turn: updating it out of turn would resume
 * a connection a disconnect in the queue had suspended.
 */
export function setDecisionsTerminalSnapshots(
  payload: SetDecisionsTerminalSnapshotsPayload
): Promise<DecisionsStatus> {
  const offs = payload.enabled ? terminalSnapshotsOffs : ++terminalSnapshotsOffs;
  if (!payload.enabled) {
    const current = readDecisionsSettings(store);
    if (current.terminalSnapshots) {
      writeDecisionsSettings(store, { ...current, terminalSnapshots: false });
      // Out of turn on purpose: publishing stops and what was shared is taken back now.
      service?.snapshotsChanged();
      getDecisionsHostsPort()?.announceOwnerState();
    }
  }
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (payload.enabled) {
      if (shutDown || !current.enabled) throw setupRefused();
      if (payload.consent !== true) {
        throw new AppError({
          code: "PERMISSION",
          message: "Terminal snapshots turn on only after you agree to what they send",
        });
      }
      // Turned off since this was asked for, here or in another window: the later off stands.
      if (offs !== terminalSnapshotsOffs) return getDecisionsStatus();
    }
    const saved = writeDecisionsSettings(store, {
      ...current,
      terminalSnapshots: payload.enabled,
      terminalSnapshotsConsentedAt: payload.enabled
        ? Date.now()
        : current.terminalSnapshotsConsentedAt,
    });
    service?.updateSettings(saved);
    service?.snapshotsChanged();
    getDecisionsHostsPort()?.announceOwnerState();
    publishStatus();
    return getDecisionsStatus();
  });
}

/** Rises with each turn off of holding phone pushes, so a turn on queued before one never lands after it. */
let holdPhonePushesOffs = 0;

/**
 * Turns holding phone pushes while the person is here on or off (#17240).
 * Off is saved to the store before the queue, as terminal snapshots' is, so
 * presence stops being reported the moment it's turned off; the service hears
 * of the setting in turn.
 */
export function setDecisionsHoldPhonePushes(enabled: boolean): Promise<DecisionsStatus> {
  const offs = enabled ? holdPhonePushesOffs : ++holdPhonePushesOffs;
  if (!enabled) {
    const current = readDecisionsSettings(store);
    if (current.holdPhonePushes) {
      writeDecisionsSettings(store, { ...current, holdPhonePushes: false });
      service?.presenceChanged();
      // Every window shows it off now, not once the queue reaches it.
      publishStatus();
    }
  }
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (enabled) {
      if (shutDown || !current.enabled) throw setupRefused();
      // Turned off since this was asked for, here or in another window: the later off stands.
      if (offs !== holdPhonePushesOffs) return getDecisionsStatus();
    }
    const saved = writeDecisionsSettings(store, { ...current, holdPhonePushes: enabled });
    service?.updateSettings(saved);
    service?.presenceChanged();
    publishStatus();
    return getDecisionsStatus();
  });
}

/** Rises with each turn off of agent-stopped pushes, so a turn on queued before one never lands after it. */
let agentStoppedPushesOffs = 0;

/**
 * Turns telling the phone when an agent here stops on or off (#17319). Off is
 * saved to the store before the queue, as holding pushes' is, so a batch
 * gathering now is dropped the moment it's turned off; the service hears of
 * the setting in turn.
 */
export function setDecisionsAgentStoppedPushes(enabled: boolean): Promise<DecisionsStatus> {
  const offs = enabled ? agentStoppedPushesOffs : ++agentStoppedPushesOffs;
  if (!enabled) {
    const current = readDecisionsSettings(store);
    if (current.agentStoppedPushes) {
      writeDecisionsSettings(store, { ...current, agentStoppedPushes: false });
      service?.agentStoppedPushesChanged();
      // Every window shows it off now, not once the queue reaches it.
      publishStatus();
    }
  }
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (enabled) {
      if (shutDown || !current.enabled) throw setupRefused();
      // Turned off since this was asked for, here or in another window: the later off stands.
      if (offs !== agentStoppedPushesOffs) return getDecisionsStatus();
    }
    const saved = writeDecisionsSettings(store, { ...current, agentStoppedPushes: enabled });
    service?.updateSettings(saved);
    service?.agentStoppedPushesChanged();
    publishStatus();
    return getDecisionsStatus();
  });
}

/**
 * Whether a terminal snapshot may be captured or published now (#16228):
 * Decisions on in this run, and snapshots on with the person's agreement.
 * Read from the store each time, so it answers false as soon as either is
 * turned off, whatever the queue still holds.
 */
export function terminalSnapshotsAllowed(): boolean {
  const settings = readDecisionsSettings(store);
  return !shutDown && settings.enabled && settings.terminalSnapshots;
}

/**
 * The same for an enrolled Host's own panes (#16230): it serves them, and
 * its owner's Shell last said snapshots are on. A Host away from its owner
 * keeps what it was last told, as it keeps running questions.
 */
function hostSnapshotsAllowed(): boolean {
  const record = readHostRecord(store);
  return !shutDown && hostRecordServes(record) && record?.ownerTerminalSnapshots === true;
}

/** Makes a one-time invitation for a phone to pair (#16009). */
export async function startPairing(): Promise<DecisionsPairingStartResult> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.invite() : devices;
}

/** Whether a phone has answered an invitation this computer made, and its code. */
export async function readPairing(pairingId: string): Promise<DecisionsPairingState> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.read(pairingId) : devices;
}

/** Approves the phone whose code the person saw match on both screens. */
export async function approvePairing(
  payload: ApproveDecisionsPairingPayload
): Promise<DecisionsPairingApproveResult> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.approve(payload) : devices;
}

/** Rejects an invitation on the relay: a code that didn't match, or a pairing given up. */
export async function declinePairing(pairingId: string): Promise<DecisionsPairingDeclineResult> {
  const devices = await ownerDevicesFor();
  return devices instanceof OwnerDevices ? devices.decline(pairingId) : devices;
}

/** The rules questions are asked under (#16013): the trusted gates and the default expiry. */
export function getDecisionsPolicy(): DecisionsPolicy {
  return decisionsPolicyOf(readDecisionsSettings(store), policyRevision);
}

/**
 * Saves one field of the policy over the setting as it stands when its turn
 * comes, so a save of another field queued meanwhile is kept. The running
 * lifetime's policy changes in place, so the next question is asked under it;
 * questions already asked keep what they were asked with.
 */
function savePolicy(change: Partial<PolicySettings>): Promise<DecisionsPolicy> {
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (shutDown || !current.enabled) throw setupRefused();
    const saved = writeDecisionsSettings(store, { ...current, ...change });
    policyRevision += 1;
    service?.updateSettings(saved);
    // The policy has no push of its own: Settings in other windows reads it
    // again on a status change, so one goes out with every save.
    publishStatus();
    return decisionsPolicyOf(saved, policyRevision);
  });
}

/**
 * How long a question asked on this computer waits when its agent sets no
 * expiry (#16122): one of the choices Settings offers, or null for never.
 * Anything else is refused rather than saved as the default.
 */
export function setDecisionsDefaultQuestionExpiry(ms: number | null): Promise<DecisionsPolicy> {
  if (!isQuestionExpiryChoice(ms)) {
    return Promise.reject(
      new AppError({
        code: "VALIDATION",
        message: "That expiry isn't one Settings offers",
      })
    );
  }
  return savePolicy({ defaultQuestionExpiryMs: ms });
}

/**
 * Switches one agent's `ask_human` on or off (#16223), over the setting as it
 * stands when its turn comes, so a change to another agent queued meanwhile
 * is kept. Only launches from now on read it: an agent already running keeps
 * what it launched with, and the running lifetime has nothing to update.
 */
export function setDecisionsAgentAskHuman(
  payload: SetDecisionsAgentAskHumanPayload
): Promise<DecisionsPolicy> {
  const { agentId, enabled } = payload;
  if (!isAskHumanAgentId(agentId)) {
    return Promise.reject(
      new AppError({ code: "VALIDATION", message: "That isn't an agent Daintree knows" })
    );
  }
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (shutDown || !current.enabled) throw setupRefused();
    if (current.askHumanAgents.includes(agentId) === enabled) {
      return decisionsPolicyOf(current, policyRevision);
    }
    if (enabled && current.askHumanAgents.length >= MAX_ASK_HUMAN_AGENTS) {
      throw new AppError({
        code: "VALIDATION",
        message: "Too many agents are switched on. Switch one off first.",
      });
    }
    const saved = writeDecisionsSettings(store, {
      ...current,
      askHumanAgents: enabled
        ? [...current.askHumanAgents, agentId]
        : current.askHumanAgents.filter((id) => id !== agentId),
    });
    policyRevision += 1;
    // Like the rest of the policy, Settings in other windows reads it again on a status change.
    publishStatus();
    return decisionsPolicyOf(saved, policyRevision);
  });
}

/**
 * The decision model changed (#16027). Like the policy it has no push of its
 * own: Settings reads it again on a status change.
 */
function publishModelChanged(): void {
  modelRevision += 1;
  publishStatus();
}

/** The owner lifetime's model, which only exists while learning is on and the store is open. */
function ownerModel(action: string): DecisionModelRuntime {
  const settings = readDecisionsSettings(store);
  if (shutDown || !settings.enabled) throw setupRefused();
  const model = service?.getRole() === "owner" ? service.getDecisionModel() : null;
  if (model === null || !settings.modelLearning) {
    throw new AppError({ code: "PERMISSION", message: `Turn on learning to ${action}` });
  }
  return model;
}

/**
 * The decision model as Settings shows it (#16027): the preferences as
 * saved, and what the owner lifetime's model observes. Learning off reads
 * whether a history is still stored, and opens nothing.
 */
export function getDecisionsModel(): DecisionsModelState {
  const settings = readDecisionsSettings(store);
  const owner = service !== null && service.getRole() === "owner" ? service : null;
  const snapshot = owner?.getDecisionModel()?.snapshot() ?? null;
  let history: DecisionsModelHistory;
  if (!settings.modelLearning) {
    const files = owner?.getDecisionModelFiles() ?? decisionModelFiles(decisionsKeyFilePath());
    history = { state: "closed", stored: existsSync(files.history) };
  } else if (snapshot !== null && snapshot.historyCount !== null) {
    history = { state: "open", count: snapshot.historyCount };
  } else {
    history = { state: "unavailable" };
  }
  const evaluation = settings.modelLearning ? (snapshot?.evaluation ?? null) : null;
  return {
    revision: modelRevision,
    learning: settings.modelLearning,
    adapter: settings.modelAdapter,
    ...(settings.modelConsentedAt === null ? {} : { consentedAt: settings.modelConsentedAt }),
    history,
    evaluation: evaluation === null ? null : describeEvaluation(evaluation),
    running: snapshot?.running ?? null,
    lastRun: snapshot?.lastRun ?? null,
    answeringFrom: snapshot?.answeringFrom ?? null,
  };
}

/**
 * Saves the decision model's preferences (#16027) and waits for the model to
 * take them. Learning turns on only once the person has agreed to what it
 * keeps and sends: `consent` records that the first time, and a later turn
 * on keeps the original time. Only while on.
 */
export function setDecisionsModel(payload: SetDecisionsModelPayload): Promise<DecisionsModelState> {
  return serialize(async () => {
    const current = readDecisionsSettings(store);
    if (shutDown || !current.enabled) throw setupRefused();
    const consent = payload.consent === true;
    if (payload.learning && !consent && current.modelConsentedAt === null) {
      throw new AppError({
        code: "PERMISSION",
        message: "Learning turns on only after you agree to what it keeps and sends",
      });
    }
    const modelConsentedAt = current.modelConsentedAt ?? (consent ? Date.now() : null);
    const saved = writeDecisionsSettings(store, {
      ...current,
      modelLearning: payload.learning,
      modelAdapter: payload.adapter,
      modelConsentedAt,
    });
    service?.updateSettings(saved);
    await service?.getDecisionModel()?.settled();
    publishModelChanged();
    return getDecisionsModel();
  });
}

/**
 * Starts evaluating the chosen CLI against the person's own history, or
 * answers the evaluation already running. It runs outside the transitions,
 * since it can take many minutes, and goes on when Settings closes.
 */
export function startDecisionsModelEvaluation(): Promise<DecisionsModelState> {
  return serialize(async () => {
    const model = ownerModel("evaluate the decision model");
    try {
      model.startEvaluation();
    } catch {
      throw new AppError({
        code: "PERMISSION",
        message:
          readDecisionsSettings(store).modelAdapter === null
            ? "Choose an agent CLI to evaluate the decision model"
            : "The decision model's history isn't open, so it can't be evaluated",
      });
    }
    return getDecisionsModel();
  });
}

/** Cancels the evaluation running, if it is the one named. */
export function cancelDecisionsModelEvaluation(
  payload: CancelDecisionsModelEvaluationPayload
): DecisionsModelState {
  const model = service?.getRole() === "owner" ? service.getDecisionModel() : null;
  model?.cancelEvaluation(payload.runId);
  return getDecisionsModel();
}

/**
 * Saves whether the person lets the decision model answer in their place
 * (#18062) over the setting as it stands now, since a relay revocation can be
 * written outside the transitions and an older read would undo it. The
 * running model takes a withdrawal at once.
 */
function saveAnswerConsent(allowed: boolean): void {
  const current = readDecisionsSettings(store);
  if (current.proxyAllowlisted === allowed) return;
  service?.updateSettings(writeDecisionsSettings(store, { ...current, proxyAllowlisted: allowed }));
}

/**
 * Chooses the confidence the model answers automatically from, for the
 * evaluation it was chosen from, or stops automatic answers with null. It is
 * the one choice that lets the model answer in the person's place (#18062):
 * a confidence also lets a question without a gate take a proxy answer while
 * the model is armed, and null withdraws that. A threshold saved before this
 * choice existed stays unarmed until the person chooses again.
 */
export function setDecisionsModelThreshold(
  payload: SetDecisionsModelThresholdPayload
): Promise<DecisionsModelState> {
  return serialize(async () => {
    const model = ownerModel("choose when the decision model answers");
    const evaluation = model.getEvaluation();
    if (evaluation === null || evaluation.evaluatedAt !== payload.evaluatedAt) {
      throw new AppError({
        code: "STALE_GENERATION",
        message: "The decision model's evaluation changed. Read the new report first.",
      });
    }
    if (
      payload.threshold !== null &&
      !thresholdSupported(evaluation.report.calibration, payload.threshold)
    ) {
      throw new AppError({
        code: "VALIDATION",
        message: "That confidence isn't one the evaluation supports answering from",
      });
    }
    if (payload.threshold === null) {
      // Withdrawn from the running model first, so it stops answering at once,
      // even if neither the setting nor the file can be written.
      model.withdrawConsent();
      try {
        saveAnswerConsent(false);
      } catch (error) {
        console.warn(
          "[Decisions] Automatic answers weren't withdrawn in the setting:",
          error instanceof Error ? error.name : typeof error
        );
      }
    }
    try {
      await model.setAutoAnswerThreshold(payload.threshold, payload.evaluatedAt);
    } catch (error) {
      // A new report stored while this waited its turn.
      if (error instanceof Error && error.name === "StaleEvaluationError") {
        throw new AppError({
          code: "STALE_GENERATION",
          message: "The decision model's evaluation changed. Read the new report first.",
        });
      }
      console.warn(
        "[Decisions] The decision model's threshold wasn't saved:",
        error instanceof Error ? error.name : typeof error
      );
      throw new AppError({
        code: "INTERNAL",
        message: "The choice couldn't be saved. Try again.",
      });
    }
    if (payload.threshold !== null) {
      // After the threshold, so the model arms only at the confidence just
      // chosen. With consent already saved, the threshold was the whole save.
      const current = readDecisionsSettings(store);
      if (!current.proxyAllowlisted) {
        if (shutDown || !current.enabled) throw setupRefused();
        try {
          saveAnswerConsent(true);
        } catch (error) {
          console.warn(
            "[Decisions] Automatic answers weren't allowed in the setting:",
            error instanceof Error ? error.name : typeof error
          );
          throw new AppError({
            code: "INTERNAL",
            message: "The choice couldn't be saved. Try again.",
          });
        }
      }
      await model.grantConsent();
    }
    return getDecisionsModel();
  });
}

/**
 * Deletes what the decision model learned (#16027): its history and
 * evaluation, with learning on or off. Behind the transitions, so learning
 * can't turn on while its files go. Only while on.
 */
export function clearDecisionsModelHistory(): Promise<DecisionsModelState> {
  return serialize(async () => {
    const settings = readDecisionsSettings(store);
    if (shutDown || !settings.enabled) throw setupRefused();
    const running = await runningService();
    try {
      await running.clearModelHistory();
    } catch (error) {
      console.warn(
        "[Decisions] The decision model's history wasn't cleared:",
        error instanceof Error ? error.name : typeof error
      );
      throw new AppError({
        code: "INTERNAL",
        message: "The decision model's history couldn't be deleted. Try again.",
      });
    } finally {
      publishModelChanged();
    }
    return getDecisionsModel();
  });
}

function cancelKitExports(): void {
  for (const controller of kitExports) controller.abort();
  kitExports.clear();
}

function kitExportCancelled(): AppError {
  return new AppError({
    code: "CANCELLED",
    message: "Decisions was turned off or disconnected, so the recovery kit wasn't saved",
  });
}

/**
 * `start()`'s answer, unless the export is cancelled first: one already
 * cancelled starts nothing, and a later answer is dropped.
 */
function unlessCancelled<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(kitExportCancelled());
  const work = start();
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(kitExportCancelled());
    signal.addEventListener("abort", cancel, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      }
    );
  });
}

function sameRecord(a: RecordedIdentity | null, b: RecordedIdentity): boolean {
  return (
    a !== null &&
    a.relayOrigin === b.relayOrigin &&
    a.installationId === b.installationId &&
    a.deviceId === b.deviceId
  );
}

/** The kit's suggested file name, after the relay it belongs to. */
function kitFileName(relayOrigin: string): string {
  const host = new URL(relayOrigin).hostname.replace(/[^A-Za-z0-9.-]+/g, "-");
  return `decisions-recovery-kit-${host}.json`;
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([stat(a), stat(b)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/**
 * Writes the kit where the person chose, owner-only, replacing any file
 * there whole or not at all, then reads it back, so a kit that didn't land
 * as made is said now rather than found out when it is needed.
 */
async function writeKitFile(
  path: string,
  text: string,
  keyFilePath: string,
  signal: AbortSignal
): Promise<void> {
  if (await sameDirectory(dirname(path), dirname(keyFilePath))) {
    throw new AppError({
      code: "INVALID_PATH",
      message:
        "That folder holds Daintree's own copy of the keys. Save the kit somewhere else, away from this computer if you can.",
    });
  }
  // Quit doesn't wait for the transitions, so it can land during the check above.
  if (signal.aborted) throw kitExportCancelled();
  let written: string;
  try {
    await resilientAtomicWriteFile(path, text, "utf-8", { mode: OWNER_RW_FILE_MODE });
    written = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new AppError({
      code: "PERSIST_FAILED",
      message: `The recovery kit couldn't be saved to ${basename(path)}${code ? ` (${code})` : ""}. Choose another location.`,
    });
  }
  if (written !== text) {
    throw new AppError({
      code: "PERSIST_FAILED",
      message: `${basename(path)} didn't read back as it was saved. Save the kit again, somewhere else if this repeats.`,
    });
  }
}

/**
 * Saves a recovery kit of this computer's identity (#16007): the kit is made
 * from the sealed keys behind the switch's transitions, the person picks
 * where it goes with `choosePath` (null when they cancel), and it is written
 * behind them again, only if the same identity is still set up. Saving never
 * finishes setup: the saved file has to be verified. The passphrase is used
 * to lock the kit and kept nowhere.
 */
export async function exportRecoveryKit(
  payload: ExportDecisionsRecoveryKitPayload,
  choosePath: (defaultName: string) => Promise<string | null>
): Promise<DecisionsKitExportResult> {
  const controller = new AbortController();
  kitExports.add(controller);
  try {
    const made = await serialize(async () => {
      try {
        const { keys } = await setupKeys();
        return await makeRecoveryKit(keys, readDecisionsSettings(store), payload.passphrase);
      } finally {
        // The dialog can stay open for minutes; the passphrase has done its
        // work once the kit is locked, so Decisions holds it no longer. The
        // IPC call's own arguments last until it returns.
        payload.passphrase = "";
      }
    });
    if ("failure" in made) return made.failure;
    const path = await unlessCancelled(
      () => choosePath(kitFileName(made.recorded.relayOrigin)),
      controller.signal
    );
    if (path === null) return { result: "cancelled" };
    return await serialize(async () => {
      const settings = readDecisionsSettings(store);
      const running = await settledService();
      if (
        controller.signal.aborted ||
        shutDown ||
        !settings.enabled ||
        running === null ||
        !sameRecord(recordedIdentity(settings), made.recorded)
      ) {
        throw kitExportCancelled();
      }
      await writeKitFile(path, made.text, running.getKeyFilePath(), controller.signal);
      return { result: "saved" as const, fileName: basename(path) };
    });
  } finally {
    kitExports.delete(controller);
  }
}

/**
 * Checks a saved kit file against this computer's identity (#16007) and, if
 * it holds it whole, records that it was verified, which finishes setup.
 * The kit and passphrase go no further than the check.
 */
export function verifyRecoveryKit(
  payload: VerifyDecisionsRecoveryKitPayload
): Promise<DecisionsKitVerifyResult> {
  return serialize(async () => {
    const { service: running, keys } = await setupKeys();
    const before = await keyVersionOf(running);
    const checked = await checkRecoveryKit(
      keys,
      readDecisionsSettings(store),
      payload.kit,
      payload.passphrase
    );
    if ("failure" in checked) return checked.failure;
    // Equal on both sides of the check's load, so it is the version the kit
    // was checked against; a write between leaves the kit not current.
    const after = await keyVersionOf(running);
    if (shutDown) throw setupRefused();
    const current = readDecisionsSettings(store);
    let saved: DecisionsSettings;
    try {
      saved = writeDecisionsSettings(store, {
        ...current,
        recoveryKit: {
          verifiedAt: Date.now(),
          ...checked.verified,
          ...(typeof before === "string" && before === after ? { keys: before } : {}),
        },
      });
    } catch {
      throw new AppError({
        code: "PERSIST_FAILED",
        message: "The kit checked out, but that couldn't be recorded in settings. Verify it again.",
      });
    }
    running.updateSettings(saved);
    // Other windows' Settings show setup finished too.
    publishStatus();
    return { result: "verified", status: await getDecisionsStatus() };
  });
}

/**
 * Revokes a paired device and rotates the key for the rest (#16010). The
 * person confirmed it in Settings, which says what it can't recall.
 */
export async function revokeDevice(deviceId: string): Promise<DecisionsRevokeDeviceResult> {
  const devices = await ownerDevicesFor();
  if (!(devices instanceof OwnerDevices)) return devices;
  const result = await devices.revoke(deviceId);
  if (result.result === "revoked") publishDevicesChanged();
  return result;
}

/** Rotates the key without revoking anyone (#16010). */
export async function rotateKeys(): Promise<DecisionsRotateKeysResult> {
  const devices = await ownerDevicesFor();
  if (!(devices instanceof OwnerDevices)) return devices;
  const result = await devices.rotate();
  if (result.result === "rotated") publishDevicesChanged();
  return result;
}

/**
 * This machine as a Remote Host its owner enrolled (#16022). It serves its own
 * panes with its own `desktop-host` identity, Shell or no Shell, until its
 * owner's Shell says Decisions is off or the relay revokes its device. Each
 * change to what it reports is heard here, so its link can tell the owner.
 */
const hostRuntimeListeners = new Set<() => void>();

function publishHostRuntime(): void {
  if (shutDown) return;
  for (const listener of [...hostRuntimeListeners]) {
    try {
      listener();
    } catch (err) {
      console.warn("[Decisions] A Host report listener threw:", err);
    }
  }
}

/** Calls `listener` whenever what this Host reports may have changed. */
export function onDecisionsHostRuntimeChanged(listener: () => void): () => void {
  hostRuntimeListeners.add(listener);
  return () => {
    hostRuntimeListeners.delete(listener);
  };
}

/**
 * What this Host reports of its own Decisions to `owner`'s Shell: not
 * enrolled, unless it was enrolled by that owner.
 */
export function decisionsHostRuntimeFor(
  owner: Pick<OwnerStateAnnouncement, "installationId" | "ownerDeviceId">
): DecisionsHostRuntime {
  const record = readHostRecord(store);
  if (
    record === null ||
    record.installationId !== owner.installationId ||
    record.ownerDeviceId !== owner.ownerDeviceId
  ) {
    return { state: "not-enrolled" };
  }
  const running = service !== null && service.getRole() === "host" ? service : null;
  return hostRuntimeOf(
    record,
    running?.getStatus() ?? null,
    running?.getQuestionPolicy() ?? IDLE_HOST_QUESTION_POLICY
  );
}

/**
 * What a Host reports of how it asks while no Host lifetime runs (#17942):
 * nothing settles an advisory question then, so its agents can't ask one.
 */
const IDLE_HOST_QUESTION_POLICY: DecisionsHostQuestionPolicy = {
  advisoryQuestions: false,
  defaultQuestionExpiryMs: HOST_DEFAULT_QUESTION_EXPIRY_MS,
};

/**
 * Runs the Host lifetime the record calls for while the owner's switch here
 * is off: started while it serves, a revoked Host's removal finished,
 * stopped otherwise. Always inside the switch's transitions.
 */
async function reconcileHostLifetime(): Promise<void> {
  if (shutDown || readDecisionsSettings(store).enabled) return;
  const record = readHostRecord(store);
  if (record !== null && hostRecordServes(record)) {
    const next = await getDecisionsService();
    await next.start(hostLifetimeSettings(record), "host");
  } else if (record?.revokedAt != null && record.credentialsRemovedAt === null) {
    await removeHostCredentials(record);
  } else {
    const running = await settledService();
    if (running?.getRole() === "host") await running.stop();
  }
  publishHostRuntime();
}

/**
 * Removes a revoked Host's delivery credentials: its keys, only while the
 * key file still holds that device's (an enrollment may have saved another's
 * meanwhile), and the questions stored for it, which no later device of this
 * Host could have answered. Its lifetime stops first. Recorded as removed
 * only once both are gone; what fails is tried again at the next start.
 */
async function removeHostCredentials(record: DecisionsHostRecord): Promise<void> {
  const next = await getDecisionsService();
  try {
    if (next.getRole() === "host") await next.stop();
    await next.clearHostKeys(record.deviceId);
    await next.eraseStoredRows();
  } catch (err) {
    console.warn("[Decisions] A revoked Host's keys couldn't be removed yet:", err);
    return;
  }
  const current = readHostRecord(store);
  if (current?.deviceId === record.deviceId && current.revokedAt !== null) {
    writeHostRecord(store, { ...current, credentialsRemovedAt: Date.now() });
  }
}

/** The relay revoked this Host's device: recorded, then the Host stops and its credentials go. */
function hostRevoked(relay: RelayBinding): Promise<void> {
  return serialize(async () => {
    const record = readHostRecord(store);
    if (
      record === null ||
      record.relayOrigin !== relay.relayOrigin ||
      record.installationId !== relay.installationId ||
      record.deviceId !== relay.deviceId
    ) {
      return;
    }
    let current = record;
    if (record.revokedAt === null) {
      try {
        current = writeHostRecord(store, { ...record, revokedAt: Date.now() });
      } catch (err) {
        // Stopped all the same: the relay refuses the device whatever is saved.
        console.warn("[Decisions] A Host's revocation couldn't be recorded:", err);
      }
    }
    publishHostRuntime();
    if (shutDown || readDecisionsSettings(store).enabled) return;
    await removeHostCredentials(current);
    publishHostRuntime();
  });
}

/**
 * This machine holds `held` as its Remote Host identity, just accepted or
 * read (#16022). A record naming that device already stands as it is (turned
 * off or revoked included); otherwise the record names it now, off if the
 * owner's Shell last said Decisions is off (`ownerEnabled`), and its lifetime
 * starts. The questions stored for a device it replaced go first: only the
 * device that asked could have them answered. While they can't be removed,
 * the record stays as it was, and the next read tries again.
 */
export function noteHostIdentity(
  held: HeldHost,
  options: { ownerEnabled?: boolean } = {}
): Promise<void> {
  return serialize(async () => {
    if (shutDown) return;
    const relayOrigin = normalizeRelayOrigin(held.relayOrigin);
    if (relayOrigin === null) return;
    const previous = readHostRecord(store);
    if (
      previous !== null &&
      previous.relayOrigin === relayOrigin &&
      previous.installationId === held.installationId &&
      previous.deviceId === held.deviceId
    ) {
      return;
    }
    if (previous !== null) {
      try {
        const running = await getDecisionsService();
        if (running.getRole() === "host") await running.stop();
        await running.eraseStoredRows();
      } catch (err) {
        console.warn(
          "[Decisions] A replaced Host device's questions couldn't be removed yet:",
          err
        );
        return;
      }
    }
    writeHostRecord(store, {
      relayOrigin,
      installationId: held.installationId,
      deviceId: held.deviceId,
      ownerDeviceId: held.ownerDeviceId,
      hostId: previous?.hostId ?? newId(),
      ownerOffAt: options.ownerEnabled === false ? Date.now() : null,
      revokedAt: null,
      credentialsRemovedAt: null,
      // What the owner says of snapshots comes after it is taken up, as its latest announcement.
      ownerTerminalSnapshots: false,
    });
    await reconcileHostLifetime();
  });
}

/**
 * What the owner's Shell says of its Decisions (#16022): off stops this Host
 * and keeps its keys, so it carries on where it left off; on starts it
 * again. Only the owner its certificate chains to is heard, and a revoked
 * Host stays stopped. Answers what it then reports to that owner.
 */
export function applyOwnerState(input: OwnerStateAnnouncement): Promise<DecisionsHostRuntime> {
  // Snapshots off goes into the record ahead of the queue, as the owner's own switch does.
  if (!input.terminalSnapshots) stopHostSnapshots(input);
  return serialize(async () => {
    const record = readHostRecord(store);
    if (
      !shutDown &&
      record !== null &&
      record.revokedAt === null &&
      record.installationId === input.installationId &&
      record.ownerDeviceId === input.ownerDeviceId
    ) {
      const off = record.ownerOffAt !== null;
      const ownerOffAt =
        off !== input.enabled ? record.ownerOffAt : input.enabled ? null : Date.now();
      if (
        ownerOffAt !== record.ownerOffAt ||
        record.ownerTerminalSnapshots !== input.terminalSnapshots
      ) {
        writeHostRecord(store, {
          ...record,
          ownerOffAt,
          ownerTerminalSnapshots: input.terminalSnapshots,
        });
      }
      await reconcileHostLifetime();
      if (service?.getRole() === "host") service.snapshotsChanged();
    }
    return decisionsHostRuntimeFor(input);
  });
}

/** The owner's Shell said its terminal snapshots are off: this Host stops sharing its panes' at once. */
function stopHostSnapshots(
  owner: Pick<OwnerStateAnnouncement, "installationId" | "ownerDeviceId">
) {
  const record = readHostRecord(store);
  if (
    record?.ownerTerminalSnapshots !== true ||
    record.installationId !== owner.installationId ||
    record.ownerDeviceId !== owner.ownerDeviceId
  ) {
    return;
  }
  writeHostRecord(store, { ...record, ownerTerminalSnapshots: false });
  if (service?.getRole() === "host") service.snapshotsChanged();
}

/** How long a launch waits for `/mcp/decisions` before going ahead without it. */
const LAUNCH_ROUTE_WAIT_MS = 5_000;

/** `promise`'s value, or null once `ms` pass or if it rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

/**
 * The running lifetime once its start has finished. Always behind the switch's
 * transitions, never on `getSettings()` alone: a start sets the settings
 * before its store opens and its connection is made, so a launch that came
 * in between would find nothing pending and miss the route.
 */
async function startedLifetime(): Promise<DecisionsService | null> {
  await startDecisionsIfEnabled();
  return service?.getSettings() ? service : null;
}

/** This machine's lifetime serves panes: the owner's switch is on, or it is an enrolled Host (#16022). */
function servesPanes(): boolean {
  return readDecisionsSettings(store).enabled || hostRecordServes(readHostRecord(store));
}

/**
 * The listener port an agent launch points `daintree-decisions` at (#16012),
 * once this lifetime takes questions. Null while off or quitting, with no
 * relay identity or a connection that stopped, and when the route isn't
 * there within the wait. Panes restored at startup launch before boot's
 * deferred start, so this starts the lifetime itself; and it waits a bounded
 * time, so no launch hangs on a keychain prompt or a setup queued ahead.
 */
export async function decisionsLaunchPort(): Promise<number | null> {
  if (shutDown || !servesPanes()) return null;
  const deadline = Date.now() + LAUNCH_ROUTE_WAIT_MS;
  const running = await within(startedLifetime(), LAUNCH_ROUTE_WAIT_MS);
  const remaining = deadline - Date.now();
  if (running === null || shutDown || remaining <= 0) return null;
  return within(running.questionsPort(remaining), remaining);
}

/** A run forgotten with the identity it ran on is shown nowhere, however it ends. */
function publishSetupCheck(check: SetupCheck, run: DecisionsSetupCheckRun): void {
  if (check !== shownCheck) return;
  lastSetupRun = run;
  if (!shutDown) sendToLocalViews("decisions:setup-check-changed", run);
}

/**
 * Records a check that ran to the end against the identity it checked, if
 * it wasn't called off by a change to what it checks and the setting still
 * records that identity. A cancelled run records nothing.
 */
function recordSetupCheck(
  relay: { relayOrigin: string; installationId: string; deviceId: string },
  check: SetupCheck,
  run: DecisionsSetupCheckRun
): void {
  if (shutDown || check !== shownCheck) return;
  if (run.state !== "passed" && run.state !== "failed") return;
  const current = readDecisionsSettings(store);
  if (
    current.relayOrigin !== relay.relayOrigin ||
    current.installationId !== relay.installationId ||
    current.deviceId !== relay.deviceId
  ) {
    return;
  }
  // Written to the store alone: the status reads it from there, the service
  // reads nothing of it, and updating the service's settings would resume a
  // connection a disconnect had suspended.
  try {
    writeDecisionsSettings(store, {
      ...current,
      setupCheck: {
        checkedAt: run.finishedAt ?? Date.now(),
        ...relay,
        failedStep: check.failedStep(),
      },
    });
  } catch {
    console.warn("[Decisions] The setup check's result couldn't be recorded in settings");
    return;
  }
  publishStatus();
}

/**
 * Runs the setup check (#16024) against the identity set up here: the whole
 * loop, from the relay's health to a test question answered on a phone and
 * typed into a diagnostic terminal. One at a time; asking while one runs
 * answers that one. It runs beside the switch's transitions, since it waits
 * on a person, and turning off, a disconnect, a deletion or quit cancels it.
 */
export function startSetupCheck(): Promise<DecisionsSetupCheckStartResult> {
  if (setupCheck) return Promise.resolve({ result: "running", run: setupCheck.snapshot() });
  // Admitted behind the switch's transitions, so a start can't slip in while
  // a turn-off, disconnect or deletion is under way; the run itself waits on
  // a person outside them.
  const epoch = setupCheckEpoch;
  return serialize(() => admitSetupCheck(epoch));
}

async function admitSetupCheck(epoch: number): Promise<DecisionsSetupCheckStartResult> {
  // Turned off, disconnected, deleted or quit since it was asked for.
  if (epoch !== setupCheckEpoch) throw setupRefused();
  const running = await runningService();
  if (epoch !== setupCheckEpoch) throw setupRefused();
  // Another start, ahead of this one in the queue, made one.
  const raced = setupCheck as SetupCheck | null;
  if (raced) return { result: "running", run: raced.snapshot() };
  const settings = running.getSettings() ?? readDecisionsSettings(store);
  const { relayOrigin, installationId, deviceId, hostId } = settings;
  if (relayOrigin === null || installationId === null || deviceId === null || hostId === null) {
    return { result: "not-set-up" };
  }
  if (settings.revokedAt !== null || running.getStatus().state === "revoked") {
    return { result: "revoked" };
  }
  const relay = { relayOrigin, installationId, deviceId };
  const check = new SetupCheck(
    {
      relay: { ...relay, hostId },
      checkRelay: (origin, signal) => checkDecisionsRelay(origin, { signal }),
      questionSource: () => running.getQuestionSource(),
      refreshConnection: () => running.refreshConnection(),
      status: () => running.getStatus(),
      onStatus: (listener) => running.onStatusChanged((event) => listener(event.status)),
      onCommit: (listener) => running.getStore()?.onCommit(listener) ?? (() => {}),
      diagnostics: setupDiagnostics,
      nextRevision: () => ++setupCheckRevision,
    },
    (run) => publishSetupCheck(check, run)
  );
  setupCheck = check;
  shownCheck = check;
  void check.start().then(
    (run) => {
      if (setupCheck === check) setupCheck = null;
      recordSetupCheck(relay, check, run);
    },
    (error: unknown) => {
      if (setupCheck === check) setupCheck = null;
      console.warn(
        "[Decisions] The setup check stopped:",
        error instanceof Error ? error.name : typeof error
      );
    }
  );
  return { result: "started", run: check.snapshot() };
}

/** The setup check running now, or the latest one this run of Daintree saw; null when there is none. */
export function getSetupCheck(): DecisionsSetupCheckRun | null {
  return setupCheck?.snapshot() ?? lastSetupRun;
}

/**
 * Calls off the setup check running now, if it is `runId`, so a cancel that
 * arrives late can't end a newer run; resolves once it has cleaned up.
 */
export async function cancelSetupCheck(
  payload: CancelDecisionsSetupCheckPayload
): Promise<DecisionsSetupCheckRun | null> {
  const check = setupCheck;
  if (check?.runId === payload.runId) return check.cancel();
  return check?.snapshot() ?? lastSetupRun;
}

/**
 * Cancels the running check for a change that ends what it checks, and
 * forgets the last run. Resolves once it cleaned up, or after
 * `SETUP_CHECK_CANCEL_MS`, so a stuck store can't hold up the change.
 */
function endSetupCheck(): Promise<void> {
  setupCheckEpoch += 1;
  const check = setupCheck;
  setupCheck = null;
  shownCheck = null;
  lastSetupRun = null;
  if (!check) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    check.cancel().then(
      () => {},
      () => {}
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETUP_CHECK_CANCEL_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Boot: starts the service only if the saved setting, sanitised, is on; or,
 * with it off, as the enrolled Remote Host the Host's record names (#16022),
 * which also finishes removing a revoked Host's keys.
 */
export function startDecisionsIfEnabled(): Promise<void> {
  return serialize(async () => {
    if (shutDown) return;
    const settings = readDecisionsSettings(store);
    if (settings.enabled) {
      const next = await getDecisionsService();
      await next.start(settings);
      return;
    }
    await reconcileHostLifetime();
  });
}

/**
 * Turns Decisions on or off at runtime: saves the switch, keeping every other
 * field as it reads (a damaged relay field reads as not set up, so turning on
 * over one starts afresh), then starts or stops the service to match what was
 * saved. `consent` records the first agreement to what Decisions sends; a
 * later one keeps the original time.
 */
export function setDecisionsEnabled(
  enabled: boolean,
  options: { consent?: boolean } = {}
): Promise<DecisionsStatus> {
  // Before the queue, as a disconnect does: an export whose kit is still being
  // made would otherwise reach its dialog before this turn comes round.
  const checkStopped = enabled ? Promise.resolve() : endSetupCheck();
  if (!enabled) {
    cancelKitExports();
    // No agent-stopped push goes out while this waits its turn.
    decisionsOffsPending += 1;
    service?.agentStoppedPushesChanged();
  }
  const run = serialize(async () => {
    const current = readDecisionsSettings(store);
    const consentedAt = current.consentedAt ?? (options.consent ? Date.now() : null);
    const saved = writeDecisionsSettings(store, { ...current, enabled, consentedAt });
    if (!saved.enabled) {
      cancelRelayChecks();
      forgetOwnerDevices();
      relayDeploys.reset();
    }
    try {
      if (saved.enabled && !shutDown) {
        const next = await getDecisionsService();
        await next.start(saved);
      } else {
        // Its question is cancelled while the store is still open.
        await checkStopped;
        await (await settledService())?.stop();
        // An enrolled Host's own lifetime has no switch here (#16022).
        await reconcileHostLifetime();
      }
    } finally {
      // The setting changed, whatever became of the start.
      publishStatus();
      // Every connected Host this computer enrolled hears of it now (#16022).
      getDecisionsHostsPort()?.announceOwnerState();
    }
    return getDecisionsStatus();
  });
  if (enabled) return run;
  return run.finally(() => {
    // Never below none, even across a test's reset with one still waiting.
    decisionsOffsPending = Math.max(0, decisionsOffsPending - 1);
    service?.agentStoppedPushesChanged();
  });
}

/** Quit: ends the service for good. One still being made is waited for, so it can't start afterwards. */
export async function stopDecisions(): Promise<void> {
  shutDown = true;
  relayRemovals?.dispose();
  cancelRelayChecks();
  forgetOwnerDevices();
  cancelKitExports();
  relayDeploys.dispose();
  hostEnroller.dispose();
  for (const controller of setups) controller.abort();
  await endSetupCheck();
  await (await settledService())?.dispose();
}

/** @internal Tests only. */
export function _resetDecisionsForTesting(): void {
  hostDeclineOwners.clear();
  cancelRelayChecks();
  forgetOwnerDevices();
  cancelKitExports();
  for (const controller of setups) controller.abort();
  setups.clear();
  void setupCheck?.cancel().catch(() => {});
  setupCheck = null;
  shownCheck = null;
  lastSetupRun = null;
  setupCheckRevision = 0;
  setupCheckEpoch = 0;
  service = null;
  creating = null;
  questionNotifier = null;
  holdPhonePushesOffs = 0;
  agentStoppedPushesOffs = 0;
  decisionsOffsPending = 0;
  shutDown = false;
  transitions = Promise.resolve();
  statusRevision = 0;
  statusPushes = Promise.resolve();
  storageOutageNoticed = false;
  policyRevision = 0;
  modelRevision = 0;
  hostEnroller.dispose();
  hostEnroller = makeHostEnroller();
  relayDeploys.dispose();
  relayDeploys = makeRelayDeploys();
  hostRecords = null;
  hostRuntimeListeners.clear();
  relayRemovals?.dispose();
  relayRemovals = null;
  stopFollowingHostQuestions();
  ownQuestions = [];
  listingQuestions = false;
  hostServedQuestions = null;
  hostQuestionListeners.clear();
}
