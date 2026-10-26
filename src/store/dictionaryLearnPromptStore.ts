import { create } from "zustand";

export interface DictionaryLearnPrompt {
  word: string;
  utterance: string;
}

interface DictionaryLearnPromptState {
  /** The offer to learn a word, per composer: the one send that produced it. */
  prompts: Map<string, DictionaryLearnPrompt>;
  offer: (terminalId: string, prompt: DictionaryLearnPrompt) => void;
  clear: (terminalId: string) => void;
}

export const useDictionaryLearnPromptStore = create<DictionaryLearnPromptState>()((set) => ({
  prompts: new Map(),
  offer: (terminalId, prompt) =>
    set((state) => ({ prompts: new Map(state.prompts).set(terminalId, prompt) })),
  clear: (terminalId) =>
    set((state) => {
      if (!state.prompts.has(terminalId)) return state;
      const prompts = new Map(state.prompts);
      prompts.delete(terminalId);
      return { prompts };
    }),
}));
