import { usePanelStore } from "@/store/panelStore";

const WORKTREE_DELETE_TERMINAL_CLOSE_TIMEOUT_MS = 10_000;
const WORKTREE_DELETE_TERMINAL_CLOSE_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getLiveTerminalIdsForWorktree(worktreeId: string): string[] {
  const state = usePanelStore.getState();
  return state.panelIds.filter((id) => {
    const panel = state.panelsById[id];
    return (
      panel?.worktreeId === worktreeId && panel.location !== "trash" && panel.ephemeral !== true
    );
  });
}

export async function waitForTerminalsToClose(terminalIds: string[]): Promise<void> {
  if (terminalIds.length === 0) return;
  if (typeof window === "undefined" || !window.electron?.terminal?.getInfo) return;

  const remaining = new Set(terminalIds);
  const deadline = Date.now() + WORKTREE_DELETE_TERMINAL_CLOSE_TIMEOUT_MS;

  while (remaining.size > 0 && Date.now() < deadline) {
    await Promise.all(
      Array.from(remaining, async (terminalId) => {
        try {
          const info = await window.electron.terminal.getInfo(terminalId);
          // hasPty flips before the backend forgets the terminal, which can leave cwd locked on Windows.
          if (info.hasPty === false) return;
        } catch {
          remaining.delete(terminalId);
        }
      })
    );

    if (remaining.size > 0) {
      await sleep(WORKTREE_DELETE_TERMINAL_CLOSE_POLL_MS);
    }
  }

  if (remaining.size > 0) {
    throw new Error(
      `Timed out waiting for ${remaining.size} terminal(s) to close before deleting worktree`
    );
  }
}

export async function closeTerminalsForWorktree(worktreeId: string): Promise<void> {
  const terminalIds = getLiveTerminalIdsForWorktree(worktreeId);
  if (terminalIds.length === 0) return;

  const store = usePanelStore.getState();
  terminalIds.forEach((id) => store.removePanel(id));
  await waitForTerminalsToClose(terminalIds);
}
