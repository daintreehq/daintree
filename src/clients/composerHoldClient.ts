import type {
  ComposerHoldChange,
  ComposerHoldResult,
  HeldComposerSend,
} from "@shared/types/ipc/composerHold";

/** A pane composer's sends held while its agent works (#16379), for this view's project. */
export const composerHoldClient = {
  hold: (terminalId: string, text: string, imagePaths?: string[]): Promise<ComposerHoldResult> =>
    window.electron.composerHold.hold(terminalId, text, imagePaths),
  withdraw: (terminalId: string, token: string): Promise<boolean> =>
    window.electron.composerHold.withdraw(terminalId, token).then((result) => result.withdrawn),
  list: (): Promise<HeldComposerSend[]> => window.electron.composerHold.list(),
  onChanged: (callback: (change: ComposerHoldChange) => void): (() => void) =>
    window.electron.composerHold.onChanged(callback),
};
