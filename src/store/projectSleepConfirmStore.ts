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
  /**
   * `idle` is the whole batch the preview checked; `project` is one named
   * target; `all` is every open project; `restart` is one target slept and
   * then reopened in this window.
   */
  kind: "project" | "all" | "idle" | "restart";
  projects: SleepConfirmProject[];
  /**
   * Offer to wait for the agents to settle before sleeping (#17882). Only the
   * user's own Sleep of named projects offers it; the idle batch has nothing
   * to wait for and a restart is a stop by definition.
   */
  offerWhenIdle?: boolean;
}

/**
 * What the user chose. `idle` waits for every agent to be observed settled,
 * and `pauseNote` asks the working ones to stop at their next pause first.
 */
export type SleepChoice = { when: "now" } | { when: "idle"; pauseNote: boolean };

interface PendingSleepConfirmation {
  resolve: (choice: SleepChoice | null) => void;
  request: SleepConfirmRequest;
}

interface ProjectSleepConfirmState {
  pendingConfirm: PendingSleepConfirmation | null;
  /** Bumped on every request; the host's ErrorBoundary `resetKeys` signal (#9918). */
  requestSeq: number;
  requestConfirmation: (request: SleepConfirmRequest) => Promise<boolean>;
  /** Resolves with the user's choice, or null when they cancelled. */
  requestSleepChoice: (request: SleepConfirmRequest) => Promise<SleepChoice | null>;
  resolveConfirmation: (ok: boolean) => void;
  resolveChoice: (choice: SleepChoice | null) => void;
}

/**
 * Deferred-Promise confirm gate for `project.sleep`, `project.sleepIdle` and
 * `project.restart`, which the palette, a keybinding, the memory notice and MCP
 * all reach with no dialog of their own. A second request while one is pending cancels the first.
 */
export const useProjectSleepConfirmStore = create<ProjectSleepConfirmState>()((set, get) => ({
  pendingConfirm: null,
  requestSeq: 0,

  requestConfirmation: (request) =>
    get()
      .requestSleepChoice(request)
      .then((choice) => choice !== null),

  requestSleepChoice: (request) => {
    get().pendingConfirm?.resolve(null);
    return new Promise<SleepChoice | null>((resolve) => {
      set((state) => ({
        pendingConfirm: { resolve, request },
        requestSeq: state.requestSeq + 1,
      }));
    });
  },

  resolveConfirmation: (ok) => get().resolveChoice(ok ? { when: "now" } : null),

  resolveChoice: (choice) => {
    const pending = get().pendingConfirm;
    if (!pending) return;
    pending.resolve(choice);
    set({ pendingConfirm: null });
  },
}));
