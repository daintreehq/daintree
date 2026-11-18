import { create } from "zustand";

/**
 * What Daintree last observed for one agent while a Sleep waits on it (#17882).
 * Observations only: `waiting-input` is an agent at its prompt as far as the
 * output shows, never a claim that it stopped somewhere safe.
 */
export type SleepWaitObservation =
  | "working"
  | "directing"
  | "approval"
  | "question"
  | "error"
  | "waiting-input"
  | "idle"
  | "completed"
  | "starting";

export interface SleepWaitAgent {
  terminalId: string;
  title: string;
  observation: SleepWaitObservation;
  /** Set once the pause note was tried for this agent in this run. */
  note?: "sent" | "refused";
}

/**
 * `waiting`: an agent still holds it. `ready`: every agent has read as settled
 * for the dwell. `unavailable`: its terminals couldn't be read. `left-open`:
 * the user came back to it, or it started again before its turn. `gone`: it
 * was slept or closed elsewhere.
 */
export type SleepWaitProjectStatus =
  | "waiting"
  | "ready"
  | "unavailable"
  | "left-open"
  | "gone"
  | "sleeping"
  | "slept"
  | "failed";

export interface SleepWaitProject {
  id: string;
  name: string;
  status: SleepWaitProjectStatus;
  agents: SleepWaitAgent[];
}

export interface SleepWaitRun {
  id: number;
  /** `timed-out` stops sleeping on its own and asks; `sleeping` is past the point of cancelling. */
  phase: "waiting" | "timed-out" | "sleeping";
  projects: SleepWaitProject[];
  pauseNote: boolean;
}

interface ProjectSleepWaitState {
  run: SleepWaitRun | null;
  setRun: (run: SleepWaitRun | null) => void;
}

/** The live view of a Sleep that waits for agents; the runner in `projectSleepWait` writes it. */
export const useProjectSleepWaitStore = create<ProjectSleepWaitState>()((set) => ({
  run: null,
  setRun: (run) => set({ run }),
}));
