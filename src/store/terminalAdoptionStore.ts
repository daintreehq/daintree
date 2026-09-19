import { create } from "zustand";
import type { TerminalAdoptionEntry } from "@shared/types/ipc/mcpServer";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

interface TerminalAdoptionState {
  /**
   * Terminals the user handed to an orchestrating pane (#12490), keyed by the
   * handed-over terminal. Main is the only authority: this mirrors its list and
   * never writes an entry of its own.
   */
  adoptionsByTerminalId: Record<string, TerminalAdoptionEntry>;
  applyAdoptions: (adoptions: readonly TerminalAdoptionEntry[]) => void;
}

function indexByTerminal(
  adoptions: readonly TerminalAdoptionEntry[]
): Record<string, TerminalAdoptionEntry> {
  const byTerminal: Record<string, TerminalAdoptionEntry> = {};
  for (const adoption of adoptions) byTerminal[adoption.terminalId] = adoption;
  return byTerminal;
}

export const useTerminalAdoptionStore = create<TerminalAdoptionState>((set) => ({
  adoptionsByTerminalId: {},
  applyAdoptions: (adoptions) => set({ adoptionsByTerminalId: indexByTerminal(adoptions) }),
}));

let adoptionsUnsubscribe: (() => void) | null = null;
// Same generation guard the fleet snapshot uses: a pull from an earlier setup
// must not land after cleanup, and a push for this setup outranks the pull.
let setupGeneration = 0;
let pushLandedGeneration = -1;

/**
 * Subscribe, then hydrate. Hand-overs change only on a user gesture or a pane
 * exit, so a view that only subscribed could wait indefinitely for its first
 * list — and a driven terminal would show nothing in the meantime.
 */
export function setupTerminalAdoptionListeners(): () => void {
  if (typeof window === "undefined") return () => {};
  if (adoptionsUnsubscribe !== null) return cleanupTerminalAdoptionListeners;

  const generation = ++setupGeneration;

  adoptionsUnsubscribe = window.electron.events.on("terminal:adoptions-changed", (adoptions) => {
    pushLandedGeneration = generation;
    useTerminalAdoptionStore.getState().applyAdoptions(adoptions);
  });

  safeFireAndForget(
    window.electron.mcpServer.listTerminalAdoptions().then((adoptions) => {
      if (generation !== setupGeneration) return;
      if (pushLandedGeneration === generation) return;
      useTerminalAdoptionStore.getState().applyAdoptions(adoptions);
    }),
    { context: "terminalAdoptionStore hydrate" }
  );

  return cleanupTerminalAdoptionListeners;
}

export function cleanupTerminalAdoptionListeners(): void {
  setupGeneration++;
  if (adoptionsUnsubscribe) {
    adoptionsUnsubscribe();
    adoptionsUnsubscribe = null;
  }
}
