import type {
  TerminalWhenDone,
  TerminalWhenDoneEntry,
} from "@shared/types/ipc/terminalWhenDone";

/** This view's project's agent terminals' When done choices (#16171). */
export const terminalWhenDoneClient = {
  set: (terminalId: string, choice: TerminalWhenDone): Promise<void> =>
    window.electron.terminalWhenDone.set(terminalId, choice),
  list: (): Promise<TerminalWhenDoneEntry[]> => window.electron.terminalWhenDone.list(),
};
