import { useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { EditorView } from "@codemirror/view";
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
import { imageChipField, fileDropChipField } from "../inputEditorExtensions";
import { normalizeChips, type TrayItem } from "../attachmentTrayUtils";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

interface LatestRefShape {
  isInHistoryMode: boolean;
  terminalId: string;
  projectId?: string;
  resetHistoryIndex: (terminalId: string, projectId?: string) => void;
}

interface UseContextDetectionParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  lastEmittedValueRef: React.MutableRefObject<string>;
  isApplyingExternalValueRef: React.MutableRefObject<boolean>;
  setValue: Dispatch<SetStateAction<string>>;
  setAtContext: Dispatch<SetStateAction<AtFileContext | null>>;
  setSlashContext: Dispatch<SetStateAction<SlashCommandContext | null>>;
  setDiffContext: Dispatch<SetStateAction<AtDiffContext | null>>;
  setTerminalContext: Dispatch<SetStateAction<AtTerminalContext | null>>;
  setSelectionContext: Dispatch<SetStateAction<AtSelectionContext | null>>;
  setAttachments: Dispatch<SetStateAction<TrayItem[]>>;
}

export function useContextDetection({
  latestRef,
  lastEmittedValueRef,
  isApplyingExternalValueRef,
  setValue,
  setAtContext,
  setSlashContext,
  setDiffContext,
  setTerminalContext,
  setSelectionContext,
  setAttachments,
}: UseContextDetectionParams) {
  const lastSlashContextRef = useRef<SlashCommandContext | null>(null);
  const lastAtContextRef = useRef<AtFileContext | null>(null);
  const lastDiffContextRef = useRef<AtDiffContext | null>(null);
  const lastTerminalContextRef = useRef<AtTerminalContext | null>(null);
  const lastSelectionContextRef = useRef<AtSelectionContext | null>(null);

  const editorUpdateListener = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const nextValue = update.state.doc.toString();
          if (nextValue !== lastEmittedValueRef.current) {
            lastEmittedValueRef.current = nextValue;
            setValue(nextValue);
          }

          if (isApplyingExternalValueRef.current) {
            isApplyingExternalValueRef.current = false;
          } else {
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
            const prev = lastSlashContextRef.current;
            if (
              !prev ||
              prev.start !== slash.start ||
              prev.tokenEnd !== slash.tokenEnd ||
              prev.query !== slash.query
            ) {
              lastSlashContextRef.current = slash;
              setSlashContext(slash);
            }
            if (lastAtContextRef.current !== null) {
              lastAtContextRef.current = null;
              setAtContext(null);
            }
            if (lastDiffContextRef.current !== null) {
              lastDiffContextRef.current = null;
              setDiffContext(null);
            }
            if (lastTerminalContextRef.current !== null) {
              lastTerminalContextRef.current = null;
              setTerminalContext(null);
            }
            if (lastSelectionContextRef.current !== null) {
              lastSelectionContextRef.current = null;
              setSelectionContext(null);
            }
            return;
          }

          const termCtx = getTerminalContext(text, caret);
          if (termCtx) {
            const prev = lastTerminalContextRef.current;
            if (!prev || prev.atStart !== termCtx.atStart || prev.tokenEnd !== termCtx.tokenEnd) {
              lastTerminalContextRef.current = termCtx;
              setTerminalContext(termCtx);
            }
            if (lastAtContextRef.current !== null) {
              lastAtContextRef.current = null;
              setAtContext(null);
            }
            if (lastSlashContextRef.current !== null) {
              lastSlashContextRef.current = null;
              setSlashContext(null);
            }
            if (lastDiffContextRef.current !== null) {
              lastDiffContextRef.current = null;
              setDiffContext(null);
            }
            if (lastSelectionContextRef.current !== null) {
              lastSelectionContextRef.current = null;
              setSelectionContext(null);
            }
            return;
          }
          if (lastTerminalContextRef.current !== null) {
            lastTerminalContextRef.current = null;
            setTerminalContext(null);
          }

          const selCtx = getSelectionContext(text, caret);
          if (selCtx) {
            const prev = lastSelectionContextRef.current;
            if (!prev || prev.atStart !== selCtx.atStart || prev.tokenEnd !== selCtx.tokenEnd) {
              lastSelectionContextRef.current = selCtx;
              setSelectionContext(selCtx);
            }
            if (lastAtContextRef.current !== null) {
              lastAtContextRef.current = null;
              setAtContext(null);
            }
            if (lastSlashContextRef.current !== null) {
              lastSlashContextRef.current = null;
              setSlashContext(null);
            }
            if (lastDiffContextRef.current !== null) {
              lastDiffContextRef.current = null;
              setDiffContext(null);
            }
            return;
          }
          if (lastSelectionContextRef.current !== null) {
            lastSelectionContextRef.current = null;
            setSelectionContext(null);
          }

          const diffCtx = getDiffContext(text, caret);
          if (diffCtx) {
            const prevDiff = lastDiffContextRef.current;
            if (
              !prevDiff ||
              prevDiff.atStart !== diffCtx.atStart ||
              prevDiff.tokenEnd !== diffCtx.tokenEnd ||
              prevDiff.diffType !== diffCtx.diffType
            ) {
              lastDiffContextRef.current = diffCtx;
              setDiffContext(diffCtx);
            }
            if (lastAtContextRef.current !== null) {
              lastAtContextRef.current = null;
              setAtContext(null);
            }
            if (lastSlashContextRef.current !== null) {
              lastSlashContextRef.current = null;
              setSlashContext(null);
            }
            return;
          }

          if (lastDiffContextRef.current !== null) {
            lastDiffContextRef.current = null;
            setDiffContext(null);
          }

          const atCtx = getAtFileContext(text, caret);
          const prevAt = lastAtContextRef.current;
          if (
            (atCtx &&
              (!prevAt ||
                prevAt.atStart !== atCtx.atStart ||
                prevAt.tokenEnd !== atCtx.tokenEnd ||
                prevAt.queryRaw !== atCtx.queryRaw)) ||
            (!atCtx && prevAt)
          ) {
            lastAtContextRef.current = atCtx;
            setAtContext(atCtx);
          }
          if (lastSlashContextRef.current !== null) {
            lastSlashContextRef.current = null;
            setSlashContext(null);
          }
        }

        const imgs = update.state.field(imageChipField, false) ?? [];
        const files = update.state.field(fileDropChipField, false) ?? [];
        const next = normalizeChips(imgs, files);
        setAttachments((prev) => {
          if (prev.length === 0 && next.length === 0) return prev;
          if (
            prev.length === next.length &&
            prev.every(
              (p, i) => p.id === next[i].id && p.from === next[i].from && p.to === next[i].to
            )
          )
            return prev;
          return next;
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return { editorUpdateListener };
}
