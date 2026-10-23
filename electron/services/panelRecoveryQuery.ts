import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import type { ProjectViewManagersProvider } from "../window/activeProjectIds.js";
import { logError } from "../utils/logger.js";

export const PANEL_RECOVERY_TIMEOUT_MS = 3_000;

export type PanelRecoveryHold = "panel-unrecoverable" | "panel-unknown";

type Answer = "clear" | "holding" | "unknown";

function askView(wc: Electron.WebContents, timeoutMs: number): Promise<Answer> {
  const requestId = randomUUID();
  return new Promise<Answer>((resolve) => {
    let settled = false;
    const settle = (answer: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(CHANNELS.PROJECT_PANEL_RECOVERY_REPLY, onReply);
      if (!wc.isDestroyed()) {
        wc.removeListener("destroyed", onGone);
        wc.removeListener("render-process-gone", onGone);
      }
      resolve(answer);
    };
    const onReply = (event: Electron.IpcMainEvent, payload: unknown) => {
      if (event.sender !== wc) return;
      const reply = payload as { requestId?: unknown; holding?: unknown } | null;
      if (reply?.requestId !== requestId) return;
      settle(
        typeof reply.holding === "boolean" ? (reply.holding ? "holding" : "clear") : "unknown"
      );
    };
    const onGone = () => settle("unknown");
    const timer = setTimeout(() => settle("unknown"), timeoutMs);
    ipcMain.on(CHANNELS.PROJECT_PANEL_RECOVERY_REPLY, onReply);
    wc.once("destroyed", onGone);
    wc.once("render-process-gone", onGone);
    try {
      wc.send(CHANNELS.PROJECT_PANEL_RECOVERY_QUERY, requestId);
    } catch {
      settle("unknown");
    }
  });
}

/**
 * Whether any window's view of `projectId` holds work that would not survive
 * the view being destroyed. Only an affirmative "no" from every resident view
 * clears: a view that is mid-load, gone, or silent holds, because the
 * renderer is the only place that knows. A project with no resident view has
 * nothing to ask.
 */
export async function readPanelRecoveryHold(
  projectId: string,
  provider: ProjectViewManagersProvider,
  timeoutMs = PANEL_RECOVERY_TIMEOUT_MS
): Promise<PanelRecoveryHold | null> {
  const targets: Array<Electron.WebContents | null> = [];
  try {
    for (const manager of provider()) {
      for (const entry of manager.getAllViews()) {
        if (entry.projectId !== projectId) continue;
        // Electron 41+ hands back undefined for a destroyed view's webContents.
        const wc = entry.view?.webContents;
        targets.push(!wc || wc.isDestroyed() || wc.isLoadingMainFrame() ? null : wc);
      }
    }
  } catch (error) {
    logError("panel-recovery-view-lookup-failed", error, { projectId });
    return "panel-unknown";
  }

  const answers = await Promise.all(
    targets.map((wc) => (wc ? askView(wc, timeoutMs) : Promise.resolve<Answer>("unknown")))
  );
  if (answers.includes("holding")) return "panel-unrecoverable";
  if (answers.includes("unknown")) return "panel-unknown";
  return null;
}

/**
 * What each live view last pushed unprompted: the same answer the query gets,
 * sent whenever it changes, so eviction — which runs synchronously and cannot
 * wait out a round trip — reads the same verdict automatic Sleep asks for.
 * Keyed by `webContents.id` and dropped with the view, so a crashed or
 * destroyed renderer holds nothing here: its recoverable state is on disk and
 * the rest went with it.
 */
const reportedHolds = new Map<number, boolean>();

/** Record a view's pushed answer. Exported for tests that cannot reach `ipcMain`. */
export function recordPanelRecoveryState(wc: Electron.WebContents, holding: boolean): void {
  if (wc.isDestroyed()) return;
  const id = wc.id;
  if (!reportedHolds.has(id)) {
    const forget = () => {
      reportedHolds.delete(id);
      wc.removeListener("destroyed", forget);
      wc.removeListener("render-process-gone", forget);
    };
    wc.on("destroyed", forget);
    wc.on("render-process-gone", forget);
  }
  reportedHolds.set(id, holding);
}

/**
 * Whether the view last said it holds work its teardown would lose. A view that
 * has said nothing yet (still loading, or a build without the push) holds
 * nothing: unlike Sleep's query, eviction has no answer to wait for, and failing
 * closed here would pin every view that never spoke.
 */
export function isPanelRecoveryHeldReported(wc: Electron.WebContents): boolean {
  if (wc.isDestroyed()) return false;
  return reportedHolds.get(wc.id) === true;
}

/** Listen for pushed answers. Returns the teardown. */
export function installPanelRecoveryStateListener(): () => void {
  const onState = (event: Electron.IpcMainEvent, holding: unknown) => {
    if (typeof holding !== "boolean") return;
    recordPanelRecoveryState(event.sender, holding);
  };
  ipcMain.on(CHANNELS.PROJECT_PANEL_RECOVERY_STATE, onState);
  return () => {
    ipcMain.removeListener(CHANNELS.PROJECT_PANEL_RECOVERY_STATE, onState);
  };
}

/** Test-only: forget every pushed answer. */
export function _resetPanelRecoveryStateForTests(): void {
  reportedHolds.clear();
}
