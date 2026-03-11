import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorView, drawSelection } from "@codemirror/view";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import type { LegacyAgentType } from "@shared/types";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";
import { buildTerminalSendPayload } from "@/lib/terminalInput";
import { useFileAutocomplete } from "@/hooks/useFileAutocomplete";
import { useSlashCommandAutocomplete } from "@/hooks/useSlashCommandAutocomplete";
import { useSlashCommandList } from "@/hooks/useSlashCommandList";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { AutocompleteMenu, type AutocompleteItem } from "./AutocompleteMenu";
import {
  formatAtFileToken,
  getAtFileContext,
  getSlashCommandContext,
  type AtFileContext,
  type SlashCommandContext,
} from "./hybridInputParsing";
import { CommandPickerHost } from "@/components/Commands";
import { useCommandStore } from "@/store/commandStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalStore, useVoiceRecordingStore, useWorktreeDataStore } from "@/store";
import { VoiceInputButton } from "./VoiceInputButton";
import type { CommandContext, CommandResult } from "@shared/types/commands";
import { isEnterLikeLineBreakInputEvent } from "./hybridInputEvents";
import {
  inputTheme,
  createContentAttributes,
  createPlaceholder,
  createSlashChipField,
  createSlashTooltip,
  createFileChipField,
  createFileChipTooltip,
  createCustomKeymap,
  createAutoSize,
  createImagePasteHandler,
  imageChipField,
  addImageChip,
  createImageChipTooltip,
  fileDropChipField,
  addFileDropChip,
  createFileDropChipTooltip,
  createFilePasteHandler,
  interimMarkField,
  setInterimRange,
  aiCorrectedField,
  setAICorrectedRanges,
} from "./inputEditorExtensions";

export interface HybridInputBarHandle {
  focus: () => void;
  focusWithCursorAtEnd: () => void;
}

export interface HybridInputBarProps {
  terminalId: string;
  onSend: (payload: { data: string; trackerData: string; text: string }) => void;
  onSendKey?: (key: string) => void;
  onActivate?: () => void;
  cwd: string;
  agentId?: LegacyAgentType;
  agentHasLifecycleEvent?: boolean;
  restartKey?: number;
  disabled?: boolean;
  className?: string;
}

const AI_CORRECTION_MATCH_RADIUS = 32;

function resolveAICorrectionRange(
  doc: string,
  segmentStart: number,
  text: string
): { from: number; to: number } | null {
  if (!text) return null;

  const exactEnd = segmentStart + text.length;
  if (segmentStart >= 0 && exactEnd <= doc.length && doc.slice(segmentStart, exactEnd) === text) {
    return { from: segmentStart, to: exactEnd };
  }

  const nearbyStart = Math.max(0, segmentStart - AI_CORRECTION_MATCH_RADIUS);
  const nearbyEnd = Math.min(doc.length, segmentStart + AI_CORRECTION_MATCH_RADIUS + text.length);
  const nearbySlice = doc.slice(nearbyStart, nearbyEnd);
  const nearbyIndex = nearbySlice.indexOf(text);
  if (nearbyIndex >= 0) {
    const from = nearbyStart + nearbyIndex;
    return { from, to: from + text.length };
  }

  const firstIndex = doc.indexOf(text);
  if (firstIndex >= 0 && doc.indexOf(text, firstIndex + 1) === -1) {
    return { from: firstIndex, to: firstIndex + text.length };
  }

  return null;
}

interface LatestState {
  terminalId: string;
  projectId?: string;
  disabled: boolean;
  isInitializing: boolean;
  isInHistoryMode: boolean;
  activeMode: "command" | "file" | null;
  isAutocompleteOpen: boolean;
  autocompleteItems: AutocompleteItem[];
  selectedIndex: number;
  value: string;
  atContext: AtFileContext | null;
  slashContext: SlashCommandContext | null;
  onSend: HybridInputBarProps["onSend"];
  onSendKey?: HybridInputBarProps["onSendKey"];
  addToHistory: (terminalId: string, command: string) => void;
  resetHistoryIndex: (terminalId: string) => void;
  clearDraftInput: (terminalId: string, projectId?: string) => void;
  navigateHistory: (
    terminalId: string,
    direction: "up" | "down",
    currentInput: string
  ) => string | null;
  isVoiceActiveForPanel: boolean;
}

export const HybridInputBar = forwardRef<HybridInputBarHandle, HybridInputBarProps>(
  (
    {
      terminalId,
      onSend,
      onSendKey,
      onActivate,
      cwd,
      agentId,
      agentHasLifecycleEvent = false,
      restartKey = 0,
      disabled = false,
      className,
    },
    ref
  ) => {
    const getDraftInput = useTerminalInputStore((s) => s.getDraftInput);
    const setDraftInput = useTerminalInputStore((s) => s.setDraftInput);
    const clearDraftInput = useTerminalInputStore((s) => s.clearDraftInput);
    const addToHistory = useTerminalInputStore((s) => s.addToHistory);
    const navigateHistory = useTerminalInputStore((s) => s.navigateHistory);
    const resetHistoryIndex = useTerminalInputStore((s) => s.resetHistoryIndex);
    const isInHistoryMode = useTerminalInputStore(
      (s) => (s.historyIndex.get(terminalId) ?? -1) !== -1
    );
    // Get projectId early so it can be used for draft input initialization
    const projectId = useProjectStore((s) => s.currentProject?.id);
    const [value, setValue] = useState(() => getDraftInput(terminalId, projectId));
    const submitAfterCompositionRef = useRef(false);
    const isComposingRef = useRef(false);
    const editorHostRef = useRef<HTMLDivElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const placeholderCompartmentRef = useRef(new Compartment());
    const keymapCompartmentRef = useRef(new Compartment());
    const editableCompartmentRef = useRef(new Compartment());
    const chipCompartmentRef = useRef(new Compartment());
    const tooltipCompartmentRef = useRef(new Compartment());
    const fileChipTooltipCompartmentRef = useRef(new Compartment());
    const imageChipTooltipCompartmentRef = useRef(new Compartment());
    const fileDropChipTooltipCompartmentRef = useRef(new Compartment());
    const isApplyingExternalValueRef = useRef(false);
    const lastEnterKeydownNewlineRef = useRef(false);
    const handledEnterRef = useRef(false);
    const inputShellRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const lastEmittedValueRef = useRef<string>(value);
    const [atContext, setAtContext] = useState<AtFileContext | null>(null);
    const [slashContext, setSlashContext] = useState<SlashCommandContext | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const lastQueryRef = useRef<string>("");
    const [menuLeftPx, setMenuLeftPx] = useState<number>(0);
    const [initializationState, setInitializationState] = useState<"initializing" | "initialized">(
      "initializing"
    );
    const latestRef = useRef<LatestState | null>(null);

    const openPicker = useCommandStore((s) => s.openPicker);
    const currentProject = useProjectStore((s) => s.currentProject);
    const voiceStatus = useVoiceRecordingStore((s) => s.status);
    const activeVoicePanelId = useVoiceRecordingStore((s) => s.activeTarget?.panelId ?? null);
    const voiceDraftRevision = useTerminalInputStore((s) => s.voiceDraftRevision);
    const panelWorktreeId = useTerminalStore(
      (s) => s.terminals.find((terminal) => terminal.id === terminalId)?.worktreeId
    );
    const panelWorktree = useWorktreeDataStore((s) =>
      panelWorktreeId ? s.worktrees.get(panelWorktreeId) : undefined
    );
    const isVoiceRecording = activeVoicePanelId === terminalId && voiceStatus === "recording";
    const isVoiceConnecting = activeVoicePanelId === terminalId && voiceStatus === "connecting";
    const isVoiceFinishing = activeVoicePanelId === terminalId && voiceStatus === "finishing";
    const isVoiceActiveForPanel = isVoiceRecording || isVoiceConnecting || isVoiceFinishing;

    const commandContext = useMemo(
      (): CommandContext => ({
        terminalId,
        cwd,
        projectId,
      }),
      [terminalId, cwd, projectId]
    );

    const isAgentTerminal = agentId !== undefined;

    const imagePasteExtension = useMemo(
      () =>
        createImagePasteHandler(async (view) => {
          try {
            const result = await window.electron.clipboard.saveImage();
            if (!result.ok) return;
            const cursor = view.state.selection.main.head;
            const { filePath, thumbnailDataUrl } = result;
            view.dispatch({
              changes: { from: cursor, insert: filePath + " " },
              effects: addImageChip.of({
                from: cursor,
                to: cursor + filePath.length,
                filePath,
                thumbnailUrl: thumbnailDataUrl,
              }),
              selection: { anchor: cursor + filePath.length + 1 },
            });
          } catch {
            // Editor may have been destroyed before IPC returned
          }
        }),
      []
    );

    const filePasteExtension = useMemo(
      () =>
        createFilePasteHandler((view, files) => {
          const cursor = view.state.selection.main.head;
          const effects: ReturnType<typeof addFileDropChip.of>[] = [];

          let insertText = "";
          for (const file of files) {
            const token = formatAtFileToken(file.path);
            const from = cursor + insertText.length;
            insertText += token + " ";
            effects.push(
              addFileDropChip.of({
                from,
                to: from + token.length,
                filePath: file.path,
                fileName: file.name,
              })
            );
          }

          view.dispatch({
            changes: { from: cursor, insert: insertText },
            effects,
            selection: { anchor: cursor + insertText.length },
          });
        }),
      []
    );

    useEffect(() => {
      setInitializationState("initializing");
    }, [restartKey]);

    useEffect(() => {
      if (initializationState === "initializing" && isAgentTerminal && agentHasLifecycleEvent) {
        setInitializationState("initialized");
      }
    }, [initializationState, isAgentTerminal, agentHasLifecycleEvent]);

    const isInitializing = isAgentTerminal && initializationState === "initializing";

    useEffect(() => {
      const draft = getDraftInput(terminalId, projectId);
      setValue(draft);
      lastEmittedValueRef.current = draft;
      setAtContext(null);
      setSlashContext(null);
      setSelectedIndex(0);
      lastQueryRef.current = "";
      lastEnterKeydownNewlineRef.current = false;
      handledEnterRef.current = false;
      submitAfterCompositionRef.current = false;

      const view = editorViewRef.current;
      if (view && view.state.doc.toString() !== draft) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: draft },
        });
      }
    }, [terminalId, projectId, getDraftInput]);

    useEffect(() => {
      setDraftInput(terminalId, value, projectId);
    }, [terminalId, value, projectId, setDraftInput]);

    const placeholder = useMemo(() => {
      const agentName = agentId ? getAgentConfig(agentId)?.name : null;
      return agentName ? `Type a command for ${agentName}…` : "Type a command…";
    }, [agentId]);

    const activeMode = slashContext ? "command" : atContext ? "file" : null;
    const isAutocompleteOpen = activeMode !== null && !disabled;

    const { files: autocompleteFiles, isLoading: isAutocompleteLoading } = useFileAutocomplete({
      cwd,
      query: atContext?.queryForSearch ?? "",
      enabled: isAutocompleteOpen && activeMode === "file",
      limit: 50,
    });

    const { items: autocompleteCommands, isLoading: isCommandsLoading } =
      useSlashCommandAutocomplete({
        query: slashContext?.query ?? "",
        enabled: isAutocompleteOpen && activeMode === "command",
        agentId,
        projectPath: cwd,
      });

    const { commandMap } = useSlashCommandList({
      agentId,
      projectPath: cwd,
    });

    const autocompleteItems = useMemo((): AutocompleteItem[] => {
      if (activeMode === "file") {
        return autocompleteFiles.map((file) => ({ key: file, label: file, value: file }));
      }
      if (activeMode === "command") {
        return autocompleteCommands;
      }
      return [];
    }, [activeMode, autocompleteCommands, autocompleteFiles]);

    const isLoading =
      activeMode === "file"
        ? isAutocompleteLoading
        : activeMode === "command"
          ? isCommandsLoading
          : false;

    latestRef.current = {
      terminalId,
      projectId,
      disabled,
      isInitializing,
      isInHistoryMode,
      activeMode,
      isAutocompleteOpen,
      autocompleteItems,
      selectedIndex,
      value,
      atContext,
      slashContext,
      onSend,
      onSendKey,
      addToHistory,
      resetHistoryIndex,
      clearDraftInput,
      navigateHistory,
      isVoiceActiveForPanel,
    };

    useLayoutEffect(() => {
      if (!isAutocompleteOpen) return;
      const view = editorViewRef.current;
      const shell = inputShellRef.current;
      if (!view || !shell) return;

      const anchorIndex =
        activeMode === "file"
          ? atContext?.atStart
          : activeMode === "command"
            ? (slashContext?.start ?? 0)
            : null;
      if (anchorIndex === null || anchorIndex === undefined) return;

      const compute = () => {
        const shellRect = shell.getBoundingClientRect();
        const coords = view.coordsAtPos(anchorIndex);
        if (!coords) return;

        const rawLeft = coords.left - shellRect.left;
        const menuWidth = menuRef.current?.offsetWidth ?? 420;
        const viewportRight = window.innerWidth;
        const menuAbsoluteLeft = shellRect.left + rawLeft;
        const maxAbsoluteLeft = viewportRight - menuWidth;
        const clampedAbsoluteLeft = Math.max(0, Math.min(menuAbsoluteLeft, maxAbsoluteLeft));
        const clampedLeft = clampedAbsoluteLeft - shellRect.left;
        setMenuLeftPx(Math.max(0, clampedLeft));
      };

      compute();

      const onResize = () => compute();
      window.addEventListener("resize", onResize);
      const ro = new ResizeObserver(() => compute());
      ro.observe(shell);
      ro.observe(view.dom);

      return () => {
        window.removeEventListener("resize", onResize);
        ro.disconnect();
      };
    }, [activeMode, atContext?.atStart, isAutocompleteOpen, slashContext?.start]);

    useEffect(() => {
      const activeQuery =
        activeMode === "file"
          ? `file:${atContext?.queryForSearch ?? ""}`
          : activeMode === "command"
            ? `command:${slashContext?.query ?? ""}`
            : "";

      if (activeQuery !== lastQueryRef.current) {
        lastQueryRef.current = activeQuery;
        setSelectedIndex(0);
      }
    }, [activeMode, atContext?.queryForSearch, slashContext?.query]);

    useEffect(() => {
      if (!isAutocompleteOpen) return;
      const root = rootRef.current;
      if (!root) return;

      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (root.contains(target)) return;
        setAtContext(null);
        setSlashContext(null);
      };

      document.addEventListener("pointerdown", onPointerDown, true);
      return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [isAutocompleteOpen]);

    useEffect(() => {
      if (!isAutocompleteOpen) return;
      if (autocompleteItems.length === 0) {
        setSelectedIndex(0);
        return;
      }
      setSelectedIndex((prev) => Math.max(0, Math.min(prev, autocompleteItems.length - 1)));
    }, [autocompleteItems.length, isAutocompleteOpen]);

    const applyEditorValue = useCallback(
      (
        nextValue: string,
        options?: {
          selection?: EditorSelection;
          focus?: boolean;
        }
      ) => {
        if (lastEmittedValueRef.current !== nextValue) {
          lastEmittedValueRef.current = nextValue;
          setValue(nextValue);
        }

        const view = editorViewRef.current;
        if (!view) return;

        const current = view.state.doc.toString();
        const shouldChangeDoc = current !== nextValue;
        const shouldChangeSelection = options?.selection !== undefined;

        if (!shouldChangeDoc && !shouldChangeSelection) {
          if (options?.focus) view.focus();
          return;
        }

        if (shouldChangeDoc) {
          isApplyingExternalValueRef.current = true;
        }

        const transaction = {
          ...(shouldChangeDoc
            ? { changes: { from: 0, to: view.state.doc.length, insert: nextValue } }
            : {}),
          ...(shouldChangeSelection ? { selection: options?.selection } : {}),
          scrollIntoView: true,
        };

        view.dispatch(transaction);

        if (options?.focus) view.focus();
      },
      []
    );

    const sendText = useCallback(
      (text: string) => {
        const latest = latestRef.current;
        if (!latest || latest.disabled) return;
        if (text.trim().length === 0) return;

        const payload = buildTerminalSendPayload(text);
        latest.onSend({ data: payload.data, trackerData: payload.trackerData, text });
        latest.addToHistory(latest.terminalId, text);
        latest.resetHistoryIndex(latest.terminalId);

        applyEditorValue("", { selection: EditorSelection.create([EditorSelection.cursor(0)]) });
        latest.clearDraftInput(latest.terminalId, latest.projectId);
        useVoiceRecordingStore.getState().clearAICorrectionSpans(latest.terminalId);
        setAtContext(null);
        setSlashContext(null);
      },
      [applyEditorValue]
    );

    // Voice segments are flushed to the draft store by VoiceRecordingService
    // and increment voiceDraftRevision.  Sync the editor to the draft when
    // that revision bumps (works even if this component was unmounted during
    // a worktree switch — on remount, the draft already contains the text).
    useEffect(() => {
      if (voiceDraftRevision === 0) return;
      const draft = useTerminalInputStore.getState().getDraftInput(terminalId, currentProject?.id);
      const view = editorViewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (draft !== current) {
        // Update React state first so the draft-writeback effect (which
        // syncs `value` → setDraftInput) won't overwrite with stale data.
        setValue(draft);
        lastEmittedValueRef.current = draft;
        isApplyingExternalValueRef.current = true;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: draft },
          selection: { anchor: draft.length },
          scrollIntoView: true,
        });
      }
    }, [voiceDraftRevision, terminalId, currentProject?.id]);

    // Drive voice decorations from transcript state:
    //   interim → character-level italic mark on live delta text
    //   aiCorrectionSpans → persistent dotted underline on AI-touched text
    const transcriptPhase = useVoiceRecordingStore(
      (s) => s.panelBuffers[terminalId]?.transcriptPhase ?? "idle"
    );
    const liveSegmentStart = useVoiceRecordingStore(
      (s) => s.panelBuffers[terminalId]?.draftLengthAtSegmentStart ?? -1
    );
    const aiCorrectionSpans = useVoiceRecordingStore(
      (s) => s.panelBuffers[terminalId]?.aiCorrectionSpans
    );
    const voiceCorrectionEnabled = useVoiceRecordingStore((s) => s.correctionEnabled);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      // When correction is disabled, suppress all voice decorations
      if (!voiceCorrectionEnabled) {
        view.dispatch({
          effects: [setInterimRange.of(null), setAICorrectedRanges.of([])],
        });
        return;
      }

      const docLen = view.state.doc.length;
      const doc = view.state.doc.toString();
      const aiRanges =
        aiCorrectionSpans?.flatMap((span) => {
          const range = resolveAICorrectionRange(doc, span.segmentStart, span.text);
          return range ? [range] : [];
        }) ?? [];

      switch (transcriptPhase) {
        case "interim": {
          // Show italic mark on live delta text
          const interimRange =
            liveSegmentStart >= 0 && liveSegmentStart < docLen
              ? { from: liveSegmentStart, to: docLen }
              : null;
          view.dispatch({
            effects: [setInterimRange.of(interimRange), setAICorrectedRanges.of(aiRanges)],
          });
          break;
        }
        case "paragraph_pending_ai":
        case "utterance_final":
        case "stable":
        case "idle": {
          view.dispatch({
            effects: [setInterimRange.of(null), setAICorrectedRanges.of(aiRanges)],
          });
          break;
        }
        default:
          view.dispatch({
            effects: [setInterimRange.of(null), setAICorrectedRanges.of(aiRanges)],
          });
          break;
      }
    }, [
      transcriptPhase,
      voiceDraftRevision,
      liveSegmentStart,
      voiceCorrectionEnabled,
      aiCorrectionSpans,
    ]);

    const sendFromEditor = useCallback(() => {
      const view = editorViewRef.current;
      const latest = latestRef.current;
      const text = view?.state.doc.toString() ?? latest?.value ?? "";
      sendText(text);
    }, [sendText]);

    const focusEditor = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;
      view.focus();
      requestAnimationFrame(() => view.focus());
    }, []);

    const focusEditorWithCursorAtEnd = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return;
      requestAnimationFrame(() => {
        if (editorViewRef.current !== view) return;
        view.dispatch({
          selection: EditorSelection.cursor(view.state.doc.length),
          scrollIntoView: true,
        });
        view.focus();
      });
    }, []);

    const handleHistoryNavigation = useCallback(
      (direction: "up" | "down"): boolean => {
        const latest = latestRef.current;
        if (!latest) return false;

        const view = editorViewRef.current;
        const currentValue = view?.state.doc.toString() ?? latest.value;
        const result = latest.navigateHistory(latest.terminalId, direction, currentValue);

        if (result !== null) {
          applyEditorValue(result, {
            selection: EditorSelection.create([EditorSelection.cursor(result.length)]),
            focus: true,
          });
          return true;
        }

        return false;
      },
      [applyEditorValue]
    );

    const applyAutocompleteItem = useCallback(
      (item: AutocompleteItem, action: "insert" | "execute") => {
        const view = editorViewRef.current;
        if (!view) return;

        const latest = latestRef.current;
        if (!latest) return;

        const currentValue = view.state.doc.toString();
        const caret = view.state.selection.main.head;
        const slashCtx = getSlashCommandContext(currentValue, caret) ?? latest.slashContext;

        if (latest.activeMode === "file") {
          const ctx = getAtFileContext(currentValue, caret);
          if (!ctx) return;

          const token = `${formatAtFileToken(item.value)} `;
          const before = currentValue.slice(0, ctx.atStart);
          const after = currentValue.slice(ctx.tokenEnd);
          const nextValue = `${before}${token}${after}`;
          const nextCaret = before.length + token.length;

          if (action === "execute") {
            sendText(nextValue);
            setAtContext(null);
            setSlashContext(null);
            setSelectedIndex(0);
            lastQueryRef.current = "";
            return;
          }

          applyEditorValue(nextValue, {
            selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
            focus: true,
          });
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";
          return;
        }

        if (latest.activeMode === "command" && slashCtx) {
          const before = currentValue.slice(0, slashCtx.start);
          const after = currentValue.slice(slashCtx.tokenEnd);

          const hasLeadingSpace = after.startsWith(" ");
          const shouldAppendSpace = action === "insert" && !hasLeadingSpace;
          const token = shouldAppendSpace ? `${item.value} ` : item.value;
          const nextValue = `${before}${token}${after}`;
          const nextCaret =
            before.length + token.length + (action === "insert" && hasLeadingSpace ? 1 : 0);

          if (action === "execute") {
            sendText(nextValue);
            setAtContext(null);
            setSlashContext(null);
            setSelectedIndex(0);
            lastQueryRef.current = "";
            return;
          }

          applyEditorValue(nextValue, {
            selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
            focus: true,
          });
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";
        }
      },
      [applyEditorValue, sendText]
    );

    const applyAutocompleteSelection = useCallback(
      (action: "insert" | "execute") => {
        const latest = latestRef.current;
        if (!latest) return false;

        const item = latest.autocompleteItems[latest.selectedIndex];
        if (!item) return false;

        applyAutocompleteItem(item, action);
        return true;
      },
      [applyAutocompleteItem]
    );

    const handleAutocompleteSelect = useCallback(
      (item: AutocompleteItem) => {
        applyAutocompleteItem(item, "insert");
      },
      [applyAutocompleteItem]
    );

    const handleCommandExecuted = useCallback(
      (_commandId: string, result: CommandResult) => {
        if (result.success && result.prompt) {
          sendText(result.prompt);
        } else if (!result.success && result.error) {
          // Log execution errors for debugging custom prompt issues
          console.error("[HybridInputBar] Command execution failed:", result.error);
        }
      },
      [sendText]
    );

    useImperativeHandle(
      ref,
      () => ({ focus: focusEditor, focusWithCursorAtEnd: focusEditorWithCursorAtEnd }),
      [focusEditor, focusEditorWithCursorAtEnd]
    );

    const lastSlashContextRef = useRef<SlashCommandContext | null>(null);
    const lastAtContextRef = useRef<AtFileContext | null>(null);

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
                latest.resetHistoryIndex(latest.terminalId);
              }
            }
          }

          if (update.docChanged || update.selectionSet) {
            const caret = update.state.selection.main.head;
            const text = update.state.doc.toString();

            const slash = getSlashCommandContext(text, caret);
            if (slash) {
              // Only update if context actually changed
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
              return;
            }

            const atCtx = getAtFileContext(text, caret);
            // Only update if context actually changed
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
        }),
      []
    );

    const domEventHandlers = useMemo(
      () =>
        EditorView.domEventHandlers({
          beforeinput: (event) => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (latest.disabled) {
              event.preventDefault();
              return true;
            }

            const nativeEvent = event as InputEvent;
            if (!isEnterLikeLineBreakInputEvent(nativeEvent)) return false;

            if (handledEnterRef.current) {
              handledEnterRef.current = false;
              event.preventDefault();
              return true;
            }

            if (lastEnterKeydownNewlineRef.current) {
              return false;
            }

            if (latest.isAutocompleteOpen && latest.autocompleteItems[latest.selectedIndex]) {
              event.preventDefault();
              const action = latest.activeMode === "command" ? "execute" : "insert";
              applyAutocompleteSelection(action);
              return true;
            }

            event.preventDefault();

            if (nativeEvent.isComposing) {
              submitAfterCompositionRef.current = true;
              return true;
            }

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            if (text.trim().length === 0) {
              if (latest.onSendKey) latest.onSendKey("enter");
              return true;
            }

            sendFromEditor();
            return true;
          },
          compositionstart: () => {
            isComposingRef.current = true;
            submitAfterCompositionRef.current = false;
            lastEnterKeydownNewlineRef.current = false;
            return false;
          },
          compositionend: () => {
            isComposingRef.current = false;
            if (!submitAfterCompositionRef.current) return false;
            submitAfterCompositionRef.current = false;
            // Defer one tick so CM6 can commit the final composition text to
            // view.state.doc before we read it.  Unlike the old RAF approach,
            // setTimeout is NOT canceled by the blur handler, so a focus shift
            // during composition cannot silently drop the submission.
            setTimeout(sendFromEditor, 0);
            return false;
          },
          keydown: (event) => {
            const isEnter =
              event.key === "Enter" ||
              event.key === "Return" ||
              event.code === "Enter" ||
              event.code === "NumpadEnter";

            if (isEnter) {
              lastEnterKeydownNewlineRef.current = event.shiftKey || event.altKey;
            }

            if (event.isComposing) {
              if (isEnter && !event.shiftKey && !event.altKey) {
                submitAfterCompositionRef.current = true;
              }
              return false;
            }

            return false;
          },
          blur: (event) => {
            const nextTarget = event.relatedTarget as HTMLElement | null;
            const root = rootRef.current;
            if (root && nextTarget && root.contains(nextTarget)) return false;

            setAtContext(null);
            setSlashContext(null);
            lastEnterKeydownNewlineRef.current = false;
            handledEnterRef.current = false;
            submitAfterCompositionRef.current = false;

            return false;
          },
        }),
      [applyAutocompleteSelection, sendFromEditor]
    );

    const keymapExtension = useMemo(
      () =>
        createCustomKeymap({
          onEnter: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;

            if (latest.isAutocompleteOpen && latest.autocompleteItems[latest.selectedIndex]) {
              const action = latest.activeMode === "command" ? "execute" : "insert";

              handledEnterRef.current = true;
              setTimeout(() => {
                handledEnterRef.current = false;
              }, 0);

              applyAutocompleteSelection(action);
              return true;
            }

            if (latest.disabled) return true;

            // During voice recording, plain Enter commits the current paragraph
            // instead of submitting to the terminal.
            if (latest.isVoiceActiveForPanel) {
              handledEnterRef.current = true;
              setTimeout(() => {
                handledEnterRef.current = false;
              }, 0);

              const { terminalId: tid, projectId: pid } = latest;
              const voiceStore = useVoiceRecordingStore.getState();
              const buffer = voiceStore.panelBuffers[tid];
              const paragraphStart = buffer?.activeParagraphStart ?? -1;
              const correctionEnabled = voiceStore.correctionEnabled;

              // Flush paragraph buffer in the main process. This captures any in-flight
              // utterance text via commitParagraphBoundary() and returns the authoritative
              // rawText that the correction service will use.
              const flushPromise = window.electron.voiceInput.flushParagraph();

              // Insert a newline at the end of the draft and reset paragraph state
              // synchronously — the UI must feel immediate regardless of IPC timing.
              const inputStore = useTerminalInputStore.getState();
              const draft = inputStore.getDraftInput(tid, pid);
              inputStore.setDraftInput(tid, draft + "\n", pid);
              inputStore.bumpVoiceDraftRevision();

              voiceStore.resetParagraphState(tid);

              // Register pending correction once we know the authoritative rawText.
              // Only add when correction is enabled — otherwise no CORRECTION_REPLACE
              // will arrive and the text would stay dimmed permanently.
              if (paragraphStart >= 0 && correctionEnabled) {
                flushPromise
                  .then((result) => {
                    if (result?.correctionId && result.rawText) {
                      useVoiceRecordingStore
                        .getState()
                        .addPendingCorrection(
                          tid,
                          result.correctionId,
                          paragraphStart,
                          result.rawText
                        );
                    }
                  })
                  .catch(() => {});
              }

              return true;
            }

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            if (text.trim().length === 0) {
              handledEnterRef.current = true;
              setTimeout(() => {
                handledEnterRef.current = false;
              }, 0);

              if (latest.onSendKey) latest.onSendKey("enter");
              return true;
            }

            handledEnterRef.current = true;
            setTimeout(() => {
              handledEnterRef.current = false;
            }, 0);

            sendFromEditor();
            return true;
          },
          onEscape: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;

            if (latest.isAutocompleteOpen) {
              setAtContext(null);
              setSlashContext(null);
              return true;
            }

            if (latest.disabled) return false;
            if (!latest.onSendKey) return false;

            latest.onSendKey("escape");
            return true;
          },
          onArrowUp: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled) return false;

            const resultsCount = latest.autocompleteItems.length;
            if (latest.isAutocompleteOpen && resultsCount > 0) {
              setSelectedIndex((prev) => {
                if (resultsCount === 0) return 0;
                return (prev - 1 + resultsCount) % resultsCount;
              });
              return true;
            }

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            const isEmpty = text.trim().length === 0;
            const canNavigateHistory = isEmpty || latest.isInHistoryMode;

            if (canNavigateHistory) {
              if (handleHistoryNavigation("up")) return true;
              if (isEmpty && latest.onSendKey) {
                latest.onSendKey("up");
                return true;
              }
            }

            return false;
          },
          onArrowDown: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled) return false;

            const resultsCount = latest.autocompleteItems.length;
            if (latest.isAutocompleteOpen && resultsCount > 0) {
              setSelectedIndex((prev) => {
                if (resultsCount === 0) return 0;
                return (prev + 1) % resultsCount;
              });
              return true;
            }

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            const isEmpty = text.trim().length === 0;
            const canNavigateHistory = isEmpty || latest.isInHistoryMode;

            if (canNavigateHistory) {
              if (handleHistoryNavigation("down")) return true;
              if (isEmpty && latest.onSendKey) {
                latest.onSendKey("down");
                return true;
              }
            }

            return false;
          },
          onArrowLeft: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled) return false;

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            if (text.trim().length !== 0) return false;

            if (!latest.onSendKey) return false;
            latest.onSendKey("left");
            return true;
          },
          onArrowRight: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled) return false;

            const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
            if (text.trim().length !== 0) return false;

            if (!latest.onSendKey) return false;
            latest.onSendKey("right");
            return true;
          },
          onTab: () => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;

            if (latest.isAutocompleteOpen && latest.autocompleteItems[latest.selectedIndex]) {
              applyAutocompleteSelection("insert");
              return true;
            }

            return false;
          },
          onCtrlC: (hasSelection) => {
            const latest = latestRef.current;
            if (!latest) return false;
            if (isComposingRef.current) return false;
            if (latest.disabled) return false;
            if (!latest.onSendKey) return false;
            if (hasSelection) return false;

            latest.onSendKey("ctrl+c");
            return true;
          },
        }),
      [applyAutocompleteSelection, handleHistoryNavigation, sendFromEditor]
    );

    useLayoutEffect(() => {
      const host = editorHostRef.current;
      if (!host) return;

      // Editor already exists - don't recreate it. This guard is critical because
      // React's effect cleanup runs BEFORE the effect body on dependency changes,
      // which would destroy the editor then immediately recreate it, causing focus loss.
      // Dynamic values (placeholder, disabled, commandMap, etc.) are updated via
      // compartment reconfigure effects, not by recreating the entire editor.
      if (editorViewRef.current) return;

      const state = EditorState.create({
        doc: value,
        extensions: [
          inputTheme,
          EditorView.lineWrapping,
          drawSelection(),
          createContentAttributes(),
          createAutoSize(),
          placeholderCompartmentRef.current.of(createPlaceholder(placeholder)),
          editableCompartmentRef.current.of(EditorView.editable.of(!disabled)),
          chipCompartmentRef.current.of(createSlashChipField({ commandMap })),
          tooltipCompartmentRef.current.of(!disabled ? createSlashTooltip(commandMap) : []),
          createFileChipField(),
          fileChipTooltipCompartmentRef.current.of(!disabled ? createFileChipTooltip() : []),
          imageChipField,
          imageChipTooltipCompartmentRef.current.of(!disabled ? createImageChipTooltip() : []),
          fileDropChipField,
          fileDropChipTooltipCompartmentRef.current.of(
            !disabled ? createFileDropChipTooltip() : []
          ),
          interimMarkField,
          aiCorrectedField,
          keymapCompartmentRef.current.of(keymapExtension),
          editorUpdateListener,
          domEventHandlers,
          imagePasteExtension,
          filePasteExtension,
        ],
      });

      const view = new EditorView({
        state,
        parent: host,
      });

      editorViewRef.current = view;

      return () => {
        view.destroy();
        editorViewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Editor created once, updated via compartments
    }, [terminalId]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: placeholderCompartmentRef.current.reconfigure(createPlaceholder(placeholder)),
      });
    }, [placeholder]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!disabled)),
      });
    }, [disabled]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: chipCompartmentRef.current.reconfigure(createSlashChipField({ commandMap })),
      });
    }, [commandMap]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: tooltipCompartmentRef.current.reconfigure(
          !disabled ? createSlashTooltip(commandMap) : []
        ),
      });
    }, [commandMap, disabled]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: fileChipTooltipCompartmentRef.current.reconfigure(
          !disabled ? createFileChipTooltip() : []
        ),
      });
    }, [disabled]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: imageChipTooltipCompartmentRef.current.reconfigure(
          !disabled ? createImageChipTooltip() : []
        ),
      });
    }, [disabled]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      view.dispatch({
        effects: fileDropChipTooltipCompartmentRef.current.reconfigure(
          !disabled ? createFileDropChipTooltip() : []
        ),
      });
    }, [disabled]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      const current = view.state.doc.toString();
      if (value === current) return;

      isApplyingExternalValueRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }, [value]);

    const barContent = (
      <div className="group cursor-text bg-canopy-bg px-4 pb-3 pt-3">
        <div className="flex items-end gap-2">
          <div
            ref={inputShellRef}
            className={cn(
              "group/shell relative",
              "flex w-full items-center gap-1.5 rounded-sm border border-white/[0.06] bg-overlay-soft py-1 shadow-[0_6px_12px_rgba(0,0,0,0.18)] transition-colors",
              "group-hover:border-white/[0.08] group-hover:bg-overlay-medium",
              "focus-within:border-white/[0.12] focus-within:ring-1 focus-within:ring-white/[0.06] focus-within:bg-white/[0.05]",
              isVoiceActiveForPanel &&
                "border-canopy-accent/60 bg-canopy-accent/[0.12] shadow-[0_0_0_1px_rgba(var(--theme-accent-rgb),0.35),0_0_16px_rgba(var(--theme-accent-rgb),0.15)]",
              disabled && "opacity-60"
            )}
            aria-disabled={disabled}
            aria-busy={isInitializing || isVoiceConnecting}
          >
            <AutocompleteMenu
              ref={menuRef}
              isOpen={isAutocompleteOpen}
              items={autocompleteItems}
              selectedIndex={selectedIndex}
              isLoading={isLoading}
              onSelect={handleAutocompleteSelect}
              style={{ left: `${menuLeftPx}px` }}
              ariaLabel={activeMode === "command" ? "Command autocomplete" : "File autocomplete"}
            />

            <button
              type="button"
              onClick={openPicker}
              disabled={disabled}
              className="select-none pl-2 pr-1 font-mono text-xs font-semibold leading-5 text-canopy-accent/85 hover:text-canopy-accent transition-colors cursor-pointer focus-visible:outline-none"
              aria-label="Open command picker"
            >
              ❯
            </button>

            <div className="relative flex-1">
              <div
                ref={editorHostRef}
                className={cn("w-full", "text-canopy-text", disabled && "pointer-events-none")}
              />
            </div>

            <div className="flex items-center pr-1.5">
              <VoiceInputButton
                panelId={terminalId}
                panelTitle={agentId ? getAgentConfig(agentId)?.name : undefined}
                projectId={currentProject?.id}
                projectName={currentProject?.name}
                worktreeId={panelWorktreeId}
                worktreeLabel={panelWorktree?.branch || panelWorktree?.name}
                disabled={disabled}
              />
            </div>
          </div>
        </div>
      </div>
    );

    return (
      <>
        <div
          ref={rootRef}
          className={cn("relative w-full shrink-0", disabled && "pointer-events-none", className)}
          onPointerDownCapture={(e) => {
            if (disabled) return;
            if (e.button !== 0) return;
            onActivate?.();
            focusEditor();
          }}
          onMouseDownCapture={(e) => {
            if (disabled) return;
            if (e.button !== 0) return;
            onActivate?.();
            focusEditor();
          }}
          onClick={() => {
            if (disabled) return;
            onActivate?.();
            focusEditor();
          }}
        >
          {barContent}
        </div>
        <CommandPickerHost context={commandContext} onCommandExecuted={handleCommandExecuted} />
      </>
    );
  }
);

HybridInputBar.displayName = "HybridInputBar";
