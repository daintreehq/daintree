import { create } from "zustand";

/**
 * Clipboard-bound copy-tree runs currently in flight, whatever started them —
 * the toolbar button, Cmd+Shift+C, the palette, a recents replay, a context
 * menu, or an MCP/assistant dispatch. The toolbar's Copy context button derives
 * its spinner from this count, so an agent-driven copy spins it exactly like a
 * clicked one.
 *
 * A count rather than a boolean: runs can overlap (an MCP copy landing while a
 * manual one is generating), and a boolean would let the first completion
 * switch the spinner off under the run still going.
 */
interface CopyTreeRunState {
  activeRunCount: number;
  beginRun: () => void;
  endRun: () => void;
}

export const useCopyTreeRunStore = create<CopyTreeRunState>((set) => ({
  activeRunCount: 0,
  beginRun: () => set((s) => ({ activeRunCount: s.activeRunCount + 1 })),
  // Clamped so a double-settled promise can never wedge the count negative and
  // eat the next run's spinner.
  endRun: () => set((s) => ({ activeRunCount: Math.max(0, s.activeRunCount - 1) })),
}));
