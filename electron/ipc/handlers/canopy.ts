import path from "node:path";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { app, webContents } from "electron";
import type {
  CanopyLookPlace,
  CanopyMode,
  CanopyModelInfo,
  CanopyPlan,
  CanopyReadMark,
  CanopyReadRestore,
  CanopyReadTarget,
  CanopyScreenSearchTarget,
  CanopySnapshot,
  CanopyTarget,
  CanopyTerminalView,
  AssistantOpenDestination,
  CanopyRenameRequest,
  CanopyRemoveRequest,
  CanopyRestoreOutcome,
  CanopyRestoreRequest,
  CanopyResumeAnswer,
  CanopyResumeRequest,
  CanopyTrashEntry,
  CanopyTrashRequest,
  CanopyTrashTarget,
} from "../../../shared/types/ipc/canopy.js";
import { getAgentNotificationServiceRef, getPtyClient } from "../../window/serviceRefs.js";
import type { TerminalInputNotice } from "../../services/PtyClient.js";
import type { TerminalResizeResult } from "../../../shared/types/pty-host.js";
import {
  notifyCanopyRefinementsChanged,
  setCanopyRefinementSource,
} from "../../services/canopy/canopyRefinementSource.js";
import { getFleetSnapshotService, getRunHandBackService } from "./projectCrud/index.js";
import { readPluginTerminalScreen } from "../../services/plugin/pluginTerminalScreenRead.js";
import { CANOPY_HISTORY_ROWS, CanopyService } from "../../services/canopy/CanopyService.js";
import { CanopyTrashLedger } from "../../services/canopy/canopyTrashLedger.js";
import { CanopyClosedTrash, mergeCanopyTrash } from "../../services/canopy/canopyClosedTrash.js";
import {
  adoptCanopyTrashClose,
  listAgentSessions,
  onSessionHistoryWritten,
  removeFromCanopyTrash,
} from "../../services/pty/agentSessionHistory.js";
import { getAgentSessionRetentionDays } from "../../services/pty/agentSessionRetention.js";
import {
  hasCanopyTrashRemoval,
  noteCanopyTrashRemoval,
} from "../../services/pty/canopyTrashRemovals.js";
import { thawThenSend } from "../../utils/thawThenSend.js";
import { getLifecycleLedger } from "../../services/pty/lifecycleLedger.js";
import { attributeClose } from "../../services/pty/closeAttribution.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { searchScreens } from "../../services/canopy/canopyScreenSearch.js";
import { isCanopyMode, readCanopyMode } from "../../services/canopy/canopyMode.js";
import { CanopyLocalReader } from "../../services/canopy/canopyLocalReader.js";
import { CANOPY_MODEL, CanopyModels, canopyModelName } from "../../services/canopy/canopyModels.js";
import { store } from "../../store.js";
import { hostInstanceId } from "../../services/hostInstance.js";
import { traced } from "../../services/canopy/canopyTrace.js";
import {
  broadcastToRenderer,
  checkRateLimit,
  endpointPushTarget,
  getProjectPushTargets,
  typedBroadcast,
  type ProjectPushTarget,
} from "../utils.js";
import type { IpcContext } from "../types.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { getIpcDispatcher } from "../dispatcher.js";
import { CANOPY_METHOD_CHANNELS } from "./canopy.preload.js";
import {
  beginWatchRequest,
  isCurrentWatchRequest,
  followDriveLeaseChange,
  onSizeHoldsChange,
  remoteSizeHolds,
  stopAllTerminalWatches,
  stopWorkerTerminalWatches,
  resizeWatchedTerminal,
  stopTerminalWatch,
  stopTerminalWatchById,
  watchTerminal,
  watchedTerminal,
} from "./canopyTerminalWatch.js";
import { isImageAttachmentPath } from "../../../shared/utils/imageAttachmentInput.js";
import { AppError } from "../../utils/errorTypes.js";
import type {
  AgentDirectory,
  AgentDirectorySubject,
} from "../../../shared/types/agentDirectory.js";
import type { AssistantWorkReading } from "../../../shared/types/assistantWork.js";
import {
  parseGlobalAssistantInputStamp,
  resolveLiveAssistant,
} from "../../services/assistants/liveAssistantSubject.js";
import type { GlobalAssistantInputStamp } from "../../../shared/types/ipc/help.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { answerRunByLabel, isAnswerLabel } from "../../services/terminalAnswer.js";
import { isCanopyViewerEndpointId } from "../endpoint.js";
import { terminalAnswerOf } from "../../../shared/utils/terminalSubmission.js";
import { scheduledRunForRecord } from "../../../shared/utils/scheduledRunProvenance.js";
import { getGitBranch } from "../../utils/gitUtils.js";
import { events } from "../../services/events.js";
import { projectStore } from "../../services/ProjectStore.js";
import { getDefaultPanelTitle } from "../../../shared/config/panelKindRegistry.js";
import type { FleetRunRow } from "../../../shared/types/ipc/fleet.js";
import type { PanelLocation } from "../../../shared/types/panel.js";
import { TRASH_TTL_MS } from "../../../shared/config/trash.js";

const MAX_INPUT_LENGTH = 64_000;
const MAX_SUBMIT_LENGTH = 100_000;
const MAX_SUBMIT_IMAGES = 10;
const MAX_KEY_LENGTH = 32;
const MAX_LABEL_LENGTH = 200;
/**
 * Reading runs only once the user has turned it on, and so does acting on what
 * was read. Checked here as well as in the panel, so no other caller can reach
 * the reader through it. The list, the terminal pane and the user's own marks
 * work without it: they use only what Daintree observes.
 */
function requireActivated(): void {
  if (currentPlan().activated) return;
  throw new AppError({
    code: "PERMISSION",
    message: "Canopy isn't turned on",
    userMessage: "Canopy isn't turned on.",
  });
}

/**
 * The background watch's pace in ms, when `DAINTREE_CANOPY_BACKGROUND_POLL_MS`
 * sets one; 0 turns the watch off. Read once, when the service is made.
 */
function backgroundPollOverride(): number | undefined {
  const raw = process.env.DAINTREE_CANOPY_BACKGROUND_POLL_MS?.trim();
  if (!raw) return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  // A watch faster than once a second only keeps the reader busy, and past a
  // timer's 32-bit range Node fires it at once.
  return ms === 0 ? 0 : Math.min(2_147_483_647, Math.max(1_000, ms));
}

/** Changes of mode since launch; see `CanopyPlan.modeRevision`. */
let modeRevision = 0;
/** Names this launch, which `modeRevision` counts in; see `CanopyPlan.hostEpoch`. */
const hostEpoch = hostInstanceId;

function currentPlan(): CanopyPlan {
  const mode = readCanopyMode();
  return { mode, modeRevision, hostEpoch, activated: mode === "on" };
}

let models: CanopyModels | null = null;
let reader: CanopyLocalReader | null = null;
/** Whether the model was ready when last told, so only a change wakes the service. */
let modelWasReady = false;

/** Made on first use: a user who never turns Canopy on never looks for a model. */
function getModels(): CanopyModels {
  models ??= new CanopyModels(
    path.join(app.getPath("userData"), "canopy", "models"),
    onModelsChanged,
    // An update replaces the files the reader has open, and what the last
    // revision read is read again by the new one.
    () => reader?.release(),
    () => service?.readerChanged()
  );
  return models;
}

function getReader(): CanopyLocalReader {
  reader ??= new CanopyLocalReader(() => getModels().installedDir());
  return reader;
}

function modelReady(): boolean {
  return models?.state().status === "ready";
}

function onModelsChanged(): void {
  const ready = modelReady();
  if (ready !== modelWasReady) {
    modelWasReady = ready;
    service?.readerChanged();
  } else {
    service?.modelChanged();
  }
}

/**
 * With Canopy on, gets the model here if it isn't, or its newest revision if
 * an older one is, and once it is ready deletes any other: a model an earlier
 * Daintree chose included.
 */
function ensureModel(): void {
  if (readCanopyMode() !== "on") return;
  void getModels()
    .ensure()
    .then(async () => {
      if (models?.state().status === "ready") await models.remove(true);
    })
    .catch((error: unknown) => console.error("[Canopy] Model download failed:", error));
}

/**
 * What Canopy shows with no service made since launch: nothing. Sequence 0,
 * so it never paints over anything a service has pushed since.
 */
function hiddenOrIdleSnapshot(): CanopySnapshot {
  return {
    sequence: 0,
    ...currentPlan(),
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: false,
    busy: false,
    refreshedAt: null,
    cards: [],
    glances: [],
    lastError: null,
    failedRuns: [],
    trash: trashList(),
  };
}

/** Every agent run in this host's trash, any project's: made at registration, read by every snapshot. */
let trashLedger: CanopyTrashLedger | null = null;
/** The closes the journal holds past the trash's window: made at registration, read on writes. */
let closedTrash: CanopyClosedTrash | null = null;

function trashList(): CanopyTrashEntry[] {
  return mergeCanopyTrash(trashLedger?.list() ?? [], closedTrash?.list() ?? []);
}

let service: CanopyService | null = null;
let unsubscribeFleet: (() => void) | null = null;
let unsubscribeInput: (() => void) | null = null;
const activeViews = new Set<number>();
/** The workspace each view's panel asked to read (null: every one), kept across its opens. */
const viewScopes = new Map<number, string | null>();
/** The runs each view's open panel lists, scope and filters applied, as it last said. */
const viewShown = new Map<number, ReadonlySet<string>>();
/** Views that already carry lifecycle listeners, with the way to take them off. */
const watchedViews = new Map<number, () => void>();
/** Canopy views of another Shell, which no broadcast reaches: told each snapshot by name. */
const snapshotObservers = new Set<(snapshot: CanopySnapshot) => void>();

/** Every view hears a snapshot: this machine's windows, its remote views, and its observers. */
function publishSnapshot(snapshot: CanopySnapshot): void {
  typedBroadcast<"canopy:snapshot-updated">(CHANNELS.CANOPY_SNAPSHOT_UPDATED, snapshot);
  for (const observer of [...snapshotObservers]) {
    try {
      observer(snapshot);
    } catch (error) {
      console.error("[Canopy] Snapshot observer failed:", error);
    }
  }
}

/** Canopy's mode and the revision it is at in this launch, without making a service. */
export function canopyModeState(): { mode: CanopyMode; modeRevision: number; hostEpoch: string } {
  return { mode: readCanopyMode(), modeRevision, hostEpoch };
}

/** One budget for mode changes, however they arrive: this machine's views or another's Settings. */
export function checkCanopyModeRate(): void {
  checkRateLimit(CANOPY_METHOD_CHANNELS.setMode, 10, 10_000);
}

/**
 * The guarded mode change behind `canopy:set-mode`, for callers that already
 * checked their arguments: Settings on another machine editing this one
 * (#14167) goes through exactly the same steps. A change made against a
 * revision or launch that isn't current changes nothing and answers how
 * Canopy stands now.
 */
export function changeCanopyMode(
  mode: CanopyMode,
  expectRevision?: number,
  expectHostEpoch?: string
): CanopySnapshot {
  if (
    (expectRevision !== undefined && expectRevision !== modeRevision) ||
    (expectHostEpoch !== undefined && expectHostEpoch !== hostEpoch)
  ) {
    return service ? service.getSnapshot() : hiddenOrIdleSnapshot();
  }
  const was = readCanopyMode();
  if (mode === "on" && was === "hidden") {
    throw new AppError({
      code: "PERMISSION",
      message: "Canopy is hidden",
      userMessage: "Show Canopy before turning it on.",
    });
  }
  if (mode !== was) modeRevision++;
  store.set("canopyMode", mode);
  if (mode !== "on") stopWorkerTerminalWatches();
  // Nothing was started, and nothing is wanted: no service to tell, but
  // every view still hears the change, as a service would have told them.
  if (!service && mode !== "on") {
    const idle = hiddenOrIdleSnapshot();
    publishSnapshot(idle);
    return idle;
  }
  const canopy = getService();
  canopy.setPlan(currentPlan());
  if (mode === "on") {
    ensureModel();
  } else {
    // Off lets the model go; a download under way stops, keeping what it fetched.
    reader?.release();
    models?.cancel();
  }
  return canopy.getSnapshot();
}

/**
 * Be told each snapshot every view is pushed, for Canopy views that read this
 * machine without being one of its views. No replay: `canopy:get-snapshot`
 * reads the current one.
 */
export function observeCanopySnapshots(observer: (snapshot: CanopySnapshot) => void): () => void {
  snapshotObservers.add(observer);
  return () => {
    snapshotObservers.delete(observer);
  };
}

/**
 * The fleet service is created after the handlers register, so the
 * subscription is made on first use rather than at registration, and retried
 * on each use — every scan included — until the fleet service exists.
 */
function subscribeFleet(): void {
  subscribeInput();
  if (unsubscribeFleet !== null) return;
  unsubscribeFleet = getFleetSnapshotService()?.subscribe(() => service?.onFleetChanged()) ?? null;
}

/**
 * Input to any terminal, and every resize of one, wherever it came from, so an answer typed into the
 * agent's own pane clears it here at once rather than when its screen is next
 * read. Made on first use like the fleet subscription: the terminal host may
 * not exist yet when the handlers register.
 */
function subscribeInput(): void {
  if (unsubscribeInput !== null) return;
  const ptyClient = getPtyClient();
  if (!ptyClient) return;
  const onInput = (runId: string, input: TerminalInputNotice) =>
    service?.noteInput(runId, input.answer);
  // Every resize, whoever asked for it: the agent redraws for the new size, and
  // that redraw is not something new on its screen.
  const onResize = (runId: string, result: TerminalResizeResult) => {
    if (result.outcome === "applied") service?.noteResize(runId);
  };
  ptyClient.on("terminal-input", onInput);
  ptyClient.on("resize-result", onResize);
  unsubscribeInput = () => {
    ptyClient.off("terminal-input", onInput);
    ptyClient.off("resize-result", onResize);
  };
}

/**
 * The views whose open panel lists the run, as each last said, scope and
 * filters applied: only these are in front of its ask. A panel that hasn't
 * said yet lists nothing for certain: better a page the user may not need
 * than an ask held back for a row they can't see.
 */
export function canopyPanelsListing(runId: string): number[] {
  return [...activeViews].filter((view) => viewShown.get(view)?.has(runId) ?? false);
}

/**
 * Carries a read change made in the inbox to the run's hand-back, so the two
 * read states agree. Only a run the inbox now holds wholly read is read there:
 * a read through an older turn leaves newer work unread in both. An undo
 * (`restored`) puts back unread turns as well as marks.
 */
function syncHandBack(mark: CanopyReadMark, restored = false): void {
  const handBacks = getRunHandBackService();
  if (!handBacks) return;
  const whollyRead = mark.markedUnreadAt === null && mark.readTurn >= mark.turn;
  if (mark.markedUnreadAt !== null || (restored && !whollyRead)) handBacks.markUnread(mark.runId);
  else if (whollyRead) handBacks.markRead(mark.runId);
}

/**
 * The other direction: a hand-back the user read or marked unread from its own
 * surfaces — the terminal's menu — is read or unread in the inbox too, for the
 * incarnation the fleet shows. Only while Canopy is on and its service is up.
 */
function onHandBackChanged(change: { id: string; unseen: boolean; fromUser?: boolean }): void {
  if (!change.fromUser || service === null || !currentPlan().activated) return;
  const run = getFleetSnapshotService()
    ?.getLastBroadcast()
    ?.runs.find((entry) => entry.runId === change.id);
  if (!run) return;
  service.setRead(change.id, run.spawnedAt, !change.unseen);
}

function getService(): CanopyService {
  subscribeFleet();
  if (service) return service;
  const backgroundPollMs = backgroundPollOverride();
  service = new CanopyService({
    plan: currentPlan(),
    ...(backgroundPollMs !== undefined ? { backgroundPollMs } : {}),
    getTrash: trashList,
    getRuns: () => {
      subscribeFleet();
      const snapshot = getFleetSnapshotService()?.getLastBroadcast();
      return snapshot && !snapshot.degraded ? snapshot.runs : null;
    },
    // An agent read as asking the user something pages them, through the same
    // banner and sound as Daintree's own waiting alert.
    onAsk: (run, ask) =>
      getAgentNotificationServiceRef()?.notifyCanopyAsk(
        {
          terminalId: run.runId,
          ...(run.worktreeId !== undefined ? { worktreeId: run.worktreeId } : {}),
          ...(run.agentId !== undefined ? { agentId: run.agentId } : {}),
          kind: ask.kind,
        },
        () => canopyPanelsListing(run.runId)
      ),
    readScreen: async (runId, lines) => {
      const result = await readPluginTerminalScreen(getPtyClient(), runId, null, lines, null, {
        dropGhostInput: true,
        withCols: true,
      });
      if (result.status !== "ok") return null;
      return result.cols !== undefined ? { text: result.text, cols: result.cols } : result.text;
    },
    readHistory: async (runId, rows) => {
      const result = await readPluginTerminalScreen(
        getPtyClient(),
        runId,
        null,
        rows,
        {
          scrollbackRows: rows,
          maxBytes: 96 * 1024,
        },
        { dropGhostInput: true }
      );
      return result.status === "ok" ? result.text : null;
    },
    read: (input, signal) => traced("reader", input, () => getReader().read(input, signal)),
    readerReady: modelReady,
    readerName: () => canopyModelName(CANOPY_MODEL),
    modelState: () => getModels().state(),
    broadcast: (snapshot) => publishSnapshot(snapshot),
    // The fleet and the project counts re-read their refinements: that is how
    // the sidebar hears of them with no panel open.
    onRefinementsChanged: () => notifyCanopyRefinementsChanged(),
  });
  const made = service;
  setCanopyRefinementSource((runId, spawnedAt) => made.getRefinement(runId, spawnedAt));
  ensureModel();
  return service;
}

function assertRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("Invalid run id");
  }
}

/** The most runs one bulk read change may name. */
const MAX_READ_BATCH = 500;
/** Every run a panel can list, the whole fleet across projects: far above any real one. */
const MAX_SHOWN_RUNS = 10_000;
/** The words one search may look for on a terminal, and how long each may be. */
const MAX_SEARCH_TERMS = 16;
const MAX_SEARCH_TERM_LENGTH = 200;
/** How much of a terminal a search reads: its screen and the history the describer reads. */
const SEARCH_MAX_BYTES = 96 * 1024;

function assertScreenSearchTarget(value: unknown): asserts value is CanopyScreenSearchTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid run");
  }
  const target = value as Record<string, unknown>;
  assertRunId(target.runId);
  assertTarget(target);
  const terms = target.terms;
  if (
    !Array.isArray(terms) ||
    terms.length === 0 ||
    terms.length > MAX_SEARCH_TERMS ||
    !terms.every(
      (term) => typeof term === "string" && term.length > 0 && term.length <= MAX_SEARCH_TERM_LENGTH
    )
  ) {
    throw new Error("Invalid search");
  }
}

function isTurn(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertReadTarget(value: unknown): asserts value is CanopyReadTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid run");
  }
  const target = value as Record<string, unknown>;
  assertRunId(target.runId);
  assertTarget(target);
  if (!isTurn(target.turn)) throw new Error("Invalid turn");
}

function assertReadRestore(value: unknown): asserts value is CanopyReadRestore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid mark");
  }
  const { mark, expectVersion } = value as Record<string, unknown>;
  if (!isTurn(expectVersion)) throw new Error("Invalid mark");
  assertReadTarget(mark);
  const { readTurn, markedUnreadAt, version } = mark as unknown as Record<string, unknown>;
  if (!isTurn(readTurn) || !isTurn(version)) throw new Error("Invalid mark");
  // A mark set in the future would hold off every look until then.
  if (markedUnreadAt !== null && (!isTurn(markedUnreadAt) || markedUnreadAt > Date.now())) {
    throw new Error("Invalid mark");
  }
}

function assertTarget(value: unknown): asserts value is CanopyTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid target");
  }
  const target = value as Record<string, unknown>;
  if (typeof target.spawnedAt !== "number" || !Number.isFinite(target.spawnedAt)) {
    throw new Error("Invalid target");
  }
}

/**
 * Writes only ever reach the terminal the card was built from: a run the fleet
 * can see right now, in the same incarnation (ids are reused across respawns),
 * and not exited. The fleet is polled, so the PTY host's own record is the one
 * checked last.
 */
async function assertSameTerminal(runId: string, target: CanopyTarget): Promise<void> {
  const snapshot = getFleetSnapshotService()?.getLastBroadcast();
  if (!snapshot || snapshot.degraded) {
    throw new Error("Agent state is unavailable right now — try again in a moment.");
  }
  if (!snapshot.runs.some((run) => run.runId === runId && run.spawnedAt === target.spawnedAt)) {
    throw new Error("That agent isn't running any more.");
  }
  const record = await requirePtyClient()
    .getTerminalAsync(runId)
    .catch(() => null);
  if (!record || record.spawnedAt !== target.spawnedAt || record.isExited === true) {
    throw new Error("That agent isn't running any more.");
  }
}

/**
 * The run the list showed is still this incarnation, alive or exited — for
 * acts on the pane rather than on its process.
 */
async function assertSameIncarnation(runId: string, target: CanopyTarget): Promise<void> {
  const snapshot = getFleetSnapshotService()?.getLastBroadcast();
  if (!snapshot || snapshot.degraded) {
    throw new Error("Agent state is unavailable right now — try again in a moment.");
  }
  if (!snapshot.runs.some((run) => run.runId === runId && run.spawnedAt === target.spawnedAt)) {
    throw new Error("That agent isn't there any more.");
  }
  const record = await requirePtyClient()
    .getTerminalAsync(runId)
    .catch(() => null);
  if (!record || record.spawnedAt !== target.spawnedAt) {
    throw new Error("That agent isn't there any more.");
  }
}

/** The terminal a view's current stream is for, or a refusal naming nothing on screen. */
function requireWatched(
  viewId: number,
  watchId: unknown
): { runId: string; spawnedAt: number; assistant: boolean; mayType: boolean } {
  if (typeof watchId !== "number" || !Number.isInteger(watchId)) throw new Error("Invalid stream");
  const watched = watchedTerminal(viewId, watchId);
  if (!watched) throw new Error("That agent isn't running any more.");
  return watched;
}

/**
 * A rename reaches the terminal wherever its pane lives. The host record takes
 * it at once, for the fleet and Canopy's own rows; the saved project state
 * takes it too, so a project view evicted or closed meanwhile restores the new
 * name rather than the one it saved; and the views of the run's project rename
 * the pane themselves, as the user's own rename there would — which, for an
 * empty title, also works out the exact default the view gives it.
 */
async function renameThroughOwningViews(run: FleetRunRow, title: string): Promise<void> {
  const named = title.trim();
  // Already the name Daintree gives it: there is nothing to put back, and the
  // view holding it would leave a name this guessed in place.
  if (!named && (run.titleMode ?? "default") === "default") return;
  const titleMode = named ? "user" : "default";
  const shown = named || defaultTitleOf(run);
  requirePtyClient().updateTitle(run.runId, shown, titleMode);
  events.emit("terminal:title-changed", { id: run.runId, timestamp: Date.now() });
  for (const view of getProjectPushTargets(run.workspaceId, CHANNELS.CANOPY_RENAME_REQUESTED)) {
    try {
      view.send(CHANNELS.CANOPY_RENAME_REQUESTED, {
        runId: run.runId,
        title: named,
      } satisfies CanopyRenameRequest);
    } catch {
      // A view torn down mid-send has no pane left to rename.
    }
  }
  // Saved before the rename is answered, so a project reopened straight after
  // restores the new name.
  await projectStore
    .enqueueProjectStateUpdate(run.workspaceId, (state) => {
      const saved = state?.terminals?.find((terminal) => terminal.id === run.runId);
      if (!state || !saved) return null;
      saved.title = shown;
      saved.titleMode = titleMode;
      return state;
    })
    .catch((error: unknown) => {
      // The host and every open view have the name; only a later restore of a
      // view evicted meanwhile would miss it, which is no reason to say the
      // rename failed.
      console.warn("[Canopy] Saving a renamed terminal's title failed:", error);
    });
}

/**
 * The name Daintree gives a run, as its view works it out: the agent it was
 * seen to be, else the one it was launched as until something else is seen.
 * The view holding it puts back its own exact default on top of this.
 */
function defaultTitleOf(run: FleetRunRow): string {
  const agent = run.agentId ?? (run.everDetectedAgent !== true ? run.launchAgentId : undefined);
  return getDefaultPanelTitle("terminal", agent);
}

/**
 * The host's trash alone leaves the pane on the grid: a view drops a host trash
 * it did not start, so a late echo can't re-trash a pane the user has just
 * restored. So the views of the run's project are told to move the pane to the
 * trash themselves, without trashing on the host again — a second host trash
 * landing after an Undo would trash the restored terminal. The request reaches
 * each view before the host's own trashed and restored events, so an Undo still
 * finds the pane in the trash. A view that does not hold the pane ignores it.
 */
function trashThroughOwningViews(runId: string, spawnedAt: number): number | null {
  requirePtyClient().trash(runId);
  const run = getFleetSnapshotService()
    ?.getLastBroadcast()
    ?.runs.find((candidate) => candidate.runId === runId);
  if (!run) return null;
  const receipt = ++trashReceipts;
  pruneTrashReceipts();
  const trashed: TrashedRun = {
    runId,
    spawnedAt,
    workspaceId: run.workspaceId,
    at: Date.now(),
  };
  recentlyTrashed.set(receipt, trashed);
  const views = getProjectPushTargets(run.workspaceId, CHANNELS.CANOPY_TRASH_REQUESTED);
  for (const view of views) {
    try {
      view.send(CHANNELS.CANOPY_TRASH_REQUESTED, { runId } satisfies CanopyTrashRequest);
    } catch {
      // A view torn down mid-send has no pane left to move.
    }
  }
  // No view of the project is open to move the pane, so its saved layout is
  // what would bring it back: opened later, the project would restore the
  // trashed agent. The saved pane goes to the trash there instead, as a view
  // saving its own trash would leave it, and an Undo puts it back.
  if (views.length === 0) {
    trashed.layoutSaved = true;
    void projectStore
      .enqueueProjectStateUpdate(run.workspaceId, (state) => {
        const saved = state?.terminals?.find((terminal) => terminal.id === runId);
        if (!state || !saved || saved.location === "trash") return null;
        trashed.savedLocation = saved.location;
        saved.location = "trash";
        return state;
      })
      .catch((error: unknown) => {
        console.warn("[Canopy] Saving a trash to its project's layout failed:", error);
      });
  }
  return receipt;
}

/**
 * Trashes Canopy made, by receipt, for an Undo to put back: once a run is in
 * the trash it leaves the fleet, so its project can't be looked up then. A
 * receipt names one trash of one incarnation, so an Undo can never restore a
 * terminal respawned under the same id, or a later trash of it. Kept only for
 * as long as the trash keeps the terminal.
 */
interface TrashedRun {
  runId: string;
  spawnedAt: number;
  workspaceId: string;
  at: number;
  /**
   * No view of the project was open to move the pane, so the trash was saved
   * to the project's layout instead, in its queue; Undo puts it back there.
   */
  layoutSaved?: boolean;
  /** Where that saved layout had the pane, once the queued save has run. */
  savedLocation?: PanelLocation;
}
const recentlyTrashed = new Map<number, TrashedRun>();
let trashReceipts = 0;

/** A terminal brought back from the trash: that incarnation's receipts are spent. */
function forgetReceiptsFor(runId: string, spawnedAt?: number): void {
  for (const [receipt, trashed] of recentlyTrashed) {
    if (trashed.runId === runId && (spawnedAt === undefined || trashed.spawnedAt === spawnedAt)) {
      recentlyTrashed.delete(receipt);
    }
  }
}

/**
 * A restore Canopy asked the host for, per run, and until when its
 * acknowledgement is expected: one that never comes (the terminal had already
 * left the trash) lapses rather than swallowing someone else's later restore.
 */
const ownRestores = new Map<string, number>();
const OWN_RESTORE_ACK_MS = 5_000;

/** The host restored a terminal: someone else's restore spends its receipts; Canopy's own did already. */
function onHostRestored(runId: string): void {
  const expected = ownRestores.get(runId);
  ownRestores.delete(runId);
  if (expected !== undefined && Date.now() <= expected) return;
  forgetReceiptsFor(runId);
}

function pruneTrashReceipts(): void {
  const now = Date.now();
  for (const [receipt, trashed] of recentlyTrashed) {
    if (now - trashed.at > TRASH_TTL_MS) recentlyTrashed.delete(receipt);
  }
}

function leftTheTrash(): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "Terminal no longer in the trash",
    userMessage: "That terminal has left the trash.",
  });
}

/**
 * Takes back a trash made from Canopy. The host restores the terminal — the
 * same restore any view's own Undo sends, so a view repeating it changes
 * nothing — and the views of the run's project bring its pane back out of
 * their trash. Refused once the trash has let the terminal go, or for a
 * terminal that is no longer the incarnation trashed.
 */
async function restoreThroughOwningViews(
  receipt: number,
  /** Checked again right before anything is restored: control can move while the host is asked. */
  mayRestore: (trashed: TrashedRun) => boolean = () => true
): Promise<void> {
  pruneTrashReceipts();
  const trashed = recentlyTrashed.get(receipt);
  if (!trashed) throw leftTheTrash();
  const ptyClient = requirePtyClient();
  // The same incarnation, exited or not: an agent that finished while in the
  // trash comes back as its pane would from the grid's own Undo. Checked
  // before anything else is spent, so a stale receipt costs a newer one nothing.
  const record = await ptyClient.getTerminalAsync(trashed.runId).catch(() => null);
  if (!record || record.spawnedAt !== trashed.spawnedAt) {
    recentlyTrashed.delete(receipt);
    throw leftTheTrash();
  }
  // Restored elsewhere while the host was asked: that restore spent it. Or the
  // trash let it go meanwhile: the host is ending it, and a restore now would
  // come back to nothing.
  if (!recentlyTrashed.has(receipt)) throw leftTheTrash();
  if (Date.now() - trashed.at > TRASH_TTL_MS) {
    recentlyTrashed.delete(receipt);
    throw leftTheTrash();
  }
  // Trashed while its project was closed, and the project opened since: it
  // came up without the pane, so a terminal brought back would have nowhere to
  // show and nothing to keep it.
  if (
    trashed.layoutSaved &&
    getProjectPushTargets(trashed.workspaceId, CHANNELS.CANOPY_RESTORE_REQUESTED).length > 0
  ) {
    recentlyTrashed.delete(receipt);
    throw new AppError({
      code: "NOT_FOUND",
      message: "Terminal's project opened since it was trashed",
      userMessage: "That terminal's project has opened since. Nothing was restored.",
    });
  }
  if (!mayRestore(trashed)) throw drivenElsewhere(trashed.workspaceId);
  forgetReceiptsFor(trashed.runId, trashed.spawnedAt);
  // The host's word that this restore landed is ours, not news of someone
  // else's: it must not spend a receipt for a trash made after it.
  ownRestores.set(trashed.runId, Date.now() + OWN_RESTORE_ACK_MS);
  ptyClient.restore(trashed.runId);
  if (trashed.layoutSaved) {
    // Queued behind the trash's own save, so it reads where that save found
    // the pane even when the queue had not reached it when Undo was pressed.
    await projectStore
      .enqueueProjectStateUpdate(trashed.workspaceId, (state) => {
        const savedLocation = trashed.savedLocation;
        const saved = state?.terminals?.find((terminal) => terminal.id === trashed.runId);
        if (!state || !saved || savedLocation === undefined || saved.location !== "trash") {
          return null;
        }
        saved.location = savedLocation;
        return state;
      })
      .catch((error: unknown) => {
        // The host has the terminal back; only a later open of the project
        // would leave its pane in the trash.
        console.warn(
          "[Canopy] Putting a restored pane back in its project's layout failed:",
          error
        );
      });
  }
  for (const view of getProjectPushTargets(
    trashed.workspaceId,
    CHANNELS.CANOPY_RESTORE_REQUESTED
  )) {
    try {
      view.send(CHANNELS.CANOPY_RESTORE_REQUESTED, {
        runId: trashed.runId,
      } satisfies CanopyRestoreRequest);
    } catch {
      // A view torn down mid-send has no pane left to restore.
    }
  }
}

/** Canopy's own receipt for this trash of the run, when Canopy made it: it knows what an Undo needs. */
function receiptFor(trashed: CanopyTrashEntry): number | undefined {
  let found: number | undefined;
  for (const [receipt, held] of recentlyTrashed) {
    if (held.runId === trashed.run.runId && held.spawnedAt === trashed.run.spawnedAt) {
      found = receipt;
    }
  }
  return found;
}

function assertTrashTarget(target: unknown): asserts target is CanopyTrashTarget {
  assertTarget(target);
  const expiresAt = (target as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("Invalid trash target");
  }
}

/** The trash Canopy's Trash showed, while the trash still holds it: that trash of that incarnation. */
function heldTrash(runId: string, target: CanopyTrashTarget): CanopyTrashEntry {
  const held = trashLedger?.get(runId);
  if (
    !held ||
    held.ended ||
    held.run.spawnedAt !== target.spawnedAt ||
    held.expiresAt !== target.expiresAt ||
    Date.now() >= held.expiresAt
  ) {
    throw leftTheTrash();
  }
  return held;
}

/** The trash Canopy's Trash showed, when it is that trash and the process lives on in it. */
function isLiveTrash(runId: string, target: CanopyTrashTarget): boolean {
  const held = trashLedger?.get(runId);
  return (
    !!held &&
    !held.ended &&
    held.run.spawnedAt === target.spawnedAt &&
    held.expiresAt === target.expiresAt
  );
}

/** The project of an ended run the Trash showed: still closing, or a close the journal holds. */
function closedWorkspaceOf(runId: string, target: CanopyTrashTarget): string | undefined {
  if (isEndingTrash(runId, target)) return trashLedger?.get(runId)?.run.workspaceId;
  return closedTrash?.find(runId, target)?.entry.run.workspaceId;
}

/** The trash let the run go a moment ago, and its close is still on its way to the journal. */
function isEndingTrash(runId: string, target: CanopyTrashTarget): boolean {
  const held = trashLedger?.get(runId);
  return (
    !!held?.ended && held.run.spawnedAt === target.spawnedAt && held.expiresAt === target.expiresAt
  );
}

/** The host's own word that the terminal is still in that trash, read just before acting on it. */
async function assertHostHolds(
  runId: string,
  target: CanopyTrashTarget
): Promise<HostTerminalRecord> {
  const record = await requirePtyClient()
    .getTerminalAsync(runId)
    .catch(() => null);
  if (
    !record ||
    record.spawnedAt !== target.spawnedAt ||
    record.isTrashed !== true ||
    record.trashExpiresAt !== target.expiresAt
  ) {
    throw leftTheTrash();
  }
  // Restored, removed or expired elsewhere while the host answered.
  heldTrash(runId, target);
  return record;
}

type HostTerminalRecord = NonNullable<
  Awaited<ReturnType<ReturnType<typeof requirePtyClient>["getTerminalAsync"]>>
>;

/**
 * Puts back a run from Canopy's Trash, whoever trashed it. A trash Canopy
 * made goes back as its Undo would; any other was a view's own close, so the
 * view holding the pane puts it back from its trash, as its own Restore would.
 * With no view of the project open, nothing holds the pane: the terminal
 * would come back with nowhere to show, so nothing is restored.
 */
async function restoreTrashedRun(
  runId: string,
  target: CanopyTrashTarget,
  mayRestore: (workspaceId: string) => boolean
): Promise<void> {
  const held = heldTrash(runId, target);
  const receipt = receiptFor(held);
  if (receipt !== undefined) {
    await restoreThroughOwningViews(receipt, (trashed) => mayRestore(trashed.workspaceId));
    return;
  }
  await assertHostHolds(runId, target);
  const workspaceId = held.run.workspaceId;
  const views = getProjectPushTargets(workspaceId, CHANNELS.CANOPY_RESTORE_REQUESTED);
  if (views.length === 0) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "Trashed terminal's project has no open view",
      userMessage: "That terminal's project has closed since. Nothing was restored.",
    });
  }
  if (!mayRestore(workspaceId)) throw drivenElsewhere(workspaceId);
  requirePtyClient().restore(runId);
  for (const view of views) {
    try {
      view.send(CHANNELS.CANOPY_RESTORE_REQUESTED, { runId } satisfies CanopyRestoreRequest);
    } catch {
      // A view torn down mid-send has no pane left to restore.
    }
  }
}

/**
 * Ends a trashed run on the host, for a pane no view holds: closed as the
 * trash's own expiry closes it, its session captured for resuming and handed
 * to the same journal. Not waited on: an agent may take seconds to quit.
 */
function endOnHost(runId: string, info: HostTerminalRecord): void {
  const ptyClient = requirePtyClient();
  // The generation before the kill: a respawn under the same id must not take the record.
  const launchGeneration = getLifecycleLedger().currentGeneration(runId);
  // Sent at once, with the record just checked: nothing may move between the check and the kill.
  const closing = ptyClient.gracefulKill(runId);
  void (async () => {
    const sessionId = await closing;
    // An agent that had exited is not killed by a graceful close: its record goes too.
    if (info.isExited === true) ptyClient.kill(runId, "canopy-trash-removed");
    if (!sessionId || !info.launchAgentId || info.isAssistantTerminal === true) return;
    events.emit("agent-session:captured", {
      terminalId: runId,
      launchGeneration,
      boundary: "trash-expiry",
      record: {
        sessionId,
        agentId: info.launchAgentId,
        worktreeId: info.worktreeId ?? null,
        title:
          (info.titleMode === "user" ? info.title : (info.lastObservedTitle ?? info.title)) ?? null,
        projectId: info.projectId ?? null,
        agentLaunchFlags: info.agentLaunchFlags,
        agentModelId: info.agentModelId,
        cwd: info.cwd,
        ...scheduledRunForRecord(info),
        ...attributeClose(info, "kill"),
      },
    });
  })().catch((error: unknown) => {
    console.warn("[Canopy] Ending a trashed terminal failed:", error);
  });
}

/** How long a view is given to take a removal before the host ends the run itself. */
const REMOVE_FALLBACK_MS = 3_000;
const removeFallbacks = new Set<ReturnType<typeof setTimeout>>();

/**
 * Removes a run in Canopy's Trash for good, ending its process. The view
 * holding the pane removes it as its own Remove would, so its session is
 * kept for resuming as any close keeps it. A pane no view holds — trashed
 * from Canopy with its project closed, or a view reloaded since — is ended
 * on the host.
 */
async function removeTrashedRun(
  runId: string,
  target: CanopyTrashTarget,
  mayRemove: (workspaceId: string) => boolean
): Promise<void> {
  const held = heldTrash(runId, target);
  const record = await assertHostHolds(runId, target);
  // Control can move while the host is asked.
  if (!mayRemove(held.run.workspaceId)) throw drivenElsewhere(held.run.workspaceId);
  const receipt = receiptFor(held);
  // Trashed into the saved layout, so no open view holds the pane, even one
  // of the project opened since.
  const savedOnly = receipt !== undefined && recentlyTrashed.get(receipt)?.layoutSaved === true;
  // The trash is over: an Undo of it must find nothing to put back. Its close
  // lands already out of Canopy's Trash, whichever path ends the process.
  forgetReceiptsFor(runId, target.spawnedAt);
  noteCanopyTrashRemoval({ id: runId, spawnedAt: target.spawnedAt });
  const views = getProjectPushTargets(held.run.workspaceId, CHANNELS.CANOPY_REMOVE_REQUESTED);
  if (views.length === 0 || savedOnly) {
    endOnHost(runId, record);
    return;
  }
  for (const view of views) {
    try {
      view.send(CHANNELS.CANOPY_REMOVE_REQUESTED, { runId } satisfies CanopyRemoveRequest);
    } catch {
      // A view torn down mid-send has no pane left to remove.
    }
  }
  // The view's close takes it out of the trash at once; still there, no view
  // held it. Checked again as at the request: that trash, and still this
  // window's to change.
  const fallback = setTimeout(() => {
    removeFallbacks.delete(fallback);
    if (trashLedger?.get(runId) === undefined) return;
    void assertHostHolds(runId, target).then(
      (still) => {
        if (mayRemove(held.run.workspaceId)) endOnHost(runId, still);
      },
      () => {}
    );
  }, REMOVE_FALLBACK_MS);
  fallback.unref?.();
  removeFallbacks.add(fallback);
}

/**
 * Takes an ended run out of Canopy's Trash. Nothing is ended or deleted: its
 * session stays in the journal for the Resume Sessions palette.
 */
async function dismissClosedRun(runId: string, target: CanopyTrashTarget): Promise<void> {
  const terminal = { id: runId, spawnedAt: target.spawnedAt };
  // A close still on its way lands removed; one already journaled is marked so.
  noteCanopyTrashRemoval(terminal);
  trashLedger?.remove(runId);
  await removeFromCanopyTrash([terminal], app.getPath("userData"));
}

function stillClosing(): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "Terminal's close is still being saved",
    userMessage: "That agent is still closing. Try again in a moment.",
  });
}

/** How long the project's view is given to take up a resume before Canopy stops waiting. */
const RESUME_START_MS = 30_000;
/** How long a resume the view took up is given to land its pane. */
const RESUME_LAUNCH_MS = 30_000;
const MAX_PENDING_RESUMES = 20;

interface PendingResume {
  /** The view asked: only its word counts. */
  viewId: number;
  /** The view took it up: it is launching, and is waited for. */
  started: boolean;
  resolve: (answer: CanopyResumeAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingResumes = new Map<string, PendingResume>();
/** One resume at a time per close: a second Restore joins the first. */
const resumingCloses = new Map<string, Promise<CanopyRestoreOutcome>>();

/**
 * The view asked is about to launch: while Canopy still waits, the launch gets
 * its own while to land, and the view is told how long, so a reply it hears
 * late starts nothing either. Null once Canopy stopped waiting, so a view slow
 * to hear never launches a resume nobody is told of.
 */
function startResume(requestId: string, viewId: number): number | null {
  const pending = pendingResumes.get(requestId);
  if (!pending || pending.viewId !== viewId || pending.started) return null;
  pending.started = true;
  clearTimeout(pending.timer);
  pending.timer = setTimeout(
    () => settleResume(requestId, { error: "The project didn't finish resuming it in time." }),
    RESUME_LAUNCH_MS
  );
  pending.timer.unref?.();
  return RESUME_LAUNCH_MS;
}

function settleResume(requestId: string, answer: CanopyResumeAnswer): void {
  const pending = pendingResumes.get(requestId);
  if (!pending) return;
  pendingResumes.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(answer);
}

/**
 * Asks one view of the run's project to resume its session, the way the
 * Resume Sessions palette does, and waits for the pane it lands in. The
 * caller's own view when it shows that project; otherwise the project's first.
 */
function askViewToResume(
  ctx: IpcContext,
  workspaceId: string,
  request: Omit<CanopyResumeRequest, "requestId">
): Promise<CanopyResumeAnswer> | null {
  const views = getProjectPushTargets(workspaceId, CHANNELS.CANOPY_RESUME_REQUESTED).filter(
    (view) => !view.isDestroyed()
  );
  // A view that doesn't drive the project would hold the launch for control
  // while reporting a pane: only the driver's, or with a window of this
  // machine driving, any of this machine's windows.
  const driver = peekDriveLeaseService()?.getHolderEndpoint(workspaceId)?.handle;
  const permitted =
    driver === undefined
      ? views
      : views.filter((view) => view.id === driver || (driver > 0 && view.id > 0));
  const view = permitted.find((candidate) => candidate.id === ctx.webContentsId) ?? permitted[0];
  if (!view) return null;
  if (pendingResumes.size >= MAX_PENDING_RESUMES) {
    throw new AppError({
      code: "RATE_LIMITED",
      message: "Too many resumes waiting on their views",
      userMessage: "Too many agents are being restored at once. Try again in a moment.",
    });
  }
  const requestId = randomUUID();
  return new Promise<CanopyResumeAnswer>((resolve) => {
    const timer = setTimeout(
      () => settleResume(requestId, { error: "The project didn't answer in time." }),
      RESUME_START_MS
    );
    timer.unref?.();
    pendingResumes.set(requestId, { viewId: view.id, started: false, resolve, timer });
    const send = () => {
      try {
        view.send(CHANNELS.CANOPY_RESUME_REQUESTED, {
          requestId,
          ...request,
        } satisfies CanopyResumeRequest);
      } catch {
        settleResume(requestId, { error: "The project's window closed." });
      }
    };
    // A cached view may be frozen, and a frozen renderer runs nothing until thawed.
    const local = view.id > 0 ? webContents.fromId(view.id) : undefined;
    if (local) thawThenSend(local, () => pendingResumes.has(requestId), send);
    else send();
  });
}

/**
 * Puts back a run whose process the trash let go: its project's view resumes
 * the session it was running, as the Resume Sessions palette would, or shows
 * the pane already running it. Taken out of the Trash once a pane has it.
 * With no view of the project open, says so, and the caller opens it there.
 */
async function resumeClosedRun(
  ctx: IpcContext,
  runId: string,
  target: CanopyTrashTarget
): Promise<CanopyRestoreOutcome> {
  const closed = closedTrash?.find(runId, target);
  if (!closed) throw leftTheTrash();
  if (closed.entry.ended?.worktreeRemoved) {
    throw new AppError({
      code: "NOT_FOUND",
      message: "Closed terminal's worktree was removed",
      userMessage: "That agent's worktree has been removed. There's nowhere to resume it.",
    });
  }
  const workspaceId = closed.entry.run.workspaceId;
  const key = `${runId}#${target.spawnedAt}`;
  const joined = resumingCloses.get(key);
  if (joined) return joined;
  const asked = askViewToResume(ctx, workspaceId, { session: closed.record });
  if (!asked) return { open: { workspaceId } };
  const resuming = asked.then(async (answer): Promise<CanopyRestoreOutcome> => {
    if ("error" in answer) {
      throw new AppError({
        code: "PROJECT_VIEW_UNAVAILABLE",
        message: "Resuming a closed terminal failed",
        userMessage: answer.error,
      });
    }
    await dismissClosedRun(runId, target).catch((error: unknown) => {
      // The pane is back; only the Trash still lists it, until a later write.
      console.warn("[Canopy] Taking a resumed run out of the Trash failed:", error);
    });
    return { runId: answer.runId };
  });
  resumingCloses.set(key, resuming);
  try {
    return await resuming;
  } finally {
    if (resumingCloses.get(key) === resuming) resumingCloses.delete(key);
  }
}

/** Whether a worktree's directory is gone. Only a missing directory says so: unreadable is not gone. */
async function isWorktreeGone(worktreePath: string): Promise<boolean> {
  try {
    await stat(worktreePath);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

const MAX_EMPTY_TRASH = 200;

function requirePtyClient() {
  const ptyClient = getPtyClient();
  if (!ptyClient) throw new Error("The terminal host isn't available.");
  return ptyClient;
}

/**
 * The workspace the open panels show, when they agree: its runs are read at a
 * panel's pace and given words. Otherwise every workspace, each panel showing
 * its own. Runs outside it are still watched as the background watch watches
 * them, since that lights the toolbar and pages for every project.
 */
function reconciledScope(): string | null {
  const scopes = new Set([...activeViews].map((id) => viewScopes.get(id) ?? null));
  return scopes.size === 1 ? ([...scopes][0] ?? null) : null;
}

function syncActive(): void {
  const canopy = getService();
  // History pruned, or a worktree deleted, while no panel looked: an opening
  // panel sees the closes as they stand now.
  if (activeViews.size > 0) {
    closedTrash?.refresh();
    closedTrash?.recheckWorktrees();
  }
  // Opening, scope first, so the scan the opening starts reads the right runs;
  // closing, the close first, so a wider scope starts nothing while it settles.
  if (activeViews.size > 0) {
    canopy.setScope(reconciledScope());
    canopy.setActive(true);
  } else {
    canopy.setActive(false);
    canopy.setScope(reconciledScope());
  }
}

/** A view that stopped showing its panel without saying so (reload, crash, teardown). */
function forgetView(id: number): void {
  stopTerminalWatch(id);
  viewScopes.delete(id);
  viewShown.delete(id);
  service?.forgetViewer(id);
  if (!activeViews.delete(id)) return;
  // Never builds a service: after cleanup there may be none, and none is wanted.
  // A view that went away will not bounce back, so no reopen grace either.
  service?.setActive(activeViews.size > 0, true);
  service?.setScope(reconciledScope());
}

/** The view a call came from, as something a push can reach: local or remote. */
function viewOf(ctx: IpcContext): ProjectPushTarget {
  return ctx.event?.sender ?? endpointPushTarget(ctx.endpoint);
}

/**
 * Forget a view's panel once it stops showing it without saying so: a local
 * view by its own lifecycle, a remote one when its endpoint closes. A remote
 * view's reload keeps its endpoint, so its panel is forgotten when it next
 * opens it or the view goes.
 */
function watchView(ctx: IpcContext): void {
  const id = ctx.webContentsId;
  if (watchedViews.has(id)) return;
  const sender = ctx.event?.sender;
  if (!sender) {
    const closed = ctx.endpoint.onClose(() => {
      watchedViews.delete(id);
      forgetView(id);
    });
    watchedViews.set(id, () => closed.dispose());
    return;
  }
  // One set of listeners per WebContents for its whole life, not one per
  // opening: re-adding on every open leaked a `destroyed` listener each time
  // the panel was closed and reopened.
  const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    // A reload replaces the document without running React's cleanup, so the
    // new document starts with its panel closed and must open it again.
    if (details.isMainFrame && !details.isSameDocument) forgetView(id);
  };
  const onGone = () => forgetView(id);
  sender.on("did-start-navigation", onNavigate);
  sender.on("render-process-gone", onGone);
  const unwatchDestroyed = onWebContentsDestroyed(sender, () => {
    watchedViews.delete(id);
    forgetView(id);
  });
  watchedViews.set(id, () => {
    sender.removeListener("did-start-navigation", onNavigate);
    sender.removeListener("render-process-gone", onGone);
    unwatchDestroyed();
  });
}

/**
 * Typing into, resizing or putting back a run's terminal is its project's
 * driver's to do while a drive lease is held, as through `terminal:input`. The
 * run names the project, not the caller's view, so the handler checks it.
 */
function drivesProject(ctx: IpcContext, projectId: string | null): boolean {
  const lease = peekDriveLeaseService();
  return !lease || projectId === null || lease.isDriving(projectId, ctx.endpoint);
}

function drivesRun(ctx: IpcContext, runId: string): boolean {
  if (!peekDriveLeaseService()) return true;
  return drivesProject(ctx, requirePtyClient().getTerminalProjectId(runId));
}

function drivenElsewhere(projectId: string | null): AppError {
  return new AppError({
    code: "DRIVEN_ELSEWHERE",
    message: `project ${projectId ?? "unknown"} is driven elsewhere; only its driver may change its terminals`,
    userMessage: "This project is being driven from another screen.",
    context: { projectId },
  });
}

/**
 * A panel reading this host from a view bound elsewhere. It types and sizes a
 * worker's terminal as its own machine's windows do, but has no files on this
 * machine to attach.
 */
function isViewer(ctx: IpcContext): boolean {
  return isCanopyViewerEndpointId(ctx.endpoint.endpointId);
}

/**
 * An assistant is watched from a window of the machine it runs on, or by a
 * viewer this machine serves for a person reading it from elsewhere (#14163).
 * A window bound to another host forwards its terminal input there, so a
 * stream opened here would take keystrokes meant for that host's terminal of
 * the same id; and a remote view's own endpoint is a project's window, not a
 * viewer of this machine's assistants.
 */
function assertViewsThisMachine(ctx: IpcContext): void {
  if (isViewer(ctx)) return;
  if (!ctx.event || getIpcDispatcher().hostForSender(ctx.webContentsId) !== null) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "Assistants are viewed from the machine they run on.",
      userMessage: "Open this assistant from a window on its own machine.",
    });
  }
}

/** Where main holds the assistants a person can view; read at the moment of use. */
async function liveAssistantSources() {
  const [{ helpSessionService }, { peekGlobalAssistantService }] = await Promise.all([
    import("../../services/HelpSessionService.js"),
    import("../../services/globalAssistant.js"),
  ]);
  const global = peekGlobalAssistantService();
  return {
    hostId: LOCAL_HOST_ID,
    ptyClient: requirePtyClient(),
    getRunningLaneSession: (projectId: string, slot: number) =>
      helpSessionService.getRunningLaneSession(projectId, slot),
    onSessionEnded: (
      listener: (event: { projectId: string; slot: number; sessionId: string }) => void
    ) => helpSessionService.addSessionEndedListener(listener),
    global: global
      ? {
          getState: () => global.getState(),
          onChange: (listener: () => void) => global.onChange(() => listener()),
          inputOwnerWebContentsId: () => global.inputOwnerWebContentsId(),
          canWrite: (attachmentId: string, epoch: number) => global.canWrite(attachmentId, epoch),
        }
      : null,
  };
}

/**
 * A card answer presses keys with no input ownership behind it, so it never
 * reaches the global assistant, whose input one window holds at a time (#14454).
 */
async function assertNotGlobalAssistant(runId: string): Promise<void> {
  const { peekGlobalAssistantService } = await import("../../services/globalAssistant.js");
  const state = peekGlobalAssistantService()?.getState();
  if (state?.terminalId === runId) {
    throw new AppError({
      code: "PERMISSION",
      message: "card answers don't reach the global assistant",
      userMessage: "Answer the global assistant from the window that has its input.",
    });
  }
}

/** An assistant a person watches takes their keystrokes only while they may type to it. */
function assertMayType(watched: { assistant: boolean; mayType: boolean }): void {
  if (watched.assistant && !watched.mayType) {
    throw new AppError({
      code: "PERMISSION",
      message: "another view holds the assistant's input",
      userMessage: "Another window has this assistant's input.",
    });
  }
}

let offDriveLease: (() => void) | null = null;

/**
 * A viewer that stops driving stops holding at once, so the new driver's panes
 * fit again without waiting for the stream to end; one that drives again asks
 * for its size again.
 */
function followDriveLease(): void {
  offDriveLease ??= peekDriveLeaseService()?.onChange(() => followDriveLeaseChange()) ?? null;
}

/** A composer's message and its image chips, as the host may take them. */
function assertSubmission(ctx: IpcContext, text: unknown, imagePaths: unknown): void {
  if (typeof text !== "string" || text.length > MAX_SUBMIT_LENGTH) {
    throw new Error("Invalid message");
  }
  if (
    imagePaths !== undefined &&
    (!Array.isArray(imagePaths) ||
      imagePaths.length > MAX_SUBMIT_IMAGES ||
      !imagePaths.every((path) => typeof path === "string" && isImageAttachmentPath(path)))
  ) {
    throw new Error("Invalid attachments");
  }
  // A path the viewer's machine named is nothing on this one.
  if (Array.isArray(imagePaths) && imagePaths.length > 0 && isViewer(ctx)) {
    throw new AppError({
      code: "VALIDATION",
      message: "a Canopy viewer named image paths from another machine",
      userMessage: "Images can't be sent to an agent on another host.",
    });
  }
}

function submitTo(runId: string, text: string, imagePaths: string[] | undefined): void {
  if (imagePaths !== undefined && imagePaths.length > 0) {
    requirePtyClient().submit(runId, text, undefined, undefined, undefined, imagePaths);
  } else {
    requirePtyClient().submit(runId, text);
  }
}

function assertDrivesRun(ctx: IpcContext, runId: string): void {
  if (!drivesRun(ctx, runId)) throw drivenElsewhere(requirePtyClient().getTerminalProjectId(runId));
}

export const canopyNamespace = defineIpcNamespace({
  name: "canopy",
  ops: {
    getSnapshot: op(CANOPY_METHOD_CHANNELS.getSnapshot, async (): Promise<CanopySnapshot> => {
      // Not on, there is nothing to show and nothing is started to show it:
      // every view asks at launch, and a user who never turned Canopy on pays
      // for none of it until they open the panel.
      if (!service && readCanopyMode() !== "on") return hiddenOrIdleSnapshot();
      return getService().getSnapshot();
    }),

    /**
     * A panel opened or closed. With one open, main watches screens closely and
     * describes them; with none, changed screens go to the classifier alone.
     */
    setActive: op(
      CANOPY_METHOD_CHANNELS.setActive,
      async (ctx, active: boolean): Promise<CanopySnapshot> => {
        if (typeof active !== "boolean") throw new Error("Invalid active flag");
        const id = ctx.webContentsId;
        if (active) {
          activeViews.add(id);
          watchView(ctx);
        } else {
          activeViews.delete(id);
          // A closed panel shows nothing: the next open says afresh what it lists.
          viewShown.delete(id);
          stopTerminalWatch(id);
        }
        syncActive();
        return getService().getSnapshot();
      },
      { withContext: true }
    ),

    refresh: op(CANOPY_METHOD_CHANNELS.refresh, async (): Promise<void> => {
      requireActivated();
      checkRateLimit(CANOPY_METHOD_CHANNELS.refresh, 6, 10_000);
      await getService().refresh();
    }),

    /**
     * Stream the run's terminal to this view, for the panel's live pane. One
     * per view: watching another run, closing the panel, a reload or the view
     * going away all end it. Only ever the run the user selected, and only
     * while its incarnation is the one the card was built from.
     */
    watchTerminal: op(
      CANOPY_METHOD_CHANNELS.watchTerminal,
      async (ctx, runId: string, target: CanopyTarget): Promise<CanopyTerminalView> => {
        // One stream per view, and a newer request overtakes an older one, so
        // this only bounds a runaway view: arrowing down the list opens one per row.
        checkRateLimit(CANOPY_METHOD_CHANNELS.watchTerminal, 120, 10_000);
        assertRunId(runId);
        assertTarget(target);
        const viewId = ctx.webContentsId;
        // Claimed before the first await, so an unwatch, a close or a newer
        // selection arriving during validation cancels this one.
        const ticket = beginWatchRequest(viewId);
        // The pane's effect can run before the panel's own `setActive` lands,
        // so a watch carries its own lifecycle cleanup rather than requiring it.
        watchView(ctx);
        // Taken before validating, so a respawn while the host is asked can't
        // bind the stream to the successor of the terminal it checked.
        const ptyClient = requirePtyClient();
        const generation = ptyClient.getLiveGeneration(runId);
        await assertSameTerminal(runId, target);
        if (!isCurrentWatchRequest(viewId, ticket)) return { watchId: null, snapshot: null };
        if (generation !== null && !ptyClient.isLiveGeneration(runId, generation)) {
          throw new Error("That agent isn't running any more.");
        }
        const remote = isViewer(ctx);
        if (remote) followDriveLease();
        const view = await watchTerminal(
          ptyClient,
          viewOf(ctx),
          runId,
          target.spawnedAt,
          ticket,
          generation,
          // Sizing follows typing: only while the view drives the run's project.
          () => drivesRun(ctx, runId),
          null,
          remote
        );
        // Says to a panel on another machine that this host takes its size;
        // one that predates it says nothing, and is never asked.
        return view.watchId === null ? view : { ...view, holdsSize: true };
      },
      { withContext: true }
    ),

    /**
     * Stream a Daintree Assistant's terminal to this view, for the person who
     * chose it. Admission is main's own hold on the lane (or the global
     * session) and the exact launch generation the subject names, never the
     * fleet, and Canopy need not be on: nothing here reads the screen, lists
     * the run or marks it handled.
     */
    watchAssistantTerminal: op(
      CANOPY_METHOD_CHANNELS.watchAssistantTerminal,
      async (
        ctx,
        subject: AgentDirectorySubject,
        inputStamp?: GlobalAssistantInputStamp
      ): Promise<CanopyTerminalView> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.watchAssistantTerminal, 120, 10_000);
        assertViewsThisMachine(ctx);
        // A viewer serves another machine's reader, which never holds this one's input.
        const stamp = isViewer(ctx) ? null : parseGlobalAssistantInputStamp(inputStamp);
        const viewId = ctx.webContentsId;
        const ticket = beginWatchRequest(viewId);
        watchView(ctx);
        const binding = await resolveLiveAssistant(subject, await liveAssistantSources(), stamp);
        if (!isCurrentWatchRequest(viewId, ticket)) return { watchId: null, snapshot: null };
        const ptyClient = requirePtyClient();
        const { terminalId } = binding.subject;
        return watchTerminal(
          ptyClient,
          viewOf(ctx),
          terminalId,
          binding.spawnedAt,
          ticket,
          binding.launchGeneration,
          // Resize authority follows input: a global session's other windows only read it,
          // and a viewer follows the size this machine's own window gave the terminal.
          isViewer(ctx) ? () => false : () => drivesRun(ctx, terminalId) && binding.mayType(viewId),
          binding
        );
      },
      { withContext: true }
    ),

    /**
     * Where "Open in Assistant" goes for this subject, if main still runs it.
     * Passive: nothing is attached, switched, started or resumed to answer;
     * null when the session has ended or been replaced.
     */
    resolveAssistant: op(
      CANOPY_METHOD_CHANNELS.resolveAssistant,
      async (ctx, subject: AgentDirectorySubject): Promise<AssistantOpenDestination | null> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.resolveAssistant, 60, 10_000);
        assertViewsThisMachine(ctx);
        const binding = await resolveLiveAssistant(subject, await liveAssistantSources()).catch(
          (error: unknown) => {
            // Only a session that has ended or been replaced answers "nothing to open";
            // a bad subject, another host or a failure is said as itself.
            if (
              error instanceof AppError &&
              (error.code === "NOT_FOUND" || error.code === "STALE_GENERATION")
            ) {
              return null;
            }
            throw error;
          }
        );
        if (!binding) return null;
        const { hostId, scope, terminalId, incarnation, lane } = binding.subject;
        return scope.kind === "project" && lane !== undefined
          ? { scope: "project", hostId, projectId: scope.projectId, lane, terminalId, incarnation }
          : { scope: "global", hostId, terminalId, incarnation };
      },
      { withContext: true }
    ),

    /**
     * This machine's workers and assistants, for Canopy's role filter and the
     * assistant picker. Passive like the directory itself, and outside Canopy's
     * gate: listing an assistant reads no screen and sends nothing anywhere.
     */
    readAgentDirectory: op(
      CANOPY_METHOD_CHANNELS.readAgentDirectory,
      async (ctx, options?: { projectId?: string }): Promise<AgentDirectory> => {
        // Per view: every open Canopy and picker reads every few seconds, and
        // one window's surfaces must not spend another's allowance.
        checkRateLimit(
          `${CANOPY_METHOD_CHANNELS.readAgentDirectory}#${ctx.webContentsId}`,
          20,
          10_000
        );
        assertViewsThisMachine(ctx);
        if (
          options !== undefined &&
          (typeof options !== "object" || options === null || Array.isArray(options))
        ) {
          throw new AppError({ code: "VALIDATION", message: "Invalid directory options" });
        }
        const projectId = options?.projectId;
        if (
          projectId !== undefined &&
          (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256)
        ) {
          throw new AppError({ code: "VALIDATION", message: "Invalid project id" });
        }
        const { getLocalAgentDirectory } =
          await import("../../services/assistants/localAgentDirectory.js");
        return getLocalAgentDirectory().read(projectId === undefined ? {} : { projectId });
      },
      { withContext: true }
    ),

    /**
     * Which of this machine's workers an assistant made or holds (#14166), for
     * Canopy's "Show its work". Read from main's own records, passive like the
     * directory, and outside Canopy's gate for the same reason.
     */
    readAssistantWork: op(
      CANOPY_METHOD_CHANNELS.readAssistantWork,
      async (ctx): Promise<AssistantWorkReading> => {
        checkRateLimit(
          `${CANOPY_METHOD_CHANNELS.readAssistantWork}#${ctx.webContentsId}`,
          20,
          10_000
        );
        assertViewsThisMachine(ctx);
        const { readLocalAssistantWork } =
          await import("../../services/assistants/localAssistantWork.js");
        return readLocalAssistantWork();
      },
      { withContext: true }
    ),

    unwatchTerminal: op(
      CANOPY_METHOD_CHANNELS.unwatchTerminal,
      async (ctx, watchId?: number): Promise<void> => {
        if (watchId === undefined) {
          stopTerminalWatch(ctx.webContentsId);
          return;
        }
        if (!Number.isSafeInteger(watchId)) throw new Error("Invalid watch");
        stopTerminalWatchById(ctx.webContentsId, watchId);
      },
      { withContext: true }
    ),

    /**
     * The user turned Canopy on — agreeing, in the panel, to send agent screens
     * off the machine to be read — or off again from Settings; or hid it, or
     * showed it again. Leaving `on`, every card read so far is dropped and every
     * live terminal view ends. Hidden is left for `unset` only: reading starts
     * again only through turning it on.
     *
     * `expectRevision` is the mode revision the change was made against — an
     * Undo's — so one made after Canopy moved on since, in any view, changes
     * nothing and answers how Canopy stands now. `expectHostEpoch` is the same
     * guard for the host process: a revision counted before a restart is not
     * this one's.
     */
    setMode: op(
      CANOPY_METHOD_CHANNELS.setMode,
      async (
        mode: CanopyMode,
        expectRevision?: number,
        expectHostEpoch?: string
      ): Promise<CanopySnapshot> => {
        if (!isCanopyMode(mode)) throw new Error("Invalid Canopy mode");
        if (expectRevision !== undefined && !Number.isSafeInteger(expectRevision)) {
          throw new Error("Invalid Canopy mode revision");
        }
        if (expectHostEpoch !== undefined) {
          if (typeof expectHostEpoch !== "string" || expectHostEpoch.length > 64) {
            throw new Error("Invalid Canopy host epoch");
          }
          if (expectRevision === undefined) throw new Error("A host epoch needs a revision");
        }
        checkCanopyModeRate();
        return changeCanopyMode(mode, expectRevision, expectHostEpoch);
      }
    ),

    /** The model, and whether it is on this machine. */
    /**
     * The terminals a panel on another machine holds at its own size, for a
     * window here to freeze their panes. Not gated on Canopy: any window with
     * the terminal open needs it, and with Canopy off the list is empty.
     */
    getSizeHolds: op(CANOPY_METHOD_CHANNELS.getSizeHolds, async (): Promise<string[]> =>
      remoteSizeHolds()
    ),

    getModel: op(CANOPY_METHOD_CHANNELS.getModel, async (): Promise<CanopyModelInfo> =>
      getModels().info()
    ),

    /** Tries a failed or stopped download again. */
    retryModel: op(CANOPY_METHOD_CHANNELS.retryModel, async (): Promise<CanopySnapshot> => {
      ensureModel();
      return service ? service.getSnapshot() : hiddenOrIdleSnapshot();
    }),

    /**
     * Deletes the downloaded model, at any time. With Canopy on that turns it
     * off first, by the same guarded change as any other turn-off, so every view
     * hears it and nothing downloads the model again on the next launch.
     */
    removeModels: op(CANOPY_METHOD_CHANNELS.removeModels, async (): Promise<CanopySnapshot> => {
      checkRateLimit(CANOPY_METHOD_CHANNELS.removeModels, 10, 10_000);
      if (readCanopyMode() === "on") changeCanopyMode("unset");
      reader?.release();
      models?.cancel();
      await getModels().remove(false);
      return service ? service.getSnapshot() : hiddenOrIdleSnapshot();
    }),

    /** Raw keystrokes from the live view, for the terminal it is streaming. */
    terminalInput: op(
      CANOPY_METHOD_CHANNELS.terminalInput,
      async (ctx, watchId: number, data: string): Promise<void> => {
        if (typeof data !== "string" || data.length === 0 || data.length > MAX_INPUT_LENGTH) {
          throw new Error("Invalid input");
        }
        const watched = requireWatched(ctx.webContentsId, watchId);
        assertMayType(watched);
        assertDrivesRun(ctx, watched.runId);
        requirePtyClient().write(watched.runId, data);
        // Return submits a line: the user has answered what the screen showed.
        if (!watched.assistant && terminalAnswerOf(data) === "submit") {
          service?.noteUserSent(watched.runId, watched.spawnedAt);
          service?.markHandled(watched.runId, watched.spawnedAt);
        }
      },
      { withContext: true }
    ),

    /**
     * The live view's own size: the PTY is held at it while the view shows the
     * terminal, and handed back to its pane's size when the stream ends.
     */
    terminalResize: op(
      CANOPY_METHOD_CHANNELS.terminalResize,
      async (ctx, watchId: number, cols: number, rows: number): Promise<void> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.terminalResize, 60, 10_000);
        // Ignored rather than refused, as `terminal:resize` ignores one: the
        // panel keeps reading at whatever size the driver's pane gave it.
        const watched = watchedTerminal(ctx.webContentsId, watchId);
        // A viewer's assistant follows the size this machine's own window gave it.
        if (isViewer(ctx) && watched?.assistant !== false) return;
        if (watched && !drivesRun(ctx, watched.runId)) return;
        // Another window's session to size: this one only reads it.
        if (watched && !watched.mayType) return;
        resizeWatchedTerminal(requirePtyClient(), ctx.webContentsId, watchId, cols, rows);
      },
      { withContext: true }
    ),

    /** A named key from the composer (Escape, an arrow), for the streamed terminal. */
    terminalSendKey: op(
      CANOPY_METHOD_CHANNELS.terminalSendKey,
      async (ctx, watchId: number, key: string): Promise<void> => {
        if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
          throw new Error("Invalid key");
        }
        const watched = requireWatched(ctx.webContentsId, watchId);
        assertMayType(watched);
        assertDrivesRun(ctx, watched.runId);
        requirePtyClient().sendKey(watched.runId, key);
        if (!watched.assistant && key === "enter") {
          service?.noteUserSent(watched.runId, watched.spawnedAt);
          service?.markHandled(watched.runId, watched.spawnedAt);
        }
      },
      { withContext: true }
    ),

    /** A message from the composer, submitted to the streamed terminal. */
    terminalSubmit: op(
      CANOPY_METHOD_CHANNELS.terminalSubmit,
      async (ctx, watchId: number, text: string, imagePaths?: string[]): Promise<void> => {
        assertSubmission(ctx, text, imagePaths);
        const watched = requireWatched(ctx.webContentsId, watchId);
        assertMayType(watched);
        // The stream ends on exit, but a submit is worth one more look at the
        // host's own record: the message must reach this incarnation or none.
        const record = await requirePtyClient()
          .getTerminalAsync(watched.runId)
          .catch(() => null);
        const current = watchedTerminal(ctx.webContentsId, watchId);
        if (
          !record ||
          record.spawnedAt !== watched.spawnedAt ||
          record.isExited === true ||
          current === null
        ) {
          throw new Error("That agent isn't running any more.");
        }
        // Input may have moved to another window while the host answered.
        assertMayType(current);
        assertDrivesRun(ctx, watched.runId);
        submitTo(watched.runId, text, imagePaths);
        if (!watched.assistant) {
          service?.noteUserSent(watched.runId, watched.spawnedAt);
          service?.markHandled(watched.runId, watched.spawnedAt);
        }
      },
      { withContext: true }
    ),

    /**
     * A reply that outlived its card: a dictated send waits for its cleanup,
     * and the user may have moved to another run, whose stream replaced this
     * one's, by the time it goes (#15510). It goes by the run, as an answer does.
     */
    submitReply: op(
      CANOPY_METHOD_CHANNELS.submitReply,
      async (
        ctx,
        runId: string,
        target: CanopyTarget,
        text: string,
        imagePaths?: string[]
      ): Promise<void> => {
        // The user's own words, as typed into the pane: no reading needed.
        checkRateLimit(CANOPY_METHOD_CHANNELS.submitReply, 30, 10_000);
        assertRunId(runId);
        assertTarget(target);
        assertSubmission(ctx, text, imagePaths);
        assertDrivesRun(ctx, runId);
        // Taken before validating, so a respawn while the host is asked can't
        // take the reply its predecessor was sent.
        const ptyClient = requirePtyClient();
        const generation = ptyClient.getLiveGeneration(runId);
        await assertNotGlobalAssistant(runId);
        await assertSameTerminal(runId, target);
        if (generation !== null && !ptyClient.isLiveGeneration(runId, generation)) {
          throw new Error("That agent isn't running any more.");
        }
        // Control can move to another screen while the host answered.
        assertDrivesRun(ctx, runId);
        submitTo(runId, text, imagePaths);
        service?.noteUserSent(runId, target.spawnedAt);
        service?.markHandled(runId, target.spawnedAt);
      },
      { withContext: true }
    ),

    /**
     * Move the run to the trash — restorable, so no confirmation tier applies
     * (D0). Returns the receipt `untrash` takes back, or null when the run had
     * already left the fleet and so has no project to restore it into.
     */
    trash: op(
      CANOPY_METHOD_CHANNELS.trash,
      async (runId: string, target: CanopyTarget): Promise<number | null> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.trash, 20, 10_000);
        assertRunId(runId);
        assertTarget(target);
        // The same incarnation, exited or not: an exited agent's pane is
        // still there to clear away, as the pane says.
        await assertSameIncarnation(runId, target);
        return trashThroughOwningViews(runId, target.spawnedAt);
      }
    ),

    /**
     * Read one run again, its words included, for a reading the user thinks
     * is wrong: a screen that hasn't moved is otherwise never read again.
     */
    reread: op(
      CANOPY_METHOD_CHANNELS.reread,
      async (runId: string, target: CanopyTarget): Promise<void> => {
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.reread, 10, 10_000);
        assertRunId(runId);
        assertTarget(target);
        if (!(await getService().reread(runId, target.spawnedAt))) {
          throw new AppError({
            code: "NOT_FOUND",
            message: "Run not read yet",
            userMessage: "Canopy hasn't read that agent yet.",
          });
        }
      }
    ),

    /**
     * Take back a trash made from Canopy, by the receipt `trash` gave, while
     * the trash still holds that terminal.
     */
    // Not gated on Canopy being on: putting back a terminal it trashed reads
    // nothing, and turning Canopy off must not strand one in the trash.
    untrash: op(
      CANOPY_METHOD_CHANNELS.untrash,
      async (ctx, receipt: number): Promise<void> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.untrash, 20, 10_000);
        if (!Number.isSafeInteger(receipt) || receipt <= 0) {
          throw new Error("Invalid trash receipt");
        }
        // The receipt, not an argument the lease gate can read, names the
        // project: an exited terminal's live record no longer does.
        const trashed = recentlyTrashed.get(receipt);
        if (trashed && !drivesProject(ctx, trashed.workspaceId)) {
          throw drivenElsewhere(trashed.workspaceId);
        }
        await restoreThroughOwningViews(receipt, (held) => drivesProject(ctx, held.workspaceId));
      },
      { withContext: true }
    ),

    /**
     * Put back a run from Canopy's Trash, whoever trashed it, while the trash
     * still holds that trash of it. Not gated on Canopy being on, as Undo isn't.
     */
    restoreTrashed: op(
      CANOPY_METHOD_CHANNELS.restoreTrashed,
      async (ctx, runId: string, target: CanopyTrashTarget): Promise<CanopyRestoreOutcome> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.restoreTrashed, 20, 10_000);
        assertRunId(runId);
        assertTrashTarget(target);
        if (isLiveTrash(runId, target)) {
          const workspaceId = heldTrash(runId, target).run.workspaceId;
          if (!drivesProject(ctx, workspaceId)) throw drivenElsewhere(workspaceId);
          await restoreTrashedRun(runId, target, (project) => drivesProject(ctx, project));
          return { runId };
        }
        if (isEndingTrash(runId, target)) throw stillClosing();
        // Read the journal again: a close aged out of history since is not resumed.
        closedTrash?.refresh();
        const workspaceId = closedTrash?.find(runId, target)?.entry.run.workspaceId;
        if (workspaceId === undefined) throw leftTheTrash();
        if (!drivesProject(ctx, workspaceId)) throw drivenElsewhere(workspaceId);
        return resumeClosedRun(ctx, runId, target);
      },
      { withContext: true }
    ),

    /**
     * A project's view is about to launch a resume Canopy asked of it: how
     * long it has to land the pane, or null once Canopy stopped waiting. Only
     * the view asked is heard, and only once.
     */
    resumeStarted: op(
      CANOPY_METHOD_CHANNELS.resumeStarted,
      async (ctx, requestId: string): Promise<number | null> => {
        if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 64) {
          throw new Error("Invalid resume request id");
        }
        return startResume(requestId, ctx.webContentsId);
      },
      { withContext: true }
    ),

    /**
     * A project's view answers a resume Canopy asked of it: the pane now
     * running the session, or why there is none. Only the view asked is heard.
     */
    resumeSettled: op(
      CANOPY_METHOD_CHANNELS.resumeSettled,
      async (ctx, requestId: string, answer: CanopyResumeAnswer): Promise<void> => {
        if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 64) {
          throw new Error("Invalid resume request id");
        }
        const pending = pendingResumes.get(requestId);
        if (!pending || pending.viewId !== ctx.webContentsId) return;
        const resumed =
          answer !== null &&
          typeof answer === "object" &&
          "runId" in answer &&
          typeof answer.runId === "string" &&
          answer.runId.length > 0 &&
          answer.runId.length <= 200;
        const failed =
          answer !== null &&
          typeof answer === "object" &&
          "error" in answer &&
          typeof answer.error === "string";
        settleResume(
          requestId,
          resumed
            ? { runId: answer.runId }
            : { error: failed ? answer.error.slice(0, 500) : "The project couldn't resume it." }
        );
      },
      { withContext: true }
    ),

    /**
     * Remove a run in Canopy's Trash for good, ending its process: D1, so the
     * panel confirms before it asks.
     */
    removeTrashed: op(
      CANOPY_METHOD_CHANNELS.removeTrashed,
      async (ctx, runId: string, target: CanopyTrashTarget): Promise<void> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.removeTrashed, 20, 10_000);
        assertRunId(runId);
        assertTrashTarget(target);
        if (isLiveTrash(runId, target)) {
          const workspaceId = heldTrash(runId, target).run.workspaceId;
          if (!drivesProject(ctx, workspaceId)) throw drivenElsewhere(workspaceId);
          await removeTrashedRun(runId, target, (project) => drivesProject(ctx, project));
          return;
        }
        const workspaceId = closedWorkspaceOf(runId, target);
        if (workspaceId === undefined) throw leftTheTrash();
        if (!drivesProject(ctx, workspaceId)) throw drivenElsewhere(workspaceId);
        await dismissClosedRun(runId, target);
      },
      { withContext: true }
    ),

    /**
     * Empty Canopy's Trash: exactly the runs the panel confirmed, never
     * whatever the trash holds by the time this lands. A run that has left
     * since is skipped; one whose project is driven elsewhere refuses the
     * whole batch before anything is removed. Answers how many it removed.
     */
    emptyTrash: op(
      CANOPY_METHOD_CHANNELS.emptyTrash,
      async (ctx, targets: Array<CanopyTrashTarget & { runId: string }>): Promise<number> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.emptyTrash, 10, 10_000);
        if (!Array.isArray(targets) || targets.length > MAX_EMPTY_TRASH) {
          throw new Error("Invalid trash targets");
        }
        for (const target of targets) {
          assertRunId(target?.runId);
          assertTrashTarget(target);
        }
        // Each run as the panel confirmed it: live in the trash, or ended.
        const held = targets.flatMap((target) => {
          if (isLiveTrash(target.runId, target)) {
            try {
              return [
                {
                  target,
                  live: true,
                  workspaceId: heldTrash(target.runId, target).run.workspaceId,
                },
              ];
            } catch {
              return [];
            }
          }
          const workspaceId = closedWorkspaceOf(target.runId, target);
          return workspaceId === undefined ? [] : [{ target, live: false, workspaceId }];
        });
        for (const { workspaceId } of held) {
          if (!drivesProject(ctx, workspaceId)) throw drivenElsewhere(workspaceId);
        }
        let removed = 0;
        for (const { target, live } of held) {
          try {
            if (live) {
              await removeTrashedRun(target.runId, target, (project) =>
                drivesProject(ctx, project)
              );
            } else {
              await dismissClosedRun(target.runId, target);
            }
            removed += 1;
          } catch (error) {
            // Left the trash while the others were removed: nothing to do for it.
            if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
          }
        }
        return removed;
      },
      { withContext: true }
    ),

    /**
     * The user renamed a run from Canopy: any project's, as a rename of its
     * pane would. An empty title puts back the one Daintree gives it.
     */
    rename: op(
      CANOPY_METHOD_CHANNELS.rename,
      async (runId: string, target: CanopyTarget, title: string): Promise<void> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.rename, 20, 10_000);
        assertRunId(runId);
        assertTarget(target);
        if (typeof title !== "string" || title.length > MAX_LABEL_LENGTH) {
          throw new Error("Invalid title");
        }
        await assertSameTerminal(runId, target);
        const run = getFleetSnapshotService()
          ?.getLastBroadcast()
          ?.runs.find((candidate) => candidate.runId === runId);
        if (!run) throw new Error("That agent isn't running any more.");
        await renameThroughOwningViews(run, title);
      }
    ),

    /** Out of the inbox until the agent has something new to say; Undo and Unarchive bring it back. */
    archive: op(
      CANOPY_METHOD_CHANNELS.archive,
      async (
        runId: string,
        target: CanopyTarget,
        expectTurn?: number
      ): Promise<CanopyReadMark | null> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.archive, 30, 10_000);
        assertRunId(runId);
        assertTarget(target);
        if (expectTurn !== undefined && !isTurn(expectTurn)) throw new Error("Invalid turn");
        // What archiving left read, for an undo to put back; null when refused.
        const mark = getService().archive(runId, target.spawnedAt, expectTurn);
        if (mark !== null) syncHandBack(mark);
        return mark;
      }
    ),

    /**
     * Pick one of the options a run's dialog shows, by its label, straight from
     * the list — any project's run, since it goes by the run, not a panel in
     * this view. The keys are planned from the screen as it is now, so an
     * option that is no longer drawn presses nothing.
     */
    answer: op(
      CANOPY_METHOD_CHANNELS.answer,
      async (ctx, runId: string, target: CanopyTarget, label: string): Promise<void> => {
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.answer, 30, 10_000);
        assertRunId(runId);
        assertTarget(target);
        assertDrivesRun(ctx, runId);
        if (!isAnswerLabel(label)) throw new Error("Invalid option");
        await assertNotGlobalAssistant(runId);
        await answerRunByLabel({
          pty: requirePtyClient(),
          runId,
          spawnedAt: target.spawnedAt,
          label,
          stillAllowed: () => {
            // Canopy turned off between keys stops the rest.
            if (!currentPlan().activated)
              return "That terminal has moved on since the list showed it.";
            // The panel that asked is gone: the rest of the answer is no one's.
            if (ctx.endpoint.isClosed()) {
              return "Canopy closed before the answer was finished. Nothing more was pressed.";
            }
            // Control can move to another screen between keys.
            if (!drivesRun(ctx, runId)) {
              return "Another screen took control of that project. Nothing more was pressed.";
            }
            return null;
          },
        });
        service?.noteUserSent(runId, target.spawnedAt);
        service?.markHandled(runId, target.spawnedAt);
      },
      { withContext: true }
    ),

    unarchive: op(
      CANOPY_METHOD_CHANNELS.unarchive,
      async (runId: string, target: CanopyTarget): Promise<void> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.unarchive, 30, 10_000);
        assertRunId(runId);
        assertTarget(target);
        getService().unarchive(runId, target.spawnedAt);
      }
    ),

    /**
     * The user had this terminal in front of them — focused in its pane, or
     * open in the panel. Kept by main so every view's panel ranks by it.
     */
    markSeen: op(
      CANOPY_METHOD_CHANNELS.markSeen,
      async (ctx, runId: string, looking?: boolean, place?: CanopyLookPlace): Promise<void> => {
        // A look ending is never refused: one dropped would keep reading the
        // run for the look's whole lease, a row the user only passed over.
        if (looking !== false) checkRateLimit(CANOPY_METHOD_CHANNELS.markSeen, 120, 10_000);
        assertRunId(runId);
        if (looking !== undefined && typeof looking !== "boolean") throw new Error("Invalid look");
        if (place !== undefined && place !== "pane" && place !== "panel") {
          throw new Error("Invalid look");
        }
        if (looking === undefined) {
          getService().markSeen(runId);
          return;
        }
        // A look lasts until the view says it ended, or goes away without saying so.
        watchView(ctx);
        getService().markSeen(runId, {
          viewId: ctx.webContentsId,
          place: place ?? "pane",
          looking,
        });
      },
      { withContext: true }
    ),

    /**
     * The user sent a run something from its own pane, as their view saw it:
     * the work that starts is theirs, not news. Said only by a view's input
     * entry points; quiet while Canopy is off, since every pane reports it.
     */
    noteSent: op(CANOPY_METHOD_CHANNELS.noteSent, async (runId: string): Promise<void> => {
      if (!currentPlan().activated) return;
      checkRateLimit(CANOPY_METHOD_CHANNELS.noteSent, 120, 10_000);
      assertRunId(runId);
      getService().noteUserSentTo(runId);
    }),

    /** The user read a run, through the turn the panel showed — or marked it unread. */
    setRead: op(
      CANOPY_METHOD_CHANNELS.setRead,
      async (
        runId: string,
        target: CanopyTarget,
        read: boolean,
        turn?: number
      ): Promise<CanopyReadMark | null> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.setRead, 60, 10_000);
        assertRunId(runId);
        assertTarget(target);
        if (typeof read !== "boolean") throw new Error("Invalid read");
        if (turn !== undefined && !isTurn(turn)) throw new Error("Invalid turn");
        const mark = getService().setRead(runId, target.spawnedAt, read, turn);
        if (mark !== null) syncHandBack(mark);
        return mark;
      }
    ),

    /** Every run the panel listed, read through the turns it showed. */
    markAllRead: op(
      CANOPY_METHOD_CHANNELS.markAllRead,
      async (targets: CanopyReadTarget[]): Promise<CanopyReadMark[]> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.markAllRead, 10, 10_000);
        if (!Array.isArray(targets) || targets.length > MAX_READ_BATCH) {
          throw new Error("Invalid runs");
        }
        for (const target of targets) assertReadTarget(target);
        const marks = getService().markAllRead(targets);
        for (const mark of marks) syncHandBack(mark);
        return marks;
      }
    ),

    /** Undo of a read change: what was read before, wherever nothing new has happened since. */
    restoreReads: op(
      CANOPY_METHOD_CHANNELS.restoreReads,
      async (restores: CanopyReadRestore[]): Promise<void> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.restoreReads, 20, 10_000);
        if (!Array.isArray(restores) || restores.length > MAX_READ_BATCH) {
          throw new Error("Invalid runs");
        }
        for (const restore of restores) assertReadRestore(restore);
        for (const mark of getService().restoreReads(restores)) syncHandBack(mark, true);
      }
    ),

    /**
     * The branch a run's folder has checked out, for the panel to say where the
     * agent is. Read from the folder the fleet snapshot holds for the run, never
     * a path the view names; null for a detached HEAD, a folder outside git, or
     * a run that has gone.
     */
    runBranch: op(
      CANOPY_METHOD_CHANNELS.runBranch,
      async (runId: string, target: CanopyTarget): Promise<string | null> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.runBranch, 60, 10_000);
        assertRunId(runId);
        assertTarget(target);
        const run = getFleetSnapshotService()
          ?.getLastBroadcast()
          ?.runs.find((entry) => entry.runId === runId && entry.spawnedAt === target.spawnedAt);
        if (!run?.cwd) return null;
        return getGitBranch(run.cwd);
      }
    ),

    /**
     * Which of these runs' terminals hold the words the panel's search asked
     * them for. Matched here, on the machine the terminal runs on: only ids go
     * back, and no screen read for a search goes anywhere else. Only runs the
     * fleet holds in the same incarnation are read.
     */
    searchScreens: op(
      CANOPY_METHOD_CHANNELS.searchScreens,
      async (targets: CanopyScreenSearchTarget[]): Promise<string[]> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.searchScreens, 60, 10_000);
        if (!Array.isArray(targets) || targets.length > MAX_READ_BATCH) {
          throw new Error("Invalid runs");
        }
        for (const target of targets) assertScreenSearchTarget(target);
        const runs = getFleetSnapshotService()?.getLastBroadcast()?.runs ?? [];
        const live = new Set(runs.map((run) => `${run.runId}\u0000${run.spawnedAt}`));
        const known = targets.filter((target) =>
          live.has(`${target.runId}\u0000${target.spawnedAt}`)
        );
        return searchScreens(known, async (target) => {
          const result = await readPluginTerminalScreen(
            getPtyClient(),
            target.runId,
            null,
            CANOPY_HISTORY_ROWS,
            { scrollbackRows: CANOPY_HISTORY_ROWS, maxBytes: SEARCH_MAX_BYTES },
            { dropGhostInput: true }
          );
          return result.status === "ok" ? result.text : null;
        });
      }
    ),

    /**
     * The runs this view's open panel lists right now — scope, Unread filter
     * and folded Archived applied: only those are in front of the user, so
     * only their asks are held back from a native page.
     */
    setShown: op(
      CANOPY_METHOD_CHANNELS.setShown,
      async (ctx, runIds: string[]): Promise<void> => {
        if (!Array.isArray(runIds) || runIds.length > MAX_SHOWN_RUNS) {
          throw new Error("Invalid run list");
        }
        for (const runId of runIds) assertRunId(runId);
        viewShown.set(ctx.webContentsId, new Set(runIds));
        watchView(ctx);
      },
      { withContext: true }
    ),

    /** Read only this workspace's agents (its id), or every workspace's (null). */
    setScope: op(
      CANOPY_METHOD_CHANNELS.setScope,
      async (ctx, workspaceId: string | null): Promise<void> => {
        if (
          workspaceId !== null &&
          (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 200)
        ) {
          throw new Error("Invalid workspace id");
        }
        // Each view's choice is its own: another window's panel keeps reading
        // what it shows.
        viewScopes.set(ctx.webContentsId, workspaceId);
        watchView(ctx);
        if (activeViews.has(ctx.webContentsId)) getService().setScope(reconciledScope());
      },
      { withContext: true }
    ),
  },
});

export function registerCanopyHandlers(): () => void {
  const unregister = canopyNamespace.register();
  const ledger = new CanopyTrashLedger({
    readTerminal: (id) => getPtyClient()?.getTerminalAsync(id) ?? Promise.resolve(null),
    isHelpTerminal: (id) => getAgentAvailabilityStore().isHelpTerminal(id),
    // Only a service tells views: with none made, no panel is open, and the
    // next one to open reads the trash with the rest of the snapshot.
    onChange: () => service?.trashChanged(),
    isRemoved: (entry) =>
      hasCanopyTrashRemoval({ id: entry.run.runId, spawnedAt: entry.run.spawnedAt }),
    // The incarnation's own record becomes the close when none of the close
    // lands: its agent had quit before the pane was closed, or that quit's own
    // capture took the record first.
    onSettle: (entry) =>
      adoptCanopyTrashClose(
        { id: entry.run.runId, spawnedAt: entry.run.spawnedAt },
        {
          expiresAt: entry.expiresAt,
          closedAt: entry.trashedAt,
          ...(entry.run.titleMode !== undefined ? { titleMode: entry.run.titleMode } : {}),
          ...(entry.run.agentPresetColor !== undefined
            ? { agentPresetColor: entry.run.agentPresetColor }
            : {}),
        },
        app.getPath("userData")
      ),
  });
  trashLedger = ledger;
  const closed = new CanopyClosedTrash({
    readRecords: () =>
      listAgentSessions(undefined, app.getPath("userData"), getAgentSessionRetentionDays()),
    isWorktreeGone,
    onChange: () => service?.trashChanged(),
  });
  closedTrash = closed;
  // Every journal write, whoever made it: a close landing, a removal, a clear
  // or prune of history. A close the journal now holds stands for its run.
  const offHistory = onSessionHistoryWritten(() => {
    closed.refresh();
    for (const entry of closed.list()) ledger.onJournaled(entry.run.runId, entry.run.spawnedAt);
  });
  const offTrashed = events.on("terminal:trashed", ({ id, expiresAt }) =>
    ledger.onTrashed(id, expiresAt)
  );
  const offTrashCleared = events.on("terminal:trash-cleared", ({ id, expiresAt }) =>
    ledger.onCleared(id, expiresAt)
  );
  // Restored anywhere — the grid's Undo, the trash, another toast — a trash
  // Canopy made is over, and its receipt must not restore a later one.
  const offRestored = events.on("terminal:restored", ({ id }) => {
    onHostRestored(id);
    ledger.onRestored(id);
  });
  const offHandBack = events.on("terminal:hand-back-changed", onHandBackChanged);
  const offSizeHolds = onSizeHoldsChange((terminalIds) =>
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "terminal:canopy-size-holds-changed",
      payload: terminalIds,
    })
  );
  return () => {
    unregister();
    offTrashed();
    offTrashCleared();
    offRestored();
    offHistory();
    ledger.dispose();
    if (trashLedger === ledger) trashLedger = null;
    closed.dispose();
    if (closedTrash === closed) closedTrash = null;
    for (const requestId of [...pendingResumes.keys()]) {
      settleResume(requestId, { error: "Canopy stopped." });
    }
    for (const fallback of removeFallbacks) clearTimeout(fallback);
    removeFallbacks.clear();
    offHandBack();
    offDriveLease?.();
    offDriveLease = null;
    unsubscribeFleet?.();
    unsubscribeFleet = null;
    unsubscribeInput?.();
    unsubscribeInput = null;
    for (const unwatch of watchedViews.values()) unwatch();
    watchedViews.clear();
    activeViews.clear();
    viewScopes.clear();
    viewShown.clear();
    recentlyTrashed.clear();
    ownRestores.clear();
    stopAllTerminalWatches();
    offSizeHolds();
    setCanopyRefinementSource(null);
    service?.dispose();
    service = null;
    reader?.release();
    reader = null;
    models?.cancel();
    models = null;
  };
}
