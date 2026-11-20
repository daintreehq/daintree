import type { CodexLimitContinueEntry } from "@shared/types/codexLimitContinuation";

/** Whether this view's project's Codex panes continue once their usage limit resets (#17909). */
export const codexLimitContinueClient = {
  set: (terminalId: string, enabled: boolean): Promise<void> =>
    window.electron.codexLimitContinue.set(terminalId, enabled),
  list: (): Promise<CodexLimitContinueEntry[]> => window.electron.codexLimitContinue.list(),
};
