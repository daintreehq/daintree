import { app } from "electron";
import type {
  CanopyLookPlace,
  CanopyMode,
  CanopyPlan,
  CanopyReadMark,
  CanopyReadRestore,
  CanopyReadTarget,
  CanopySnapshot,
  CanopyTarget,
  CanopyTier,
  CanopyTerminalView,
  CanopyTrashRequest,
} from "../../../shared/types/ipc/canopy.js";
import { getAgentNotificationServiceRef, getPtyClient } from "../../window/serviceRefs.js";
import type { TerminalInputNotice } from "../../services/PtyClient.js";
import type { TerminalResizeResult } from "../../../shared/types/pty-host.js";
import { getFleetSnapshotService } from "./projectCrud/index.js";
import { readPluginTerminalScreen } from "../../services/plugin/pluginTerminalScreenRead.js";
import { CanopyService } from "../../services/canopy/CanopyService.js";
import { isCanopyMode, readCanopyMode } from "../../services/canopy/canopyMode.js";
import {
  canopyWaking,
  classifyWithCanopy,
  describeWithCanopy,
  wakeCanopy,
} from "../../services/canopy/canopyBackend.js";
import { store } from "../../store.js";
import { traced } from "../../services/canopy/canopyTrace.js";
import { checkRateLimit, getProjectRendererTargets, typedBroadcast } from "../utils.js";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { CANOPY_METHOD_CHANNELS } from "./canopy.preload.js";
import {
  beginWatchRequest,
  isCurrentWatchRequest,
  stopAllTerminalWatches,
  resizeWatchedTerminal,
  stopTerminalWatch,
  watchTerminal,
  watchedTerminal,
} from "./canopyTerminalWatch.js";
import { isImageAttachmentPath } from "../../../shared/utils/imageAttachmentInput.js";
import { planChoice } from "../../../shared/utils/terminalChoice.js";
import { AppError } from "../../utils/errorTypes.js";
import { terminalAnswerOf } from "../../../shared/utils/terminalSubmission.js";
import { getGitBranch } from "../../utils/gitUtils.js";

const MAX_INPUT_LENGTH = 64_000;
const MAX_SUBMIT_LENGTH = 100_000;
const MAX_SUBMIT_IMAGES = 10;
const MAX_KEY_LENGTH = 32;
const MAX_LABEL_LENGTH = 200;
const BACKDROP_JPEG_QUALITY = 85;
/** Rows read to find the option being chosen; dialogs sit at the bottom. */
const ANSWER_SCREEN_LINES = 40;
/** Between keys, so a TUI reading a burst as one chunk still sees each one. */
const ANSWER_KEY_GAP_MS = 80;
/** Why a one-key answer pressed nothing, in words the panel shows as is. */
/**
 * Canopy acts on nothing until the user has turned it on. Checked here as well
 * as in the panel, so no other caller can reach a terminal through it.
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
 * Free while Canopy is in beta: a development build can ask for the priority
 * tier to compare the two.
 */
function currentTier(): CanopyTier {
  return !app.isPackaged && process.env.DAINTREE_CANOPY_TIER === "priority" ? "priority" : "free";
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
  // A watch faster than once a second only spends the address's rate limit,
  // and past a timer's 32-bit range Node fires it at once.
  return ms === 0 ? 0 : Math.min(2_147_483_647, Math.max(1_000, ms));
}

/** Changes of mode since launch; see `CanopyPlan.modeRevision`. */
let modeRevision = 0;

function currentPlan(): CanopyPlan {
  const mode = readCanopyMode();
  return { mode, modeRevision, activated: mode === "on", tier: currentTier() };
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
  };
}

function answerRefused(reason: string): AppError {
  return new AppError({ code: "NOT_FOUND", message: reason, userMessage: reason });
}

const ANSWER_KEY_SEQUENCES: Record<string, string> = {
  Up: "\x1b[A",
  Down: "\x1b[B",
  Enter: "\r",
};

let service: CanopyService | null = null;
let unsubscribeFleet: (() => void) | null = null;
let unsubscribeInput: (() => void) | null = null;
const activeViews = new Set<number>();
/** The workspace each view's panel asked to read (null: every one), kept across its opens. */
const viewScopes = new Map<number, string | null>();
/** Views that already carry lifecycle listeners, with the way to take them off. */
const watchedViews = new Map<number, () => void>();

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

function getService(): CanopyService {
  subscribeFleet();
  if (service) return service;
  const backgroundPollMs = backgroundPollOverride();
  service = new CanopyService({
    plan: currentPlan(),
    ...(backgroundPollMs !== undefined ? { backgroundPollMs } : {}),
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
        () => [...activeViews]
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
    classify: (input, signal) =>
      traced("classifier", input, () => classifyWithCanopy(input, signal)),
    describe: (input, classifierSays, signal, onPartial) =>
      traced("describer", { ...input, classifierSays }, () =>
        describeWithCanopy(input, classifierSays, signal, onPartial)
      ),
    serviceWaking: () => canopyWaking(),
    broadcast: (snapshot) =>
      typedBroadcast<"canopy:snapshot-updated">(CHANNELS.CANOPY_SNAPSHOT_UPDATED, snapshot),
  });
  return service;
}

/** Starts a worker waking as soon as reads are about to begin; see `wakeCanopy`. */
function wakeService(): void {
  if (currentPlan().activated) wakeCanopy();
}

function assertRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("Invalid run id");
  }
}

/** The most runs one bulk read change may name. */
const MAX_READ_BATCH = 500;

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

/** The terminal a view's current stream is for, or a refusal naming nothing on screen. */
function requireWatched(viewId: number, watchId: unknown): { runId: string; spawnedAt: number } {
  if (typeof watchId !== "number" || !Number.isInteger(watchId)) throw new Error("Invalid stream");
  const watched = watchedTerminal(viewId, watchId);
  if (!watched) throw new Error("That agent isn't running any more.");
  return watched;
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
function trashThroughOwningViews(runId: string): void {
  requirePtyClient().trash(runId);
  const run = getFleetSnapshotService()
    ?.getLastBroadcast()
    ?.runs.find((candidate) => candidate.runId === runId);
  if (!run) return;
  for (const view of getProjectRendererTargets(run.workspaceId)) {
    try {
      view.send(CHANNELS.CANOPY_TRASH_REQUESTED, { runId } satisfies CanopyTrashRequest);
    } catch {
      // A view torn down mid-send has no pane left to move.
    }
  }
}

function requirePtyClient() {
  const ptyClient = getPtyClient();
  if (!ptyClient) throw new Error("The terminal host isn't available.");
  return ptyClient;
}

/**
 * The workspaces to read: the one every open panel shows, when they agree;
 * otherwise every workspace, each panel showing its own. With no panel open
 * the background watch reads everything, since it lights the toolbar for
 * every project.
 */
function reconciledScope(): string | null {
  const scopes = new Set([...activeViews].map((id) => viewScopes.get(id) ?? null));
  return scopes.size === 1 ? ([...scopes][0] ?? null) : null;
}

function syncActive(): void {
  const canopy = getService();
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
  service?.forgetViewer(id);
  if (!activeViews.delete(id)) return;
  // Never builds a service: after cleanup there may be none, and none is wanted.
  // A view that went away will not bounce back, so no reopen grace either.
  service?.setActive(activeViews.size > 0, true);
  service?.setScope(reconciledScope());
}

function watchView(sender: Electron.WebContents): void {
  const id = sender.id;
  if (watchedViews.has(id)) return;
  // One set of listeners per WebContents for its whole life, not one per
  // opening: re-adding on every open leaked a `destroyed` listener each time
  // the panel was closed and reopened.
  const onNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    // A reload replaces the document without running React's cleanup, so the
    // new document starts with its panel closed and must open it again.
    if (details.isMainFrame && !details.isSameDocument) forgetView(id);
  };
  const onGone = () => forgetView(id);
  const onDestroyed = () => {
    watchedViews.delete(id);
    forgetView(id);
  };
  sender.on("did-start-navigation", onNavigate);
  sender.on("render-process-gone", onGone);
  sender.once("destroyed", onDestroyed);
  watchedViews.set(id, () => {
    sender.removeListener("did-start-navigation", onNavigate);
    sender.removeListener("render-process-gone", onGone);
    sender.removeListener("destroyed", onDestroyed);
  });
}

export const canopyNamespace = defineIpcNamespace({
  name: "canopy",
  ops: {
    getSnapshot: op(CANOPY_METHOD_CHANNELS.getSnapshot, async (): Promise<CanopySnapshot> => {
      // Hidden, there is nothing to show and nothing is started to show it.
      if (!service && readCanopyMode() === "hidden") return hiddenOrIdleSnapshot();
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
          watchView(ctx.event.sender);
          wakeService();
        } else {
          activeViews.delete(id);
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
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.watchTerminal, 30, 10_000);
        assertRunId(runId);
        assertTarget(target);
        const viewId = ctx.webContentsId;
        // Claimed before the first await, so an unwatch, a close or a newer
        // selection arriving during validation cancels this one.
        const ticket = beginWatchRequest(viewId);
        // The pane's effect can run before the panel's own `setActive` lands,
        // so a watch carries its own lifecycle cleanup rather than requiring it.
        watchView(ctx.event.sender);
        await assertSameTerminal(runId, target);
        if (!isCurrentWatchRequest(viewId, ticket)) return { watchId: null, snapshot: null };
        return watchTerminal(requirePtyClient(), ctx.event.sender, runId, target.spawnedAt, ticket);
      },
      { withContext: true }
    ),

    unwatchTerminal: op(
      CANOPY_METHOD_CHANNELS.unwatchTerminal,
      async (ctx): Promise<void> => {
        stopTerminalWatch(ctx.webContentsId);
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
     * nothing and answers how Canopy stands now.
     */
    setMode: op(
      CANOPY_METHOD_CHANNELS.setMode,
      async (mode: CanopyMode, expectRevision?: number): Promise<CanopySnapshot> => {
        if (!isCanopyMode(mode)) throw new Error("Invalid Canopy mode");
        if (expectRevision !== undefined && !Number.isSafeInteger(expectRevision)) {
          throw new Error("Invalid Canopy mode revision");
        }
        checkRateLimit(CANOPY_METHOD_CHANNELS.setMode, 10, 10_000);
        if (expectRevision !== undefined && expectRevision !== modeRevision) {
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
        if (mode !== "on") stopAllTerminalWatches();
        const canopy = getService();
        canopy.setPlan(currentPlan());
        wakeService();
        return canopy.getSnapshot();
      }
    ),

    /**
     * A still of the view as it stands, for the panel to hold behind itself so
     * the app under it stops moving while it is open — the grid pane of the
     * terminal the panel streams included, frozen at its own size. JPEG: a
     * full-window PNG takes longer to encode than the panel takes to open.
     */
    captureBackdrop: op(
      CANOPY_METHOD_CHANNELS.captureBackdrop,
      async (ctx): Promise<Uint8Array | null> => {
        checkRateLimit(CANOPY_METHOD_CHANNELS.captureBackdrop, 10, 10_000);
        const image = await ctx.event.sender.capturePage();
        if (image.isEmpty()) return null;
        return new Uint8Array(image.toJPEG(BACKDROP_JPEG_QUALITY));
      },
      { withContext: true }
    ),

    /** Raw keystrokes from the live view, for the terminal it is streaming. */
    terminalInput: op(
      CANOPY_METHOD_CHANNELS.terminalInput,
      async (ctx, watchId: number, data: string): Promise<void> => {
        requireActivated();
        if (typeof data !== "string" || data.length === 0 || data.length > MAX_INPUT_LENGTH) {
          throw new Error("Invalid input");
        }
        const watched = requireWatched(ctx.webContentsId, watchId);
        requirePtyClient().write(watched.runId, data);
        // Return submits a line: the user has answered what the screen showed.
        if (terminalAnswerOf(data) === "submit") {
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
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.terminalResize, 60, 10_000);
        resizeWatchedTerminal(requirePtyClient(), ctx.webContentsId, watchId, cols, rows);
      },
      { withContext: true }
    ),

    /** A named key from the composer (Escape, an arrow), for the streamed terminal. */
    terminalSendKey: op(
      CANOPY_METHOD_CHANNELS.terminalSendKey,
      async (ctx, watchId: number, key: string): Promise<void> => {
        requireActivated();
        if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
          throw new Error("Invalid key");
        }
        const watched = requireWatched(ctx.webContentsId, watchId);
        requirePtyClient().sendKey(watched.runId, key);
        if (key === "enter") {
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
        requireActivated();
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
        const watched = requireWatched(ctx.webContentsId, watchId);
        // The stream ends on exit, but a submit is worth one more look at the
        // host's own record: the message must reach this incarnation or none.
        const record = await requirePtyClient()
          .getTerminalAsync(watched.runId)
          .catch(() => null);
        if (
          !record ||
          record.spawnedAt !== watched.spawnedAt ||
          record.isExited === true ||
          watchedTerminal(ctx.webContentsId, watchId) === null
        ) {
          throw new Error("That agent isn't running any more.");
        }
        if (imagePaths !== undefined && imagePaths.length > 0) {
          requirePtyClient().submit(
            watched.runId,
            text,
            undefined,
            undefined,
            undefined,
            imagePaths
          );
        } else {
          requirePtyClient().submit(watched.runId, text);
        }
        service?.noteUserSent(watched.runId, watched.spawnedAt);
        service?.markHandled(watched.runId, watched.spawnedAt);
      },
      { withContext: true }
    ),

    /** Move the run to the trash — restorable, so no confirmation tier applies (D0). */
    trash: op(
      CANOPY_METHOD_CHANNELS.trash,
      async (runId: string, target: CanopyTarget): Promise<void> => {
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.trash, 20, 10_000);
        assertRunId(runId);
        assertTarget(target);
        await assertSameTerminal(runId, target);
        trashThroughOwningViews(runId);
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
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.archive, 30, 10_000);
        assertRunId(runId);
        assertTarget(target);
        if (expectTurn !== undefined && !isTurn(expectTurn)) throw new Error("Invalid turn");
        // What archiving left read, for an undo to put back; null when refused.
        return getService().archive(runId, target.spawnedAt, expectTurn);
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
      async (runId: string, target: CanopyTarget, label: string): Promise<void> => {
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.answer, 30, 10_000);
        assertRunId(runId);
        assertTarget(target);
        if (typeof label !== "string" || label.trim() === "" || label.length > MAX_LABEL_LENGTH) {
          throw new Error("Invalid option");
        }
        const pty = requirePtyClient();
        const record = await pty.getTerminalAsync(runId);
        // Nothing is pressed unless the dialog is still there to answer.
        if (!record || record.spawnedAt !== target.spawnedAt || record.isExited === true) {
          throw answerRefused("That terminal has moved on since the list showed it.");
        }
        const screen = await readPluginTerminalScreen(pty, runId, null, ANSWER_SCREEN_LINES);
        if (screen.status !== "ok") {
          throw answerRefused("Couldn't read the terminal to find that option.");
        }
        const plan = planChoice(screen.text, label);
        if (!plan.ok) throw answerRefused(`${plan.reason} Nothing was pressed.`);
        for (const [index, key] of plan.keys.entries()) {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, ANSWER_KEY_GAP_MS));
          pty.write(runId, ANSWER_KEY_SEQUENCES[key] ?? key);
        }
        service?.noteUserSent(runId, target.spawnedAt);
        service?.markHandled(runId, target.spawnedAt);
      }
    ),

    unarchive: op(
      CANOPY_METHOD_CHANNELS.unarchive,
      async (runId: string, target: CanopyTarget): Promise<void> => {
        requireActivated();
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
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.markSeen, 120, 10_000);
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
        watchView(ctx.event.sender);
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
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.setRead, 60, 10_000);
        assertRunId(runId);
        assertTarget(target);
        if (typeof read !== "boolean") throw new Error("Invalid read");
        if (turn !== undefined && !isTurn(turn)) throw new Error("Invalid turn");
        return getService().setRead(runId, target.spawnedAt, read, turn);
      }
    ),

    /** Every run the panel listed, read through the turns it showed. */
    markAllRead: op(
      CANOPY_METHOD_CHANNELS.markAllRead,
      async (targets: CanopyReadTarget[]): Promise<CanopyReadMark[]> => {
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.markAllRead, 10, 10_000);
        if (!Array.isArray(targets) || targets.length > MAX_READ_BATCH) {
          throw new Error("Invalid runs");
        }
        for (const target of targets) assertReadTarget(target);
        return getService().markAllRead(targets);
      }
    ),

    /** Undo of a read change: what was read before, wherever nothing new has happened since. */
    restoreReads: op(
      CANOPY_METHOD_CHANNELS.restoreReads,
      async (restores: CanopyReadRestore[]): Promise<void> => {
        requireActivated();
        checkRateLimit(CANOPY_METHOD_CHANNELS.restoreReads, 20, 10_000);
        if (!Array.isArray(restores) || restores.length > MAX_READ_BATCH) {
          throw new Error("Invalid runs");
        }
        for (const restore of restores) assertReadRestore(restore);
        getService().restoreReads(restores);
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
        requireActivated();
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
        watchView(ctx.event.sender);
        if (activeViews.has(ctx.webContentsId)) getService().setScope(reconciledScope());
      },
      { withContext: true }
    ),
  },
});

export function registerCanopyHandlers(): () => void {
  const unregister = canopyNamespace.register();
  return () => {
    unregister();
    unsubscribeFleet?.();
    unsubscribeFleet = null;
    unsubscribeInput?.();
    unsubscribeInput = null;
    for (const unwatch of watchedViews.values()) unwatch();
    watchedViews.clear();
    activeViews.clear();
    viewScopes.clear();
    stopAllTerminalWatches();
    service?.dispose();
    service = null;
  };
}
