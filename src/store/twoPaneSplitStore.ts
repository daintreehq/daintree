import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";

export interface TwoPaneSplitConfig {
  enabled: boolean;
  defaultRatio: number;
  preferPreview: boolean;
}

export interface WorktreeRatioEntry {
  ratio: number;
  panels: [string | null, string | null];
}

export function resolveEffectiveRatio(
  entry: WorktreeRatioEntry | undefined,
  currentLeft: string,
  currentRight: string
): number | undefined {
  if (!entry) return undefined;
  const [storedLeft, storedRight] = entry.panels;

  // Legacy migration entries — no panel IDs recorded yet
  if (storedLeft === null && storedRight === null) return entry.ratio;

  // Partial-null is invalid data — treat as no match
  if (storedLeft === null || storedRight === null) return undefined;

  // Exact match — same panel pair in same order
  if (storedLeft === currentLeft && storedRight === currentRight) return entry.ratio;

  // Exact reverse — same pair, swapped positions
  if (storedLeft === currentRight && storedRight === currentLeft) return 1 - entry.ratio;

  // Different panel pair — stale ratio, use default
  return undefined;
}

interface TwoPaneSplitState {
  config: TwoPaneSplitConfig;
  ratioByWorktreeId: Record<string, WorktreeRatioEntry>;

  setEnabled: (enabled: boolean) => void;
  setDefaultRatio: (ratio: number) => void;
  setPreferPreview: (prefer: boolean) => void;
  setWorktreeRatio: (
    worktreeId: string,
    ratio: number,
    panels: [string | null, string | null]
  ) => void;
  commitRatioIfChanged: (
    worktreeId: string,
    pendingRatio: number | null,
    panels: [string | null, string | null]
  ) => void;
  getWorktreeRatio: (worktreeId: string | null) => number;
  resetWorktreeRatio: (worktreeId: string) => void;
  resetAllWorktreeRatios: () => void;
}

const DEFAULT_CONFIG: TwoPaneSplitConfig = {
  enabled: true,
  defaultRatio: 0.5,
  preferPreview: false,
};

type TwoPaneSplitPersistedState = Pick<TwoPaneSplitState, "config" | "ratioByWorktreeId">;

/**
 * Coerce a persisted (or in-memory) snapshot into the canonical persisted shape,
 * mapping a null/malformed blob to defaults so the write merge compares canonical
 * values (issue #11351).
 */
function toTwoPaneSplitPersisted(
  state: Partial<TwoPaneSplitState> | null | undefined
): TwoPaneSplitPersistedState {
  const config = state?.config;
  const ratios = state?.ratioByWorktreeId;
  return {
    config: {
      enabled: typeof config?.enabled === "boolean" ? config.enabled : DEFAULT_CONFIG.enabled,
      defaultRatio:
        typeof config?.defaultRatio === "number" && Number.isFinite(config.defaultRatio)
          ? config.defaultRatio
          : DEFAULT_CONFIG.defaultRatio,
      preferPreview:
        typeof config?.preferPreview === "boolean"
          ? config.preferPreview
          : DEFAULT_CONFIG.preferPreview,
    },
    ratioByWorktreeId:
      ratios !== null && typeof ratios === "object" && !Array.isArray(ratios) ? ratios : {},
  };
}

/**
 * Baseline-aware three-way merge for two-pane-split writes across project views
 * (issue #11351). `ratioByWorktreeId` merges per worktree id so a stale view
 * writing one worktree's ratio no longer wipes a sibling worktree's ratio another
 * view committed; the three `config` fields defer to a sibling's on-disk value
 * unless this writer changed them. The version guards keep the raw (un-migrated)
 * `onDisk`/`baseline` reads from diffing a foreign schema — the v0→v1 migration
 * reshapes each ratio from a scalar into a `WorktreeRatioEntry`.
 */
function mergeTwoPaneSplitPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<TwoPaneSplitPersistedState>): StorageValue<TwoPaneSplitPersistedState> {
  if (!onDisk || onDisk.version !== incoming.version) return incoming;
  const disk = toTwoPaneSplitPersisted(onDisk.state);
  const inc = toTwoPaneSplitPersisted(incoming.state);
  if (baseline && typeof baseline.version === "number" && baseline.version !== incoming.version) {
    return { version: incoming.version, state: disk };
  }
  const base = toTwoPaneSplitPersisted(baseline?.state);
  return {
    version: incoming.version,
    state: {
      config: {
        enabled: pickFieldByWriterDelta(
          base.config.enabled,
          inc.config.enabled,
          disk.config.enabled
        ),
        defaultRatio: pickFieldByWriterDelta(
          base.config.defaultRatio,
          inc.config.defaultRatio,
          disk.config.defaultRatio
        ),
        preferPreview: pickFieldByWriterDelta(
          base.config.preferPreview,
          inc.config.preferPreview,
          disk.config.preferPreview
        ),
      },
      ratioByWorktreeId: mergeRecordByWriterDelta(
        base.ratioByWorktreeId,
        inc.ratioByWorktreeId,
        disk.ratioByWorktreeId
      ),
    },
  };
}

export const useTwoPaneSplitStore = create<TwoPaneSplitState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      ratioByWorktreeId: {},

      setEnabled: (enabled) =>
        set((state) => ({
          config: { ...state.config, enabled },
        })),

      setDefaultRatio: (ratio) =>
        set((state) =>
          Number.isFinite(ratio)
            ? { config: { ...state.config, defaultRatio: Math.max(0.2, Math.min(0.8, ratio)) } }
            : state
        ),

      setPreferPreview: (prefer) =>
        set((state) => ({
          config: { ...state.config, preferPreview: prefer },
        })),

      setWorktreeRatio: (worktreeId, ratio, panels) =>
        set((state) =>
          Number.isFinite(ratio)
            ? {
                ratioByWorktreeId: {
                  ...state.ratioByWorktreeId,
                  [worktreeId]: { ratio: Math.max(0.2, Math.min(0.8, ratio)), panels },
                },
              }
            : state
        ),

      commitRatioIfChanged: (worktreeId, pendingRatio, panels) => {
        if (pendingRatio === null || !Number.isFinite(pendingRatio)) return;
        const state = get();
        const current = state.ratioByWorktreeId[worktreeId];
        const clampedRatio = Math.max(0.2, Math.min(0.8, pendingRatio));
        if (
          current?.ratio !== clampedRatio ||
          current?.panels[0] !== panels[0] ||
          current?.panels[1] !== panels[1]
        ) {
          set((state) => ({
            ratioByWorktreeId: {
              ...state.ratioByWorktreeId,
              [worktreeId]: { ratio: clampedRatio, panels },
            },
          }));
        }
      },

      getWorktreeRatio: (worktreeId) => {
        const state = get();
        if (worktreeId) {
          const entry = state.ratioByWorktreeId[worktreeId];
          if (entry) return entry.ratio;
        }
        return state.config.defaultRatio;
      },

      resetWorktreeRatio: (worktreeId) =>
        set((state) => {
          const { [worktreeId]: _, ...rest } = state.ratioByWorktreeId;
          return { ratioByWorktreeId: rest };
        }),

      resetAllWorktreeRatios: () => set({ ratioByWorktreeId: {} }),
    }),
    {
      name: "daintree-two-pane-split",
      version: 1,
      storage: createSafeJSONStorage<TwoPaneSplitPersistedState>({
        mergeOnWrite: mergeTwoPaneSplitPersistedWrite,
      }),
      // Persisted subset — matches the pre-existing default (setters are dropped
      // by JSON serialization); named explicitly so the write merge (#11351) has a
      // typed persisted shape to reconcile.
      partialize: (state): TwoPaneSplitPersistedState => ({
        config: state.config,
        ratioByWorktreeId: state.ratioByWorktreeId,
      }),
      migrate: (persisted: unknown, fromVersion: number): TwoPaneSplitPersistedState => {
        const migrated = toTwoPaneSplitPersisted(persisted as Partial<TwoPaneSplitState>);
        if (fromVersion === 0) {
          // v0 stored each ratio as a bare number; reshape into WorktreeRatioEntry.
          const old = (persisted ?? {}) as { ratioByWorktreeId?: Record<string, unknown> };
          const reshaped: Record<string, WorktreeRatioEntry> = {};
          for (const [id, scalar] of Object.entries(old.ratioByWorktreeId ?? {})) {
            if (typeof scalar === "number" && Number.isFinite(scalar)) {
              reshaped[id] = { ratio: scalar, panels: [null, null] };
            }
          }
          return { config: migrated.config, ratioByWorktreeId: reshaped };
        }
        return migrated;
      },
    }
  )
);

registerPersistedStore({
  storeId: "twoPaneSplitStore",
  store: useTwoPaneSplitStore,
  persistedStateType:
    "{ config: TwoPaneSplitConfig; ratioByWorktreeId: Record<string, WorktreeRatioEntry> }",
});
