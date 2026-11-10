import { create } from "zustand";
import { getPanelStoreSnapshot } from "./storeAccessors";

/**
 * The last message a pane's composer, or a fleet broadcast, sent to it (#16746):
 * the text as it went, expansions included, and the images that went as
 * attachments. Held in memory for the pane's lifetime, never persisted or
 * logged, so the same message can be sent again.
 */
export interface LastComposerSend {
  text: string;
  imagePaths: readonly string[];
  /** When the send was attempted, so a slow answer can't replace a newer send. */
  seq: number;
}

interface LastComposerSendState {
  sends: Readonly<Record<string, LastComposerSend>>;
  clear: (terminalId: string) => void;
}

export const useLastComposerSendStore = create<LastComposerSendState>((set) => ({
  sends: {},
  clear: (terminalId) =>
    set((state) => {
      if (!(terminalId in state.sends)) return state;
      const { [terminalId]: _gone, ...rest } = state.sends;
      return { sends: rest };
    }),
}));

let lastSeq = 0;

/** Taken as a send starts, before anything it waits on. */
export function claimComposerSendSeq(): number {
  return ++lastSeq;
}

/**
 * Notes what went to `terminalId`. A send that started before the one on
 * record leaves it there, and a pane already closed gets nothing back.
 */
export function noteLastComposerSend(
  terminalId: string,
  text: string,
  imagePaths: readonly string[],
  seq: number
): void {
  if (text.trim() === "") return;
  const panels = getPanelStoreSnapshot();
  if (panels !== null && !Object.hasOwn(panels.panelsById, terminalId)) return;
  useLastComposerSendStore.setState((state) => {
    const current = state.sends[terminalId];
    if (current !== undefined && current.seq > seq) return state;
    return {
      sends: { ...state.sends, [terminalId]: { text, imagePaths: [...imagePaths], seq } },
    };
  });
}

export function getLastComposerSend(terminalId: string): LastComposerSend | undefined {
  return useLastComposerSendStore.getState().sends[terminalId];
}
