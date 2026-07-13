import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { type ViewUpdate } from "@codemirror/view";
import type { CompletionTrigger } from "@shared/types";
import { getActiveCompletionContext, type ActiveCompletionContext } from "../hybridInputParsing";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

interface LatestRefShape {
  isInHistoryMode: boolean;
  terminalId: string;
  projectId?: string;
  resetHistoryIndex: (terminalId: string, projectId?: string) => void;
}

interface UseContextDetectionParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  /** Trigger chars that open a menu — derived from the agent's completionSources. */
  activeTriggers: ReadonlySet<CompletionTrigger>;
  // Owner stores the next document value (typically into a ref + setState pair).
  // Returning true signals the value actually changed (i.e. differed from the last emit).
  applyDocChange: (next: string) => boolean;
  // Reads-and-clears an "external value being applied" flag. Returning true means the
  // change came from our own dispatch and should not be treated as user input.
  consumeExternalValueFlag: () => boolean;
  setActiveCompletionContext: Dispatch<SetStateAction<ActiveCompletionContext | null>>;
  setIsEditorFocused?: Dispatch<SetStateAction<boolean>>;
  /**
   * Fires once per update in which the user actually *typed* — `input.type`
   * only, so paste, deletion, history navigation and programmatic writes are
   * all excluded. Backs the type-anywhere rescue's "last agent typed to"
   * notion (#11134), which must be typing, not focus.
   */
  onUserType?: () => void;
}

function contextsEqual(
  a: ActiveCompletionContext | null,
  b: ActiveCompletionContext | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.triggerChar === b.triggerChar &&
    a.start === b.start &&
    a.tokenEnd === b.tokenEnd &&
    a.query === b.query
  );
}

export function useContextDetection({
  latestRef,
  activeTriggers,
  applyDocChange,
  consumeExternalValueFlag,
  setActiveCompletionContext,
  setIsEditorFocused,
  onUserType,
}: UseContextDetectionParams) {
  // Route the listener body through a ref updated in an effect. The extension is
  // built once with a stable callback that reads handleUpdateRef at invocation
  // time. This keeps the React Compiler happy — the extension itself contains no
  // refs it can trace, and actual ref/closure access happens outside render.
  const trackerRef = useRef<ActiveCompletionContext | null>(null);
  const activeTriggersRef = useRef(activeTriggers);
  useEffect(() => {
    activeTriggersRef.current = activeTriggers;
  }, [activeTriggers]);

  const handleUpdateRef = useRef<(update: ViewUpdate) => void>(() => {});

  useEffect(() => {
    handleUpdateRef.current = (update: ViewUpdate) => {
      if (update.focusChanged && setIsEditorFocused) {
        setIsEditorFocused(update.view.hasFocus);
      }

      if (update.docChanged) {
        const nextValue = update.state.doc.toString();
        applyDocChange(nextValue);

        if (!consumeExternalValueFlag()) {
          const latest = latestRef.current;
          if (latest?.isInHistoryMode) {
            latest.resetHistoryIndex(latest.terminalId, latest.projectId);
          }

          if (update.transactions.some((tr) => tr.isUserEvent("input.type"))) {
            onUserType?.();
          }

          const isUserChange = update.transactions.some(
            (tr) => tr.isUserEvent("input") || tr.isUserEvent("delete")
          );
          if (isUserChange) {
            const terminalId = latest?.terminalId;
            if (terminalId) {
              const resultingValue = update.state.doc.toString();
              if (resultingValue.trim().length === 0) {
                terminalInstanceService.clearDirectingState(terminalId);
              } else {
                terminalInstanceService.notifyUserInput(terminalId);
              }
            }
          }
        }
      }

      if (update.docChanged || update.selectionSet) {
        const caret = update.state.selection.main.head;
        const text = update.state.doc.toString();
        const next = getActiveCompletionContext(text, caret, activeTriggersRef.current);
        if (!contextsEqual(trackerRef.current, next)) {
          trackerRef.current = next;
          setActiveCompletionContext(next);
        }
      }
    };
  });

  return { handleUpdateRef };
}
