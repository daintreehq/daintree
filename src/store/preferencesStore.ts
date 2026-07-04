import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

export type DockDensity = "compact" | "normal" | "comfortable";

// Mirrors react-diff-view's ViewType so the persistence layer stays decoupled
// from the UI library.
export type DiffViewType = "split" | "unified";

interface PreferencesState {
  showProjectPulse: boolean;
  setShowProjectPulse: (show: boolean) => void;
  showDeveloperTools: boolean;
  setShowDeveloperTools: (show: boolean) => void;
  showGridAgentHighlights: boolean;
  setShowGridAgentHighlights: (show: boolean) => void;
  /** Compose the agent's observed task title into terminal tab/header titles. */
  showAgentTaskTitles: boolean;
  setShowAgentTaskTitles: (show: boolean) => void;
  showDockAgentHighlights: boolean;
  setShowDockAgentHighlights: (show: boolean) => void;
  dockDensity: DockDensity;
  setDockDensity: (density: DockDensity) => void;
  assignWorktreeToSelf: boolean;
  setAssignWorktreeToSelf: (value: boolean) => void;
  reduceAnimations: boolean;
  setReduceAnimations: (value: boolean) => void;
  diffViewType: DiffViewType;
  setDiffViewType: (value: DiffViewType) => void;
  diffWrapLines: boolean;
  setDiffWrapLines: (value: boolean) => void;
  diffIgnoreWhitespace: boolean;
  setDiffIgnoreWhitespace: (value: boolean) => void;
  lastSelectedWorktreeRecipeIdByProject: Record<string, string | null | undefined>;
  setLastSelectedWorktreeRecipeIdByProject: (
    projectId: string,
    id: string | null | undefined
  ) => void;
  skipPushConfirmByWorktreePath: Record<string, boolean>;
  setSkipPushConfirmForWorktree: (worktreePath: string, value: boolean) => void;
}

function isDockDensity(value: unknown): value is DockDensity {
  return value === "compact" || value === "normal" || value === "comfortable";
}

function isDiffViewType(value: unknown): value is DiffViewType {
  return value === "split" || value === "unified";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Normalise the closed-set and record-shaped fields of a persisted blob against
 * the current schema. Run from the persist `merge` callback so it executes on
 * EVERY hydration — not only on version change, which is all `migrate` covers
 * (issue #9170). A corrupt-but-parseable value (e.g. hand-edited
 * `dockDensity: "dense"`, or a string where a record is expected) is replaced
 * with a safe default instead of flowing into live state unchecked.
 */
function sanitizePersistedPreferences(
  raw: Partial<PreferencesState> | undefined | null
): Partial<PreferencesState> {
  if (!raw || typeof raw !== "object") return {};
  const sanitized: Partial<PreferencesState> = { ...raw };

  if (!isDockDensity(sanitized.dockDensity)) sanitized.dockDensity = "normal";
  if (!isDiffViewType(sanitized.diffViewType)) sanitized.diffViewType = "split";
  if (typeof sanitized.diffWrapLines !== "boolean") sanitized.diffWrapLines = false;
  if (typeof sanitized.diffIgnoreWhitespace !== "boolean") sanitized.diffIgnoreWhitespace = false;
  if (typeof sanitized.showAgentTaskTitles !== "boolean") sanitized.showAgentTaskTitles = true;

  // A truthy non-record value here would otherwise bypass the push-confirm gate.
  const skip = sanitized.skipPushConfirmByWorktreePath;
  const validatedSkip: Record<string, boolean> = {};
  if (skip !== null && typeof skip === "object" && !Array.isArray(skip)) {
    for (const [key, value] of Object.entries(skip)) {
      if (typeof value === "boolean") validatedSkip[key] = value;
    }
  }
  sanitized.skipPushConfirmByWorktreePath = validatedSkip;

  return sanitized;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      showProjectPulse: true,
      setShowProjectPulse: (show) => set({ showProjectPulse: show }),
      showDeveloperTools: false,
      setShowDeveloperTools: (show) => set({ showDeveloperTools: show }),
      showGridAgentHighlights: false,
      setShowGridAgentHighlights: (show) => set({ showGridAgentHighlights: show }),
      showAgentTaskTitles: true,
      setShowAgentTaskTitles: (show) => set({ showAgentTaskTitles: show }),
      showDockAgentHighlights: false,
      setShowDockAgentHighlights: (show) => set({ showDockAgentHighlights: show }),
      dockDensity: "normal",
      setDockDensity: (density) => set({ dockDensity: density }),
      assignWorktreeToSelf: false,
      setAssignWorktreeToSelf: (value) => set({ assignWorktreeToSelf: value }),
      reduceAnimations: false,
      setReduceAnimations: (value) => set({ reduceAnimations: value }),
      diffViewType: "split",
      setDiffViewType: (value) => set({ diffViewType: value }),
      diffWrapLines: false,
      setDiffWrapLines: (value) => set({ diffWrapLines: value }),
      diffIgnoreWhitespace: false,
      setDiffIgnoreWhitespace: (value) => set({ diffIgnoreWhitespace: value }),
      lastSelectedWorktreeRecipeIdByProject: {},
      setLastSelectedWorktreeRecipeIdByProject: (projectId, id) =>
        set((state) => ({
          lastSelectedWorktreeRecipeIdByProject: {
            ...state.lastSelectedWorktreeRecipeIdByProject,
            [projectId]: id,
          },
        })),
      skipPushConfirmByWorktreePath: {},
      setSkipPushConfirmForWorktree: (worktreePath, value) =>
        set((state) => {
          if (value) {
            return {
              skipPushConfirmByWorktreePath: {
                ...state.skipPushConfirmByWorktreePath,
                [worktreePath]: true,
              },
            };
          }
          // Drop the key when clearing so the record doesn't accumulate
          // `false` entries on every confirm-without-opt-out.
          if (state.skipPushConfirmByWorktreePath[worktreePath] === undefined) {
            return state;
          }
          const { [worktreePath]: _removed, ...rest } = state.skipPushConfirmByWorktreePath;
          return { skipPushConfirmByWorktreePath: rest };
        }),
    }),
    {
      name: "daintree-preferences",
      storage: createSafeJSONStorage(),
      version: 11,
      // Runs on every hydration (unlike `migrate`, which Zustand skips when the
      // persisted version matches). Closed-set normalisation lives here so a
      // corrupt-but-parseable value is clamped even at the current version.
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersistedPreferences(persisted as Partial<PreferencesState> | undefined | null),
      }),
      migrate: (persisted, version) => {
        if (version === 0 || version === undefined) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            delete state.lastSelectedWorktreeRecipeId;
            state.lastSelectedWorktreeRecipeIdByProject = {};
          } else {
            return { lastSelectedWorktreeRecipeIdByProject: {} } as PreferencesState;
          }
        }
        if (version < 2) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.showGridAgentHighlights ??= false;
            state.showDockAgentHighlights ??= false;
          }
        }
        if (version < 3) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.dockDensity ??= "normal";
          }
        }
        if (version < 4) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.reduceAnimations ??= false;
          }
        }
        if (version < 6) {
          // skipWorkingCloseConfirm was retired with the close-confirm dialog
          // (issue #6920). Drop the field so persisted state matches the
          // current schema.
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            delete state.skipWorkingCloseConfirm;
          }
        }
        if (version < 7) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            // Validate against the closed set rather than `??=` so a corrupt
            // value (e.g. hand-edited `"side-by-side"`) is normalised.
            if (state.diffViewType !== "split" && state.diffViewType !== "unified") {
              state.diffViewType = "split";
            }
          }
        }
        if (version < 8) {
          // Issue #7979 — dockDensity is now exposed in the dock context menu's
          // radio group, so a corrupt persisted value (e.g. hand-edited
          // "dense") would leave the radio with no checked item and apply an
          // unknown CSS data attribute. Validate against the closed set.
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            if (
              state.dockDensity !== "compact" &&
              state.dockDensity !== "normal" &&
              state.dockDensity !== "comfortable"
            ) {
              state.dockDensity = "normal";
            }
          }
        }
        if (version < 9) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            // Validate the record shape rather than just `??=` so a corrupt
            // value (e.g. hand-edited array or string) is normalised. A
            // truthy string would otherwise bypass the confirm gate.
            const current = state.skipPushConfirmByWorktreePath;
            const validated: Record<string, boolean> = {};
            if (current !== null && typeof current === "object" && !Array.isArray(current)) {
              for (const [key, value] of Object.entries(current)) {
                if (typeof value === "boolean") validated[key] = value;
              }
            }
            state.skipPushConfirmByWorktreePath = validated;
          }
        }
        if (version < 10 && isRecord(persisted)) {
          if (typeof persisted.diffWrapLines !== "boolean") persisted.diffWrapLines = false;
          if (typeof persisted.diffIgnoreWhitespace !== "boolean") {
            persisted.diffIgnoreWhitespace = false;
          }
        }
        if (version < 11 && isRecord(persisted)) {
          if (typeof persisted.showAgentTaskTitles !== "boolean") {
            persisted.showAgentTaskTitles = true;
          }
        }
        return persisted as PreferencesState;
      },
    }
  )
);

registerPersistedStore({
  storeId: "preferencesStore",
  store: usePreferencesStore,
  persistedStateType:
    "{ showProjectPulse: boolean; showDeveloperTools: boolean; showGridAgentHighlights: boolean; showDockAgentHighlights: boolean; showAgentTaskTitles: boolean; dockDensity: DockDensity; assignWorktreeToSelf: boolean; reduceAnimations: boolean; diffViewType: DiffViewType; diffWrapLines: boolean; diffIgnoreWhitespace: boolean; lastSelectedWorktreeRecipeIdByProject: Record<string, string | null | undefined>; skipPushConfirmByWorktreePath: Record<string, boolean> }",
});
