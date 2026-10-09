// Imported FIRST by preview.tsx, so the bridge exists before any module that
// reaches for `window.electron` at evaluation time.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";

/** Every age on the panel is read against this, so two rounds' captures differ only in design. */
export const FROZEN_NOW = 1_764_000_000_000;
Date.now = () => FROZEN_NOW;

const listeners = new Set<(snapshot: CanopySnapshot) => void>();
let current: CanopySnapshot | null = null;
/** What each run's live pane shows, by run id; set by the preview from its fixtures. */
let screens = new Map<string, string>();

export function setPreviewCanopyScreens(next: Map<string, string>): void {
  screens = next;
}

/** The branch each run's folder has checked out, by run id; set by the preview from its fixtures. */
let branches = new Map<string, string | null>();

export function setPreviewCanopyBranches(next: Map<string, string | null>): void {
  branches = next;
}

export function setPreviewCanopySnapshot(snapshot: CanopySnapshot): void {
  current = snapshot;
  for (const listener of listeners) listener(snapshot);
}

/** What the panel last asked main to do, for the spec to assert on. */
function record(action: string, detail: unknown): Promise<void> {
  document.body.dataset.canopyLast = JSON.stringify({ action, detail });
  return Promise.resolve();
}

installPreviewShims({
  // The live pane's real composer asks for the agent's slash commands; an empty
  // list is what a project without any answers.
  slashCommands: { list: () => Promise.resolve([]) },
  canopy: {
    onSnapshotUpdated: (listener: (snapshot: CanopySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActive: () => Promise.resolve(current),
    getSnapshot: () => Promise.resolve(current),
    refresh: () => record("refresh", null),
    trash: (runId: string) => record("trash", { runId }),
    // Looks are not recorded: the fixtures' seen times stay as written, so the
    // landing selection can't move the ranking between captures — nor read
    // anything, so the unread rows stay unread for every capture.
    markSeen: () => Promise.resolve(),
    noteSent: () => Promise.resolve(),
    setMode: (mode: CanopySnapshot["mode"]) => {
      if (current) setPreviewCanopySnapshot({ ...current, mode, activated: mode === "on" });
      return record("setMode", { mode }).then(() => current);
    },
    setRead: (runId: string, target: { spawnedAt: number }, read: boolean) => {
      const mark = current?.reads.find((entry) => entry.runId === runId);
      const next = {
        runId,
        spawnedAt: target.spawnedAt,
        turn: mark?.turn ?? 0,
        readTurn: read ? (mark?.turn ?? 0) : (mark?.readTurn ?? 0),
        markedUnreadAt: read ? null : FROZEN_NOW,
        version: (mark?.version ?? 0) + 1,
      };
      if (current) {
        setPreviewCanopySnapshot({
          ...current,
          reads: [...current.reads.filter((entry) => entry.runId !== runId), next],
        });
      }
      return record("setRead", { runId, read }).then(() => next);
    },
    markAllRead: (targets: Array<{ runId: string; spawnedAt: number; turn: number }>) => {
      const marks = targets.map((target) => ({
        ...target,
        readTurn: target.turn,
        markedUnreadAt: null,
        version: 99,
      }));
      if (current) {
        const read = new Set(targets.map((target) => target.runId));
        setPreviewCanopySnapshot({
          ...current,
          reads: [...current.reads.filter((entry) => !read.has(entry.runId)), ...marks],
        });
      }
      return record("markAllRead", { count: targets.length }).then(() => marks);
    },
    restoreReads: () => record("restoreReads", null),
    runBranch: (runId: string) => Promise.resolve(branches.get(runId) ?? null),
    // Archive acts the way main does, so the Archived group can be captured.
    archive: (runId: string, target: { spawnedAt: number }) => {
      if (current) {
        setPreviewCanopySnapshot({
          ...current,
          dispositions: [
            ...current.dispositions.filter((entry) => entry.runId !== runId),
            { runId, spawnedAt: target.spawnedAt, kind: "archived", at: FROZEN_NOW - 120_000 },
          ],
        });
      }
      return record("archive", { runId });
    },
    unarchive: (runId: string) => {
      if (current) {
        setPreviewCanopySnapshot({
          ...current,
          dispositions: current.dispositions.filter((entry) => entry.runId !== runId),
        });
      }
      return record("unarchive", { runId });
    },
    setScope: (workspaceId: string | null) => record("scope", { workspaceId }),
    // No live grid behind the preview to freeze; the panel draws on its own backdrop.
    captureBackdrop: () => Promise.resolve(null),
    answer: (runId: string, _target: unknown, label: string) => record("answer", { runId, label }),
    // The live pane: a still screen for whichever run is selected, and the
    // input it would send, recorded like the rest.
    onTerminalData: () => () => {},
    watchTerminal: (runId: string) =>
      Promise.resolve({
        watchId: 1,
        snapshot: {
          data: screens.get(runId) ?? "❯ ",
          cols: 100,
          rows: 30,
          continuation: { pendingEscapeTail: "", streamOffset: 0 },
        },
      }),
    unwatchTerminal: () => Promise.resolve(),
    terminalInput: (_watchId: number, data: string) => record("input", { data }),
    terminalResize: () => Promise.resolve(),
    terminalSendKey: (_watchId: number, key: string) => record("key", { key }),
    terminalSubmit: (_watchId: number, text: string) => record("submit", { text }),
  },
});
