import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { type ViewUpdate } from "@codemirror/view";
import {
  getActiveCompletionContext,
  type ActiveCompletionContext,
  type ComposerTrigger,
} from "../hybridInputParsing";
import {
  chipPendingDeleteField,
  completionBoundaryAt,
  isOwnedByAttachmentChip,
} from "../inputEditorExtensions";
import { with as withTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

interface LatestRefShape {
  isInHistoryMode: boolean;
  terminalId: string;
  projectId?: string;
  resetHistoryIndex: (terminalId: string, projectId?: string) => void;
}

interface UseContextDetectionParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  /** Trigger chars that open a menu — derived from the agent's completionSources. */
  activeTriggers: ReadonlySet<ComposerTrigger>;
  // Owner stores the next document value (typically into a ref + setState pair).
  // Returning true signals the value actually changed (i.e. differed from the last emit).
  applyDocChange: (next: string, update: ViewUpdate) => boolean;
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

  // An unmounted composer can no longer send or clear its draft, so it must
  // not keep holding directing; the draft itself stays in the store.
  const heldTerminalIdRef = useRef<string | null>(null);
  useEffect(() => {
    const held = heldTerminalIdRef;
    return () => {
      const heldId = held.current;
      if (heldId) withTerminalService((service) => service.releaseComposerDraft(heldId), heldId);
    };
  }, []);

  useEffect(() => {
    handleUpdateRef.current = (update: ViewUpdate) => {
      if (update.focusChanged && setIsEditorFocused) {
        setIsEditorFocused(update.view.hasFocus);
      }

      if (update.docChanged) {
        const nextValue = update.state.doc.toString();
        applyDocChange(nextValue, update);

        const isExternal = consumeExternalValueFlag();
        const latest = latestRef.current;
        let isUserChange = false;
        if (!isExternal) {
          if (latest?.isInHistoryMode) {
            latest.resetHistoryIndex(latest.terminalId, latest.projectId);
          }

          if (update.transactions.some((tr) => tr.isUserEvent("input.type"))) {
            onUserType?.();
          }

          isUserChange = update.transactions.some(
            (tr) =>
              tr.isUserEvent("input") ||
              tr.isUserEvent("delete") ||
              tr.isUserEvent("undo") ||
              tr.isUserEvent("redo")
          );
        }

        const terminalId = latest?.terminalId;
        if (terminalId) {
          if (nextValue.trim().length === 0) {
            // A user clearing the draft ends directing outright; any other
            // empty (the reset after a send, a stash, an unannotated chip
            // removal) only ends the draft hold.
            if (isUserChange) {
              withTerminalService((service) => service.clearDirectingState(terminalId), terminalId);
            } else {
              withTerminalService(
                (service) => service.releaseComposerDraft(terminalId),
                terminalId
              );
            }
            heldTerminalIdRef.current = null;
          } else if (isUserChange) {
            const previous = heldTerminalIdRef.current;
            if (previous && previous !== terminalId) {
              withTerminalService((service) => service.releaseComposerDraft(previous), previous);
            }
            heldTerminalIdRef.current = terminalId;
            withTerminalService((service) => service.notifyComposerDraft(terminalId), terminalId);
          }
        }
      }

      if (update.docChanged || update.selectionSet) {
        // A completion token is whitespace-delimited, so it never spans a line
        // break: scanning the caret's line gives the same answer as the whole
        // doc without flattening a large draft on every caret move.
        const caret = update.state.selection.main.head;
        const line = update.state.doc.lineAt(caret);
        // A chip staged for deletion is its own moment: Backspace has just
        // selected it, and a menu offering to complete it says the opposite.
        const typedAgainst = completionBoundaryAt(update.state, caret);
        const local = update.state.field(chipPendingDeleteField, false)
          ? null
          : getActiveCompletionContext(
              line.text,
              caret - line.from,
              activeTriggersRef.current,
              typedAgainst === undefined ? undefined : typedAgainst - line.from
            );
        const start = local ? local.start + line.from : 0;
        const tokenEnd = local ? local.tokenEnd + line.from : 0;
        // A dropped file's `@path` spells a file query too, but it is an
        // attachment, not something being typed.
        const next =
          local && !isOwnedByAttachmentChip(update.state, start, tokenEnd)
            ? { ...local, start, tokenEnd }
            : null;
        if (!contextsEqual(trackerRef.current, next)) {
          trackerRef.current = next;
          setActiveCompletionContext(next);
        }
      }
    };
  });

  return { handleUpdateRef };
}
