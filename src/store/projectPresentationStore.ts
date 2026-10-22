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
  | { kind: "answer"; hash: string; answer: PresentationSuggestionAnswer };

interface ProjectPresentationState {
  levels: PresentationLevels;
  suggestion: PresentationSuggestion | null;
  suggestionAnswer: PresentationSuggestionAnswerRecord | null;
  /**
   * True once main has answered for this view's project. Until then the
   * profile is unknown rather than empty: surfaces draw their defaults, which
   * is what they drew before profiles existed, and the suggestion notice stays
   * down so a project that answered long ago is never asked again mid-boot.
   */
  loaded: boolean;
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
  setLevel: (feature: PresentationFeatureId, level: PresentationLevel | null) => Promise<void>;
  answerSuggestion: (hash: string, answer: PresentationSuggestionAnswer) => Promise<void>;
  dismissFailedSave: () => void;
  deferSuggestion: (hash: string) => void;
  /** Re-read the profile and the repository's suggestion. */
  refresh: () => void;
  /** Idempotent: pulls once, then follows main's pushes. */
  init: () => void;
}

let initialized = false;
let unsubscribe: (() => void) | null = null;
// A slow pull must never overwrite a newer one, nor roll back a snapshot
// adopted from a save or a push while it was in flight.
let pullSeq = 0;
let adoptSeq = 0;
// A relaunch restores the last project before main has registered its view,
// so the first read can come back unbound. Nothing else would ask again until
// the user changes something, so an unbound read retries a few times.
const UNBOUND_RETRY_DELAYS_MS = [250, 1000, 3000] as const;
let unboundRetries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export const useProjectPresentationStore = create<ProjectPresentationState>((set, get) => {
  const adopt = (snapshot: ProjectPresentationSnapshot) => {
    ++adoptSeq;
    set({
      levels: snapshot.levels,
      suggestion: snapshot.suggestion,
      suggestionAnswer: snapshot.suggestionAnswer,
      projectId: snapshot.projectId,
      loaded: true,
      // A recorded write — this view's or another's — is newer than any attempt
      // that failed before it, and retrying that attempt would overwrite it.
      failedSave: null,
    });
  };

  const pull = () => {
    // A retry can outlive the page it was scheduled from (a test environment
    // torn down under it), so the global itself is checked.
    const api = typeof window === "undefined" ? undefined : window.electron?.projectPresentation;
    if (typeof api?.get !== "function") return;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const seq = ++pullSeq;
    const adoptedAtStart = adoptSeq;
    void api.get().then(
      (snapshot) => {
        if (seq !== pullSeq || adoptSeq !== adoptedAtStart) return;
        // `!= null`: a stubbed bridge answers `undefined`.
        if (snapshot != null) {
          adopt(snapshot);
          return;
        }
        // Unbound: stay unloaded — surfaces keep their defaults and nobody is
        // asked a question they may already have answered — and read again.
        const delay = UNBOUND_RETRY_DELAYS_MS[unboundRetries];
        if (delay !== undefined && !get().loaded) {
          unboundRetries++;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            pull();
          }, delay);
        }
      },
      (error: unknown) => {
        // Stay as loaded as we were: reading the failure as "nothing set" would
        // put back what the user quietened and ask the suggestion again.
        logWarn("[projectPresentationStore] Failed to read the presentation profile", { error });
      }
    );
  };

  const write = async (
    failed: PresentationFailedSave,
    call: () => Promise<ProjectPresentationSnapshot>
  ) => {
    set({ failedSave: null });
    try {
      // Not applied ahead of the round trip: main pushes each write to every
      // view of the project before replying, so adopting only what it returns
      // keeps them all in step with the store.
      adopt(await call());
    } catch (error) {
      set({ failedSave: failed });
      logWarn("[projectPresentationStore] Failed to save the presentation profile", {
        kind: failed.kind,
        error,
      });
    }
  };

  return {
    levels: {},
    suggestion: null,
    suggestionAnswer: null,
    loaded: false,
    projectId: null,
    failedSave: null,
    answering: null,
    deferredSuggestionHash: null,
    setLevel: async (feature, level) => {
      const api = window.electron?.projectPresentation;
      if (typeof api?.setLevel !== "function") return;
      await write({ kind: "level", feature, level }, () => api.setLevel(feature, level));
    },
    answerSuggestion: async (hash, answer) => {
      const api = window.electron?.projectPresentation;
      if (typeof api?.answerSuggestion !== "function") return;
      set({ answering: answer });
      try {
        await write({ kind: "answer", hash, answer }, () => api.answerSuggestion(hash, answer));
      } finally {
        set({ answering: null });
      }
    },
    dismissFailedSave: () => set({ failedSave: null }),
    deferSuggestion: (hash) => set({ deferredSuggestionHash: hash }),
    refresh: pull,
    init: () => {
      if (initialized) return;
      // Tolerate a partially-stubbed bridge rather than forcing a mock into
      // every component test that renders the toolbar or the grid. Absent
      // bridge ⇒ defaults, which is what every surface drew before profiles.
      // Don't latch until the bridge is present, so this stays retryable.
      const api = window.electron?.projectPresentation;
      if (typeof api?.get !== "function" || typeof api.onChanged !== "function") return;

      pull();
      unsubscribe = api.onChanged((snapshot) => {
        // Main addresses this to one project's views. Refuse one for a project
        // this view has already been told it is not, and accept it before the
        // first answer names one, since main sent it here on purpose.
        const owner = get().projectId;
        if (owner !== null && owner !== snapshot.projectId) return;
        adopt(snapshot);
      });
      initialized = true;
    },
  };
});

/** Test-only: reset the module-level init guard, sequences, and state. */
export function _resetProjectPresentationStoreForTest(): void {
  unsubscribe?.();
  unsubscribe = null;
  initialized = false;
  pullSeq = 0;
  adoptSeq = 0;
  unboundRetries = 0;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  useProjectPresentationStore.setState({
    levels: {},
    suggestion: null,
    suggestionAnswer: null,
    loaded: false,
    projectId: null,
    failedSave: null,
    answering: null,
    deferredSuggestionHash: null,
  });
}
