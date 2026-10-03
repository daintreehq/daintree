// Imported FIRST by preview.tsx, so the bridge exists before any module that
// reaches for `window.electron` at evaluation time.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { TriageSnapshot } from "@shared/types/ipc/triage";

/** Every age on the panel is read against this, so two rounds' captures differ only in design. */
export const FROZEN_NOW = 1_764_000_000_000;
Date.now = () => FROZEN_NOW;

const listeners = new Set<(snapshot: TriageSnapshot) => void>();
let current: TriageSnapshot | null = null;

export function setPreviewTriageSnapshot(snapshot: TriageSnapshot): void {
  current = snapshot;
  for (const listener of listeners) listener(snapshot);
}

/** What the panel last asked main to do, for the spec to assert on. */
function record(action: string, detail: unknown): Promise<void> {
  document.body.dataset.triageLast = JSON.stringify({ action, detail });
  return Promise.resolve();
}

installPreviewShims({
  triage: {
    onSnapshotUpdated: (listener: (snapshot: TriageSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActive: () => Promise.resolve(current),
    getSnapshot: () => Promise.resolve(current),
    refresh: () => record("refresh", null),
    trash: (runId: string) => record("trash", { runId }),
    // The live pane: a still screen for whichever run is selected, and the
    // input it would send, recorded like the rest.
    onTerminalData: () => () => {},
    watchTerminal: (runId: string) =>
      Promise.resolve({
        watchId: 1,
        snapshot: {
          data: `\x1b[2m${runId}\x1b[0m\r\n\r\n❯ `,
          cols: 100,
          rows: 30,
          continuation: { pendingEscapeTail: "", streamOffset: 0 },
        },
      }),
    unwatchTerminal: () => Promise.resolve(),
    terminalInput: (_watchId: number, data: string) => record("input", { data }),
    terminalSendKey: (_watchId: number, key: string) => record("key", { key }),
    terminalSubmit: (_watchId: number, text: string) => record("submit", { text }),
  },
});
