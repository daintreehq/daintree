import { create } from "zustand";

export interface MoveTerminalsOpening {
  /** New on every opening, so a second one starts from its own account and boxes. */
  id: number;
  agentId: string;
  /** Picked in the agent's menu; absent when the dialog asks (the palette). */
  account?: { id: string | null; name: string };
}

/**
 * The open "Move terminals to account" dialog (#17089). It mounts in the
 * project-level dialog host, since the palette opens it as well as the agent's
 * toolbar menu, and that button may not be on the toolbar at all.
 */
interface MoveTerminalsDialogState {
  opening: MoveTerminalsOpening | null;
  open: (agentId: string, account?: MoveTerminalsOpening["account"]) => void;
  close: () => void;
}

let nextOpeningId = 0;

export const useMoveTerminalsDialogStore = create<MoveTerminalsDialogState>()((set) => ({
  opening: null,
  open: (agentId, account) =>
    set({ opening: { id: ++nextOpeningId, agentId, ...(account ? { account } : {}) } }),
  close: () => set({ opening: null }),
}));
