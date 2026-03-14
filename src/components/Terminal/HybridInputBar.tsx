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
import type { AgentState } from "@/types";
import { getAgentConfig } from "@/config/agents";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
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
  getDiffContext,
  getTerminalContext,
  getSelectionContext,
  getAllAtDiffTokens,
  getAllAtTerminalTokens,
  getAllAtSelectionTokens,
  type AtFileContext,
  type SlashCommandContext,
  type AtDiffContext,
  type AtTerminalContext,
  type AtSelectionContext,
  type DiffContextType,
} from "./hybridInputParsing";
import { CommandPickerHost } from "@/components/Commands";
import { PromptHistoryPalette } from "./PromptHistoryPalette";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useCommandStore } from "@/store/commandStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalStore, useVoiceRecordingStore, useWorktreeDataStore } from "@/store";
import { VoiceInputButton } from "./VoiceInputButton";
import { Archive, Terminal as TerminalIcon, X } from "lucide-react";
import { registerInputController, unregisterInputController } from "@/store/terminalInputStore";
import type { CommandContext, CommandResult } from "@shared/types/commands";
import { isEnterLikeLineBreakInputEvent } from "./hybridInputEvents";
import { IMAGE_EXTENSIONS } from "./useTerminalFileTransfer";
import { AppDialog } from "@/components/ui/AppDialog";
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
  pendingAIField,
  setPendingAIRanges,
  createUrlPasteField,
  createUrlPasteDetector,
  createPlainPasteKeymap,
  urlContextChipField,
  addUrlContextChip,
  updateUrlPasteStatus,
  removeUrlPasteEntry,
  diffChipField,
  createDiffChipTooltip,
  terminalChipField,
  createTerminalChipTooltip,
  selectionChipField,
  createSelectionChipTooltip,
} from "./inputEditorExtensions";
import { AttachmentTray } from "./AttachmentTray";
import { normalizeChips, getContextWindow, type TrayItem } from "./attachmentTrayUtils";

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
  addToHistory: (terminalId: string, command: string) => void;
  resetHistoryIndex: (terminalId: string) => void;
  clearDraftInput: (terminalId: string, projectId?: string) => void;
  navigateHistory: (
    terminalId: string,
    direction: "up" | "down",
    currentInput: string
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
      agentState,
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
    const stashEditorState = useTerminalInputStore((s) => s.stashEditorState);
    const popStashedEditorState = useTerminalInputStore((s) => s.popStashedEditorState);
    // Get projectId early so it can be used for draft input initialization
    const projectId = useProjectStore((s) => s.currentProject?.id);
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
    const placeholderCompartmentRef = useRef(new Compartment());
    const keymapCompartmentRef = useRef(new Compartment());
    const editableCompartmentRef = useRef(new Compartment());
    const chipCompartmentRef = useRef(new Compartment());
    const tooltipCompartmentRef = useRef(new Compartment());
    const fileChipTooltipCompartmentRef = useRef(new Compartment());
    const imageChipTooltipCompartmentRef = useRef(new Compartment());
    const fileDropChipTooltipCompartmentRef = useRef(new Compartment());
    const diffChipTooltipCompartmentRef = useRef(new Compartment());
    const terminalChipTooltipCompartmentRef = useRef(new Compartment());
    const selectionChipTooltipCompartmentRef = useRef(new Compartment());
    const autoSizeCompartmentRef = useRef(new Compartment());
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
    const [errorChipDismissed, setErrorChipDismissed] = useState(false);
    const prevAgentStateRef = useRef<AgentState | undefined>(undefined);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const lastQueryRef = useRef<string>("");
    const [menuLeftPx, setMenuLeftPx] = useState<number>(0);
    const dragDepthRef = useRef(0);
    const [isDragOverFiles, setIsDragOverFiles] = useState(false);
    const [attachments, setAttachments] = useState<TrayItem[]>([]);
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

    const handleDragEnter = useCallback((e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current++;
      if (dragDepthRef.current === 1) setIsDragOverFiles(true);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.stopPropagation();
      dragDepthRef.current--;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
        setIsDragOverFiles(false);
      }
    }, []);

    const handleDrop = useCallback(async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragOverFiles(false);

      const view = editorViewRef.current;
      if (!view || !e.dataTransfer.files.length) return;

      type ResolvedFile =
        | { type: "image"; filePath: string; thumbnailDataUrl: string }
        | { type: "file"; filePath: string; fileName: string };

      const resolved: ResolvedFile[] = [];

      for (const file of Array.from(e.dataTransfer.files)) {
        const filePath = window.electron.webUtils.getPathForFile(file);
        if (!filePath) continue;
        const name = file.name.trim() || filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;

        if (IMAGE_EXTENSIONS.test(file.name)) {
          try {
            const result = await window.electron.clipboard.thumbnailFromPath(filePath);
            if (result.ok) {
              resolved.push({ type: "image", filePath, thumbnailDataUrl: result.thumbnailDataUrl });
            } else {
              resolved.push({ type: "file", filePath, fileName: name });
            }
          } catch {
            resolved.push({ type: "file", filePath, fileName: name });
          }
        } else {
          resolved.push({ type: "file", filePath, fileName: name });
        }
      }

      if (resolved.length === 0) return;

      try {
        const cursor = view.state.selection.main.head;
        const imageEffects: ReturnType<typeof addImageChip.of>[] = [];
        const fileEffects: ReturnType<typeof addFileDropChip.of>[] = [];
        let insertText = "";

        for (const entry of resolved) {
          const from = cursor + insertText.length;
          if (entry.type === "image") {
            insertText += entry.filePath + " ";
            imageEffects.push(
              addImageChip.of({
                from,
                to: from + entry.filePath.length,
                filePath: entry.filePath,
                thumbnailUrl: entry.thumbnailDataUrl,
              })
            );
          } else {
            const token = formatAtFileToken(entry.filePath);
            insertText += token + " ";
            fileEffects.push(
              addFileDropChip.of({
                from,
                to: from + token.length,
                filePath: entry.filePath,
                fileName: entry.fileName,
              })
            );
          }
        }

        view.dispatch({
          changes: { from: cursor, insert: insertText },
          effects: [...imageEffects, ...fileEffects],
          selection: { anchor: cursor + insertText.length },
        });
      } catch {
        // Editor may have been destroyed
      }
    }, []);

    const editorViewRefForUrl = editorViewRef;
    const urlPasteFieldInstance = useMemo(
      () =>
        createUrlPasteField((entryId: number, url: string) => {
          const view = editorViewRefForUrl.current;
          if (!view) return;

          view.dispatch({
            effects: updateUrlPasteStatus.of({ id: entryId, status: "loading" }),
          });

          window.electron.urlContext
            .resolve(url)
            .then((result) => {
              const currentView = editorViewRefForUrl.current;
              if (!currentView) return;

              if (result.ok) {
                const entries = currentView.state.field(urlPasteFieldInstance, false) ?? [];
                const entry = entries.find((e) => e.id === entryId);
                if (!entry) return;

                currentView.dispatch({
                  changes: { from: entry.from, to: entry.to, insert: result.markdown },
                  effects: [
                    removeUrlPasteEntry.of({ id: entryId }),
                    addUrlContextChip.of({
                      from: entry.from,
                      to: entry.from + result.markdown.length,
                      title: result.title,
                      tokenEstimate: result.tokenEstimate,
                      sourceUrl: result.sourceUrl,
                    }),
                  ],
                });
              } else {
                currentView.dispatch({
                  effects: updateUrlPasteStatus.of({
                    id: entryId,
                    status: "error",
                    errorMessage: result.message,
                  }),
                });
              }
            })
            .catch(() => {
              const currentView = editorViewRefForUrl.current;
              if (!currentView) return;
              currentView.dispatch({
                effects: updateUrlPasteStatus.of({
                  id: entryId,
                  status: "error",
                  errorMessage: "Failed to fetch URL",
                }),
              });
            });
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    );

    const urlPasteDetector = useMemo(() => createUrlPasteDetector(), []);

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

    const { commandMap } = useSlashCommandList({
      agentId,
      projectPath: cwd,
    });

    const autocompleteDiffItems = useMemo((): AutocompleteItem[] => {
      if (!diffContext) return [];
      const items: AutocompleteItem[] = [
        { key: "diff", label: "Working tree diff (@diff)", value: "@diff" },
        { key: "diff:staged", label: "Staged diff (@diff:staged)", value: "@diff:staged" },
        { key: "diff:head", label: "HEAD diff (@diff:head)", value: "@diff:head" },
      ];
      const partial =
        diffContext.tokenEnd > diffContext.atStart + 1
          ? value.slice(diffContext.atStart + 1, diffContext.tokenEnd)
          : "";
      if (!partial) return items;
      return items.filter((item) => item.value.slice(1).startsWith(partial));
    }, [diffContext, value]);

    const autocompleteTerminalItems = useMemo((): AutocompleteItem[] => {
      if (!terminalContext) return [];
      return [
        { key: "terminal", label: "Terminal output (@terminal)", value: "@terminal" },
      ];
    }, [terminalContext]);

    const autocompleteSelectionItems = useMemo((): AutocompleteItem[] => {
      if (!selectionContext) return [];
      return [
        { key: "selection", label: "Terminal selection (@selection)", value: "@selection" },
      ];
    }, [selectionContext]);

    const autocompleteItems = useMemo((): AutocompleteItem[] => {
      if (activeMode === "terminal") {
        return autocompleteTerminalItems;
      }
      if (activeMode === "selection") {
        return autocompleteSelectionItems;
      }
      if (activeMode === "diff") {
        return autocompleteDiffItems;
      }
      if (activeMode === "file") {
        return autocompleteFiles.map((file) => ({ key: file, label: file, value: file }));
      }
      if (activeMode === "command") {
        return autocompleteCommands;
      }
      return [];
    }, [activeMode, autocompleteTerminalItems, autocompleteSelectionItems, autocompleteDiffItems, autocompleteCommands, autocompleteFiles]);

    const isLoading =
      activeMode === "file"
        ? isAutocompleteLoading
        : activeMode === "command"
          ? isCommandsLoading
          : false; // diff items are static, never loading

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

    const isSendingRef = useRef(false);

    const sendText = useCallback(
      async (text: string) => {
        const latest = latestRef.current;
        if (!latest || latest.disabled) return;
        if (text.trim().length === 0) return;
        if (isSendingRef.current) return;

        let resolvedText = text;

        // Resolve @terminal tokens (synchronous — direct buffer access)
        const terminalTokens = getAllAtTerminalTokens(resolvedText);
        if (terminalTokens.length > 0) {
          const sorted = [...terminalTokens].sort((a, b) => b.start - a.start);
          for (const token of sorted) {
            const managed = terminalInstanceService.get(terminalId);
            let replacement: string;
            if (managed) {
              const buffer = managed.terminal.buffer.active;
              const start = Math.max(0, buffer.length - 100);
              const lines: string[] = [];
              for (let i = start; i < buffer.length; i++) {
                const line = buffer.getLine(i);
                if (line) lines.push(line.translateToString(true));
              }
              const content = lines.join("\n").trimEnd();
              replacement = content ? "```\n" + content + "\n```" : "[No terminal output]";
            } else {
              replacement = "[Terminal not available]";
            }
            resolvedText =
              resolvedText.slice(0, token.start) + replacement + resolvedText.slice(token.end);
          }
        }

        // Resolve @selection tokens (synchronous — cached selection)
        const selectionTokens = getAllAtSelectionTokens(resolvedText);
        if (selectionTokens.length > 0) {
          const sorted = [...selectionTokens].sort((a, b) => b.start - a.start);
          for (const token of sorted) {
            const selection = terminalInstanceService.getCachedSelection(terminalId);
            const replacement = selection
              ? "```\n" + selection + "\n```"
              : "[No terminal selection]";
            resolvedText =
              resolvedText.slice(0, token.start) + replacement + resolvedText.slice(token.end);
          }
        }

        // Resolve @diff tokens before sending
        const diffTokens = getAllAtDiffTokens(resolvedText);
        if (diffTokens.length > 0) {
          isSendingRef.current = true;
          try {
            const sorted = [...diffTokens].sort((a, b) => b.start - a.start);
            for (const token of sorted) {
              let replacement: string;
              try {
                const raw = await window.electron.git.getWorkingDiff(cwd, token.diffType);
                if (raw) {
                  replacement = "```diff\n" + raw + "\n```";
                } else {
                  const labels: Record<DiffContextType, string> = {
                    unstaged: "working tree",
                    staged: "staged",
                    head: "HEAD",
                  };
                  replacement = `No ${labels[token.diffType]} changes.`;
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                replacement = `[Error fetching diff: ${msg}]`;
              }
              resolvedText =
                resolvedText.slice(0, token.start) + replacement + resolvedText.slice(token.end);
            }
          } finally {
            isSendingRef.current = false;
          }
        }

        // Auto-attach error output if error chip is active
        if (agentState === "failed" && !errorChipDismissed) {
          const managed = terminalInstanceService.get(terminalId);
          if (managed) {
            const buffer = managed.terminal.buffer.active;
            const start = Math.max(0, buffer.length - 100);
            const lines: string[] = [];
            for (let i = start; i < buffer.length; i++) {
              const line = buffer.getLine(i);
              if (line) lines.push(line.translateToString(true));
            }
            const content = lines.join("\n").trimEnd();
            if (content) {
              resolvedText = "```\n" + content + "\n```\n\n" + resolvedText;
            }
          }
          setErrorChipDismissed(true);
        }

        const payload = buildTerminalSendPayload(resolvedText);
        latest.onSend({ data: payload.data, trackerData: payload.trackerData, text: resolvedText });
        latest.addToHistory(latest.terminalId, text);
        latest.resetHistoryIndex(latest.terminalId);
        if (latest.projectId) {
          useCommandHistoryStore.getState().recordPrompt(latest.projectId, text, agentId ?? null);
        }

        setIsExpanded(false);
        applyEditorValue("", { selection: EditorSelection.create([EditorSelection.cursor(0)]) });
        latest.clearDraftInput(latest.terminalId, latest.projectId);
        useVoiceRecordingStore.getState().clearAICorrectionSpans(latest.terminalId);
        setAtContext(null);
        setSlashContext(null);
        setDiffContext(null);
        setTerminalContext(null);
        setSelectionContext(null);
      },
      [applyEditorValue, agentId, cwd]
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
    //   pendingCorrections → dotted underline while whole-session cleanup is in flight
    const transcriptPhase = useVoiceRecordingStore(
      (s) => s.panelBuffers[terminalId]?.transcriptPhase ?? "idle"
    );
    const liveSegmentStart = useVoiceRecordingStore(
      (s) => s.panelBuffers[terminalId]?.draftLengthAtSegmentStart ?? -1
    );
    const pendingCorrections = useVoiceRecordingStore(
      (s) => s.panelBuffers[terminalId]?.pendingCorrections
    );
    const voiceCorrectionEnabled = useVoiceRecordingStore((s) => s.correctionEnabled);

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;

      // When correction is disabled, suppress all voice decorations
      if (!voiceCorrectionEnabled) {
        view.dispatch({
          effects: [setInterimRange.of(null), setPendingAIRanges.of([])],
        });
        return;
      }

      const docLen = view.state.doc.length;
      const doc = view.state.doc.toString();
      const pendingRanges =
        pendingCorrections?.flatMap((correction) => {
          const range = resolveAICorrectionRange(doc, correction.segmentStart, correction.rawText);
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
            effects: [setInterimRange.of(interimRange), setPendingAIRanges.of(pendingRanges)],
          });
          break;
        }
        case "paragraph_pending_ai":
        case "utterance_final":
        case "stable":
        case "idle": {
          view.dispatch({
            effects: [setInterimRange.of(null), setPendingAIRanges.of(pendingRanges)],
          });
          break;
        }
        default:
          view.dispatch({
            effects: [setInterimRange.of(null), setPendingAIRanges.of(pendingRanges)],
          });
          break;
      }
    }, [
      transcriptPhase,
      voiceDraftRevision,
      liveSegmentStart,
      voiceCorrectionEnabled,
      pendingCorrections,
    ]);

    useEffect(() => {
      if (agentState === "failed" && prevAgentStateRef.current !== "failed") {
        setErrorChipDismissed(false);
      }
      prevAgentStateRef.current = agentState;
    }, [agentState]);

    const sendFromEditor = useCallback(() => {
      const view = editorViewRef.current;
      const latest = latestRef.current;
      const text = view?.state.doc.toString() ?? latest?.value ?? "";
      sendText(text);
    }, [sendText]);

    const collapseEditor = useCallback(() => {
      setIsExpanded(false);
    }, []);

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

    const removeAttachment = useCallback((item: TrayItem) => {
      const view = editorViewRef.current;
      if (!view) return;
      const doc = view.state.doc.toString();
      const deleteTo = item.to < doc.length && doc[item.to] === " " ? item.to + 1 : item.to;
      view.dispatch({ changes: { from: item.from, to: deleteTo, insert: "" } });
      view.focus();
    }, []);

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
                latest.resetHistoryIndex(latest.terminalId);
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

            // Check @terminal and @selection before @diff and @file
            const termCtx = getTerminalContext(text, caret);
            if (termCtx) {
              const prev = lastTerminalContextRef.current;
              if (
                !prev ||
                prev.atStart !== termCtx.atStart ||
                prev.tokenEnd !== termCtx.tokenEnd
              ) {
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
              if (
                !prev ||
                prev.atStart !== selCtx.atStart ||
                prev.tokenEnd !== selCtx.tokenEnd
              ) {
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

            // Check diff context before file context so @diff is not treated as a file path
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

            // Clear diff context if no longer active
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
          const urls = update.state.field(urlContextChipField, false) ?? [];
          const next = normalizeChips(imgs, files, urls);
          setAttachments((prev) => {
            if (prev.length === 0 && next.length === 0) return prev;
            if (
              prev.length === next.length &&
              prev.every((p, i) => p.id === next[i].id && p.tokenEstimate === next[i].tokenEstimate)
            )
              return prev;
            return next;
          });
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

    const handleStash = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return false;
      const doc = view.state.doc.toString();
      if (doc.length === 0) return true;
      const latest = latestRef.current;
      if (!latest) return false;
      stashEditorState(latest.terminalId, view.state, latest.projectId);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
        selection: EditorSelection.cursor(0),
      });
      return true;
    }, [stashEditorState]);

    const handlePopStash = useCallback(() => {
      const view = editorViewRef.current;
      if (!view) return false;
      const latest = latestRef.current;
      if (!latest) return false;
      const stashed = popStashedEditorState(latest.terminalId, latest.projectId);
      if (!stashed) return false;
      view.setState(stashed);
      // Re-apply current editable config since setState restores stale config.
      // Keymap callbacks read from latestRef so they stay current without reconfigure.
      view.dispatch({
        effects: editableCompartmentRef.current.reconfigure(
          EditorView.editable.of(!latest.disabled)
        ),
      });
      return true;
    }, [popStashedEditorState]);

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

              // Flush paragraph buffer in the main process. This captures any in-flight
              // utterance text via commitParagraphBoundary() and returns the authoritative
              // rawText that the correction service will use.
              void window.electron.voiceInput.flushParagraph();

              // Insert a newline at the end of the draft and reset paragraph state
              // synchronously — the UI must feel immediate regardless of IPC timing.
              const inputStore = useTerminalInputStore.getState();
              const draft = inputStore.getDraftInput(tid, pid);
              inputStore.setDraftInput(tid, draft + "\n", pid);
              inputStore.bumpVoiceDraftRevision();

              voiceStore.resetParagraphState(tid);

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
              setDiffContext(null);
              return true;
            }

            if (latest.isExpanded) {
              setIsExpanded(false);
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
          onStash: handleStash,
          onPopStash: handlePopStash,
          onExpand: () => {
            setIsExpanded((v) => !v);
            return true;
          },
          onHistorySearch: () => {
            historyPaletteOpenRef.current?.();
            return true;
          },
        }),
      [
        applyAutocompleteSelection,
        handleHistoryNavigation,
        handleStash,
        handlePopStash,
        sendFromEditor,
      ]
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
          urlPasteFieldInstance,
          urlContextChipField,
          urlPasteDetector,
          plainPasteKeymap,
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
      registerInputController(terminalId, {
        stash: handleStash,
        pop: handlePopStash,
      });
      return () => unregisterInputController(terminalId);
    }, [terminalId, handleStash, handlePopStash]);

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

    useEffect(() => {
      const view = editorViewRef.current;
      if (!view) return;
      const compactHost = compactEditorHostRef.current;
      const modalHost = modalEditorHostRef.current;

      if (isExpanded && modalHost) {
        modalHost.appendChild(view.dom);
        view.dispatch({
          effects: autoSizeCompartmentRef.current.reconfigure([]),
        });
        view.dom.style.height = "";
        view.scrollDOM.style.overflowY = "auto";
        // Double rAF to ensure we focus after AppDialog's own rAF focus logic
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            view.requestMeasure();
            view.focus();
          });
        });
      } else if (!isExpanded && compactHost) {
        compactHost.appendChild(view.dom);
        view.dispatch({
          effects: autoSizeCompartmentRef.current.reconfigure(createAutoSize()),
        });
        // Force a geometry update so createAutoSize restores the compact height
        view.dom.style.height = "";
        requestAnimationFrame(() => {
          view.requestMeasure();
          view.focus();
        });
      }
    }, [isExpanded]);

    const showErrorChip = agentState === "failed" && !errorChipDismissed;

    const barContent = (
      <div className="group cursor-text bg-canopy-bg px-4 pb-3 pt-3">
        {showErrorChip && (
          <div className="flex items-center gap-1.5 px-1 pb-1.5">
            <div className="flex items-center gap-1.5 rounded-sm bg-status-error/10 px-2 py-0.5 text-status-error">
              <TerminalIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="text-xs font-medium">Attach error output</span>
              <button
                type="button"
                onClick={() => setErrorChipDismissed(true)}
                className="ml-0.5 rounded-sm p-0.5 hover:bg-status-error/20 transition-colors cursor-pointer"
                aria-label="Dismiss error context"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
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
              isDragOverFiles && "border-canopy-accent/60 ring-1 ring-canopy-accent/30",
              disabled && "opacity-60"
            )}
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
                ref={(node) => {
                  editorHostRef.current = node;
                  compactEditorHostRef.current = node;
                }}
                className={cn(
                  "w-full min-h-[20px]",
                  "text-canopy-text",
                  disabled && "pointer-events-none"
                )}
              />
            </div>

            <div className="flex items-center pr-1.5">
              {hasStash && (
                <button
                  type="button"
                  onClick={handlePopStash}
                  className="flex items-center justify-center h-5 w-5 rounded-sm text-canopy-accent/70 hover:text-canopy-accent hover:bg-white/[0.06] transition-colors cursor-pointer"
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
                worktreeLabel={panelWorktree?.branch || panelWorktree?.name}
                disabled={disabled}
              />
            </div>
          </div>
          <AttachmentTray
            items={attachments}
            totalTokens={attachments.reduce((s, a) => s + a.tokenEstimate, 0)}
            contextWindow={getContextWindow(agentId)}
            onRemove={removeAttachment}
          />
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
