import type {
  ComposerHoldChange,
  ComposerHoldResult,
  ComposerHoldSendNowResult,
  HeldComposerSend,
} from "@shared/types/ipc/composerHold";

/** A pane composer's sends held for its pane's next prompt (#16379, #16872), for this view's project. */
export const composerHoldClient = {
  hold: (terminalId: string, text: string, imagePaths?: string[]): Promise<ComposerHoldResult> =>
    window.electron.composerHold.hold(terminalId, text, imagePaths),
  withdraw: (terminalId: string, token: string): Promise<boolean> =>
    window.electron.composerHold.withdraw(terminalId, token).then((result) => result.withdrawn),
  /** Type a held send now (#16745); `inputBlocked` drops it instead, saying so. */
  sendNow: (
    terminalId: string,
    token: string,
    inputBlocked: boolean
  ): Promise<ComposerHoldSendNowResult> =>
    window.electron.composerHold.sendNow(terminalId, token, inputBlocked),
  list: (): Promise<HeldComposerSend[]> => window.electron.composerHold.list(),
  onChanged: (callback: (change: ComposerHoldChange) => void): (() => void) =>
    window.electron.composerHold.onChanged(callback),
};
