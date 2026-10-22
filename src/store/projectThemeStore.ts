import { create } from "zustand";
import type { ProjectThemeChoice, ProjectThemeSuggestionAnswer } from "@shared/theme";
import type { ProjectThemeSnapshot } from "@shared/types/ipc/projectTheme";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logWarn } from "@/utils/logger";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

/**
 * Renderer mirror of THIS view's project theme (#13833) for the settings rows
 * and the suggestion notice. Painting does not wait on it: the app theme store
 * seeds the choice from the boot config and follows main's pushes itself.
 *
 * No call carries a project id; main resolves it from the sender's view.
 */
export type ProjectThemeFailedSave =
  | { kind: "theme"; schemeId: string | null }
  | { kind: "answer"; schemeId: string; answer: ProjectThemeSuggestionAnswer }
  | { kind: "resetSuggestion" };

interface ProjectThemeState {
  projectId: string | null;
  choice: ProjectThemeChoice | null;
  /** What `.daintree/project.json` suggests, as of the last read. */
  suggestedSchemeId: string | null;
  /** True once main has answered for this view's project; until then nothing is asked. */
  loaded: boolean;
  /** The suggestion answer in flight, so the notice holds still while it lands. */
  answering: ProjectThemeSuggestionAnswer | null;
  /** The suggestion this view was told to ask about later. Not persisted. */
  deferredSuggestionId: string | null;
  failedSave: { save: ProjectThemeFailedSave; message: string } | null;
  setTheme: (schemeId: string | null) => Promise<boolean>;
  answerSuggestion: (schemeId: string, answer: ProjectThemeSuggestionAnswer) => Promise<boolean>;
  resetSuggestion: () => Promise<boolean>;
  retryFailedSave: () => void;
  dismissFailedSave: () => void;
  deferSuggestion: (schemeId: string) => void;
  /** Idempotent: pulls once, then follows main's pushes. */
  init: () => void;
}

let initialized = false;
// Only the latest pull may land; an older one finishing late is dropped.
let pullSeq = 0;
// A relaunch restores the last project before main has registered its view,
// so the first read can come back unbound; try again a few times.
const RETRY_DELAYS_MS = [250, 1000, 3000] as const;

export const useProjectThemeStore = create<ProjectThemeState>((set, get) => {
  const adopt = (snapshot: ProjectThemeSnapshot): void => {
    set({
      projectId: snapshot.projectId,
      choice: snapshot.choice,
      suggestedSchemeId: snapshot.suggestedSchemeId,
      loaded: true,
    });
  };

  const write = async (
    save: ProjectThemeFailedSave,
    run: () => Promise<ProjectThemeSnapshot>
  ): Promise<boolean> => {
    try {
      // A pull in flight read before this write; let it go.
      ++pullSeq;
      adopt(await run());
      set({ failedSave: null });
      return true;
    } catch (error) {
      logWarn("[ProjectTheme] Failed to save the project theme", { error });
      set({
        failedSave: { save, message: formatErrorMessage(error, "Couldn't save the theme") },
      });
      return false;
    }
  };

  const pull = (attempt: number): void => {
    const bridge = window.electron?.projectTheme;
    if (!bridge) return;
    const seq = ++pullSeq;
    void bridge
      .get()
      .then((snapshot) => {
        if (seq !== pullSeq) return;
        if (snapshot) {
          adopt(snapshot);
          return;
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) setTimeout(() => pull(attempt + 1), delay);
      })
      .catch((error: unknown) => {
        logWarn("[ProjectTheme] Failed to read the project theme", { error });
      });
  };

  return {
    projectId: null,
    choice: null,
    suggestedSchemeId: null,
    loaded: false,
    answering: null,
    deferredSuggestionId: null,
    failedSave: null,

    setTheme: (schemeId) =>
      write({ kind: "theme", schemeId }, () => window.electron.projectTheme.setTheme(schemeId)),

    answerSuggestion: async (schemeId, answer) => {
      if (get().answering !== null) return false;
      set({ answering: answer });
      try {
        return await write({ kind: "answer", schemeId, answer }, () =>
          window.electron.projectTheme.answerSuggestion(schemeId, answer)
        );
      } finally {
        set({ answering: null });
      }
    },

    resetSuggestion: () =>
      write({ kind: "resetSuggestion" }, () => window.electron.projectTheme.resetSuggestion()),

    retryFailedSave: () => {
      const failed = get().failedSave?.save;
      if (!failed) return;
      if (failed.kind === "theme") void get().setTheme(failed.schemeId);
      else if (failed.kind === "answer") void get().answerSuggestion(failed.schemeId, failed.answer);
      else void get().resetSuggestion();
    },

    dismissFailedSave: () => set({ failedSave: null }),

    deferSuggestion: (schemeId) => set({ deferredSuggestionId: schemeId }),

    init: () => {
      if (initialized) return;
      const bridge = window.electron?.projectTheme;
      if (!bridge?.onChanged) return;
      initialized = true;
      bridge.onChanged(({ projectId, choice }) => {
        if (projectId !== (get().projectId ?? getViewWorkspaceId())) return;
        set({ choice });
      });
      pull(0);
    },
  };
});

/** Test-only: forget the subscription and pull state between cases. */
export function resetProjectThemeStoreForTests(): void {
  initialized = false;
  pullSeq = 0;
  useProjectThemeStore.setState({
    projectId: null,
    choice: null,
    suggestedSchemeId: null,
    loaded: false,
    answering: null,
    deferredSuggestionId: null,
    failedSave: null,
  });
}
