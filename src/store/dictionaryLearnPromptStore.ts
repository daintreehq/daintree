import { create } from "zustand";

export interface DictionaryLearnPrompt {
  word: string;
  utterance: string;
}

interface DictionaryLearnPromptState {
  /** The offer to learn a word, per composer: the one send that produced it. */
  prompts: Map<string, DictionaryLearnPrompt>;
  offer: (terminalId: string, prompt: DictionaryLearnPrompt) => void;
  /** With `expected`, only that offer goes: a later one in the same composer stays. */
  clear: (terminalId: string, expected?: DictionaryLearnPrompt) => void;
}

export const useDictionaryLearnPromptStore = create<DictionaryLearnPromptState>()((set) => ({
  prompts: new Map(),
  offer: (terminalId, prompt) =>
    set((state) => ({ prompts: new Map(state.prompts).set(terminalId, prompt) })),
  clear: (terminalId, expected) =>
    set((state) => {
      const current = state.prompts.get(terminalId);
      if (!current || (expected && current !== expected)) return state;
      const prompts = new Map(state.prompts);
      prompts.delete(terminalId);
      return { prompts };
    }),
}));
