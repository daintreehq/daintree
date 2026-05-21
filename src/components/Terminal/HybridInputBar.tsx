import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { AgentState } from "@/types";
import { logError } from "@/utils/logger";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";
import { useFileAutocomplete } from "@/hooks/useFileAutocomplete";
import { useSlashCommandAutocomplete } from "@/hooks/useSlashCommandAutocomplete";
import { useSlashCommandList } from "@/hooks/useSlashCommandList";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { AutocompleteMenu, type AutocompleteItem } from "./AutocompleteMenu";
import {
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
import { usePanelStore, useVoiceRecordingStore } from "@/store";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { tryFleetBroadcastFromEditor } from "@/components/Fleet/fleetEnterBroadcast";

import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { VoiceInputButton } from "./VoiceInputButton";
import { Archive, Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useVoiceWaitSubmit } from "./hooks/useVoiceWaitSubmit";
import { registerInputController, unregisterInputController } from "@/store/terminalInputStore";
import type { CommandResult } from "@shared/types/commands";
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
import { useCompartmentDriver } from "./hooks/useCompartmentDriver";
import { usePasteExtensions } from "./hooks/usePasteExtensions";
import { useAutocompleteState } from "./hooks/useAutocompleteState";
import { useAutocompletePositioning } from "./hooks/useAutocompletePositioning";
import { useAutocompleteApply } from "./hooks/useAutocompleteApply";
import { useFleetMirror } from "./hooks/useFleetMirror";
import { useEditorDomHandlers } from "./hooks/useEditorDomHandlers";
import { useEditorFactory } from "./hooks/useEditorFactory";
import { useHostReparent } from "./hooks/useHostReparent";

export interface HybridInputBarHandle {
  focus: () => void;
  focusWithCursorAtEnd: () => void;
  cancelPendingFocus: () => void;
}

export interface HybridInputBarProps {
  terminalId: string;
  onSend: (payload: { data: string; trackerData: string; text: string }) => void;
  onSendKey?: (key: string) => void;
  onActivate?: () => void;
  cwd: string;
  agentId?: BuiltInAgentId;
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
    const isFocusedTerminal = usePanelStore((s) => s.focusedId === terminalId);
    const hasStash = useTerminalInputStore((s) => {
      const key = projectId ? `${projectId}:${terminalId}` : terminalId;
      return s.stashedEditorStates.has(key);
    });
    const popStashShortcut = useKeybindingDisplay("terminal.popStash");
    const [value, setValue] = useState(() => getDraftInput(terminalId, projectId));
    const submitAfterCompositionRef = useRef(false);
    const isComposingRef = useRef(false);
    const editorHostRef = useRef<HTMLDivElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    const modalEditorHostRef = useRef<HTMLDivElement | null>(null);
    const compactEditorHostRef = useRef<HTMLDivElement | null>(null);
    const lastEnterKeydownNewlineRef = useRef(false);
    const handledEnterRef = useRef(false);
    const historyPaletteOpenRef = useRef<(() => void) | null>(null);
    const inputShellRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const lastEmittedValueRef = useRef<string>(value);
    const focusGenerationRef = useRef(0);
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
    const panelWorktreeId = usePanelStore((s) => s.panelsById[terminalId]?.worktreeId);
    const panelWorktree = useWorktreeStore((s) =>
      panelWorktreeId ? s.worktrees.get(panelWorktreeId) : undefined
    );
    const isVoiceRecording = activeVoicePanelId === terminalId && voiceStatus === "recording";
    const isVoiceConnecting = activeVoicePanelId === terminalId && voiceStatus === "connecting";
    const isVoiceFinishing = activeVoicePanelId === terminalId && voiceStatus === "finishing";
    const isVoiceActiveForPanel = isVoiceRecording || isVoiceConnecting || isVoiceFinishing;
    const isVoiceSubmitting = useTerminalInputStore((s) => s.voiceSubmittingPanels.has(terminalId));

    const commandContext = { terminalId, cwd, projectId };

    const isAgentTerminal = agentId !== undefined;

    // --- Terminal color scheme ---
    useAppThemeStore((s) => s.selectedSchemeId);
    const effectiveTheme = useTerminalColorSchemeStore(selectEffectiveTheme);
    const inputBarColors = resolveInputBarColors(effectiveTheme);

    // --- Extracted hooks ---

    const compartments = useEditorCompartments();
    const {
      placeholderCompartmentRef,

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

    const { imagePasteExtension, filePasteExtension, plainPasteKeymap } = usePasteExtensions();

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

    // Fleet hybrid-input mirroring
    const armedIds = useFleetArmingStore((s) => s.armedIds);
    const isArmed = armedIds.has(terminalId);
    const fleetSize = armedIds.size;
    const isFleetPrimary = isFocusedTerminal && isArmed && fleetSize >= 2;
    const isFleetFollower = !isFocusedTerminal && isArmed && fleetSize >= 2;

    const { isApplyingExternalValueRef } = useFleetMirror({
      editorViewRef,
      terminalId,
      projectId,
      value,
      setValue,
      isFleetPrimary,
      isFleetFollower,
      disabled,
      lastEmittedValueRef,
    });

    const placeholder = (() => {
      const agentName = agentId ? getAgentConfig(agentId)?.name : null;
      return agentName ? `Ask ${agentName}` : "Ask anything";
    })();

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

    useEffect(() => {
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
    });

    useAutocompletePositioning({
      editorViewRef,
      inputShellRef,
      menuRef,
      isAutocompleteOpen,
      activeMode,
      atContext,
      slashContext,
      diffContext,
      terminalContext,
      selectionContext,
      setMenuLeftPx,
    });

    useAutocompleteState({
      isAutocompleteOpen,
      activeMode,
      atContext,
      slashContext,
      diffContext,
      terminalContext,
      selectionContext,
      autocompleteItemsLength: autocompleteItems.length,
      rootRef,
      selectedIndex,
      setSelectedIndex,
      lastQueryRef,
      setAtContext,
      setSlashContext,
      setDiffContext,
      setTerminalContext,
      setSelectionContext,
    });

    const applyEditorValue = (
      nextValue: string,
      options?: { selection?: EditorSelection; focus?: boolean }
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
      if (shouldChangeDoc) isApplyingExternalValueRef.current = true;
      view.dispatch({
        ...(shouldChangeDoc
          ? { changes: { from: 0, to: view.state.doc.length, insert: nextValue } }
          : {}),
        ...(shouldChangeSelection ? { selection: options?.selection } : {}),
        scrollIntoView: true,
      });
      if (options?.focus) view.focus();
    };

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

    const resetEditorDoc = () => {
      applyEditorValue("", {
        selection: EditorSelection.create([EditorSelection.cursor(0)]),
      });
    };

    const sendFromEditor = () => {
      const view = editorViewRef.current;
      const latest = latestRef.current;
      const text = view?.state.doc.toString() ?? latest?.value ?? "";

      if (
        isFocusedTerminal &&
        useFleetArmingStore.getState().armedIds.has(terminalId) &&
        useFleetArmingStore.getState().armedIds.size >= 2
      ) {
        const intercepted = tryFleetBroadcastFromEditor(terminalId, text, () => {
          clearDraftInput(terminalId, projectId);
          resetEditorDoc();
        });
        if (intercepted) return;
      }

      sendText(text);
    };

    const { startVoiceWaitSubmit, cancelVoiceWaitSubmit } = useVoiceWaitSubmit({
      terminalId,
      editorViewRef,
      editableCompartmentRef,
      sendFromEditor,
    });

    const collapseEditor = () => setIsExpanded(false);

    const focusEditor = () => {
      const view = editorViewRef.current;
      if (!view) return;
      view.focus();
      const gen = focusGenerationRef.current;
      requestAnimationFrame(() => {
        if (focusGenerationRef.current !== gen) return;
        if (editorViewRef.current !== view) return;
        if (usePanelStore.getState().preferredTerminalFocusTarget !== "hybridInput") return;
        view.focus();
      });
    };

    const handleHistoryNavigation = (direction: "up" | "down"): boolean => {
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
    };

    const { applyAutocompleteSelection, handleAutocompleteSelect } = useAutocompleteApply({
      editorViewRef,
      latestRef,
      lastQueryRef,
      applyEditorValue,
      sendText,
      setAtContext,
      setSlashContext,
      setDiffContext,
      setTerminalContext,
      setSelectionContext,
      setSelectedIndex,
    });

    const handleCommandExecuted = (_commandId: string, result: CommandResult) => {
      if (result.success && result.prompt) {
        sendText(result.prompt);
      } else if (!result.success && result.error) {
        logError("[HybridInputBar] Command execution failed", result.error);
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        focus: focusEditor,
        focusWithCursorAtEnd: () => {
          const view = editorViewRef.current;
          if (!view) return;
          const gen = focusGenerationRef.current;
          requestAnimationFrame(() => {
            if (focusGenerationRef.current !== gen) return;
            if (editorViewRef.current !== view) return;
            if (usePanelStore.getState().preferredTerminalFocusTarget !== "hybridInput") return;
            view.dispatch({
              selection: EditorSelection.cursor(view.state.doc.length),
              scrollIntoView: true,
            });
            view.focus();
          });
        },
        cancelPendingFocus: () => {
          focusGenerationRef.current += 1;
        },
      }),
      [focusEditor]
    );

    const { handleUpdateRef: contextUpdateRef } = useContextDetection({
      latestRef,
      applyDocChange: (next) => {
        if (next === lastEmittedValueRef.current) return false;
        lastEmittedValueRef.current = next;
        setValue(next);
        return true;
      },
      consumeExternalValueFlag: () => {
        if (!isApplyingExternalValueRef.current) return false;
        isApplyingExternalValueRef.current = false;
        return true;
      },
      setAtContext,
      setSlashContext,
      setDiffContext,
      setTerminalContext,
      setSelectionContext,
    });

    const {
      handlersRef: keymapHandlersRef,
      handleStash,
      handlePopStash,
    } = useEditorKeymap({
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

    // --- Editor lifecycle ---

    const domEventHandlers = useEditorDomHandlers({
      latestRef,
      editorViewRef,
      isComposingRef,
      handledEnterRef,
      lastEnterKeydownNewlineRef,
      submitAfterCompositionRef,
      applyAutocompleteSelection,
      sendFromEditor,
      rootRef,
      setAtContext,
      setSlashContext,
      setDiffContext,
    });

    useEditorFactory({
      terminalId,
      editorHostRef,
      editorViewRef,
      value,
      disabled,
      placeholder,
      effectiveTheme,
      commandMap,
      compartments,
      contextUpdateRef,
      keymapHandlersRef,
      domEventHandlers,
      imagePasteExtension,
      filePasteExtension,
      plainPasteKeymap,
    });

    useEffect(() => {
      registerInputController(terminalId, { stash: handleStash, pop: handlePopStash });
      return () => unregisterInputController(terminalId);
    }, [terminalId, handleStash, handlePopStash]);

    // --- Compartment reconfigure effects ---

    useCompartmentDriver({
      editorViewRef,
      themeCompartmentRef,
      effectiveTheme,
      placeholderCompartmentRef,
      placeholder,
      editableCompartmentRef,
      disabled,
      chipCompartmentRef,
      commandMap,
      tooltipCompartmentRef,
      fileChipTooltipCompartmentRef,
      imageChipTooltipCompartmentRef,
      fileDropChipTooltipCompartmentRef,
      diffChipTooltipCompartmentRef,
      terminalChipTooltipCompartmentRef,
      selectionChipTooltipCompartmentRef,
      isAutocompleteOpen,
    });

    // Sync external value changes to editor doc
    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (value === current) return;
      isApplyingExternalValueRef.current = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }, [value]);

    // --- Host reparent (modal vs compact) ---

    useHostReparent({
      editorViewRef,
      compactEditorHostRef,
      modalEditorHostRef,
      autoSizeCompartmentRef,
      isExpanded,
    });

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
        className="relative group cursor-text px-3.5 pb-2.5 pt-2.5"
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
              emptyMessage={
                activeMode === "command"
                  ? "No commands match"
                  : activeMode === "file"
                    ? "No files match"
                    : activeMode === "terminal"
                      ? "No terminals match"
                      : "No matches"
              }
            />
            {isDragOverFiles && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-sm bg-daintree-bg/80 pointer-events-none">
                <span className="text-xs font-medium text-daintree-accent">Drop to attach</span>
              </div>
            )}
            {isVoiceSubmitting && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-sm bg-daintree-bg/80 pointer-events-none">
                <Loader2 className="h-4 w-4 animate-spin text-daintree-accent" />
              </div>
            )}
            <button
              type="button"
              onClick={openPicker}
              disabled={disabled}
              className="select-none pl-2 pr-1 font-mono text-xs font-semibold leading-5 text-daintree-accent/65 hover:text-daintree-accent/85 transition-colors cursor-pointer focus-visible:outline-hidden"
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handlePopStash}
                      className="flex items-center justify-center h-5 w-5 rounded-sm text-daintree-accent/55 hover:text-daintree-accent/80 hover:bg-tint/[0.06] transition-colors cursor-pointer"
                      aria-label="Restore stashed input"
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {createTooltipContent("Restore stashed input", popStashShortcut)}
                  </TooltipContent>
                </Tooltip>
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
              className="flex-1 min-h-[200px] overflow-auto text-daintree-text p-4"
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
