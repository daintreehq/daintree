import { create } from "zustand";
import type { PrerequisiteCheckResult } from "@shared/types";

/** Progress of a one-click install job for a single prerequisite. */
export interface PrerequisiteInstallJob {
  /** Correlates streamed progress; a superseded job's output is ignored. */
  jobId: string;
  tool: string;
  status: "running" | "handed-off" | "error";
  /** Latest scrubbed output line, shown as the banner's live status. */
  statusLine: string;
  error: string | null;
}

interface MissingPrerequisiteState {
  /** Fatal prerequisites that came back unavailable or below their minimum. */
  missing: PrerequisiteCheckResult[];
  /** Session-only — never persisted, so it returns on the next launch. */
  dismissed: boolean;
  /**
   * Count of mounted surfaces already showing prerequisite state (the Setup
   * wizard's health step, the Settings troubleshooting tab). A counter rather
   * than a boolean because both can be mounted at once and each unmount must
   * only retract its own claim.
   */
  inlineSurfaceCount: number;
  install: PrerequisiteInstallJob | null;
  setMissing: (missing: PrerequisiteCheckResult[]) => void;
  dismiss: () => void;
  claimInlineSurface: () => () => void;
  setInstall: (install: PrerequisiteInstallJob | null) => void;
}

export const useMissingPrerequisiteStore = create<MissingPrerequisiteState>((set) => ({
  missing: [],
  dismissed: false,
  inlineSurfaceCount: 0,
  install: null,
  setMissing: (missing) => set({ missing }),
  dismiss: () => set({ dismissed: true }),
  claimInlineSurface: () => {
    set((s) => ({ inlineSurfaceCount: s.inlineSurfaceCount + 1 }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set((s) => ({ inlineSurfaceCount: Math.max(0, s.inlineSurfaceCount - 1) }));
    };
  },
  setInstall: (install) => set({ install }),
}));

/** True when the banner has something to say and nothing is shadowing it. */
export function selectMissingPrerequisiteVisible(s: MissingPrerequisiteState): boolean {
  return s.missing.length > 0 && !s.dismissed && s.inlineSurfaceCount === 0;
}

export type { MissingPrerequisiteState };
