import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { AutocompleteMenu, type AutocompleteItem } from "./AutocompleteMenu";
import {
  getDaintreeAtClaim,
  fileSearchQuery,
  type ActiveCompletionContext,
} from "./hybridInputParsing";
import type { CompletionTrigger } from "@shared/types";
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
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SelectedFileMenuItems } from "./SelectedFileMenuItems";
import { resolveSelectedFilePath } from "@/services/terminal/filePathDetection";
import { composeDraftWithInstruction } from "@/services/terminal/worktreeMoveInstruction";

export interface HybridInputBarHandle {
  focus: () => void;
  /** Returns whether an editor was mounted to take the focus. */
  focusWithCursorAtEnd: () => boolean;
  cancelPendingFocus: () => void;
  /**
   * Submit the live draft with `instruction` appended, through `submit` rather
   * than the pane's fire-and-forget send, and report whether the terminal took
   * it (#11867).
   *
   * The composed text comes from the mounted CodeMirror document, never from
   * the draft store: an external write syncs into the editor in a later effect,
   * so a caller that wrote the store and read it back in the same click stack
   * would compose against the previous draft.
   *
   * Calls `sendText`, not `sendFromEditor`, which is what keeps this strictly
   * panel-specific — the fleet-broadcast branch lives in `sendFromEditor` and
   * is unreachable from here by construction rather than by a flag.
   */
  submitWithInstruction: (
    instruction: string,
    submit: (text: string) => Promise<boolean>
  ) => Promise<boolean>;
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
  isAgentTerminal: boolean;
  isInHistoryMode: boolean;
  isAutocompleteOpen: boolean;
  autocompleteItems: AutocompleteItem[];
  staleItemKeys: ReadonlySet<string>;
  selectedIndex: number;
  value: string;
  activeCompletionContext: ActiveCompletionContext | null;
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

interface HybridInputE2EController {
  setText: (text: string) => void;
  getText: () => string;
}

type ApplyEditorValue = (
  nextValue: string,
  options?: { selection?: EditorSelection; focus?: boolean }
) => void;

const EMPTY_STALE_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Whether the editor holds the caret, judged by the DOM rather than by
 * `view.hasFocus` — CodeMirror reports false there whenever the window is
 * blurred, even though the editor is still `document.activeElement`.
 */
function editorOwnsDomFocus(view: EditorView): boolean {
  return view.contentDOM.contains(document.activeElement);
}

const hybridInputE2EControllers = new Map<string, HybridInputE2EController>();

function installHybridInputE2EBridge(): void {
  if (!window.__DAINTREE_E2E_MODE__) return;
  if (window.__daintreeHybridInputE2E) return;
  window.__daintreeHybridInputE2E = {
    setText: (terminalId, text) => {
      const controller = hybridInputE2EControllers.get(terminalId);
      if (!controller) return false;
      controller.setText(text);
      return true;
    },
    getText: (terminalId) => hybridInputE2EControllers.get(terminalId)?.getText() ?? null,
    listIds: () => [...hybridInputE2EControllers.keys()],
  };
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
    // Absolute path the current selection resolves to, captured on right-click.
    // Gates the "View file" / "Open folder" context-menu section.
    const [selectionFilePath, setSelectionFilePath] = useState<string | null>(null);
    const lastEnterKeydownNewlineRef = useRef(false);
    const handledEnterRef = useRef(false);
    const historyPaletteOpenRef = useRef<(() => void) | null>(null);
    const inputShellRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const lastEmittedValueRef = useRef<string>(value);
    const focusGenerationRef = useRef(0);
    const [activeCompletionContext, setActiveCompletionContext] =
      useState<ActiveCompletionContext | null>(null);

    const [selectedIndex, setSelectedIndex] = useState(0);
    const lastQueryRef = useRef<string>("");
    const [menuLeftPx, setMenuLeftPx] = useState<number>(0);
    const [initializationState, setInitializationState] = useState<"initializing" | "initialized">(
      "initializing"
    );
    const latestRef = useRef<LatestState | null>(null);
    const applyEditorValueRef = useRef<ApplyEditorValue>(() => {});

    const openPicker = useCommandStore((s) => s.openPicker);
    const currentProject = useProjectStore((s) => s.currentProject);
    const voiceStatus = useVoiceRecordingStore((s) => s.status);
    const activeVoicePanelId = useVoiceRecordingStore((s) => s.activeTarget?.panelId ?? null);
    const externalDraftRevision = useTerminalInputStore((s) => s.externalDraftRevision);
    const panelWorktreeId = usePanelStore((s) => s.panelsById[terminalId]?.worktreeId);
    const panelWorktree = useWorktreeStore((s) =>
      panelWorktreeId ? s.worktrees.get(panelWorktreeId) : undefined
    );
    const isVoiceRecording = activeVoicePanelId === terminalId && voiceStatus === "recording";
    const isVoiceConnecting = activeVoicePanelId === terminalId && voiceStatus === "connecting";
    const isVoiceReconnecting = activeVoicePanelId === terminalId && voiceStatus === "reconnecting";
    const isVoiceFinishing = activeVoicePanelId === terminalId && voiceStatus === "finishing";
    const isVoicePaused = activeVoicePanelId === terminalId && voiceStatus === "paused";
    const isVoiceActiveForPanel =
      isVoiceRecording ||
      isVoiceConnecting ||
      isVoiceReconnecting ||
      isVoiceFinishing ||
      isVoicePaused;
    const isVoiceSubmitting = useTerminalInputStore((s) => s.voiceSubmittingPanels.has(terminalId));

    const commandContext = { terminalId, cwd, projectId };

    const isAgentTerminal = agentId !== undefined;

    // --- Terminal color scheme ---
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

    // `onActivate` is the same pane-selection callback the pointer handlers
    // below fire, so a drop lands the pane in exactly the state a click on the
    // bar would (#11809). Called with no argument, which is what keeps the
    // shift/cmd fleet gestures a click carries out of a drop. Absent for the
    // Assistant, whose input bar owns no selectable pane.
    const { handleDragEnter, handleDragOver, handleDragLeave, handleDrop, isDragOverFiles } =
      useDragDrop(editorViewRef, cwd, onActivate);

    const { imagePasteExtension, filePasteExtension, plainPasteKeymap } = usePasteExtensions(cwd);

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
      setActiveCompletionContext(null);
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
      if (isVoicePaused) return "Paused · Resume to continue.";
      const agentName = agentId ? getAgentConfig(agentId)?.name : null;
      return agentName ? `Ask ${agentName}` : "Ask anything";
    })();

    // Trigger chars that open a menu, data-driven from the agent's declared
    // completionSources — `/` and Daintree's `@` are always available; `$`
    // (Codex capabilities) is added only when the agent declares a `$` source.
    const activeTriggers = useMemo(() => {
      const triggers = new Set<CompletionTrigger>(["/", "@"]);
      for (const source of agentId ? (getAgentConfig(agentId)?.completionSources ?? []) : []) {
        triggers.add(source.trigger);
      }
      return triggers;
    }, [agentId]);

    const triggerChar = activeCompletionContext?.triggerChar ?? null;
    // Which Daintree `@` provider claims the query (else `@file` fallback).
    const atClaim =
      triggerChar === "@" ? getDaintreeAtClaim(activeCompletionContext?.query ?? "") : null;
    const isFileMode = triggerChar === "@" && atClaim === null;
    const isAutocompleteOpen = activeCompletionContext !== null && !disabled;

    const fileQuery = isFileMode ? fileSearchQuery(activeCompletionContext?.query ?? "") : "";
    const {
      files: autocompleteFiles,
      isLoading: isAutocompleteLoading,
      resultsQuery: fileResultsQuery,
    } = useFileAutocomplete({
      cwd,
      query: fileQuery,
      enabled: isAutocompleteOpen && isFileMode,
      limit: 50,
    });

    const { items: autocompleteCommands, isLoading: isCommandsLoading } =
      useSlashCommandAutocomplete({
        query: activeCompletionContext?.query ?? "",
        enabled: isAutocompleteOpen && (triggerChar === "/" || triggerChar === "$"),
        trigger: triggerChar === "$" ? "$" : "/",
        agentId,
        projectPath: cwd,
      });

    const { commandMap } = useSlashCommandList({ agentId, projectPath: cwd });

    const { autocompleteItems, isLoading } = useAutocompleteItems({
      activeCompletionContext,
      autocompleteFiles,
      isAutocompleteLoading,
      autocompleteCommands,
      isCommandsLoading,
    });

    // Per-provider staleness: only the debounced async `@file` search can go
    // stale. Its item keys ARE the file paths, so a stale file search dims only
    // those rows — never a fresh `$` or static `@diff` list.
    const isFileStale = isFileMode && fileResultsQuery !== fileQuery;
    const staleItemKeys = useMemo(
      () => (isFileStale ? new Set(autocompleteFiles) : EMPTY_STALE_KEYS),
      [isFileStale, autocompleteFiles]
    );

    useEffect(() => {
      latestRef.current = {
        terminalId,
        projectId,
        disabled,
        isInitializing,
        isAgentTerminal,
        isInHistoryMode,
        isAutocompleteOpen,
        autocompleteItems,
        staleItemKeys,
        selectedIndex,
        value,
        activeCompletionContext,
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
      activeCompletionContext,
      setMenuLeftPx,
    });

    useAutocompleteState({
      isAutocompleteOpen,
      activeCompletionContext,
      autocompleteItems,
      rootRef,
      selectedIndex,
      setSelectedIndex,
      lastQueryRef,
      setActiveCompletionContext,
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

    useEffect(() => {
      applyEditorValueRef.current = applyEditorValue;
    });

    useEffect(() => {
      if (!window.__DAINTREE_E2E_MODE__) return;
      installHybridInputE2EBridge();
      hybridInputE2EControllers.set(terminalId, {
        setText: (text) =>
          applyEditorValueRef.current(text, {
            selection: EditorSelection.create([EditorSelection.cursor(text.length)]),
            focus: true,
          }),
        getText: () => editorViewRef.current?.state.doc.toString() ?? lastEmittedValueRef.current,
      });
      return () => {
        hybridInputE2EControllers.delete(terminalId);
      };
    }, [terminalId]);

    const { sendText } = useTokenResolution({
      latestRef,
      applyEditorValue,
      setIsExpanded,
      setActiveCompletionContext,
      terminalId,
      cwd,
      agentId,
    });

    useEffect(() => {
      if (externalDraftRevision === 0) return;
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
    }, [externalDraftRevision, terminalId, currentProject?.id]);

    useVoiceDecorations({ terminalId, editorViewRef });

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

    // Claim focus on mount: TerminalPane's one-shot focus RAF may have no-opped
    // against a null ref if this lazy chunk wasn't loaded yet, leaving focus on
    // the launching AgentButton where Enter spawns a duplicate agent. See #10541.
    // Route through a ref so the mount effect reads the latest claim logic without
    // re-running on every render (and without a react-hooks suppression).
    const claimMountFocusRef = useRef<() => void>(() => {});
    useEffect(() => {
      claimMountFocusRef.current = () => {
        if (!isFocusedTerminal) return;
        if (usePanelStore.getState().preferredTerminalFocusTarget !== "hybridInput") return;
        focusEditor();
      };
    });
    useEffect(() => {
      claimMountFocusRef.current();
    }, []);

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
      setActiveCompletionContext,
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
          // No mounted editor (lazy CodeMirror still loading) means nothing can
          // take focus — say so rather than let the caller assume it landed.
          if (!view) return false;
          // Already holding the keyboard: callers want focus, not a caret move.
          // Re-running the cursor dispatch would drag the caret to the end of the
          // draft from wherever the user just clicked (#11133). Ownership is read
          // from the DOM rather than `view.hasFocus`, which reports false whenever
          // the window itself is blurred even though the editor still holds the
          // caret — a background state change would otherwise move it.
          if (editorOwnsDomFocus(view)) return true;
          const gen = focusGenerationRef.current;
          requestAnimationFrame(() => {
            if (focusGenerationRef.current !== gen) return;
            if (editorViewRef.current !== view) return;
            if (usePanelStore.getState().preferredTerminalFocusTarget !== "hybridInput") return;
            // The user can click into the draft between the call and this frame.
            if (editorOwnsDomFocus(view)) return;
            view.dispatch({
              selection: EditorSelection.cursor(view.state.doc.length),
              scrollIntoView: true,
            });
            view.focus();
          });
          return true;
        },
        cancelPendingFocus: () => {
          focusGenerationRef.current += 1;
        },
        submitWithInstruction: async (instruction, submit) => {
          const view = editorViewRef.current;
          const latest = latestRef.current;
          // "Mounted and usable", not "rendered": the editor loads lazily, and
          // a bar that cannot take the user's own Enter cannot take this
          // either. Say no and let the caller keep its banner up.
          if (!view || !latest || latest.disabled) return false;
          const snapshot = view.state.doc.toString();
          return sendText(snapshot, {
            compose: (draft) => composeDraftWithInstruction(draft, instruction),
            submit,
            // What was sent is a snapshot; what is on screen when the submit
            // finally lands may not be. Only the snapshot is ours to clear.
            isDraftUnchanged: () => editorViewRef.current?.state.doc.toString() === snapshot,
          });
        },
      }),
      [focusEditor, sendText]
    );

    // Claim the type-anywhere routing target (#11134) whenever the user really
    // types here. Agent panels only — `agentId` is absent for the fleet-armed
    // raw-shell branch of `shouldShowHybridInputBar`, and routing into a shell
    // is exactly what the rescue must never do. While a broadcast is live the
    // user typed to a fleet, not to one agent, so claim nothing.
    const recordTypedTarget = () => {
      if (agentId === undefined) return;
      if (useFleetArmingStore.getState().armedIds.size >= 2) return;
      const workspaceId = getViewWorkspaceId();
      if (workspaceId === null) return;
      useTerminalInputStore.getState().recordLastTypedAgentTarget(terminalId, workspaceId);
    };

    const { handleUpdateRef: contextUpdateRef } = useContextDetection({
      latestRef,
      activeTriggers,
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
      setActiveCompletionContext,
      onUserType: recordTypedTarget,
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
      setActiveCompletionContext,
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
      setActiveCompletionContext,
    });

    // Right-click gate for the composer's file-path menu. Read the selection
    // synchronously from the live EditorView, resolve it against the terminal's
    // cwd, and only let Radix open its menu when it resolves to a path —
    // otherwise preventDefault so no empty menu appears. When not prevented,
    // the batched setState lands before Radix renders the (portalled) content,
    // so the items are present the moment the menu opens.
    const handleEditorContextMenu = useCallback(
      (event: React.MouseEvent) => {
        const view = editorViewRef.current;
        let resolvedPath: string | null = null;
        if (view) {
          const { from, to } = view.state.selection.main;
          if (from !== to) {
            resolvedPath =
              resolveSelectedFilePath(view.state.sliceDoc(from, to), cwd)?.absolutePath ?? null;
          }
        }
        setSelectionFilePath(resolvedPath);
        if (!resolvedPath) event.preventDefault();
      },
      [cwd]
    );

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

    const isSpecialState = isVoiceActiveForPanel || isDragOverFiles || isFleetPrimary;

    // Fleet-primary uses the same amber family as FleetDraftingPill so the
    // shell itself says "Enter broadcasts" at the point of typing.
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
        : isFleetPrimary
          ? {
              borderColor: "color-mix(in oklab, var(--color-category-amber) 55%, transparent)",
              backgroundColor: inputBarColors.shellBg,
              boxShadow:
                "0 0 0 1px color-mix(in oklab, var(--color-category-amber) 22%, transparent)",
            }
          : undefined;

    const barContent = (
      <div
        className="relative group cursor-text px-3.5 pb-2.5 pt-2.5"
        // Anchors the type-anywhere rescue (#11134): marks this subtree as a
        // real typing surface, and lets the rescue verify focus actually landed
        // here rather than trusting a handle's boolean return.
        data-hybrid-input-root={terminalId}
        style={{ backgroundColor: inputBarColors.background, ...shellVars }}
      >
        <div className="flex items-end gap-2">
          <div
            ref={inputShellRef}
            className={cn(
              "group/shell relative",
              "flex w-full items-center gap-1.5 rounded-md border py-2 transition-[border-color,background-color,box-shadow] duration-150",
              !isSpecialState && [
                "bg-[var(--ib-bg)] border-[var(--ib-border)] shadow-[var(--ib-shadow)]",
                "hover:border-[var(--ib-border-hover)] hover:bg-[var(--ib-hover-bg)]",
                "focus-within:border-[var(--ib-border-focus)] focus-within:ring-1 focus-within:ring-[var(--ib-focus-ring)] focus-within:bg-[var(--ib-focus-bg)]",
              ],
              disabled && "opacity-60"
            )}
            data-voice-active={isVoiceActiveForPanel ? "true" : undefined}
            data-fleet-armed={isFleetPrimary ? "true" : undefined}
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
              staleKeys={staleItemKeys}
              onSelect={handleAutocompleteSelect}
              style={{ left: `${menuLeftPx}px` }}
              title={
                triggerChar === "/"
                  ? "Commands"
                  : triggerChar === "$"
                    ? "Capabilities"
                    : atClaim === "terminal"
                      ? "Terminal output"
                      : atClaim === "selection"
                        ? "Terminal selection"
                        : atClaim === "diff"
                          ? "Diffs"
                          : "Files"
              }
              keyHint={
                autocompleteItems[selectedIndex]?.enterAction === "execute"
                  ? "↵ run · ⇥ complete"
                  : "↵ insert"
              }
              ariaLabel={
                triggerChar === "/"
                  ? "Command autocomplete"
                  : triggerChar === "$"
                    ? "Capability autocomplete"
                    : atClaim === "terminal"
                      ? "Terminal autocomplete"
                      : atClaim === "selection"
                        ? "Selection autocomplete"
                        : atClaim === "diff"
                          ? "Diff autocomplete"
                          : "File autocomplete"
              }
              emptyMessage={
                triggerChar === "/"
                  ? "No commands match"
                  : triggerChar === "$"
                    ? "No capabilities match"
                    : isFileMode
                      ? "No files match"
                      : "No matches"
              }
            />
            {isDragOverFiles && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-daintree-bg/80 pointer-events-none">
                <span className="text-xs font-medium text-daintree-accent">Drop to attach</span>
              </div>
            )}
            {isVoiceSubmitting && (
              <div
                role="status"
                aria-live="polite"
                className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-md bg-daintree-bg/80 pointer-events-none"
              >
                <Loader2 className="h-4 w-4 animate-spin text-daintree-accent" />
                <span className="text-xs text-daintree-text/70">Finishing dictation…</span>
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
            <ContextMenu>
              <ContextMenuTrigger asChild onContextMenu={handleEditorContextMenu}>
                <div className="relative flex-1">
                  <div
                    ref={(node) => {
                      editorHostRef.current = node;
                      compactEditorHostRef.current = node;
                      // The Radix trigger swaps element type (Slot → Trigger)
                      // when its lazy chunk resolves, remounting this host node
                      // and orphaning CodeMirror's imperatively-attached DOM.
                      // Re-adopt the editor only when it is genuinely detached
                      // (isConnected === false) so the normal expand/collapse
                      // reparent in useHostReparent is left untouched. The modal
                      // host carries the mirror-image guard.
                      const view = editorViewRef.current;
                      if (node && view && !isExpanded && !view.dom.isConnected) {
                        node.appendChild(view.dom);
                      }
                    }}
                    className={cn("w-full min-h-[20px]", disabled && "pointer-events-none")}
                    style={{ color: inputBarColors.foreground }}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {selectionFilePath && <SelectedFileMenuItems absolutePath={selectionFilePath} />}
              </ContextMenuContent>
            </ContextMenu>
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
          size="5xl"
          maxHeight="max-h-[70vh]"
          dismissible
        >
          <AppDialog.Header>
            <AppDialog.Title>Expanded Editor</AppDialog.Title>
            <AppDialog.CloseButton />
          </AppDialog.Header>
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <ContextMenu>
              <ContextMenuTrigger asChild onContextMenu={handleEditorContextMenu}>
                <div
                  ref={(node) => {
                    modalEditorHostRef.current = node;
                    // Mirror of the compact host's guard: AppDialog is not a
                    // Radix consumer, so this trigger can also mount in the
                    // Slot state and remount (orphaning the editor) when the
                    // chunk resolves. Re-adopt only when detached so the normal
                    // reparent is untouched; this also closes the AppDialog
                    // mount-order gap where the reparent effect could run
                    // before this host exists.
                    const view = editorViewRef.current;
                    if (node && view && isExpanded && !view.dom.isConnected) {
                      node.appendChild(view.dom);
                    }
                  }}
                  className="flex-1 min-h-[200px] overflow-auto text-daintree-text p-4"
                />
              </ContextMenuTrigger>
              <ContextMenuContent>
                {selectionFilePath && <SelectedFileMenuItems absolutePath={selectionFilePath} />}
              </ContextMenuContent>
            </ContextMenu>
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
