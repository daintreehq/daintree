import { create } from "zustand";
import type {
  ComposerHoldChange,
  ComposerHoldDropReason,
  HeldComposerSend,
} from "@shared/types/ipc/composerHold";

/** A held send that ended unwritten, kept so its pane can say why and give the text back. */
export interface DroppedComposerSend {
  token: string;
  text: string;
  imagePaths: string[];
  reason: ComposerHoldDropReason;
}

/** Tokens that ended, so a hold answer arriving after its outcome doesn't bring it back. */
const MAX_ENDED_TOKENS = 64;

/**
 * This view's mirror of main's held composer sends (#16379), one per pane.
 * Main holds the only record, in memory, so a reloaded view reads it again;
 * a dropped send's text stays here until its pane's composer takes it back
 * or the note is dismissed.
 */
interface HeldComposerSendState {
  held: Readonly<Record<string, HeldComposerSend>>;
  dropped: Readonly<Record<string, DroppedComposerSend>>;
  /** Panes where a send was just refused because one is held. */
  refused: Readonly<Record<string, true>>;
  endedTokens: readonly string[];
  applyChange: (change: ComposerHoldChange) => void;
  replaceAll: (sends: readonly HeldComposerSend[]) => void;
  /** Main's answer to this view's own hold, which may come before or after its push. */
  noteHeld: (send: HeldComposerSend) => void;
  noteRefused: (terminalId: string) => void;
  clearDropped: (terminalId: string) => void;
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export const useHeldComposerSendStore = create<HeldComposerSendState>((set) => ({
  held: {},
  dropped: {},
  refused: {},
  endedTokens: [],

  applyChange: ({ terminalId, held, ended }) =>
    set((state) => {
      let { dropped, refused, endedTokens } = state;
      if (ended !== undefined) {
        endedTokens = [...endedTokens, ended.token].slice(-MAX_ENDED_TOKENS);
        const previous = state.held[terminalId];
        if (ended.outcome.kind === "dropped" && previous?.token === ended.token) {
          dropped = {
            ...dropped,
            [terminalId]: {
              token: ended.token,
              text: previous.text,
              imagePaths: previous.imagePaths,
              reason: ended.outcome.reason,
            },
          };
        }
      }
      if (held === null || endedTokens.includes(held.token)) {
        return {
          held: without(state.held, terminalId),
          refused: without(refused, terminalId),
          dropped,
          endedTokens,
        };
      }
      // A send held afresh replaces whatever the pane last said about the one before.
      if (state.held[terminalId]?.token !== held.token) {
        dropped = without(dropped, terminalId);
        refused = without(refused, terminalId);
      }
      return { held: { ...state.held, [terminalId]: held }, dropped, refused, endedTokens };
    }),

  replaceAll: (sends) =>
    set((state) => {
      const held: Record<string, HeldComposerSend> = {};
      for (const send of sends) {
        if (!state.endedTokens.includes(send.token)) held[send.terminalId] = send;
      }
      return { held };
    }),

  noteHeld: (send) =>
    set((state) => {
      if (state.endedTokens.includes(send.token)) return state;
      if (state.held[send.terminalId]?.token === send.token) return state;
      return {
        held: { ...state.held, [send.terminalId]: send },
        dropped: without(state.dropped, send.terminalId),
      };
    }),

  noteRefused: (terminalId) =>
    set((state) =>
      state.refused[terminalId] ? state : { refused: { ...state.refused, [terminalId]: true } }
    ),

  clearDropped: (terminalId) =>
    set((state) => {
      const dropped = without(state.dropped, terminalId);
      return dropped === state.dropped ? state : { dropped };
    }),
}));

/** Whether this view knows of a send held for `terminalId`. */
export function hasHeldComposerSend(terminalId: string): boolean {
  return terminalId in useHeldComposerSendStore.getState().held;
}
