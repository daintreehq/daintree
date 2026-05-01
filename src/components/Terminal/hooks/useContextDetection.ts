import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { type ViewUpdate } from "@codemirror/view";
import {
  getSlashCommandContext,
  getAtFileContext,
  getDiffContext,
  getTerminalContext,
  getSelectionContext,
  type AtFileContext,
  type SlashCommandContext,
  type AtDiffContext,
  type AtTerminalContext,
  type AtSelectionContext,
} from "../hybridInputParsing";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

interface LatestRefShape {
  isInHistoryMode: boolean;
  terminalId: string;
  projectId?: string;
  resetHistoryIndex: (terminalId: string, projectId?: string) => void;
}

interface UseContextDetectionParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  // Owner stores the next document value (typically into a ref + setState pair).
  // Returning true signals the value actually changed (i.e. differed from the last emit).
  applyDocChange: (next: string) => boolean;
  // Reads-and-clears an "external value being applied" flag. Returning true means the
  // change came from our own dispatch and should not be treated as user input.
  consumeExternalValueFlag: () => boolean;
  setAtContext: Dispatch<SetStateAction<AtFileContext | null>>;
  setSlashContext: Dispatch<SetStateAction<SlashCommandContext | null>>;
  setDiffContext: Dispatch<SetStateAction<AtDiffContext | null>>;
  setTerminalContext: Dispatch<SetStateAction<AtTerminalContext | null>>;
  setSelectionContext: Dispatch<SetStateAction<AtSelectionContext | null>>;
  setIsEditorFocused: Dispatch<SetStateAction<boolean>>;
}

export function useContextDetection({
  latestRef,
  applyDocChange,
  consumeExternalValueFlag,
  setAtContext,
  setSlashContext,
  setDiffContext,
  setTerminalContext,
  setSelectionContext,
  setIsEditorFocused,
}: UseContextDetectionParams) {
  // Route the listener body through a ref updated in an effect. The extension is
  // built once with a stable callback that reads handleUpdateRef at invocation
  // time. This keeps the React Compiler happy — the extension itself contains no
  // refs it can trace, and actual ref/closure access happens outside render.
  const trackersRef = useRef<{
    slash: SlashCommandContext | null;
    at: AtFileContext | null;
    diff: AtDiffContext | null;
    terminal: AtTerminalContext | null;
    selection: AtSelectionContext | null;
  }>({ slash: null, at: null, diff: null, terminal: null, selection: null });

  const handleUpdateRef = useRef<(update: ViewUpdate) => void>(() => {});

  useEffect(() => {
    handleUpdateRef.current = (update: ViewUpdate) => {
      const trackers = trackersRef.current;

      if (update.focusChanged) {
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

        const slash = getSlashCommandContext(text, caret);
        if (slash) {
          const prev = trackers.slash;
          if (
            !prev ||
            prev.start !== slash.start ||
            prev.tokenEnd !== slash.tokenEnd ||
            prev.query !== slash.query
          ) {
            trackers.slash = slash;
            setSlashContext(slash);
          }
          if (trackers.at !== null) {
            trackers.at = null;
            setAtContext(null);
          }
          if (trackers.diff !== null) {
            trackers.diff = null;
            setDiffContext(null);
          }
          if (trackers.terminal !== null) {
            trackers.terminal = null;
            setTerminalContext(null);
          }
          if (trackers.selection !== null) {
            trackers.selection = null;
            setSelectionContext(null);
          }
          return;
        }

        const termCtx = getTerminalContext(text, caret);
        if (termCtx) {
          const prev = trackers.terminal;
          if (!prev || prev.atStart !== termCtx.atStart || prev.tokenEnd !== termCtx.tokenEnd) {
            trackers.terminal = termCtx;
            setTerminalContext(termCtx);
          }
          if (trackers.at !== null) {
            trackers.at = null;
            setAtContext(null);
          }
          if (trackers.slash !== null) {
            trackers.slash = null;
            setSlashContext(null);
          }
          if (trackers.diff !== null) {
            trackers.diff = null;
            setDiffContext(null);
          }
          if (trackers.selection !== null) {
            trackers.selection = null;
            setSelectionContext(null);
          }
          return;
        }
        if (trackers.terminal !== null) {
          trackers.terminal = null;
          setTerminalContext(null);
        }

        const selCtx = getSelectionContext(text, caret);
        if (selCtx) {
          const prev = trackers.selection;
          if (!prev || prev.atStart !== selCtx.atStart || prev.tokenEnd !== selCtx.tokenEnd) {
            trackers.selection = selCtx;
            setSelectionContext(selCtx);
          }
          if (trackers.at !== null) {
            trackers.at = null;
            setAtContext(null);
          }
          if (trackers.slash !== null) {
            trackers.slash = null;
            setSlashContext(null);
          }
          if (trackers.diff !== null) {
            trackers.diff = null;
            setDiffContext(null);
          }
          return;
        }
        if (trackers.selection !== null) {
          trackers.selection = null;
          setSelectionContext(null);
        }

        const diffCtx = getDiffContext(text, caret);
        if (diffCtx) {
          const prevDiff = trackers.diff;
          if (
            !prevDiff ||
            prevDiff.atStart !== diffCtx.atStart ||
            prevDiff.tokenEnd !== diffCtx.tokenEnd ||
            prevDiff.diffType !== diffCtx.diffType
          ) {
            trackers.diff = diffCtx;
            setDiffContext(diffCtx);
          }
          if (trackers.at !== null) {
            trackers.at = null;
            setAtContext(null);
          }
          if (trackers.slash !== null) {
            trackers.slash = null;
            setSlashContext(null);
          }
          return;
        }

        if (trackers.diff !== null) {
          trackers.diff = null;
          setDiffContext(null);
        }

        const atCtx = getAtFileContext(text, caret);
        const prevAt = trackers.at;
        if (
          (atCtx &&
            (!prevAt ||
              prevAt.atStart !== atCtx.atStart ||
              prevAt.tokenEnd !== atCtx.tokenEnd ||
              prevAt.queryRaw !== atCtx.queryRaw)) ||
          (!atCtx && prevAt)
        ) {
          trackers.at = atCtx;
          setAtContext(atCtx);
        }
        if (trackers.slash !== null) {
          trackers.slash = null;
          setSlashContext(null);
        }
      }
    };
  });

  return { handleUpdateRef };
}
