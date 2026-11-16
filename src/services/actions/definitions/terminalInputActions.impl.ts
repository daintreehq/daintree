// The terminal.sendKeys run body, loaded on first dispatch by terminalInputActions.ts,
// which keeps the metadata every view registers at boot. Nothing here may import
// terminalInputActions.ts at runtime.
import type { z } from "zod";
import { terminalClient } from "@/clients";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { readTailSnapshot, tailCapturedOutput } from "@shared/utils/artifactParser";
import { planChoice } from "@shared/utils/terminalChoice";
import {
  CHOOSE_SCREEN_LINES,
  keySequence,
  screenChangedField,
  SEND_KEYS_GAP_MS,
  SEND_KEYS_SCREEN_LINES,
  SEND_KEYS_SETTLE_MS,
  type SendKeysArgsSchema,
} from "@shared/utils/terminalKeys";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import { getTerminalInputBlock, getTerminalInputBlockMessage } from "@/services/terminal/inputGate";

export async function runTerminalSendKeys(args: z.infer<typeof SendKeysArgsSchema>) {
  const { terminalId, choose } = args;
  const state = usePanelStore.getState();
  const panel = Object.hasOwn(state.panelsById, terminalId)
    ? state.panelsById[terminalId]
    : undefined;
  if (!panel || !isPtyPanel(panel)) {
    throw new UnactionableTargetError(`No terminal ${terminalId} to press keys in.`);
  }
  if (panel.isInputLocked || peekTerminalService()?.get(terminalId)?.isInputLocked) {
    throw new UnactionableTargetError(`Terminal ${terminalId} has its input locked.`);
  }
  let keys = args.keys;
  if (choose !== undefined) {
    const snapshot = await readTailSnapshot(
      (options) => window.electron.terminal.getSerializedState(terminalId, options),
      CHOOSE_SCREEN_LINES
    );
    const plan = planChoice(
      snapshot === null ? "" : tailCapturedOutput(snapshot.data, CHOOSE_SCREEN_LINES, true).content,
      choose
    );
    if (!plan.ok) throw new UnactionableTargetError(`${plan.reason} Nothing was pressed.`);
    keys = plan.keys;
  }
  if (keys === undefined) {
    throw new UnactionableTargetError("Pass `choose` or `keys`. Nothing was pressed.");
  }
  const readScreen = async (): Promise<string | null> => {
    const snapshot = await readTailSnapshot(
      (options) => window.electron.terminal.getSerializedState(terminalId, options),
      SEND_KEYS_SCREEN_LINES
    ).catch(() => null);
    return snapshot === null
      ? null
      : tailCapturedOutput(snapshot.data, SEND_KEYS_SCREEN_LINES, true).content;
  };
  // Read the same window as after the keys, so the result can say whether
  // they changed anything (#16209).
  const before = await readScreen();
  // One write per key, spaced out: a TUI reading a burst as one chunk can
  // take an arrow and an Enter as a single unknown sequence. A key written
  // while terminal input is blocked never leaves the renderer, so it is
  // refused rather than reported pressed.
  const pressed: string[] = [];
  for (const [index, key] of keys.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, SEND_KEYS_GAP_MS));
    // The screen reads were async: a lock taken meanwhile still stops the keys.
    const panelNow = usePanelStore.getState().panelsById[terminalId];
    const locked =
      (panelNow !== undefined && isPtyPanel(panelNow) && panelNow.isInputLocked) ||
      peekTerminalService()?.get(terminalId)?.isInputLocked;
    const blocked = getTerminalInputBlock();
    if (locked || blocked) {
      const why = blocked
        ? `Terminal ${terminalId} takes no input right now (${getTerminalInputBlockMessage(blocked)}).`
        : `Terminal ${terminalId} has its input locked.`;
      throw new UnactionableTargetError(
        pressed.length === 0
          ? `${why} Nothing was pressed.`
          : `${why} ${pressed.length} of ${keys.length} keys were sent (${pressed.join(", ")}); the rest weren't. Read the screen before pressing more, and never resend the whole sequence.`
      );
    }
    terminalClient.write(terminalId, keySequence(key));
    pressed.push(key);
  }
  // A wrong key on a dialog (Quit instead of Continue) shows up here, a
  // call sooner than a separate read would find it.
  await new Promise((resolve) => setTimeout(resolve, SEND_KEYS_SETTLE_MS));
  const screen = await readScreen();
  return {
    terminalId,
    keys,
    ...(screen ? { screen } : {}),
    ...screenChangedField(before, screen),
  };
}
