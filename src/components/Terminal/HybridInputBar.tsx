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
import { EditorSelection, EditorState } from "@codemirror/state";
import type { LegacyAgentType } from "@shared/types";
import type { AgentState } from "@/types";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";
import { useFileAutocomplete } from "@/hooks/useFileAutocomplete";
import { useSlashCommandAutocomplete } from "@/hooks/useSlashCommandAutocomplete";
import { useSlashCommandList } from "@/hooks/useSlashCommandList";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { AutocompleteMenu, type AutocompleteItem } from "./AutocompleteMenu";
import {
  formatAtFileToken,
  getAtFileContext,
  getSlashCommandContext,
  getDiffContext,
  getTerminalContext,
  getSelectionContext,
  type AtFileContext,
  type SlashCommandContext,
  type AtDiffContext,
  type AtTerminalContext,
  type AtSelectionContext,
} from "./hybridInputParsing";
import { CommandPickerHost } from "@/components/Commands";
import { PromptHistoryPalette } from "./PromptHistoryPalette";
import { useCommandStore } from "@/store/commandStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalStore, useVoiceRecordingStore } from "@/store";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { VoiceInputButton } from "./VoiceInputButton";
import { Archive, Loader2 } from "lucide-react";
import { useVoiceWaitSubmit } from "./hooks/useVoiceWaitSubmit";
import { registerInputController, unregisterInputController } from "@/store/terminalInputStore";
import type { CommandContext, CommandResult } from "@shared/types/commands";
import { isEnterLikeLineBreakInputEvent } from "./hybridInputEvents";
import {
  buildInputBarTheme,
  createContentAttributes,
  createPlaceholder,
  createSlashChipField,
  createSlashTooltip,
  createFileChipField,
  createFileChipTooltip,
  imageChipField,
  createImageChipTooltip,
  createImagePasteHandler,
  addImageChip,
  fileDropChipField,
  createFileDropChipTooltip,
  createFilePasteHandler,
  addFileDropChip,
  interimMarkField,
  pendingAIField,
  createPlainPasteKeymap,
  diffChipField,
  createDiffChipTooltip,
  terminalChipField,
  createTerminalChipTooltip,
  selectionChipField,
  createSelectionChipTooltip,
  createAutoSize,
} from "./inputEditorExtensions";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  useTerminalColorSchemeStore,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { resolveInputBarColors } from "@/utils/terminalTheme";

import { useEditorCompartments } from "./hooks/useEditorCompartments";
import { useAutocompleteItems } from "./hooks/useAutocompleteItems";
import { useDragDrop } from "./hooks/useDragDrop";
import { useVoiceDecorations } from "./hooks/useVoiceDecorations";
import { useContextDetection } from "./hooks/useContextDetection";
import { useTokenResolution } from "./hooks/useTokenResolution";
import { useEditorKeymap } from "./hooks/useEditorKeymap";

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
  agentState?: AgentState;
  restartKey?: number;
  disabled?: boolean;
  className?: string;
}

interface LatestState {
  terminalId: string;
  projectId?: string;
  disabled: boolean;
  isInitializing: boolean;
  isInHistoryMode: boolean;
  activeMode: "command" | "file" | "diff" | "terminal" | "selection" | null;
  isAutocompleteOpen: boolean;
  autocompleteItems: AutocompleteItem[];
  selectedIndex: number;
  value: string;
  atContext: AtFileContext | null;
  slashContext: SlashCommandContext | null;
  diffContext: AtDiffContext | null;
  terminalContext: AtTerminalContext | null;
  selectionContext: AtSelectionContext | null;
  onSend: HybridInputBarProps["onSend"];
  onSendKey?: HybridInputBarProps["onSendKey"];
  addToHistory: (terminalId: string, command: string, projectId?: string) => void;
  resetHistoryIndex: (terminalId: string, projectId?: string) => void;
  clearDraftInput: (terminalId: string, projectId?: string) => void;
  navigateHistory: (
    terminalId: string,
    direction: "up" | "down",
    currentInput: string,
    projectId?: string
  ) => string | null;
  isVoiceActiveForPanel: boolean;
  isExpanded: boolean;
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
    const projectId = useProjectStore((s) => s.currentProject?.id);
    const isInHistoryMode = useTerminalInputStore((s) => {
      const key = projectId ? `${projectId}:${terminalId}` : terminalId;
      return (s.historyIndex.get(key) ?? -1) !== -1;
    });
    const stashEditorState = useTerminalInputStore((s) => s.stashEditorState);
    const popStashedEditorState = useTerminalInputStore((s) => s.popStashedEditorState);
    const isFocusedTerminal = useTerminalStore((s) => s.focusedId === terminalId);
    const hasStash = useTerminalInputStore((s) => {
      const key = projectId ? `${projectId}:${terminalId}` : terminalId;
      return s.stashedEditorStates.has(key);
    });
    const [value, setValue] = useState(() => getDraftInput(terminalId, projectId));
    const submitAfterCompositionRef = useRef(false);
    const isComposingRef = useRef(false);
    const editorHostRef = useRef<HTMLDivElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    const modalEditorHostRef = useRef<HTMLDivElement | null>(null);
    const compactEditorHostRef = useRef<HTMLDivElement | null>(null);
    const isApplyingExternalValueRef = useRef(false);
    const lastEnterKeydownNewlineRef = useRef(false);
    const handledEnterRef = useRef(false);
    const historyPaletteOpenRef = useRef<(() => void) | null>(null);
    const inputShellRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const lastEmittedValueRef = useRef<string>(value);
    const [atContext, setAtContext] = useState<AtFileContext | null>(null);
    const [slashContext, setSlashContext] = useState<SlashCommandContext | null>(null);
    const [diffContext, setDiffContext] = useState<AtDiffContext | null>(null);
    const [terminalContext, setTerminalContext] = useState<AtTerminalContext | null>(null);
    const [selectionContext, setSelectionContext] = useState<AtSelectionContext | null>(null);
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
      useCallback(
        (s) => s.terminals.find((terminal) => terminal.id === terminalId)?.worktreeId,
        [terminalId]
      )
    );
    const panelWorktree = useWorktreeStore((s) =>
      panelWorktreeId ? s.worktrees.get(panelWorktreeId) : undefined
    );
    const isVoiceRecording = activeVoicePanelId === terminalId && voiceStatus === "recording";
    const isVoiceConnecting = activeVoicePanelId === terminalId && voiceStatus === "connecting";
    const isVoiceFinishing = activeVoicePanelId === terminalId && voiceStatus === "finishing";
    const isVoiceActiveForPanel = isVoiceRecording || isVoiceConnecting || isVoiceFinishing;
    const isVoiceSubmitting = useTerminalInputStore(
      useCallback((s) => s.voiceSubmittingPanels.has(terminalId), [terminalId])
    );

    const commandContext = useMemo(
      (): CommandContext => ({ terminalId, cwd, projectId }),
      [terminalId, cwd, projectId]
    );

    const isAgentTerminal = agentId !== undefined;

    // --- Terminal color scheme ---
    useAppThemeStore((s) => s.selectedSchemeId);
    const effectiveTheme = useTerminalColorSchemeStore(selectEffectiveTheme);
    const inputBarColors = useMemo(() => resolveInputBarColors(effectiveTheme), [effectiveTheme]);

    // --- Extracted hooks ---

    const compartments = useEditorCompartments();
    const {
      placeholderCompartmentRef,
      keymapCompartmentRef,
      editableCompartmentRef,
      chipCompartmentRef,
      tooltipCompartmentRef,
      fileChipTooltipCompartmentRef,
      imageChipTooltipCompartmentRef,
      fileDropChipTooltipCompartmentRef,
      diffChipTooltipCompartmentRef,
      terminalChipTooltipCompartmentRef,
      selectionChipTooltipCompartmentRef,
      autoSizeCompartmentRef,
      themeCompartmentRef,
    } = compartments;

    const { handleDragEnter, handleDragOver, handleDragLeave, handleDrop, isDragOverFiles } =
      useDragDrop(editorViewRef);

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
                fileSize: file.size,
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

    const plainPasteKeymap = useMemo(() => createPlainPasteKeymap(), []);

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
      setDiffContext(null);
      setSelectedIndex(0);
      lastQueryRef.current = "";
      lastEnterKeydownNewlineRef.current = false;
      handledEnterRef.current = false;
      submitAfterCompositionRef.current = false;
      const view = editorViewRef.current;
      if (view && view.state.doc.toString() !== draft) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft } });
      }
    }, [terminalId, projectId, getDraftInput]);

    useEffect(() => {
      setDraftInput(terminalId, value, projectId);
    }, [terminalId, value, projectId, setDraftInput]);

    const placeholder = useMemo(() => {
      const agentName = agentId ? getAgentConfig(agentId)?.name : null;
      return agentName ? `Type a command for ${agentName}…` : "Type a command…";
    }, [agentId]);

    const activeMode = slashContext
      ? "command"
      : terminalContext
        ? "terminal"
        : selectionContext
          ? "selection"
          : diffContext
            ? "diff"
            : atContext
              ? "file"
              : null;
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

    const { commandMap } = useSlashCommandList({ agentId, projectPath: cwd });

    const { autocompleteItems, isLoading } = useAutocompleteItems({
      activeMode,
      diffContext,
      terminalContext,
      selectionContext,
      value,
      autocompleteFiles,
      isAutocompleteLoading,
      autocompleteCommands,
      isCommandsLoading,
    });

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
      diffContext,
      terminalContext,
      selectionContext,
      onSend,
      onSendKey,
      addToHistory,
      resetHistoryIndex,
      clearDraftInput,
      navigateHistory,
      isVoiceActiveForPanel,
      isExpanded,
    };

    useLayoutEffect(() => {
      if (!isAutocompleteOpen) return;
      const view = editorViewRef.current;
      const shell = inputShellRef.current;
      if (!view || !shell) return;

      const anchorIndex =
        activeMode === "terminal"
          ? terminalContext?.atStart
          : activeMode === "selection"
            ? selectionContext?.atStart
            : activeMode === "diff"
              ? diffContext?.atStart
              : activeMode === "file"
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
    }, [
      activeMode,
      atContext?.atStart,
      diffContext?.atStart,
      terminalContext?.atStart,
      selectionContext?.atStart,
      isAutocompleteOpen,
      slashContext?.start,
    ]);

    useEffect(() => {
      const activeQuery =
        activeMode === "terminal"
          ? `terminal:${terminalContext?.atStart ?? ""}`
          : activeMode === "selection"
            ? `selection:${selectionContext?.atStart ?? ""}`
            : activeMode === "diff"
              ? `diff:${diffContext?.atStart ?? ""}:${diffContext?.tokenEnd ?? ""}`
              : activeMode === "file"
                ? `file:${atContext?.queryForSearch ?? ""}`
                : activeMode === "command"
                  ? `command:${slashContext?.query ?? ""}`
                  : "";
      if (activeQuery !== lastQueryRef.current) {
        lastQueryRef.current = activeQuery;
        setSelectedIndex(0);
      }
    }, [
      activeMode,
      atContext?.queryForSearch,
      diffContext?.atStart,
      diffContext?.tokenEnd,
      terminalContext?.atStart,
      selectionContext?.atStart,
      slashContext?.query,
    ]);

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
        setDiffContext(null);
        setTerminalContext(null);
        setSelectionContext(null);
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
      (nextValue: string, options?: { selection?: EditorSelection; focus?: boolean }) => {
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
        if (shouldChangeDoc) isApplyingExternalValueRef.current = true;
        view.dispatch({
          ...(shouldChangeDoc
            ? { changes: { from: 0, to: view.state.doc.length, insert: nextValue } }
            : {}),
          ...(shouldChangeSelection ? { selection: options?.selection } : {}),
          scrollIntoView: true,
        });
        if (options?.focus) view.focus();
      },
      []
    );

    const { sendText } = useTokenResolution({
      latestRef,
      applyEditorValue,
      setIsExpanded,
      setAtContext,
      setSlashContext,
      setDiffContext,
      setTerminalContext,
      setSelectionContext,
      terminalId,
      cwd,
      agentId,
    });

    useEffect(() => {
      if (voiceDraftRevision === 0) return;
      const draft = useTerminalInputStore.getState().getDraftInput(terminalId, currentProject?.id);
      const view = editorViewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (draft !== current) {
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

    useVoiceDecorations({ terminalId, editorViewRef, voiceDraftRevision });

    const sendFromEditor = useCallback(() => {
      const view = editorViewRef.current;
      const latest = latestRef.current;
      const text = view?.state.doc.toString() ?? latest?.value ?? "";
      sendText(text);
    }, [sendText]);

    const { startVoiceWaitSubmit, cancelVoiceWaitSubmit } = useVoiceWaitSubmit({
      terminalId,
      editorViewRef,
      editableCompartmentRef,
      sendFromEditor,
    });

    const collapseEditor = useCallback(() => setIsExpanded(false), []);

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
        const result = latest.navigateHistory(
          latest.terminalId,
          direction,
          currentValue,
          latest.projectId
        );
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

        if (latest.activeMode === "terminal") {
          const ctx = getTerminalContext(currentValue, caret) ?? latest.terminalContext;
          if (!ctx) return;
          const token = `${item.value} `;
          const before = currentValue.slice(0, ctx.atStart);
          const after = currentValue.slice(ctx.tokenEnd);
          const nextValue = `${before}${token}${after}`;
          const nextCaret = before.length + token.length;
          applyEditorValue(nextValue, {
            selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
            focus: true,
          });
          setTerminalContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";
          return;
        }

        if (latest.activeMode === "selection") {
          const ctx = getSelectionContext(currentValue, caret) ?? latest.selectionContext;
          if (!ctx) return;
          const token = `${item.value} `;
          const before = currentValue.slice(0, ctx.atStart);
          const after = currentValue.slice(ctx.tokenEnd);
          const nextValue = `${before}${token}${after}`;
          const nextCaret = before.length + token.length;
          applyEditorValue(nextValue, {
            selection: EditorSelection.create([EditorSelection.cursor(nextCaret)]),
            focus: true,
          });
          setSelectionContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";
          return;
        }

        if (latest.activeMode === "diff") {
          const ctx = getDiffContext(currentValue, caret) ?? latest.diffContext;
          if (!ctx) return;
          const token = `${item.value} `;
          const before = currentValue.slice(0, ctx.atStart);
          const after = currentValue.slice(ctx.tokenEnd);
          const nextValue = `${before}${token}${after}`;
          const nextCaret = before.length + token.length;
          if (action === "execute") {
            sendText(nextValue);
            setDiffContext(null);
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
          setDiffContext(null);
          setAtContext(null);
          setSlashContext(null);
          setSelectedIndex(0);
          lastQueryRef.current = "";
          return;
        }

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
            setDiffContext(null);
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
          setDiffContext(null);
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
            setDiffContext(null);
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
          setDiffContext(null);
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
      (item: AutocompleteItem) => applyAutocompleteItem(item, "insert"),
      [applyAutocompleteItem]
    );

    const handleCommandExecuted = useCallback(
      (_commandId: string, result: CommandResult) => {
        if (result.success && result.prompt) {
          sendText(result.prompt);
        } else if (!result.success && result.error) {
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

    const { editorUpdateListener } = useContextDetection({
      latestRef,
      lastEmittedValueRef,
      isApplyingExternalValueRef,
      setValue,
      setAtContext,
      setSlashContext,
      setDiffContext,
      setTerminalContext,
      setSelectionContext,
    });

    const { keymapExtension, handleStash, handlePopStash } = useEditorKeymap({
      latestRef,
      editorViewRef,
      isComposingRef,
      handledEnterRef,
      editableCompartmentRef,
      historyPaletteOpenRef,
      applyAutocompleteSelection,
      handleHistoryNavigation,
      sendFromEditor,
      startVoiceWaitSubmit,
      cancelVoiceWaitSubmit,
      stashEditorState,
      popStashedEditorState,
      setAtContext,
      setSlashContext,
      setDiffContext,
      setIsExpanded,
      setSelectedIndex,
    });

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
            if (lastEnterKeydownNewlineRef.current) return false;
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
            if (useTerminalInputStore.getState().isVoiceSubmitting(latest.terminalId)) {
              event.preventDefault();
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
            const latest = latestRef.current;
            if (latest && useTerminalInputStore.getState().isVoiceSubmitting(latest.terminalId)) {
              return false;
            }
            setTimeout(sendFromEditor, 0);
            return false;
          },
          keydown: (event) => {
            const isEnter =
              event.key === "Enter" ||
              event.key === "Return" ||
              event.code === "Enter" ||
              event.code === "NumpadEnter";
            if (isEnter) lastEnterKeydownNewlineRef.current = event.shiftKey || event.altKey;
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
            if (latestRef.current?.isExpanded) return false;
            setAtContext(null);
            setSlashContext(null);
            setDiffContext(null);
            lastEnterKeydownNewlineRef.current = false;
            handledEnterRef.current = false;
            submitAfterCompositionRef.current = false;
            return false;
          },
        }),
      [applyAutocompleteSelection, sendFromEditor]
    );

    // --- Editor lifecycle ---

    useLayoutEffect(() => {
      const host = editorHostRef.current;
      if (!host) return;
      if (editorViewRef.current) return;

      const state = EditorState.create({
        doc: value,
        extensions: [
          themeCompartmentRef.current.of(buildInputBarTheme(effectiveTheme)),
          EditorView.lineWrapping,
          drawSelection(),
          createContentAttributes(),
          autoSizeCompartmentRef.current.of(createAutoSize()),
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
          diffChipField,
          diffChipTooltipCompartmentRef.current.of(!disabled ? createDiffChipTooltip() : []),
          terminalChipField,
          terminalChipTooltipCompartmentRef.current.of(
            !disabled ? createTerminalChipTooltip() : []
          ),
          selectionChipField,
          selectionChipTooltipCompartmentRef.current.of(
            !disabled ? createSelectionChipTooltip() : []
          ),
          interimMarkField,
          pendingAIField,
          keymapCompartmentRef.current.of(keymapExtension),
          editorUpdateListener,
          domEventHandlers,
          imagePasteExtension,
          filePasteExtension,
          plainPasteKeymap,
        ],
      });

      const view = new EditorView({ state, parent: host });
      editorViewRef.current = view;

      return () => {
        view.destroy();
        editorViewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Editor created once, updated via compartments
    }, [terminalId]);

    useEffect(() => {
      registerInputController(terminalId, { stash: handleStash, pop: handlePopStash });
      return () => unregisterInputController(terminalId);
    }, [terminalId, handleStash, handlePopStash]);

    // --- Compartment reconfigure effects ---

    // Compartment refs are stable (useRef inside useEditorCompartments) — intentionally omitted from deps.
    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartmentRef.current.reconfigure(buildInputBarTheme(effectiveTheme)),
      });
    }, [effectiveTheme]);

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
      view.dispatch({
        effects: diffChipTooltipCompartmentRef.current.reconfigure(
          !disabled ? createDiffChipTooltip() : []
        ),
      });
    }, [disabled]);
    /* eslint-enable react-hooks/exhaustive-deps */

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (value === current) return;
      isApplyingExternalValueRef.current = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }, [value]);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;
      const compactHost = compactEditorHostRef.current;
      const modalHost = modalEditorHostRef.current;

      if (isExpanded && modalHost) {
        modalHost.appendChild(view.dom);
        view.dispatch({ effects: autoSizeCompartmentRef.current.reconfigure([]) });
        view.dom.style.height = "";
        view.scrollDOM.style.overflowY = "auto";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            view.requestMeasure();
            view.focus();
          });
        });
      } else if (!isExpanded && compactHost) {
        compactHost.appendChild(view.dom);
        view.dispatch({ effects: autoSizeCompartmentRef.current.reconfigure(createAutoSize()) });
        view.dom.style.height = "";
        requestAnimationFrame(() => {
          view.requestMeasure();
          view.focus();
        });
      }
    }, [isExpanded]);

    const shellVars = {
      "--ib-bg": inputBarColors.shellBg,
      "--ib-border": inputBarColors.shellBorder,
      "--ib-border-hover": inputBarColors.shellBorderHover,
      "--ib-border-focus": inputBarColors.shellBorderFocus,
      "--ib-shadow": inputBarColors.shellShadow,
      "--ib-focus-ring": inputBarColors.shellFocusRing,
      "--ib-hover-bg": inputBarColors.shellHoverBg,
      "--ib-focus-bg": inputBarColors.shellFocusBg,
      "--ib-accent": inputBarColors.accent,
    } as React.CSSProperties;

    const isSpecialState = isVoiceActiveForPanel || isDragOverFiles;

    const specialStyle: React.CSSProperties | undefined = isVoiceActiveForPanel
      ? {
          borderColor: `color-mix(in oklab, ${inputBarColors.accent} 60%, transparent)`,
          backgroundColor: `color-mix(in oklab, ${inputBarColors.accent} 12%, ${inputBarColors.background})`,
          boxShadow: `0 0 0 1px color-mix(in oklab, ${inputBarColors.accent} 35%, transparent), 0 0 16px color-mix(in oklab, ${inputBarColors.accent} 15%, transparent)`,
        }
      : isDragOverFiles
        ? {
            borderColor: `color-mix(in oklab, ${inputBarColors.accent} 60%, transparent)`,
            backgroundColor: inputBarColors.shellBg,
            boxShadow: `0 0 0 1px color-mix(in oklab, ${inputBarColors.accent} 30%, transparent)`,
          }
        : undefined;

    const barContent = (
      <div
        className="group cursor-text px-3.5 pb-2.5 pt-2.5"
        style={{ backgroundColor: inputBarColors.background, ...shellVars }}
      >
        <div className="flex items-end gap-2">
          <div
            ref={inputShellRef}
            className={cn(
              "group/shell relative",
              "flex w-full items-center gap-1.5 rounded-sm border py-2 transition-[border-color,background-color,box-shadow] duration-150",
              !isSpecialState && [
                "bg-[var(--ib-bg)] border-[var(--ib-border)] shadow-[var(--ib-shadow)]",
                "hover:border-[var(--ib-border-hover)] hover:bg-[var(--ib-hover-bg)]",
                "focus-within:border-[var(--ib-border-focus)] focus-within:ring-1 focus-within:ring-[var(--ib-focus-ring)] focus-within:bg-[var(--ib-focus-bg)]",
              ],
              disabled && "opacity-60"
            )}
            style={specialStyle}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
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
              ariaLabel={
                activeMode === "command"
                  ? "Command autocomplete"
                  : activeMode === "terminal"
                    ? "Terminal autocomplete"
                    : activeMode === "selection"
                      ? "Selection autocomplete"
                      : activeMode === "diff"
                        ? "Diff autocomplete"
                        : "File autocomplete"
              }
            />
            {isDragOverFiles && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-sm bg-canopy-bg/80 pointer-events-none">
                <span className="text-xs font-medium text-canopy-accent">Drop to attach</span>
              </div>
            )}
            {isVoiceSubmitting && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-sm bg-canopy-bg/80 pointer-events-none">
                <Loader2 className="h-4 w-4 animate-spin text-canopy-accent" />
              </div>
            )}
            <button
              type="button"
              onClick={openPicker}
              disabled={disabled}
              className="select-none pl-2 pr-1 font-mono text-xs font-semibold leading-5 text-canopy-accent/65 hover:text-canopy-accent/85 transition-colors cursor-pointer focus-visible:outline-none"
              aria-label="Open command picker"
            >
              ❯
            </button>
            <div className="relative flex-1">
              <div
                ref={(node) => {
                  editorHostRef.current = node;
                  compactEditorHostRef.current = node;
                }}
                className={cn("w-full min-h-[20px]", disabled && "pointer-events-none")}
                style={{ color: inputBarColors.foreground }}
              />
            </div>
            <div className="flex items-center pr-1.5">
              {hasStash && (
                <button
                  type="button"
                  onClick={handlePopStash}
                  className="flex items-center justify-center h-5 w-5 rounded-sm text-canopy-accent/55 hover:text-canopy-accent/80 hover:bg-tint/[0.06] transition-colors cursor-pointer"
                  aria-label="Restore stashed input"
                  title="Restore stashed input (⌘⇧X)"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              )}
              <VoiceInputButton
                panelId={terminalId}
                panelTitle={agentId ? getAgentConfig(agentId)?.name : undefined}
                projectId={currentProject?.id}
                projectName={currentProject?.name}
                worktreeId={panelWorktreeId}
                worktreeLabel={
                  panelWorktree?.isMainWorktree
                    ? panelWorktree?.name
                    : panelWorktree?.branch || panelWorktree?.name
                }
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
        <AppDialog
          isOpen={isExpanded}
          onClose={collapseEditor}
          size="xl"
          maxHeight="max-h-[70vh]"
          dismissible
        >
          <AppDialog.Header>
            <AppDialog.Title>Expanded Editor</AppDialog.Title>
            <AppDialog.CloseButton />
          </AppDialog.Header>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div
              ref={modalEditorHostRef}
              className="flex-1 min-h-[200px] overflow-auto text-canopy-text p-4"
            />
          </div>
        </AppDialog>
        {isFocusedTerminal && (
          <PromptHistoryPalette
            terminalId={terminalId}
            projectId={projectId}
            onOpenRef={historyPaletteOpenRef}
          />
        )}
      </>
    );
  }
);

HybridInputBar.displayName = "HybridInputBar";
