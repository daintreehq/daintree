import { create } from "zustand";
import type { ProjectRelocationMode } from "@shared/types/projectRelocation";

/**
 * Ephemeral state for the "Move or rename project" dialog (#11282, phase 4).
 * All three entry points — Project Settings, the healthy-project context menu,
 * and the missing-project "Locate moved project" recovery flow — call `open()`;
 * a single host-mounted dialog subscribes and renders. Not persisted.
 */
export interface PendingProjectRelocation {
  projectId: string;
  /** `"move"` for a healthy project, `"reattach"` for a missing one. */
  mode: ProjectRelocationMode;
  /** The project's current folder — seeds the dialog's folder/parent fields. */
  oldPath: string;
  /** The project's current display name — seeds the dialog's name field. */
  name: string;
  /**
   * Invoked with the committed display name after a successful rename (fast path
   * or move-with-rename). Lets an entry point that owns its own live name draft —
   * the Project Settings form — resync, so its close-time flush doesn't revert
   * the dialog's change. Entry points without a draft (context menus) omit it.
   */
  onDisplayNameCommitted?: (name: string) => void;
}

interface ProjectRelocationState {
  pending: PendingProjectRelocation | null;
  /**
   * Bumped on every `open()`. Used as the dialog's re-init key so a second
   * request (e.g. opening the dialog for a different project without an
   * intervening close) reseeds the form from the new target.
   */
  requestSeq: number;
  open: (target: PendingProjectRelocation) => void;
  close: () => void;
}

export const useProjectRelocationStore = create<ProjectRelocationState>((set) => ({
  pending: null,
  requestSeq: 0,
  open: (target) => set((state) => ({ pending: target, requestSeq: state.requestSeq + 1 })),
  close: () => set({ pending: null }),
}));
