import { create } from "zustand";

/** One project the confirmation names, frozen when the request opened. */
export interface SleepConfirmProject {
  id: string;
  name: string;
  path: string;
  /** Live terminal PTYs, agents included. */
  terminalCount: number;
  waitingAgentCount: number;
  activeAgentCount: number;
  /** The project on screen: sleeping it drops the user to the no-project state. */
  isActive: boolean;
  /**
   * Measured resident memory of the project's terminal process trees. Sums RSS,
   * so it counts shared pages; undefined when the process table couldn't be read.
   */
  terminalMemoryMB?: number;
}

export interface SleepConfirmRequest {
  /** `idle` is the whole batch the preview checked; `project` is one named target. */
  kind: "project" | "idle";
  projects: SleepConfirmProject[];
}

interface PendingSleepConfirmation {
  resolve: (ok: boolean) => void;
  request: SleepConfirmRequest;
}

interface ProjectSleepConfirmState {
  pendingConfirm: PendingSleepConfirmation | null;
  /** Bumped on every request; the host's ErrorBoundary `resetKeys` signal (#9918). */
  requestSeq: number;
  requestConfirmation: (request: SleepConfirmRequest) => Promise<boolean>;
  resolveConfirmation: (ok: boolean) => void;
}

/**
 * Deferred-Promise confirm gate for `project.sleep` and `project.sleepIdle`,
 * which the palette, a keybinding, the memory notice and MCP all reach with no
 * dialog of their own. A second request while one is pending cancels the first.
 */
export const useProjectSleepConfirmStore = create<ProjectSleepConfirmState>()((set, get) => ({
  pendingConfirm: null,
  requestSeq: 0,

  requestConfirmation: (request) => {
    get().pendingConfirm?.resolve(false);
    return new Promise<boolean>((resolve) => {
      set((state) => ({
        pendingConfirm: { resolve, request },
        requestSeq: state.requestSeq + 1,
      }));
    });
  },

  resolveConfirmation: (ok) => {
    const pending = get().pendingConfirm;
    if (!pending) return;
    pending.resolve(ok);
    set({ pendingConfirm: null });
  },
}));
