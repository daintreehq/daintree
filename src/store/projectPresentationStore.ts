import { create } from "zustand";
import type {
  PresentationFeatureId,
  PresentationLevel,
  PresentationLevels,
} from "@shared/config/presentationProfile";
import type {
  PresentationSuggestion,
  PresentationSuggestionAnswer,
  PresentationSuggestionAnswerRecord,
  ProjectPresentationSnapshot,
} from "@shared/types/ipc/projectPresentation";
import { logWarn } from "@/utils/logger";

/**
 * Renderer mirror of THIS view's project presentation profile (#13771). Main is
 * the source of truth; no call carries a project id, because main resolves the
 * project from the sender's own view registration. Renderer state is per
 * project view, so this module-level store is already scoped to one project.
 *
 * Holds only what the user set and the repository's suggestion. Resolving a
 * feature's level needs its git-aware default, which lives with the project
 * row — read it through `useResolvedPresentation` / `getResolvedPresentation`.
 */
export type PresentationFailedSave =
  | { kind: "level"; feature: PresentationFeatureId; level: PresentationLevel | null }
  | { kind: "answer"; hash: string; answer: PresentationSuggestionAnswer }
  | { kind: "toolbarEnabled"; enabled: boolean }
  | { kind: "pluginPromotion"; buttonId: string; promoted: boolean }
  | { kind: "resetToolbar" };

interface ProjectPresentationState {
  levels: PresentationLevels;
  suggestion: PresentationSuggestion | null;
  suggestionAnswer: PresentationSuggestionAnswerRecord | null;
  /** "Use this project's toolbar" as last set, or `null` for never (#13783). */
  useProjectToolbar: boolean | null;
  /** This project's own plugin buttons its profile promotes onto the toolbar. */
  promotedPluginButtons: string[];
  /** Main's write count for the profile held here; an older snapshot is dropped. */
  revision: number;
  /**
   * True once main has answered for this view's project. Until then the
   * profile is unknown rather than empty: surfaces draw their defaults, which
   * is what they drew before profiles existed, and the suggestion notice stays
   * down so a project that answered long ago is never asked again mid-boot.
   */
  loaded: boolean;
  /** Reading the profile failed and stopped retrying; `refresh` tries again. */
  loadFailed: boolean;
  /** The project main named for this profile; a push naming any other is refused. */
  projectId: string | null;
  /** The last write main could not record, so the surface that made it can say so and retry. */
  failedSave: PresentationFailedSave | null;
  /** The answer to the suggestion in flight, so the notice holds still while it lands. */
  answering: PresentationSuggestionAnswer | null;
  /**
   * The suggestion this view was told to ask about later. Not persisted: the
   * next time the project opens, an unanswered suggestion asks again.
   */
  deferredSuggestionHash: string | null;
  /** Each write resolves to whether main recorded it. */
  setLevel: (feature: PresentationFeatureId, level: PresentationLevel | null) => Promise<boolean>;
  answerSuggestion: (hash: string, answer: PresentationSuggestionAnswer) => Promise<void>;
  setToolbarEnabled: (enabled: boolean) => Promise<boolean>;
  setPluginButtonPromoted: (buttonId: string, promoted: boolean) => Promise<boolean>;
  resetToolbar: () => Promise<boolean>;
  /** Make the last failed write again. */
  retryFailedSave: () => void;
  dismissFailedSave: () => void;
  deferSuggestion: (hash: string) => void;
  /** Re-read the profile and the repository's suggestion. */
  refresh: () => void;
  /** Read again only if nothing has loaded and no read is in flight. */
  ensureLoaded: () => void;
  /** Idempotent: pulls once, then follows main's pushes. */
  init: () => void;
}

const NO_PROMOTED: string[] = [];

let initialized = false;
let unsubscribe: (() => void) | null = null;
// Only the latest pull may land; an older one finishing late is dropped.
let pullSeq = 0;
let pullInFlight = false;
// Snapshots taken so far. A pull that saw none land while it was in flight is
// the newest word there is, so it may move the revision down — the way back
// for a view whose store main reset under it.
let adoptions = 0;
// The revision held when the last write failed: only a later write recorded
// anywhere makes that failed attempt's Retry obsolete.
let failedAtRevision = 0;
// A relaunch restores the last project before main has registered its view,
// so the first read can come back unbound (or fail). A view that never loads
// keeps every surface at its default, so a read that comes back empty-handed
// tries again a few times before giving up and saying so.
const RETRY_DELAYS_MS = [250, 1000, 3000] as const;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

export const useProjectPresentationStore = create<ProjectPresentationState>((set, get) => {
  /**
   * Take a snapshot unless it is older than the one held, or it is
   * `authoritative`: a read nothing else overtook. `acknowledgesWrites` is for
   * a write's own reply and for pushes: either means a write was recorded, and
   * one recorded after an attempt failed makes that attempt's Retry obsolete —
   * retrying would overwrite it. A plain read records nothing and keeps the
   * Retry, unless it was an answer about a suggestion the file no longer makes,
   * which can never succeed.
   */
  const adopt = (
    snapshot: ProjectPresentationSnapshot,
    acknowledgesWrites: boolean,
    authoritative = false
  ): void => {
    const held = get();
    if (
      !authoritative &&
      held.projectId === snapshot.projectId &&
      snapshot.revision < held.revision
    ) {
      return;
    }
    ++adoptions;
    cancelRetry();
    retries = 0;
    const failed = held.failedSave;
    const failedSave =
      (acknowledgesWrites && snapshot.revision > failedAtRevision) ||
      (failed?.kind === "answer" && failed.hash !== snapshot.suggestion?.hash)
        ? null
        : failed;
    set({
      levels: snapshot.levels,
      suggestion: snapshot.suggestion,
      suggestionAnswer: snapshot.suggestionAnswer,
      // `??`: a snapshot from a main that predates #13783 carries neither.
      useProjectToolbar: snapshot.useProjectToolbar ?? null,
      promotedPluginButtons: snapshot.promotedPluginButtons ?? NO_PROMOTED,
      revision: snapshot.revision,
      projectId: snapshot.projectId,
      loaded: true,
      loadFailed: false,
      failedSave,
    });
  };

  const retryOrGiveUp = () => {
    const delay = RETRY_DELAYS_MS[retries];
    if (delay === undefined) {
      if (!get().loaded) set({ loadFailed: true });
      return;
    }
    retries++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      pull();
    }, delay);
  };

  const pull = () => {
    // A retry can outlive the page it was scheduled from (a test environment
    // torn down under it), so the global itself is checked.
    const api = typeof window === "undefined" ? undefined : window.electron?.projectPresentation;
    if (typeof api?.get !== "function") return;
    cancelRetry();
    const seq = ++pullSeq;
    const adoptionsAtStart = adoptions;
    pullInFlight = true;
    void api.get().then(
      (snapshot) => {
        if (seq !== pullSeq) return;
        pullInFlight = false;
        // `!= null`: a stubbed bridge answers `undefined`.
        if (snapshot != null) {
          adopt(snapshot, false, adoptions === adoptionsAtStart);
          return;
        }
        // Unbound: stay unloaded — surfaces keep their defaults and nobody is
        // asked a question they may already have answered — and read again.
        if (!get().loaded) retryOrGiveUp();
      },
      (error: unknown) => {
        if (seq !== pullSeq) return;
        pullInFlight = false;
        // Stay as loaded as we were: reading the failure as "nothing set" would
        // put back what the user quietened and ask the suggestion again.
        logWarn("[projectPresentationStore] Failed to read the presentation profile", { error });
        if (!get().loaded) retryOrGiveUp();
      }
    );
  };

  const write = async (
    failed: PresentationFailedSave,
    call: () => Promise<ProjectPresentationSnapshot>
  ): Promise<boolean> => {
    set({ failedSave: null });
    try {
      // Not applied ahead of the round trip: main pushes each write to every
      // view of the project before replying, so adopting only what it returns
      // keeps them all in step with the store.
      adopt(await call(), true);
      return true;
    } catch (error) {
      failedAtRevision = get().revision;
      set({ failedSave: failed });
      logWarn("[projectPresentationStore] Failed to save the presentation profile", {
        kind: failed.kind,
        error,
      });
      return false;
    }
  };

  const restartPull = () => {
    retries = 0;
    set({ loadFailed: false });
    pull();
  };

  return {
    levels: {},
    suggestion: null,
    suggestionAnswer: null,
    useProjectToolbar: null,
    promotedPluginButtons: NO_PROMOTED,
    revision: 0,
    loaded: false,
    loadFailed: false,
    projectId: null,
    failedSave: null,
    answering: null,
    deferredSuggestionHash: null,
    setLevel: async (feature, level) => {
      const api = window.electron?.projectPresentation;
      if (typeof api?.setLevel !== "function") return false;
      return write({ kind: "level", feature, level }, () => api.setLevel(feature, level));
    },
    answerSuggestion: async (hash, answer) => {
      const api = window.electron?.projectPresentation;
      if (typeof api?.answerSuggestion !== "function") return;
      set({ answering: answer });
      try {
        const saved = await write({ kind: "answer", hash, answer }, () =>
          api.answerSuggestion(hash, answer)
        );
        // Main refuses an answer about a suggestion the file no longer makes.
        // Read what it suggests now, so the question shown is the current one
        // rather than a Retry that can never succeed.
        if (!saved) pull();
      } finally {
        set({ answering: null });
      }
    },
    setToolbarEnabled: async (enabled) => {
      const api = window.electron?.projectPresentation;
      if (typeof api?.setToolbarEnabled !== "function") return false;
      return write({ kind: "toolbarEnabled", enabled }, () => api.setToolbarEnabled(enabled));
    },
    setPluginButtonPromoted: async (buttonId, promoted) => {
      const api = window.electron?.projectPresentation;
      if (typeof api?.setPluginButtonPromoted !== "function") return false;
      return write({ kind: "pluginPromotion", buttonId, promoted }, () =>
        api.setPluginButtonPromoted(buttonId, promoted)
      );
    },
    resetToolbar: async () => {
      const api = window.electron?.projectPresentation;
      if (typeof api?.resetToolbar !== "function") return false;
      return write({ kind: "resetToolbar" }, () => api.resetToolbar());
    },
    retryFailedSave: () => {
      const failed = get().failedSave;
      if (failed === null) return;
      const state = get();
      switch (failed.kind) {
        case "level":
          void state.setLevel(failed.feature, failed.level);
          return;
        case "answer":
          void state.answerSuggestion(failed.hash, failed.answer);
          return;
        case "toolbarEnabled":
          void state.setToolbarEnabled(failed.enabled);
          return;
        case "pluginPromotion":
          void state.setPluginButtonPromoted(failed.buttonId, failed.promoted);
          return;
        case "resetToolbar":
          void state.resetToolbar();
          return;
      }
    },
    dismissFailedSave: () => set({ failedSave: null }),
    deferSuggestion: (hash) => set({ deferredSuggestionHash: hash }),
    refresh: restartPull,
    ensureLoaded: () => {
      if (get().loaded || pullInFlight || retryTimer !== null) return;
      restartPull();
    },
    init: () => {
      if (initialized) return;
      // Tolerate a partially-stubbed bridge rather than forcing a mock into
      // every component test that renders the toolbar or the grid. Absent
      // bridge ⇒ defaults, which is what every surface drew before profiles.
      // Don't latch until the bridge is present, so this stays retryable.
      const api = window.electron?.projectPresentation;
      if (typeof api?.get !== "function" || typeof api.onChanged !== "function") return;

      unsubscribe = api.onChanged((snapshot) => {
        // Main addresses this to one project's views. Refuse one for a project
        // this view has already been told it is not, and accept it before the
        // first answer names one, since main sent it here on purpose.
        const owner = get().projectId;
        if (owner !== null && owner !== snapshot.projectId) return;
        adopt(snapshot, true);
      });
      pull();
      initialized = true;
    },
  };
});

/** Test-only: reset the module-level init guard, sequences, timers and state. */
export function _resetProjectPresentationStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pullSeq = 0;
  pullInFlight = false;
  adoptions = 0;
  failedAtRevision = 0;
  retries = 0;
  cancelRetry();
  useProjectPresentationStore.setState({
    levels: {},
    suggestion: null,
    suggestionAnswer: null,
    useProjectToolbar: null,
    promotedPluginButtons: NO_PROMOTED,
    revision: 0,
    loaded: false,
    loadFailed: false,
    projectId: null,
    failedSave: null,
    answering: null,
    deferredSuggestionHash: null,
  });
}
