import { create } from "zustand";
import { logError } from "@/utils/logger";
import type { PromptTemplateContribution } from "@shared/types/plugin";
import type { UserPromptTemplateProblem } from "@shared/types/ipc/userPromptTemplates";

interface UserPromptTemplateState {
  /** Null until the folder has been read once. */
  directory: string | null;
  templates: readonly PromptTemplateContribution[];
  problems: readonly UserPromptTemplateProblem[];
  /** Idempotent: the first read, so a composer has its rows before its first `/`. */
  init: () => void;
  /** Reads the folder again. Called where the answer is about to be looked at. */
  refresh: () => void;
}

// A slow older read must not overwrite a newer one. Judged against what landed,
// so a failed newer read can't discard a good older one.
let pullSeq = 0;
let committedSeq = 0;
let initialized = false;

/**
 * The person's own prompt templates (#16398), as main last read them from their
 * folder. Not persisted. Tolerates a stubbed bridge, like `pluginRuntimeStore`,
 * since every composer test would otherwise need it.
 */
export const useUserPromptTemplateStore = create<UserPromptTemplateState>((set, get) => ({
  directory: null,
  templates: [],
  problems: [],
  init: () => {
    if (initialized) return;
    initialized = true;
    get().refresh();
  },
  refresh: () => {
    const bridge = window.electron?.userPromptTemplates;
    if (typeof bridge?.list !== "function") return;
    const seq = ++pullSeq;
    void bridge.list().then(
      (snapshot) => {
        if (seq <= committedSeq) return;
        committedSeq = seq;
        const current = get();
        // An unchanged slice keeps its identity: this runs on every `/`, and a
        // new template array would reset the menu's highlight.
        const next: Partial<UserPromptTemplateState> = {};
        if (snapshot.directory !== current.directory) next.directory = snapshot.directory;
        if (JSON.stringify(snapshot.templates) !== JSON.stringify(current.templates)) {
          next.templates = snapshot.templates;
        }
        if (JSON.stringify(snapshot.problems) !== JSON.stringify(current.problems)) {
          next.problems = snapshot.problems;
        }
        if (Object.keys(next).length > 0) set(next);
      },
      (err) => {
        logError("Failed to read the prompt templates folder", err);
      }
    );
  },
}));

/** Test-only: forget what was read and any read still in flight. */
export function _resetUserPromptTemplateStoreForTest(): void {
  initialized = false;
  // Raised rather than zeroed, so a read still in flight stays older than this.
  committedSeq = pullSeq;
  useUserPromptTemplateStore.setState({ directory: null, templates: [], problems: [] });
}
