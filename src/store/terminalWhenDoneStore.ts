import { create } from "zustand";
import type {
  TerminalWhenDoneChange,
  TerminalWhenDoneEntry,
} from "@shared/types/ipc/terminalWhenDone";

type ArmedChoice = TerminalWhenDoneEntry["choice"];

/**
 * This view's mirror of main's When done choices (#16171). Main holds the only
 * record, in memory, so a reloaded view reads it again and shows a terminal as
 * armed only while main still says so.
 */
interface TerminalWhenDoneState {
  choices: Readonly<Record<string, ArmedChoice>>;
  applyChange: (change: TerminalWhenDoneChange) => void;
  replaceAll: (entries: readonly TerminalWhenDoneEntry[]) => void;
}

export const useTerminalWhenDoneStore = create<TerminalWhenDoneState>((set) => ({
  choices: {},
  applyChange: ({ terminalId, choice }) =>
    set((state) => {
      if (choice === "keep") {
        if (!(terminalId in state.choices)) return state;
        const { [terminalId]: _dropped, ...rest } = state.choices;
        return { choices: rest };
      }
      if (state.choices[terminalId] === choice) return state;
      return { choices: { ...state.choices, [terminalId]: choice } };
    }),
  replaceAll: (entries) =>
    set({
      choices: Object.fromEntries(entries.map((entry) => [entry.terminalId, entry.choice])),
    }),
}));
