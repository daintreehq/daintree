import { create } from "zustand";

export interface TerminalInputState {
  hybridInputEnabled: boolean;
  hybridInputAutoFocus: boolean;
  draftInputs: Map<string, string>;
  setHybridInputEnabled: (enabled: boolean) => void;
  setHybridInputAutoFocus: (enabled: boolean) => void;
  getDraftInput: (terminalId: string) => string;
  setDraftInput: (terminalId: string, value: string) => void;
  clearDraftInput: (terminalId: string) => void;
  clearAllDraftInputs: () => void;
}

export const useTerminalInputStore = create<TerminalInputState>()((set, get) => ({
  hybridInputEnabled: true,
  hybridInputAutoFocus: true,
  draftInputs: new Map(),
  setHybridInputEnabled: (enabled) => set({ hybridInputEnabled: enabled }),
  setHybridInputAutoFocus: (enabled) => set({ hybridInputAutoFocus: enabled }),
  getDraftInput: (terminalId) => get().draftInputs.get(terminalId) ?? "",
  setDraftInput: (terminalId, value) =>
    set((state) => {
      const newDraftInputs = new Map(state.draftInputs);
      if (value === "") {
        newDraftInputs.delete(terminalId);
      } else {
        newDraftInputs.set(terminalId, value);
      }
      return { draftInputs: newDraftInputs };
    }),
  clearDraftInput: (terminalId) =>
    set((state) => {
      const newDraftInputs = new Map(state.draftInputs);
      newDraftInputs.delete(terminalId);
      return { draftInputs: newDraftInputs };
    }),
  clearAllDraftInputs: () => set({ draftInputs: new Map() }),
}));
