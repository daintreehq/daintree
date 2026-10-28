import { useEffect } from "react";
import type { EditorState } from "@codemirror/state";
import {
  applyForgeReferences,
  eligibleIssueReferences,
  onForgeReferenceRescan,
  type ForgeReferenceMap,
} from "../inputEditorExtensions";
import {
  knownForgeReferences,
  lookUpForgeReferences,
  onForgeReferencesInvalidated,
} from "@/services/forgeReferenceLookup";

/** How long a draft sits still before the numbers in it are looked up. */
export const REFERENCE_LOOKUP_SETTLE_MS = 500;

/** Distinct numbers a draft has looked up; one pasted log full of them marks its first. */
export const MAX_DRAFT_REFERENCES = 200;

const NO_REFERENCES: ForgeReferenceMap = new Map();

function draftNumbers(state: EditorState): number[] {
  const numbers = new Set<number>();
  for (const token of eligibleIssueReferences(state)) {
    numbers.add(token.number);
    if (numbers.size >= MAX_DRAFT_REFERENCES) break;
  }
  return [...numbers];
}

interface UseForgeReferenceMarksParams {
  editorViewRef: React.RefObject<import("@codemirror/view").EditorView | null>;
  /** The view's owner, which builds a new view when it changes. */
  terminalId: string;
  /** Where the repository is resolved from; `null` looks nothing up and marks nothing. */
  cwd: string | null;
  /** Keep what's known but ask about nothing new, as a disabled composer does. */
  paused: boolean;
  /** The draft. Read from the view; this only says it changed. */
  value: string;
}

/**
 * Mark the `#N`s in the draft that name an issue or pull request (#14849).
 * What's already known marks at once; numbers with no fresh answer are looked
 * up once the draft has sat still, so typing a number digit by digit asks
 * about the number, not each prefix of it.
 */
export function useForgeReferenceMarks({
  editorViewRef,
  terminalId,
  cwd,
  paused,
  value,
}: UseForgeReferenceMarksParams): void {
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    if (!cwd) {
      applyForgeReferences(view, NO_REFERENCES);
      return;
    }

    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (): number[] => {
      if (!current || editorViewRef.current !== view) return [];
      const numbers = draftNumbers(view.state);
      applyForgeReferences(view, knownForgeReferences(cwd, numbers));
      return numbers;
    };
    const refresh = () => {
      const numbers = apply();
      clearTimeout(timer);
      if (paused || numbers.length === 0) return;
      timer = setTimeout(() => {
        void lookUpForgeReferences(cwd, numbers).then(apply);
      }, REFERENCE_LOOKUP_SETTLE_MS);
    };

    refresh();
    const stopRescan = onForgeReferenceRescan(view, refresh);
    const stopInvalidated = onForgeReferencesInvalidated(refresh);
    return () => {
      current = false;
      clearTimeout(timer);
      stopRescan();
      stopInvalidated();
    };
  }, [editorViewRef, terminalId, cwd, paused, value]);
}
