import type {
  TriageSnapshot,
  TriageTarget,
  TriageTerminalView,
} from "../../../shared/types/ipc/triage.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getFleetSnapshotService } from "./projectCrud/index.js";
import { readPluginTerminalScreen } from "../../services/plugin/pluginTerminalScreenRead.js";
import { TriageService } from "../../services/triage/TriageService.js";
import {
  checkProviderKey,
  classifyScreen,
  describeScreen,
  readTriageProviderConfig,
} from "../../services/triage/triageProviders.js";
import { TriageKeys } from "../../services/triage/triageKeyStore.js";
import type {
  TriageKeyCheck,
  TriageKeyId,
  TriageKeysStatus,
} from "../../../shared/types/ipc/triage.js";
import { checkRateLimit, typedBroadcast } from "../utils.js";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { TRIAGE_METHOD_CHANNELS } from "./triage.preload.js";
import {
  beginWatchRequest,
  isCurrentWatchRequest,
  stopAllTerminalWatches,
  stopTerminalWatch,
  watchTerminal,
  watchedTerminal,
} from "./triageTerminalWatch.js";
import { isImageAttachmentPath } from "../../../shared/utils/imageAttachmentInput.js";

const MAX_INPUT_LENGTH = 64_000;
const MAX_SUBMIT_LENGTH = 100_000;
const MAX_SUBMIT_IMAGES = 10;
const MAX_KEY_LENGTH = 32;

let service: TriageService | null = null;
let keys: TriageKeys | null = null;
let unsubscribeFleet: (() => void) | null = null;
const activeViews = new Set<number>();
/** Views that already carry lifecycle listeners, with the way to take them off. */
const watchedViews = new Map<number, () => void>();

function getKeys(): TriageKeys {
  keys ??= new TriageKeys();
  return keys;
}

function currentConfig() {
  const store = getKeys();
  return readTriageProviderConfig({
    classifier: store.effective("classifier"),
    describer: store.effective("describer"),
  });
}

function assertKeyId(value: unknown): asserts value is TriageKeyId {
  if (value !== "classifier" && value !== "describer") throw new Error("Invalid key id");
}

function getService(): TriageService {
  // The fleet service is created after the handlers register, so the
  // subscription is made here — on first use — rather than at registration,
  // and retried on each use until the fleet service exists.
  if (unsubscribeFleet === null) {
    unsubscribeFleet =
      getFleetSnapshotService()?.subscribe(() => service?.onFleetChanged()) ?? null;
  }
  if (service) return service;
  service = new TriageService({
    config: currentConfig(),
    getRuns: () => {
      const snapshot = getFleetSnapshotService()?.getLastBroadcast();
      return snapshot && !snapshot.degraded ? snapshot.runs : null;
    },
    readScreen: async (runId, lines) => {
      const result = await readPluginTerminalScreen(getPtyClient(), runId, null, lines);
      return result.status === "ok" ? result.text : null;
    },
    // Resolved per call, so a key saved in Settings takes effect without a restart.
    classify: (input, signal) =>
      classifyScreen(getKeys().effective("classifier") ?? "", input, signal),
    describe: (input, classifierSays, signal) => {
      const latest = currentConfig();
      return describeScreen(
        latest.describerKey ?? "",
        latest.describerModel,
        input,
        classifierSays,
        signal
      );
    },
    broadcast: (snapshot) =>
      typedBroadcast<"triage:snapshot-updated">(CHANNELS.TRIAGE_SNAPSHOT_UPDATED, snapshot),
  });
  return service;
}

function assertRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("Invalid run id");
  }
}

function assertTarget(value: unknown): asserts value is TriageTarget {
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
async function assertSameTerminal(runId: string, target: TriageTarget): Promise<void> {
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

function requirePtyClient() {
  const ptyClient = getPtyClient();
  if (!ptyClient) throw new Error("The terminal host isn't available.");
  return ptyClient;
}

function syncActive(): void {
  getService().setActive(activeViews.size > 0);
}

/** A view that stopped showing its panel without saying so (reload, crash, teardown). */
function forgetView(id: number): void {
  stopTerminalWatch(id);
  if (!activeViews.delete(id)) return;
  // Never builds a service: after cleanup there may be none, and none is wanted.
  // A view that went away will not bounce back, so no reopen grace either.
  service?.setActive(activeViews.size > 0, true);
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

export const triageNamespace = defineIpcNamespace({
  name: "triage",
  ops: {
    getSnapshot: op(TRIAGE_METHOD_CHANNELS.getSnapshot, async (): Promise<TriageSnapshot> => {
      return getService().getSnapshot();
    }),

    /**
     * A panel opened or closed. Main watches screens only while at least one
     * view has a panel open, so a closed panel sends nothing anywhere.
     */
    setActive: op(
      TRIAGE_METHOD_CHANNELS.setActive,
      async (ctx, active: boolean): Promise<TriageSnapshot> => {
        if (typeof active !== "boolean") throw new Error("Invalid active flag");
        const id = ctx.webContentsId;
        if (active) {
          activeViews.add(id);
          watchView(ctx.event.sender);
        } else {
          activeViews.delete(id);
          stopTerminalWatch(id);
        }
        syncActive();
        return getService().getSnapshot();
      },
      { withContext: true }
    ),

    refresh: op(TRIAGE_METHOD_CHANNELS.refresh, async (): Promise<void> => {
      checkRateLimit(TRIAGE_METHOD_CHANNELS.refresh, 6, 10_000);
      await getService().refresh();
    }),

    /**
     * Stream the run's terminal to this view, for the panel's live pane. One
     * per view: watching another run, closing the panel, a reload or the view
     * going away all end it. Only ever the run the user selected, and only
     * while its incarnation is the one the card was built from.
     */
    watchTerminal: op(
      TRIAGE_METHOD_CHANNELS.watchTerminal,
      async (ctx, runId: string, target: TriageTarget): Promise<TriageTerminalView> => {
        checkRateLimit(TRIAGE_METHOD_CHANNELS.watchTerminal, 30, 10_000);
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
      TRIAGE_METHOD_CHANNELS.unwatchTerminal,
      async (ctx): Promise<void> => {
        stopTerminalWatch(ctx.webContentsId);
      },
      { withContext: true }
    ),

    /** Raw keystrokes from the live view, for the terminal it is streaming. */
    terminalInput: op(
      TRIAGE_METHOD_CHANNELS.terminalInput,
      async (ctx, watchId: number, data: string): Promise<void> => {
        if (typeof data !== "string" || data.length === 0 || data.length > MAX_INPUT_LENGTH) {
          throw new Error("Invalid input");
        }
        requirePtyClient().write(requireWatched(ctx.webContentsId, watchId).runId, data);
      },
      { withContext: true }
    ),

    /** A named key from the composer (Escape, an arrow), for the streamed terminal. */
    terminalSendKey: op(
      TRIAGE_METHOD_CHANNELS.terminalSendKey,
      async (ctx, watchId: number, key: string): Promise<void> => {
        if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
          throw new Error("Invalid key");
        }
        requirePtyClient().sendKey(requireWatched(ctx.webContentsId, watchId).runId, key);
      },
      { withContext: true }
    ),

    /** A message from the composer, submitted to the streamed terminal. */
    terminalSubmit: op(
      TRIAGE_METHOD_CHANNELS.terminalSubmit,
      async (ctx, watchId: number, text: string, imagePaths?: string[]): Promise<void> => {
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
      },
      { withContext: true }
    ),

    getKeys: op(TRIAGE_METHOD_CHANNELS.getKeys, async (): Promise<TriageKeysStatus> => {
      return getKeys().status();
    }),

    /** Ask the provider whether it accepts a key, before it is saved. */
    checkKey: op(
      TRIAGE_METHOD_CHANNELS.checkKey,
      async (id: TriageKeyId, key: string): Promise<TriageKeyCheck> => {
        checkRateLimit(TRIAGE_METHOD_CHANNELS.checkKey, 10, 10_000);
        assertKeyId(id);
        if (typeof key !== "string" || key.trim() === "" || key.length > 512) {
          return { valid: false, error: "That doesn't look like an API key." };
        }
        return checkProviderKey(id, key.trim());
      }
    ),

    saveKey: op(
      TRIAGE_METHOD_CHANNELS.saveKey,
      async (id: TriageKeyId, key: string): Promise<TriageKeysStatus> => {
        checkRateLimit(TRIAGE_METHOD_CHANNELS.saveKey, 10, 10_000);
        assertKeyId(id);
        if (typeof key !== "string") throw new Error("Invalid key");
        getKeys().save(id, key);
        service?.setConfig(currentConfig());
        return getKeys().status();
      }
    ),

    clearKey: op(
      TRIAGE_METHOD_CHANNELS.clearKey,
      async (id: TriageKeyId): Promise<TriageKeysStatus> => {
        checkRateLimit(TRIAGE_METHOD_CHANNELS.clearKey, 10, 10_000);
        assertKeyId(id);
        getKeys().clear(id);
        service?.setConfig(currentConfig());
        return getKeys().status();
      }
    ),

    /** Move the run to the trash — restorable, so no confirmation tier applies (D0). */
    trash: op(
      TRIAGE_METHOD_CHANNELS.trash,
      async (runId: string, target: TriageTarget): Promise<void> => {
        checkRateLimit(TRIAGE_METHOD_CHANNELS.trash, 20, 10_000);
        assertRunId(runId);
        assertTarget(target);
        await assertSameTerminal(runId, target);
        requirePtyClient().trash(runId);
      }
    ),
  },
});

export function registerTriageHandlers(): () => void {
  const unregister = triageNamespace.register();
  return () => {
    unregister();
    unsubscribeFleet?.();
    unsubscribeFleet = null;
    for (const unwatch of watchedViews.values()) unwatch();
    watchedViews.clear();
    activeViews.clear();
    stopAllTerminalWatches();
    service?.dispose();
    service = null;
    keys = null;
  };
}
