import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
} from "react";
import { EditorView } from "@codemirror/view";
import { EditorSelection, Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { AgentState } from "@/types";
import { getAgentConfig } from "@/config/agents";
import { cn } from "@/lib/utils";
import { useFileAutocomplete } from "@/hooks/useFileAutocomplete";
import { useSlashCommandAutocomplete } from "@/hooks/useSlashCommandAutocomplete";
import { useSlashCommandList } from "@/hooks/useSlashCommandList";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { AutocompleteMenu, getComboboxState, type AutocompleteItem } from "./AutocompleteMenu";
import {
  getDaintreeAtClaim,
  fileSearchQuery,
  type ActiveCompletionContext,
  type ComposerTrigger,
} from "./hybridInputParsing";
import { splitContextProviderQuery } from "@shared/utils/pluginContextReference";
import type { ContextProviderItem } from "@shared/types/pluginContextProvider";
import { isActiveVoiceSession } from "@shared/types/voice";
import { usePluginContextProvidersStore } from "@/store/pluginContextProvidersStore";
import { useContextProviderSearch } from "./hooks/useContextProviderSearch";
import { useForgeReferenceMarks } from "./hooks/useForgeReferenceMarks";
import { useForgeReferences } from "./hooks/useForgeReferences";
import { contextItemKey, type ContextProviderClaim } from "./hooks/useAutocompleteItems";
import {
  applyContextReferenceProviders,
  contextReferenceChipProviders,
  type ContextReferenceChipProvider,
} from "./inputEditorExtensions/contextReferenceChip";
import { PromptTemplateForm } from "@/components/Commands/PromptTemplateForm";
import { PromptHistoryPalette } from "./PromptHistoryPalette";
import { useCanopyStore } from "@/store/canopyStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { usePluginPromptTemplates } from "@/hooks/usePluginPromptTemplates";
import { renderPromptTemplate } from "@shared/utils/pluginPromptTemplates";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore, useVoiceRecordingStore } from "@/store";
import type {
  VoiceFileReferenceNote,
  VoiceRecordingTarget,
  VoiceScratchRefusal,
} from "@/store/voiceRecordingStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { VoiceInputButton } from "./VoiceInputButton";
import { DictationCancelConfirmOverlay, useDictationCancelConfirm } from "./DictationCancelConfirm";
import { DICTATION_CANCEL_CONFIRM_PROMPT } from "@/lib/pressAgain";
import { DictionaryLearnPrompt } from "./DictionaryLearnPrompt";
import { Archive, X } from "lucide-react";
import { Paperclip } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEffectiveCombo } from "@/hooks/useKeybinding";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import {
  COMPOSER_CONTROL_FOCUS_CLASS,
  COMPOSER_CONTROL_HOVER_BG_CLASS,
  COMPOSER_CONTROL_TEXT_CLASS,
  COMPOSER_MARKER_TEXT_CLASS,
} from "./composerControlStyles";
import {
  useVoiceWaitSubmit,
  type DepartedComposerSend,
  type VoiceSendCleanup,
  type VoiceSubmitOutcome,
} from "./hooks/useVoiceWaitSubmit";
import {
  COMPOSER_BORDER_CAPTION_CLASS,
  VOICE_SEND_REOPENED_CAPTION,
  VoiceSubmitProgress,
  correctionStreamShare,
  voiceSubmitWaitCaption,
  voiceSubmitWaitStatus,
  type VoiceSubmitWaitKeys,
} from "./VoiceSubmitProgress";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import {
  registerInputController,
  selectHomeFocusTarget,
  unregisterInputController,
} from "@/store/terminalInputStore";
import {
  promptTemplateTokenCut,
  toPromptTemplateItems,
  type DraftSpan,
} from "./promptTemplateCompletion";
import { AppDialog } from "@/components/ui/AppDialog";
import { ScrollShadowOverlay } from "@/components/ui/ScrollShadow";
import {
  useTerminalColorSchemeStore,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { resolveInputBarColors, VOICE_LISTENING_FILL_MIX } from "@/utils/terminalTheme";

import { useEditorCompartments } from "./hooks/useEditorCompartments";
import { useAutocompleteItems } from "./hooks/useAutocompleteItems";
import { useDragDrop } from "./hooks/useDragDrop";
import { useAttachFiles, useAttachFromHost } from "./hooks/useAttachFiles";
import {
  fileAttachmentEntryFromSource,
  insertFileAttachments,
  insertPreparedAttachments,
} from "./fileAttachments";
import {
  composerUploadSurface,
  isComposerSendHeld,
  isolatedComposerUploadSurface,
  takeHeldBackAttachments,
  type PreparedAttachment,
} from "./uploads/pendingUploads";
import { HeldBackAttachmentsBanner } from "./uploads/HeldBackAttachmentsBanner";
import { advanceComposerDraft } from "./inputEditorExtensions/composerDraftGeneration";
import {
  CROSS_HOST_CONTEXT_REFUSAL,
  CROSS_HOST_IMAGE_REFUSAL,
  type CrossHostRefusal,
  tryComposerFleetBroadcast,
} from "./composerFleetBroadcast";
import { PendingUploadChips } from "./uploads/PendingUploadChips";
import { LazyUploadConfirmHost } from "./uploads/LazyUploadConfirmHost";
import { registerPaneDropTarget } from "./uploads/paneDropRouting";
import {
  captureFocusEpoch,
  isFocusEpochCurrent,
  pendingPaneSurface,
  requestPaneFocus,
  requestedForDictation,
  requestedPaneSurface,
  takeRequestedDictationCaret,
} from "./paneFocusRequest";
import { isRemoteWindow, useHostPlatform } from "@/hooks/useHostPlatform";
import { isMac } from "@/lib/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useVoiceDecorations } from "./hooks/useVoiceDecorations";
import { useContextDetection } from "./hooks/useContextDetection";
import {
  draftUnchangedSince,
  useTokenResolution,
  type SendTextOptions,
} from "./hooks/useTokenResolution";
import { useEditorKeymap, type ComposerSendRoute } from "./hooks/useEditorKeymap";
import { useCompartmentDriver } from "./hooks/useCompartmentDriver";
import { usePasteExtensions } from "./hooks/usePasteExtensions";
import { useAutocompleteState } from "./hooks/useAutocompleteState";
import {
  MENU_SHELL_GAP_PX,
  useAutocompletePositioning,
  type MenuPlacement,
} from "./hooks/useAutocompletePositioning";
import { useComposerMeasure } from "./hooks/useComposerMeasure";
import { useEditorScrollEdges } from "./hooks/useEditorScrollEdges";
import { useAutocompleteApply } from "./hooks/useAutocompleteApply";
import { useFleetMirror } from "./hooks/useFleetMirror";
import { useSendHandBack, type SendHandBack } from "./hooks/useSendHandBack";
import { useEditorDomHandlers } from "./hooks/useEditorDomHandlers";
import { useEditorFactory } from "./hooks/useEditorFactory";
import {
  clearComposerHistory,
  createComboboxAttributes,
  captureRewriteSelection,
  dictationWrite,
  endCorrectionReview,
  outsideDraftWrite,
  selectionAfterOutsideWrite,
  readImageChipPaths,
  replayLandedCorrection,
} from "./inputEditorExtensions";
import {
  isLatestDictation,
  outsideWriteChange,
  takeLandedCorrection,
} from "@/services/voiceCorrectionLanding";
import {
  SCRATCH_REFUSAL_CAPTION,
  SCRATCH_REFUSAL_STATUS,
  takeScratchLanded,
} from "@/services/voiceScratchCommand";
import {
  unresolvedFileReferencesCaption,
  unresolvedFileReferencesStatus,
} from "@/services/voiceFileReferences";
import { registerComposerSelectionSource } from "@/services/voiceRewriteSelection";
import type { VoiceDraftSend } from "@/services/voiceDraftSend";
import {
  readComposerSelection,
  setPendingComposerSelection,
  takePendingComposerSelection,
} from "@/lib/composerCaret";
import { isolatedComposerScope, makeDraftKey } from "@/lib/draftKey";
import { DICTATION_OWNER_ATTR } from "@/services/canopyReplyDictation";
import { useHostReparent } from "./hooks/useHostReparent";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SelectedFileMenuItems } from "./SelectedFileMenuItems";
import { systemClient } from "@/clients/systemClient";
import { resolveSelectedFilePath } from "@/services/terminal/filePathDetection";
import { composeDraftWithInstruction } from "@/services/terminal/worktreeMoveInstruction";
import { isScratchpadElement } from "@/lib/terminalScratchpad";

export interface HybridInputBarHandle {
  focus: () => void;
  /**
   * Focus for dictation starting here from a surface with no pane to ask
   * through (Canopy's reply): the caret stays where the composer last showed
   * it, else goes to the end, as a pane's does on a dictation focus (#14770).
   */
  focusForDictation: () => void;
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
  /**
   * Hands the text to the terminal. A host that can say whether the terminal
   * accepted it returns that, and a terminal-first user's keyboard goes back
   * to the pane's terminal once it has (#14692).
   */
  onSend: (payload: {
    data: string;
    trackerData: string;
    text: string;
    /** The draft's image chips, in order, each also present in `text` (#12792). */
    imagePaths?: string[];
  }) => void | Promise<boolean>;
  onSendKey?: (key: string) => void;
  onActivate?: () => void;
  cwd: string;
  agentId?: BuiltInAgentId;
  agentHasLifecycleEvent?: boolean;
  agentState?: AgentState;
  restartKey?: number;
  disabled?: boolean;
  /** Said by an empty composer while `disabled`, in place of "Ask …". */
  disabledPlaceholder?: string;
  /**
   * Another screen drives the project: the draft shown is the driver's, read
   * back from the host, so this bar never writes its text to the draft store.
   */
  followsDriver?: boolean;
  className?: string;
  /**
   * A second composer for a terminal that may also be open in its own pane
   * (the canopy panel's live view). It sends only to this terminal: never a
   * fleet broadcast or mirror, and it leaves the terminal's input controller
   * to the pane that registered it.
   */
  isolated?: boolean;
  /**
   * The terminal is on another host than this window's (Canopy reading it):
   * that host's id. Nothing of this machine's — a file, an image, a path from
   * completion, a diff or a screen expanded at send — is offered or sent,
   * since it would name something that isn't there; text is typed as text.
   * Its draft and history are that host's, apart from this one's.
   */
  otherHostId?: string;
  /**
   * Sends the composer's text and says whether the terminal took it, in place
   * of the fire-and-forget `onSend`: the draft is cleared and kept in history
   * only once it resolves `true`, so a refused send leaves the text in place.
   */
  submitText?: (text: string, imagePaths: readonly string[]) => Promise<boolean>;
  /**
   * Whether this composer's surface is the selected one, for a host whose
   * selection is not the grid's (the Assistant sidebar). Grid panes leave it
   * unset and follow the pane frame's own rule.
   */
  selected?: boolean;
  /**
   * The dictation an isolated composer takes (Canopy's reply), kept apart from
   * the pane composer typing to the same terminal: its id addresses this
   * composer's own draft. Without it an isolated composer takes none.
   */
  voiceTarget?: VoiceRecordingTarget;
  /**
   * Cmd+Enter (Ctrl+Enter off the Mac) sends as Enter does, by the route this gives
   * at the press in place of `submitText` and `onSendKey("enter")`: Canopy's
   * reply names the agent it moves on to once that send lands. Without it the
   * chord does nothing here.
   */
  modEnterSend?: () => ComposerSendRoute;
}

interface LatestState {
  terminalId: string;
  /** The id dictation into this composer is kept under (`voiceTarget`). */
  voiceId: string;
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
  /** Whose attachments still on their way hold an Enter on an empty draft too. */
  uploadSurface: string;
  modEnterSend?: () => ComposerSendRoute;
  altChords?: readonly string[];
}

interface HybridInputE2EController {
  setText: (text: string) => void;
  getText: () => string;
}

type ApplyEditorValue = (
  nextValue: string,
  options?: { selection?: EditorSelection; focus?: boolean; resetHistory?: boolean }
) => void;

const EMPTY_STALE_KEYS: ReadonlySet<string> = new Set<string>();
const NO_CONTEXT_CHIP_PROVIDERS: ReadonlyMap<string, ContextReferenceChipProvider> = new Map();
const NO_CONTEXT_ITEMS: ContextProviderItem[] = [];
const NO_TEMPLATE_ITEMS: AutocompleteItem[] = [];
// As long as a scratch refusal stays, counted from when the border shows it.
const FILE_REFERENCE_NOTE_MS = 6_000;

/** The voice note on a composer's border, which a send refused there retires. */
function standingVoiceNote(voiceId: string): VoiceScratchRefusal | VoiceFileReferenceNote | null {
  const { scratchRefusal, fileReferenceNote } = useVoiceRecordingStore.getState();
  if (scratchRefusal?.panelId === voiceId) return scratchRefusal;
  return fileReferenceNote?.panelId === voiceId ? fileReferenceNote : null;
}

/**
 * Whether the editor holds the caret, judged by the DOM rather than by
 * `view.hasFocus` — CodeMirror reports false there whenever the window is
 * blurred, even though the editor is still `document.activeElement`.
 */
function editorOwnsDomFocus(view: EditorView): boolean {
  return view.contentDOM.contains(document.activeElement);
}

/**
 * Drag feedback for both editor hosts — the compact bar and the Expanded
 * Editor. Shared so the two drop targets cannot drift apart again (#12570).
 */
const SEND_HELD_STATUS = "Not sent. The draft is still here.";
/** The `❯` and trailing controls of an unavailable composer: inactive, one family. */
const DISABLED_CONTROL_MIX = "45%";
const DISABLED_CONTROL_INK = "color-mix(in oklab, var(--ib-fg) 45%, var(--ib-bg))";
const SPOKEN_SEND_TOO_SHORT_CAPTION = "Too short to send by voice · Enter to send";
const CROSS_HOST_CAPTION: Record<CrossHostRefusal, string> = {
  context: "Not sent · Context can't reach another host",
  image: "Not sent · Images can't reach another host",
};
const CROSS_HOST_STATUS: Record<CrossHostRefusal, string> = {
  context: CROSS_HOST_CONTEXT_REFUSAL,
  image: CROSS_HOST_IMAGE_REFUSAL,
};
const SPOKEN_SEND_TOO_SHORT_STATUS =
  "Not sent: a voice send needs three or more words. Press Enter to send the reply.";
const VOICE_SUBMIT_OUTCOME_STATUS: Record<VoiceSubmitOutcome["kind"], string> = {
  sending: "Sending…",
  sent: "Sent",
  cancelled: "Send cancelled",
  reopened: "Send reopened. This dictation adds to it, and the next send takes it all.",
  held: SEND_HELD_STATUS,
};
const VOICE_SEND_UNCLEANED_STATUS: Record<VoiceSendCleanup, string> = {
  skipped: "Sent, cleanup skipped",
  failed: "Sent, cleanup failed",
};

function FileDropOverlay({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-10 flex items-center justify-center bg-surface-canvas/80 pointer-events-none",
        className
      )}
    >
      <span className="text-xs font-medium text-accent-primary">Drop to attach</span>
    </div>
  );
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
      followsDriver = false,
      disabledPlaceholder,
      className,
      isolated = false,
      otherHostId,
      submitText,
      selected,
      voiceTarget,
      modEnterSend,
    },
    ref
  ) => {
    const thisMachineOff = otherHostId !== undefined;
    const submitTextRef = useRef(submitText);
    useEffect(() => {
      submitTextRef.current = submitText;
    });
    const getDraftInput = useTerminalInputStore((s) => s.getDraftInput);
    const setDraftInput = useTerminalInputStore((s) => s.setDraftInput);
    const clearDraftInput = useTerminalInputStore((s) => s.clearDraftInput);
    const addToHistory = useTerminalInputStore((s) => s.addToHistory);
    const navigateHistory = useTerminalInputStore((s) => s.navigateHistory);
    const resetHistoryIndex = useTerminalInputStore((s) => s.resetHistoryIndex);
    const currentProjectId = useProjectStore((s) => s.currentProject?.id);
    // An isolated composer types to a terminal that may live in another
    // project, beside that terminal's own composer: its draft and history are
    // its own, so neither leaks into the pane's (or, through it, the fleet's).
    const projectId = isolated ? isolatedComposerScope(otherHostId) : currentProjectId;
    const draftKey = makeDraftKey(terminalId, projectId);
    // Where dictation into this composer is kept: the pane's own by terminal,
    // a reply's by its own id, which names the same draft with no project.
    const voiceId = voiceTarget?.panelId ?? terminalId;
    const voiceProjectId = voiceTarget ? voiceTarget.projectId : projectId;
    const draftKeyRef = useRef(draftKey);
    useEffect(() => {
      draftKeyRef.current = draftKey;
    }, [draftKey]);
    const isInHistoryMode = useTerminalInputStore((s) => {
      const key = projectId ? `${projectId}:${terminalId}` : terminalId;
      return (s.historyIndex.get(key) ?? -1) !== -1;
    });
    const stashEditorState = useTerminalInputStore((s) => s.stashEditorState);
    const popStashedEditorState = useTerminalInputStore((s) => s.popStashedEditorState);
    const isFocusedTerminal = usePanelStore((s) => !isolated && s.focusedId === terminalId);
    // The selected look follows the pane frame (`ContentPanel`): it releases
    // while the Assistant holds the keyboard, though `focusedId` stays pinned.
    // Routing and fleet keep reading `isFocusedTerminal`.
    const isAssistantActive = useMacroFocusStore((s) => s.focusedRegion === "assistant");
    // An unavailable composer never takes the lift: it is not where the
    // keyboard will go, so it reads as a field at rest with its inks stepped
    // down (`shellVars`).
    const showSelectedChrome = !disabled && (selected ?? (isFocusedTerminal && !isAssistantActive));
    const canopyOpen = useCanopyStore((s) => s.isOpen);
    const hasStash = useTerminalInputStore((s) => {
      const key = projectId ? `${projectId}:${terminalId}` : terminalId;
      return s.stashedEditorStates.has(key);
    });
    const popStashShortcut = useEffectiveCombo("terminal.popStash");
    const [value, setValue] = useState(() => getDraftInput(terminalId, projectId));
    const submitAfterCompositionRef = useRef(false);
    const isComposingRef = useRef(false);
    const editorHostRef = useRef<HTMLDivElement | null>(null);
    const editorViewRef = useRef<EditorView | null>(null);
    const [isExpanded, setIsExpanded] = useState(false);
    const modalEditorHostRef = useRef<HTMLDivElement | null>(null);
    const compactEditorHostRef = useRef<HTMLDivElement | null>(null);
    // Absolute path the current selection resolves to, captured on right-click.
    // Gates the "View file" / reveal context-menu section.
    const [selectionFilePath, setSelectionFilePath] = useState<string | null>(null);
    const lastEnterKeydownNewlineRef = useRef(false);
    const handledEnterRef = useRef(false);
    const historyPaletteOpenRef = useRef<(() => void) | null>(null);
    const inputShellRef = useRef<HTMLDivElement | null>(null);
    const trailingGroupRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const listboxId = useId();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const lastEmittedValueRef = useRef<string>(value);
    const focusGenerationRef = useRef(0);
    const [activeCompletionContext, setActiveCompletionContext] =
      useState<ActiveCompletionContext | null>(null);

    const [selectedIndex, setSelectedIndex] = useState(0);
    const lastQueryRef = useRef<string>("");
    const [menuPlacement, setMenuPlacement] = useState<MenuPlacement>({ left: 0 });
    const [initializationState, setInitializationState] = useState<"initializing" | "initialized">(
      "initializing"
    );
    const latestRef = useRef<LatestState | null>(null);
    const applyEditorValueRef = useRef<ApplyEditorValue>(() => {});

    const currentProject = useProjectStore((s) => s.currentProject);
    const voiceStatus = useVoiceRecordingStore((s) => s.status);
    // Dictation lands in a draft of this machine's project, by terminal id:
    // never one for a terminal on another host, unless it takes its own.
    const activeVoicePanelId = useVoiceRecordingStore((s) =>
      thisMachineOff && !voiceTarget ? null : (s.activeTarget?.panelId ?? null)
    );
    const voiceMicSignal = useVoiceRecordingStore((s) => s.micSignal);
    const voiceMicDeviceLabel = useVoiceRecordingStore((s) => s.micDeviceLabel);
    const voicePauseStopWarning = useVoiceRecordingStore((s) => s.pauseStopWarning);
    const externalDraftRevision = useTerminalInputStore((s) => s.externalDraftRevision);
    const panelWorktreeId = usePanelStore((s) => s.panelsById[terminalId]?.worktreeId);
    const panelOwnTitle = usePanelStore((s) => s.panelsById[terminalId]?.title);
    // Selects the drawn label, not the snapshot: the agent's own git-status
    // passes replace the snapshot while the user is typing here.
    const panelWorktreeLabel = useWorktreeStore((s) => {
      const worktree = panelWorktreeId ? s.worktrees.get(panelWorktreeId) : undefined;
      return worktree?.isMainWorktree ? worktree.name : worktree?.branch || worktree?.name;
    });
    const panelWorktreePath = useWorktreeStore((s) =>
      panelWorktreeId ? s.worktrees.get(panelWorktreeId)?.path : undefined
    );
    const isVoiceRecording = activeVoicePanelId === voiceId && voiceStatus === "recording";
    const isVoiceConnecting = activeVoicePanelId === voiceId && voiceStatus === "connecting";
    const isVoiceReconnecting = activeVoicePanelId === voiceId && voiceStatus === "reconnecting";
    const isVoiceFinishing = activeVoicePanelId === voiceId && voiceStatus === "finishing";
    const isVoicePaused = activeVoicePanelId === voiceId && voiceStatus === "paused";
    const isVoiceActiveForPanel =
      isVoiceRecording ||
      isVoiceConnecting ||
      isVoiceReconnecting ||
      isVoiceFinishing ||
      isVoicePaused;
    // The session is open (and key handling treats it as such) before the mic
    // delivers real audio, but the listening chrome waits for it (#13105).
    const isVoiceMicStarting =
      (isVoiceRecording || isVoiceConnecting || isVoiceReconnecting) && voiceMicSignal !== "live";
    // Only a session the mic is feeding gets the full glow. Every other open
    // session (paused, finishing, reconnecting, the mic still starting) keeps a
    // quieter outline so it doesn't pass for recording.
    const isVoiceListeningChrome =
      (isVoiceRecording || isVoiceConnecting) && voiceMicSignal === "live";
    const isVoiceHeldChrome =
      isVoicePaused || isVoiceFinishing || isVoiceReconnecting || isVoiceMicStarting;

    const isAgentTerminal = agentId !== undefined;
    const altChords = agentId ? getAgentConfig(agentId)?.capabilities?.altChords : undefined;

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
      contextChipTooltipCompartmentRef,
      forgeReferenceTooltipCompartmentRef,
      autoSizeCompartmentRef,
      themeCompartmentRef,
    } = compartments;

    // `onActivate` is the same pane-selection callback the pointer handlers
    // below fire, so a drop lands the pane in exactly the state a click on the
    // bar would (#11809). Called with no argument, which is what keeps the
    // shift/cmd fleet gestures a click carries out of a drop. Absent for the
    // Assistant, whose input bar owns no selectable pane.
    // In a remote window, what the user drops here is uploaded to the host;
    // the chips for those uploads live on this composer, and sending waits on them.
    const uploadSurface = isolated
      ? isolatedComposerUploadSurface(terminalId)
      : composerUploadSurface(terminalId);
    const isRemote = isRemoteWindow();
    const hostPlatform = useHostPlatform();
    const cwdRef = useRef(cwd);
    useEffect(() => {
      cwdRef.current = cwd;
    }, [cwd]);
    const readCwd = useCallback(() => cwdRef.current, []);
    const addToProjectDirectory = useCallback(
      () => panelWorktreePath ?? (cwd || null),
      [panelWorktreePath, cwd]
    );
    // Layout phase: a native drop can arrive after a commit that disabled the
    // bar but before passive effects run, and must not be taken then.
    const disabledRef = useRef(disabled);
    const thisMachineOffRef = useRef(thisMachineOff);
    useLayoutEffect(() => {
      disabledRef.current = disabled;
      thisMachineOffRef.current = thisMachineOff;
    }, [disabled, thisMachineOff]);
    // A bar that can't take the user's own typing (disabled, or read-only
    // while a voice submission settles) takes no dropped files either, and
    // nor does one typing to another host, where this machine's files aren't.
    const canTakeDrop = useCallback(() => {
      const view = editorViewRef.current;
      return (
        !!view &&
        !disabledRef.current &&
        !thisMachineOffRef.current &&
        view.state.facet(EditorView.editable)
      );
    }, []);
    const {
      handleDragEnter,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      resetDragState,
      isDragOverFiles,
    } = useDragDrop(editorViewRef, cwd, onActivate, terminalId, {
      uploadSurface,
      addToProjectDirectory,
      ...(isRemote ? { cwdProvider: readCwd } : {}),
      sharesPaneDrops: !isolated,
      canInsert: canTakeDrop,
    });

    // The dialog unmounts its body once its exit animation ends, and can close
    // under a hovering file — a slow submission collapses it mid-drag. Chromium
    // then fires the pending dragleave at the detached node, which React never
    // sees, so the depth the body accumulated would pin the overlay on the
    // compact bar. Stable identity, or every re-render would detach and reset.
    const releaseModalDropTarget = useCallback(
      (node: HTMLDivElement | null) => {
        if (!node) resetDragState();
      },
      [resetDragState]
    );
    const handleAttachFiles = useAttachFiles(editorViewRef, cwd, uploadSurface);
    const handleAttachFromHost = useAttachFromHost(editorViewRef, cwd, uploadSurface);
    // Held back for this composer's draft, so gone with the composer.
    useEffect(() => () => void takeHeldBackAttachments(uploadSurface), [uploadSurface]);
    const addHeldBackAttachments = (attachments: readonly PreparedAttachment[]): boolean => {
      const view = editorViewRef.current;
      if (!view || !insertPreparedAttachments(view, attachments, readCwd())) return false;
      view.focus();
      return true;
    };

    // A drop on this pane's agent terminal lands here when a click on the
    // terminal would focus the bar — in the pane's own composer, never Canopy's
    // reply box for the same terminal. A bar that can't take the drop
    // declines, and it falls through to the terminal instead of vanishing.
    useEffect(() => {
      if (isolated) return;
      return registerPaneDropTarget(terminalId, "hybridInput", {
        canTake: canTakeDrop,
        take: (sources) => {
          const view = editorViewRef.current;
          if (!view || !canTakeDrop()) return false;
          const entries = sources.map(fileAttachmentEntryFromSource);
          if (entries.length === 0) return false;
          view.focus();
          requestPaneFocus(terminalId, "hybridInput");
          void insertFileAttachments(editorViewRef, view, entries, cwd, {
            uploadSurface,
            cwdProvider: readCwd,
          });
          return true;
        },
      });
    }, [isolated, terminalId, cwd, uploadSurface, readCwd, canTakeDrop]);

    const { imagePasteExtension, filePasteExtension, plainPasteKeymap } = usePasteExtensions(
      cwd,
      uploadSurface,
      thisMachineOff,
      editorViewRef
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
      setActiveCompletionContext(null);
      setSelectedIndex(0);
      lastQueryRef.current = "";
      lastEnterKeydownNewlineRef.current = false;
      handledEnterRef.current = false;
      submitAfterCompositionRef.current = false;
      const view = editorViewRef.current;
      if (!view) return;
      if (view.state.doc.toString() !== draft) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft } });
      }
      // Another panel's or project's draft, even one that reads the same.
      clearComposerHistory(view);
    }, [terminalId, projectId, getDraftInput]);

    // Fleet hybrid-input mirroring
    const armedIds = useFleetArmingStore((s) => s.armedIds);
    const isArmed = !isolated && armedIds.has(terminalId);
    const fleetSize = armedIds.size;
    const isFleetPrimary = isFocusedTerminal && isArmed && fleetSize >= 2;
    const isFleetFollower = !isFocusedTerminal && isArmed && fleetSize >= 2;

    const wasFollowingDriverRef = useRef(followsDriver);
    const wasFleetFollowerRef = useRef(isFleetFollower);
    useEffect(() => {
      const wasFollowing = wasFollowingDriverRef.current;
      wasFollowingDriverRef.current = followsDriver;
      const wasFleetFollower = wasFleetFollowerRef.current;
      wasFleetFollowerRef.current = isFleetFollower;
      // Written back, the text a render behind would land over a newer draft
      // the host just sent. That holds for the pass that stops following too:
      // the store has the host's latest, and the outside-write effect below
      // brings the editor to it.
      // The primary owns a follower's draft slot. Writing its local value here
      // can overwrite a newer mirrored keystroke before the editor catches up.
      if (followsDriver || wasFollowing || isFleetFollower || wasFleetFollower) return;
      setDraftInput(terminalId, value, projectId);
    }, [terminalId, value, projectId, setDraftInput, followsDriver, isFleetFollower]);

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
      isolated,
    });

    // What the session is doing when that isn't listening. The placeholder
    // says it on an empty draft; a draft hides the placeholder, so the shell's
    // border carries it instead.
    const voiceSessionStatus = (() => {
      if (isVoicePaused) {
        return voicePauseStopWarning
          ? "Paused · Stopping in 10s unless resumed"
          : "Paused · Resume to continue";
      }
      if (isVoiceReconnecting) return "Reconnecting…";
      if (isVoiceFinishing) return "Finishing transcription…";
      if (isVoiceMicStarting) {
        if (voiceMicSignal !== "silent") return "Starting microphone…";
        return `No audio from ${voiceMicDeviceLabel ?? "microphone"}`;
      }
      return null;
    })();
    const placeholder = (() => {
      if (voiceSessionStatus) return voiceSessionStatus;
      // The live meter at the start of the empty draft says it's listening.
      if (isVoiceListeningChrome) return "";
      if (disabled && disabledPlaceholder) return disabledPlaceholder;
      const agentName = agentId ? getAgentConfig(agentId)?.name : null;
      return agentName ? `Ask ${agentName}` : "Ask anything";
    })();

    // Trigger chars that open a menu, data-driven from the agent's declared
    // completionSources — `/` and Daintree's `@` are always available; `$`
    // (Codex capabilities) is added only when the agent declares a `$` source.
    // `#` offers the project's issues and pull requests, so an isolated
    // composer, whose terminal may belong to another project, goes without.
    const activeTriggers = useMemo(() => {
      // Every menu offers what this machine has: its files, its commands.
      if (thisMachineOff) return new Set<ComposerTrigger>();
      const triggers = new Set<ComposerTrigger>(["/", "@"]);
      if (!isolated) triggers.add("#");
      for (const source of agentId ? (getAgentConfig(agentId)?.completionSources ?? []) : []) {
        triggers.add(source.trigger);
      }
      return triggers;
    }, [agentId, thisMachineOff, isolated]);

    const triggerChar = activeCompletionContext?.triggerChar ?? null;
    // A plugin's `@{prefix}:` (#13795) claims the query when a provider holds
    // that prefix in this project; then Daintree's own providers; else `@file`.
    const contextProviderEntries = usePluginContextProvidersStore((s) => s.entries);
    const completionQuery = activeCompletionContext?.query ?? "";
    const contextClaim = useMemo((): ContextProviderClaim | null => {
      if (triggerChar !== "@") return null;
      const split = splitContextProviderQuery(completionQuery);
      if (split === null) return null;
      const entry = contextProviderEntries.find(
        (e) => e.status === "active" && e.prefix === split.prefix
      );
      return entry
        ? {
            prefix: entry.prefix,
            pluginId: entry.pluginId,
            pluginName: entry.pluginName,
            query: split.query,
          }
        : null;
    }, [triggerChar, completionQuery, contextProviderEntries]);
    const atClaim =
      triggerChar === "@" && contextClaim === null ? getDaintreeAtClaim(completionQuery) : null;
    const isFileMode = triggerChar === "@" && atClaim === null && contextClaim === null;
    // A token is being completed. Whether its menu shows is decided once its
    // rows are known: the `#` menu opens only on rows (`isAutocompleteOpen`).
    const isCompleting = activeCompletionContext !== null && !disabled;
    const isAtMenuOpen = isCompleting && triggerChar === "@";

    useEffect(() => {
      usePluginContextProvidersStore.getState().init();
    }, []);
    // Which prefixes this project's plugins hold can change without an event
    // reaching this view; the moment it matters is when an `@` menu opens.
    useEffect(() => {
      if (isAtMenuOpen) usePluginContextProvidersStore.getState().refresh();
    }, [isAtMenuOpen]);

    // Chips are drawn for the prefixes a provider holds here, and never on a
    // terminal of another host, where references go as typed.
    const contextChipProviders = useMemo(
      (): ReadonlyMap<string, ContextReferenceChipProvider> =>
        thisMachineOff
          ? NO_CONTEXT_CHIP_PROVIDERS
          : contextReferenceChipProviders(contextProviderEntries),
      [thisMachineOff, contextProviderEntries]
    );
    useEffect(() => {
      const view = editorViewRef.current;
      if (view) applyContextReferenceProviders(view, contextChipProviders);
    }, [contextChipProviders, editorViewRef, terminalId]);
    // Nor are references marked there: this machine can't ask about its repository.
    useForgeReferenceMarks({
      editorViewRef,
      terminalId,
      cwd: thisMachineOff || !cwd ? null : cwd,
      paused: disabled,
      value,
    });

    const {
      items: contextSearchItems,
      isLoading: isContextLoading,
      resultsFor: contextResultsFor,
    } = useContextProviderSearch({
      prefix: contextClaim?.prefix ?? null,
      pluginId: contextClaim?.pluginId ?? null,
      query: contextClaim?.query ?? "",
      enabled: isCompleting && contextClaim !== null,
    });
    // Rows another provider answered — another prefix, or another plugin that
    // held this one a moment ago — are never shown: their ids mean nothing here.
    const contextItems =
      contextClaim !== null &&
      contextResultsFor?.prefix === contextClaim.prefix &&
      contextResultsFor.pluginId === contextClaim.pluginId
        ? contextSearchItems
        : NO_CONTEXT_ITEMS;

    const fileQuery = isFileMode ? fileSearchQuery(activeCompletionContext?.query ?? "") : "";
    const {
      files: autocompleteFiles,
      isLoading: isAutocompleteLoading,
      resultsQuery: fileResultsQuery,
    } = useFileAutocomplete({
      cwd,
      query: fileQuery,
      enabled: isCompleting && isFileMode,
      limit: 50,
    });

    const { items: autocompleteCommands, isLoading: isCommandsLoading } =
      useSlashCommandAutocomplete({
        query: activeCompletionContext?.query ?? "",
        enabled: isCompleting && (triggerChar === "/" || triggerChar === "$"),
        trigger: triggerChar === "$" ? "$" : "/",
        agentId,
        projectPath: cwd,
      });

    const { commandMap } = useSlashCommandList({ agentId, projectPath: cwd });

    // A plugin's prompt templates (#13799) share the `/` menu, in a band of
    // their own after the agent's commands.
    const promptTemplates = usePluginPromptTemplates(currentProjectId);
    const isSlashMenuOpen = isCompleting && triggerChar === "/";
    // A plugin attached in dev mode announces itself without a provenance event.
    useEffect(() => {
      if (isSlashMenuOpen) usePluginRuntimeStore.getState().refresh();
    }, [isSlashMenuOpen]);
    const templateItems = useMemo(
      () =>
        isSlashMenuOpen
          ? toPromptTemplateItems(promptTemplates, completionQuery)
          : NO_TEMPLATE_ITEMS,
      [isSlashMenuOpen, promptTemplates, completionQuery]
    );
    // Held by key and read back through the live list, so a plugin that is
    // disabled, unloaded or changed while its form is open takes the form with it.
    const [activeTemplateKey, setActiveTemplateKey] = useState<string | null>(null);
    useEffect(() => {
      if (activeTemplateKey !== null && !promptTemplates.some((t) => t.key === activeTemplateKey)) {
        setActiveTemplateKey(null);
      }
    }, [activeTemplateKey, promptTemplates]);
    const activeTemplate = promptTemplates.find((t) => t.key === activeTemplateKey) ?? null;

    const forgeReferences = useForgeReferences({
      projectId: currentProjectId,
      cwd,
      enabled: isCompleting && triggerChar === "#",
    });

    const { autocompleteItems, isLoading } = useAutocompleteItems({
      activeCompletionContext,
      autocompleteFiles,
      isAutocompleteLoading,
      autocompleteCommands,
      isCommandsLoading,
      templateItems,
      contextClaim,
      contextItems,
      isContextLoading,
      forgeReferences,
    });
    // `#` is ordinary text far more often than a reference, so with nothing to
    // offer — no forge, no credential, nothing matching — it stays just a
    // character: no menu, and Enter sends.
    const isAutocompleteOpen =
      isCompleting && (triggerChar !== "#" || autocompleteItems.length > 0);

    // Per-provider staleness: the debounced async searches — `@file` and a
    // plugin's `@{prefix}:` — can go stale. Each dims only its own rows, never
    // a fresh `$` or static `@diff` list, and Enter on a dimmed row inserts
    // nothing, so a row answering an older query is never picked.
    const isFileStale = isFileMode && fileResultsQuery !== fileQuery;
    const staleContextPrefix =
      contextClaim !== null && contextResultsFor?.query !== contextClaim.query
        ? contextClaim.prefix
        : null;
    const staleItemKeys = useMemo(() => {
      if (isFileStale) return new Set(autocompleteFiles);
      if (staleContextPrefix !== null) {
        return new Set(contextItems.map((item) => contextItemKey(staleContextPrefix, item.id)));
      }
      return EMPTY_STALE_KEYS;
    }, [isFileStale, autocompleteFiles, staleContextPrefix, contextItems]);

    useEffect(() => {
      latestRef.current = {
        terminalId,
        voiceId,
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
        modEnterSend,
        altChords,
        uploadSurface,
      };
    });

    const canvasTrackRef = useComposerMeasure({ inputShellRef, trailingGroupRef });
    const scrollEdges = useEditorScrollEdges(inputShellRef);

    useAutocompletePositioning({
      editorViewRef,
      inputShellRef,
      rootRef,
      isAutocompleteOpen,
      activeCompletionContext,
      setMenuPlacement,
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

    const applyEditorValue: ApplyEditorValue = (nextValue, options) => {
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
      if (options?.resetHistory) clearComposerHistory(view);
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

    // The selection a spoken rewrite acts on (#14635). An isolated composer
    // types to another view's terminal, so dictation never targets it.
    useEffect(() => {
      if (isolated) return;
      return registerComposerSelectionSource({
        terminalId,
        hasFocus: () => {
          const view = editorViewRef.current;
          return view !== null && editorOwnsDomFocus(view);
        },
        captureSelection: () => {
          const view = editorViewRef.current;
          // Written through at once: a send waiting on the rewrite reads the
          // draft store, which would otherwise catch up only on the next render.
          return view
            ? captureRewriteSelection(view, (doc) =>
                useTerminalInputStore.getState().setDraftInput(terminalId, doc, projectId)
              )
            : null;
        },
      });
    }, [terminalId, isolated, projectId]);

    const { sendText: sendResolvedText } = useTokenResolution({
      latestRef,
      applyEditorValue,
      setIsExpanded,
      setActiveCompletionContext,
      terminalId,
      voice: voiceTarget,
      cwd,
      agentId,
      expandContext: !thisMachineOff,
    });

    // The outside-write revision the effect below last brought into the editor.
    // While the store's count is ahead of it, a write sits in the draft store
    // that the editor does not show yet.
    const appliedExternalDraftRevisionRef = useRef(externalDraftRevision);

    useEffect(() => {
      const appliedBefore = appliedExternalDraftRevisionRef.current;
      appliedExternalDraftRevisionRef.current = externalDraftRevision;
      if (externalDraftRevision === 0) return;
      const inputState = useTerminalInputStore.getState();
      const draft = inputState.getDraftInput(terminalId, projectId);
      // Taken whatever happens, so a hint for a draft never shown can't land later.
      const pendingSelection = takePendingComposerSelection(
        makeDraftKey(terminalId, projectId),
        draft
      );
      const view = editorViewRef.current;
      if (!view) return;
      // A recalled prompt is another draft, even one that reads the same.
      const replacedAt = inputState.replacedDraftRevisions.get(makeDraftKey(terminalId, projectId));
      if (replacedAt !== undefined && replacedAt > appliedBefore) advanceComposerDraft(view);
      const landed = takeLandedCorrection(terminalId, projectId, draft);
      const reviewed = landed !== null && isLatestDictation(voiceId, landed);
      const scratched = takeScratchLanded(terminalId, projectId, draft);
      // Only what differs is replaced, so an append leaves the image and
      // file chips already in the draft attached.
      const change = outsideWriteChange(view.state.doc.toString(), draft, landed);
      if (change !== null) {
        setValue(draft);
        lastEmittedValueRef.current = draft;
        isApplyingExternalValueRef.current = true;
        // Only writes that keep the caret since this last ran (dictation,
        // its correction and file links) leave it to the user.
        const keepsCaret = inputState.caretMovingDraftRevision <= appliedBefore;
        const selection = keepsCaret
          ? selectionAfterOutsideWrite(view.state, view.hasFocus, change, pendingSelection)
          : undefined;
        view.dispatch(
          outsideDraftWrite(change, draft, landed, { selection, reviewed, keepsCaret })
        );
        // Emptied from outside (sent or cleared elsewhere): nothing to undo into.
        // A spoken "scratch that" or a cancelled dictation that empties it is
        // an edit, so undo brings the words back.
        if (draft === "" && !scratched) clearComposerHistory(view);
      } else {
        if (landed) replayLandedCorrection(view, landed, reviewed);
        // Words that replaced a selection with the same text change nothing,
        // but the selection still collapses after them.
        if (pendingSelection) {
          view.dispatch({
            selection: { anchor: pendingSelection.from, head: pendingSelection.to },
          });
        }
      }
    }, [externalDraftRevision, terminalId, projectId]);

    // A new dictation puts the last correction behind the user, so its review
    // ends as the session begins, before any of its words land (#14875).
    useEffect(
      () =>
        useVoiceRecordingStore.subscribe((state, prev) => {
          const session = state.panelBuffers[voiceId]?.dictationSessionId;
          if (!session || session === prev.panelBuffers[voiceId]?.dictationSessionId) return;
          const view = editorViewRef.current;
          if (view) endCorrectionReview(view);
        }),
      [voiceId]
    );

    // Steps taken while another screen drove are the driver's, not this
    // view's: none survive a takeover (the sync above lands the latest first).
    const historyFollowsDriverRef = useRef(followsDriver);
    useEffect(() => {
      if (historyFollowsDriverRef.current === followsDriver) return;
      historyFollowsDriverRef.current = followsDriver;
      const view = editorViewRef.current;
      if (view) clearComposerHistory(view);
    }, [followsDriver]);

    useVoiceDecorations({ terminalId: voiceId, editorViewRef });

    /**
     * The `isDraftUnchanged` for a send of the editor's text as it reads now:
     * the send clears only that text, never what landed in the draft since or
     * was still on its way to the editor when it began.
     */
    const guardSentDraft = useCallback(
      (projectIdAtSend: string | undefined) =>
        draftUnchangedSince(
          () => editorViewRef.current?.state.doc.toString() ?? latestRef.current?.value,
          () => useTerminalInputStore.getState().getDraftInput(terminalId, projectIdAtSend),
          useTerminalInputStore.getState().externalDraftRevision !==
            appliedExternalDraftRevisionRef.current
        ),
      [editorViewRef, terminalId]
    );

    // The Expanded Editor hands the caret back to the bar when its exit
    // animation ends: a hand-back from a send that closed it waits for that.
    const expandedEditorShownRef = useRef(false);
    const expandedEditorOpeningsRef = useRef(0);
    const afterExpandedEditorClosedRef = useRef<Array<() => void>>([]);
    useEffect(() => {
      if (!isExpanded) return;
      expandedEditorShownRef.current = true;
      expandedEditorOpeningsRef.current += 1;
    }, [isExpanded]);
    const handleExpandedEditorClosed = () => {
      expandedEditorShownRef.current = false;
      const waiting = afterExpandedEditorClosedRef.current;
      afterExpandedEditorClosedRef.current = [];
      for (const run of waiting) run();
    };
    const afterExpandedEditorCloses = useCallback((run: () => void) => {
      if (expandedEditorShownRef.current) afterExpandedEditorClosedRef.current.push(run);
      else run();
    }, []);

    const claimSendHandBack = useSendHandBack({
      terminalId,
      projectId,
      isolated,
      editorViewRef,
      expandedEditorOpeningsRef,
      afterExpandedEditorCloses,
    });

    // A send the terminal turned down leaves its draft where it was typed, and
    // says so until the draft next changes or is sent again (#14945). An
    // ordinary send owns the composer's spoken status from the moment it goes,
    // so an earlier dictated send's outcome is never read out again over it;
    // a dictated send leaves its own outcome to speak until it is refused.
    // A spoken "send it" on a reply too short to send by voice says so too,
    // and how to send it (#14944): that note outlasts the dictation's own
    // writes, its cleanup landing after the stop above all, while they leave
    // a reply to send.
    const [sendNote, setSendNote] = useState<{
      terminalId: string;
      refused: boolean;
      tooShort?: true;
      crossHost?: CrossHostRefusal;
      retires?: VoiceScratchRefusal | VoiceFileReferenceNote | null;
    } | null>(null);
    const dropSendRefusal = (dictationKeepsReply = false) =>
      setSendNote((note) =>
        note?.refused && !(note.tooShort && dictationKeepsReply)
          ? { terminalId: note.terminalId, refused: false }
          : note
      );
    const submitAttemptRef = useRef(0);
    const notingRefusal = useCallback(
      (submit: (outgoing: string) => Promise<boolean>, dictated: boolean) =>
        async (outgoing: string): Promise<boolean> => {
          const attempt = ++submitAttemptRef.current;
          setSendNote(dictated ? null : { terminalId, refused: false });
          let accepted: boolean;
          try {
            accepted = await submit(outgoing);
          } catch {
            accepted = false;
          }
          if (!accepted && submitAttemptRef.current === attempt) {
            const retires = standingVoiceNote(voiceId);
            // A voice wait begun since this send went has taken the status over.
            setSendNote((note) =>
              dictated || note !== null ? { terminalId, refused: true, retires } : note
            );
          }
          return accepted;
        },
      [terminalId, voiceId]
    );
    const noteSpokenSendTooShort = useCallback(() => {
      // An earlier send still on its way can't say over it that it wasn't sent.
      ++submitAttemptRef.current;
      const retires = standingVoiceNote(voiceId);
      setSendNote({ terminalId, refused: true, tooShort: true, retires });
    }, [terminalId, voiceId]);
    const noteCrossHostRefusal = (reason: CrossHostRefusal) => {
      ++submitAttemptRef.current;
      setSendNote({ terminalId, refused: true, crossHost: reason });
    };

    // Every way this composer sends — Enter, a picked slash command, a prompt
    // from the command picker — goes through `submitText` when it is given, so
    // a refused send never eats the draft, whichever path sent it.
    const sendText = useCallback(
      (text: string, options?: SendTextOptions & { dictated?: boolean }) => {
        const { dictated = false, ...sendOptions } = options ?? {};
        if (sendOptions.submit) return sendResolvedText(text, sendOptions);
        // Claimed before any expansion is awaited, so a press while a diff
        // is fetched calls the hand-back off.
        const onHandedOff = sendOptions.onHandedOff ?? claimSendHandBack();
        if (!submitTextRef.current) return sendResolvedText(text, { ...sendOptions, onHandedOff });
        const imagePaths = sendOptions.imagePaths ?? [];
        return sendResolvedText(text, {
          // Awaited now, so the user can type while it is on its way: only the
          // text that went out is cleared, whichever path sent it.
          isDraftUnchanged: guardSentDraft(latestRef.current?.projectId),
          ...sendOptions,
          onHandedOff,
          // The host's as it stands when the text goes, not at the press: an
          // expansion awaited in between can outlast a lock or a restart.
          submit: notingRefusal(
            (outgoing) => submitTextRef.current?.(outgoing, imagePaths) ?? Promise.resolve(false),
            dictated
          ),
        });
      },
      [sendResolvedText, guardSentDraft, claimSendHandBack, notingRefusal]
    );

    const resetEditorDoc = () => {
      applyEditorValue("", {
        selection: EditorSelection.create([EditorSelection.cursor(0)]),
        resetHistory: true,
      });
    };

    // Whether the composer took the draft, settled once any awaited expansion
    // or submission has: a voice send completes its progress only then.
    // A dictated send whose composer unmounted while it waited still goes
    // (#15510), from the draft store: there is no editor, and the bar's own
    // state stopped where it unmounted.
    const sendFromEditor = (
      handBack?: SendHandBack,
      voiceSend?: VoiceDraftSend,
      route?: ComposerSendRoute,
      departed?: DepartedComposerSend
    ): boolean | Promise<boolean> => {
      // An attachment still on its way would be left out of what is sent.
      if (isComposerSendHeld(uploadSurface)) return false;
      // The send takes the draft as it stands. A dictation correction still on
      // its way must not rewrite it mid-send, or land on the next draft (#14611).
      // One for words a dictated send holds back still lands on them (#14804).
      voiceRecordingService.discardPendingCorrections(voiceId, voiceSend?.sessions);
      const view = departed ? null : editorViewRef.current;
      const latest = latestRef.current;
      const doc =
        departed && voiceSend
          ? voiceSend.draft
          : (view?.state.doc.toString() ?? latest?.value ?? "");
      // Only a split of the text the editor shows can say which part of it goes.
      const split = voiceSend?.kept && voiceSend.draft === doc ? voiceSend : null;
      const text = split?.text ?? doc;
      // Typing the store hasn't caught up with: the editor reads differently
      // with no outside write on its way in. Text kept over it would eat it.
      const editorAheadOfStore = () => {
        if (departed) return false;
        const shown = editorViewRef.current?.state.doc.toString();
        const inputs = useTerminalInputStore.getState();
        return (
          shown !== undefined &&
          shown !== inputs.getDraftInput(terminalId, latest?.projectId) &&
          inputs.externalDraftRevision === appliedExternalDraftRevisionRef.current
        );
      };
      const keepDraft = split
        ? () => {
            if (editorAheadOfStore()) return;
            const kept = voiceRecordingService.keepHeldBackDictation(split);
            if (kept === null) return;
            applyEditorValue(kept, {
              selection: EditorSelection.create([EditorSelection.cursor(kept.length)]),
              resetHistory: true,
            });
          }
        : undefined;
      // A `@diff` fetch is awaited, and a handoff or the user's own typing can
      // land in the draft meanwhile; only the text that went out is cleared.
      // The session a split held back may write meanwhile too: that much
      // change still leaves the sent text to take out.
      const readStored = () =>
        useTerminalInputStore.getState().getDraftInput(terminalId, latest?.projectId);
      const unchanged = departed
        ? draftUnchangedSince(readStored, readStored)
        : guardSentDraft(latest?.projectId);
      const isDraftUnchanged = split
        ? () => unchanged() || (!editorAheadOfStore() && voiceRecordingService.holdsBackFrom(split))
        : unchanged;

      // A chip whose path the text no longer spells is left out, as the editor's own are.
      // Read before the fleet is asked: it attaches them too (#15600).
      const imagePaths = (departed ? departed.imagePaths : readImageChipPaths(view)).filter(
        (path) => text.includes(path)
      );

      // A fleet send settles a batch, or another host, later: what was typed
      // since stays, as on a single-pane send. One the fleet turned down took
      // nothing.
      let refused = false;
      const intercepted = tryComposerFleetBroadcast(
        departed ? departed.fanOut : isFocusedTerminal,
        terminalId,
        text,
        () => {
          if (!isDraftUnchanged()) return;
          if (keepDraft) keepDraft();
          else {
            clearDraftInput(terminalId, projectId);
            resetEditorDoc();
          }
          // Delivered after the departed send settled: a composer showing the
          // draft since takes the store's word for what is left.
          if (departed) useTerminalInputStore.getState().bumpExternalDraftRevision();
        },
        (reason) => {
          refused = true;
          noteCrossHostRefusal(reason);
        },
        imagePaths
      );
      if (intercepted) return !refused;

      return sendText(text, {
        imagePaths,
        isDraftUnchanged,
        onHandedOff: handBack,
        keepDraft,
        dictationSessions: voiceSend?.sessions,
        dictated: voiceSend !== undefined,
        ...(departed && { departed: true }),
        // Routed at its key press: through the route, in place of `submitText`.
        ...(route && {
          submit: notingRefusal(
            (outgoing) => route.submitText(outgoing, imagePaths),
            voiceSend !== undefined
          ),
        }),
      });
    };

    const {
      startVoiceWaitSubmit,
      cancelVoiceWaitSubmit,
      hasPendingVoiceCorrection,
      submitFromEditor,
      voiceSubmitPhase,
      voiceSubmitWait,
      voiceSubmitOutcome,
      voiceWaitKeys,
    } = useVoiceWaitSubmit({
      terminalId,
      projectId,
      voice: voiceTarget,
      editorViewRef,
      editableCompartmentRef,
      sendFromEditor,
      claimSendHandBack,
      captureDeparture: () => ({
        imagePaths: readImageChipPaths(editorViewRef.current),
        fanOut: isFocusedTerminal && isArmed,
      }),
      isDisabled: () => disabledRef.current,
      onSpokenSendTooShort: noteSpokenSendTooShort,
    });
    // The stop-and-send key sends a wait it started as it stands, from
    // anywhere in the page, unless a dictation running elsewhere takes the
    // press first.
    const stopAndSendCombo = useEffectiveCombo("voiceInput.stopAndSend");
    const voiceSessionTakesStopAndSend = useVoiceRecordingStore(
      (s) => s.activeTarget !== null && s.status !== "finishing" && isActiveVoiceSession(s.status)
    );
    const voiceSubmitKeys: VoiceSubmitWaitKeys = {
      enter: voiceWaitKeys.enter,
      escape: voiceWaitKeys.escape,
      skip:
        voiceSubmitWait?.byStopAndSend && voiceWaitKeys.page && !voiceSessionTakesStopAndSend
          ? (stopAndSendCombo ?? null)
          : null,
    };
    // The editor locks and the shell changes the moment a voice send starts;
    // what it is waiting on is only told once the wait outlasts the inline
    // gate, so a send that goes at once says nothing more.
    const isVoiceSubmitting = voiceSubmitPhase !== null;
    // A dictated send waiting is the newest send: its progress and outcome,
    // cancellation included, speak from here.
    if (isVoiceSubmitting && sendNote !== null) setSendNote(null);
    // Dictating again here is the next word on the reply the note was about.
    if (
      sendNote?.tooShort &&
      (isVoiceRecording ||
        isVoiceConnecting ||
        (activeVoicePanelId === voiceId && voiceStatus === "arming"))
    ) {
      setSendNote({ terminalId: sendNote.terminalId, refused: false });
    }
    const isVoiceSendHandingOver = voiceSubmitOutcome?.kind === "sending";
    const voiceSubmitAttempt = voiceSubmitWait?.attempt ?? voiceSubmitOutcome?.attempt ?? 0;
    const showVoiceSubmitStatus = useDeferredLoading(
      isVoiceSubmitting || isVoiceSendHandingOver,
      UI_INLINE_LOADING_GATE_MS
    );
    // A wait the status announced gets its outcome announced too; one that
    // went inside the gate, unannounced, says nothing after.
    const [announcedVoiceAttempt, setAnnouncedVoiceAttempt] = useState<number | null>(null);
    if (
      (isVoiceSubmitting || isVoiceSendHandingOver) &&
      showVoiceSubmitStatus &&
      announcedVoiceAttempt !== voiceSubmitAttempt
    ) {
      setAnnouncedVoiceAttempt(voiceSubmitAttempt);
    }
    // A send the dictation started here reopened says so while that dictation
    // is under way, its start included: the earlier words are still to go,
    // with the new ones (#15703). Once it ends, the draft shows what is left.
    const isVoicePendingHere = useVoiceRecordingStore(
      (s) => s.pendingTarget?.panelId === voiceId && !(thisMachineOff && !voiceTarget)
    );
    const isDictatingHere = isVoiceActiveForPanel || isVoicePendingHere;
    const reopenedVoiceAttempt =
      voiceSubmitOutcome?.kind === "reopened" ? voiceSubmitOutcome.attempt : null;
    const [retiredReopenAttempt, setRetiredReopenAttempt] = useState<number | null>(null);
    if (
      reopenedVoiceAttempt !== null &&
      reopenedVoiceAttempt !== retiredReopenAttempt &&
      !isDictatingHere
    ) {
      setRetiredReopenAttempt(reopenedVoiceAttempt);
    }
    const isSendReopened =
      reopenedVoiceAttempt !== null &&
      reopenedVoiceAttempt !== retiredReopenAttempt &&
      isDictatingHere;
    // The wait's progress and its receipt own the shell's top border while on
    // screen, so the focus ring, which would run through the caption, waits.
    const [isVoiceSubmitPresenting, setIsVoiceSubmitPresenting] = useState(false);
    const voiceWaitSessions =
      voiceSubmitWait?.phase === "polishing" ? voiceSubmitWait.sessions : undefined;
    const voiceCorrectionStreamed = useVoiceRecordingStore((s) =>
      correctionStreamShare(s.panelBuffers[voiceId]?.correctionRanges ?? [], voiceWaitSessions)
    );
    // Dictated words still on their way hide the placeholder as a draft does.
    const hasVoicePreview = useVoiceRecordingStore(
      (s) => (s.panelBuffers[voiceId]?.liveText ?? "").trim() !== ""
    );
    // The session's status on the border, for a draft that hides the
    // placeholder saying it. The outcomes of a scratch and a send have the
    // border first, the newer of the two showing.
    const ownSendNote = sendNote?.terminalId === terminalId ? sendNote : null;
    const isSendRefused = ownSendNote?.refused === true;
    const sendRefusedCaption = ownSendNote?.tooShort
      ? SPOKEN_SEND_TOO_SHORT_CAPTION
      : ownSendNote?.crossHost
        ? CROSS_HOST_CAPTION[ownSendNote.crossHost]
        : "Not sent";
    const sendRefusedStatus = ownSendNote?.tooShort
      ? SPOKEN_SEND_TOO_SHORT_STATUS
      : ownSendNote?.crossHost
        ? CROSS_HOST_STATUS[ownSendNote.crossHost]
        : SEND_HELD_STATUS;
    // A refused send retires the voice note it found on the border, never a
    // newer one. One the send took outlives it: it says what went out.
    const retiredNote = isSendRefused ? (ownSendNote?.retires ?? null) : null;
    useEffect(() => {
      const voice = useVoiceRecordingStore.getState();
      if (!retiredNote) return;
      if (voice.scratchRefusal === retiredNote) voice.setScratchRefusal(null);
      if (voice.fileReferenceNote === retiredNote) voice.setFileReferenceNote(null);
    }, [retiredNote]);
    // A "scratch that" that removed nothing (#14973), on an empty draft too:
    // the placeholder doesn't say it.
    const scratchRefusal = useVoiceRecordingStore((s) =>
      s.scratchRefusal?.panelId === voiceId ? s.scratchRefusal : null
    );
    const showScratchRefusalCaption =
      scratchRefusal !== null && !isVoiceSubmitting && !isVoiceSubmitPresenting;
    // Spoken file references that found no file (#14983). A spoken send hides
    // the note while it waits, often longer than the note lasts, so it runs
    // its time only while on the border.
    const fileReferenceNote = useVoiceRecordingStore((s) =>
      s.fileReferenceNote?.panelId === voiceId ? s.fileReferenceNote : null
    );
    const showFileReferenceCaption =
      fileReferenceNote !== null && !isVoiceSubmitting && !isVoiceSubmitPresenting;
    useEffect(() => {
      if (!showFileReferenceCaption || !fileReferenceNote) return;
      const timer = setTimeout(() => {
        const voice = useVoiceRecordingStore.getState();
        if (voice.fileReferenceNote === fileReferenceNote) voice.setFileReferenceNote(null);
      }, FILE_REFERENCE_NOTE_MS);
      return () => clearTimeout(timer);
    }, [showFileReferenceCaption, fileReferenceNote]);
    const showSendRefusedCaption =
      isSendRefused &&
      !isVoiceSubmitting &&
      !isVoiceSubmitPresenting &&
      !showScratchRefusalCaption &&
      !showFileReferenceCaption;
    // A second note saying the same is still a change to read.
    const voiceNoteStatus = scratchRefusal
      ? `${SCRATCH_REFUSAL_STATUS[scratchRefusal.reason]}${scratchRefusal.id % 2 ? "" : "\u200b"}`
      : fileReferenceNote
        ? `${unresolvedFileReferencesStatus(fileReferenceNote.references)}${fileReferenceNote.id % 2 ? "" : "\u200b"}`
        : "";
    const showVoiceSessionCaption =
      voiceSessionStatus !== null &&
      (value.length > 0 || hasVoicePreview) &&
      !isVoiceSubmitting &&
      !isVoiceSubmitPresenting &&
      !showSendRefusedCaption &&
      !showScratchRefusalCaption &&
      !showFileReferenceCaption;
    const showSendReopenedCaption =
      isSendReopened &&
      !isVoiceSubmitting &&
      !isVoiceSubmitPresenting &&
      !showVoiceSessionCaption &&
      !showSendRefusedCaption &&
      !showScratchRefusalCaption &&
      !showFileReferenceCaption;
    // A draft hides the placeholder that says why the composer is unavailable,
    // so the border carries it instead, as it does a voice session's state.
    const showDisabledCaption =
      disabled &&
      !!disabledPlaceholder &&
      value.length > 0 &&
      !isVoiceSubmitting &&
      !isVoiceSubmitPresenting &&
      !showVoiceSessionCaption &&
      !showSendReopenedCaption &&
      !showSendRefusedCaption &&
      !showScratchRefusalCaption &&
      !showFileReferenceCaption;

    const voiceSlotRef = useRef<HTMLSpanElement>(null);
    const voiceSlotFocusedRef = useRef(false);
    useLayoutEffect(() => {
      const slot = voiceSlotRef.current;
      if (!slot || !voiceSlotFocusedRef.current) return;
      const active = document.activeElement;
      if (active && active !== document.body) {
        voiceSlotFocusedRef.current = slot.contains(active);
        return;
      }
      slot.querySelector("button")?.focus({ preventScroll: true });
    }, [isVoiceSubmitting]);
    // A send that went without its cleanup says so even when its wait went
    // unannounced, as its receipt does.
    const voiceSendUncleaned =
      voiceSubmitOutcome?.kind === "sent" ? voiceSubmitOutcome.cleanup : undefined;
    // A reopened send is told however short its wait was, for as long as its
    // note shows: nothing else says the earlier words haven't gone (#15703).
    const voiceSubmitStatus = voiceSubmitWait
      ? showVoiceSubmitStatus
        ? voiceSubmitWaitStatus(voiceSubmitWait, voiceSubmitKeys)
        : ""
      : voiceSendUncleaned
        ? VOICE_SEND_UNCLEANED_STATUS[voiceSendUncleaned]
        : voiceSubmitOutcome?.kind === "reopened"
          ? isSendReopened
            ? VOICE_SUBMIT_OUTCOME_STATUS.reopened
            : ""
          : voiceSubmitOutcome?.attempt === announcedVoiceAttempt
            ? VOICE_SUBMIT_OUTCOME_STATUS[voiceSubmitOutcome.kind]
            : "";
    // Heard from whichever host holds the editor: a send from the Expanded
    // Editor waits there, and a live region outside its modal goes unheard.
    const voiceSubmitAnnouncer = (
      <div role="status" aria-live="polite" className="sr-only">
        {ownSendNote ? (isSendRefused ? sendRefusedStatus : "") : voiceSubmitStatus}
      </div>
    );
    // The Expanded Editor has no composer shell to draw the wait's progress
    // in, so its header names the wait, or a send that didn't go. Nothing
    // covers the draft: the cleanup is still writing over it.
    const expandedSubmitLabel =
      voiceSubmitWait && showVoiceSubmitStatus ? (
        <span aria-hidden="true" className="ml-auto mr-3 text-xs text-text-secondary">
          {voiceSubmitWaitCaption(voiceSubmitWait, voiceSubmitKeys)}
        </span>
      ) : showScratchRefusalCaption ? (
        <span aria-hidden="true" className="ml-auto mr-3 text-xs text-text-secondary">
          {SCRATCH_REFUSAL_CAPTION[scratchRefusal.reason]}
        </span>
      ) : showFileReferenceCaption ? (
        <span
          aria-hidden="true"
          className="ml-auto mr-3 min-w-0 truncate text-xs text-text-secondary"
        >
          {unresolvedFileReferencesCaption(fileReferenceNote.references)}
        </span>
      ) : isSendReopened ? (
        <span aria-hidden="true" className="ml-auto mr-3 text-xs text-text-secondary">
          {VOICE_SEND_REOPENED_CAPTION}
        </span>
      ) : isSendRefused ? (
        <span aria-hidden="true" className="ml-auto mr-3 text-xs text-text-secondary">
          {sendRefusedCaption}
        </span>
      ) : null;

    const handleDictationEscape = () => voiceRecordingService.handleEscape(voiceId);
    const dictationCancelConfirm = useDictationCancelConfirm(voiceId);

    const collapseEditor = () => setIsExpanded(false);

    // Whether a deferred grab still has the keyboard to take. A current request
    // naming this pane's surface decides; without one, only a home of the
    // hybrid input does, so a grab nobody asked for never lands off home.
    const isHybridInputStillWanted = () => {
      const requested = requestedPaneSurface(terminalId);
      if (requested !== null) return requested === "hybridInput";
      return selectHomeFocusTarget(useTerminalInputStore.getState()) === "hybridInput";
    };

    const caretToEnd = (view: EditorView) => {
      view.dispatch({
        selection: EditorSelection.cursor(view.state.doc.length),
        scrollIntoView: true,
      });
    };

    const currentDraft = () =>
      useTerminalInputStore.getState().getDraftInput(terminalId, latestRef.current?.projectId);

    // The dictation key taking the person back puts the caret after the
    // dictated words (#14791), once: a composer remounted since has forgotten
    // its caret, and one left mid-draft shows it somewhere else. The offset is
    // into the draft, so an editor still catching up with it gets the caret
    // when it does, and keeps its own rules until then.
    const placeReturnCaret = (view: EditorView): boolean => {
      const at = takeRequestedDictationCaret(terminalId);
      const draft = currentDraft();
      if (at === null || at > draft.length) return false;
      if (view.state.doc.toString() !== draft) {
        setPendingComposerSelection(draftKeyRef.current, draft, { from: at, to: at });
        return false;
      }
      view.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
      return true;
    };

    // Dictation writes at the caret the composer last showed in this draft, or
    // at the end of a draft nobody focused. Focusing a composer that never had
    // focus would leave CodeMirror's caret at 0, which the caret tracker then
    // publishes as the place to dictate (#14770).
    const parkDictationCaret = (view: EditorView) => {
      if (placeReturnCaret(view)) return;
      if (readComposerSelection(draftKeyRef.current, currentDraft()) === null) caretToEnd(view);
    };

    const focusEditor = () => {
      const view = editorViewRef.current;
      if (!view) return;
      if (requestedForDictation(terminalId) && !editorOwnsDomFocus(view)) parkDictationCaret(view);
      view.focus();
      // The second look a frame later wins focus back from the grid pane's own
      // focus pass. An isolated composer has no pane behind it, and a late
      // refocus there would undo the user leaving it in the meantime.
      if (isolated) return;
      const gen = focusGenerationRef.current;
      const epoch = captureFocusEpoch();
      requestAnimationFrame(() => {
        if (focusGenerationRef.current !== gen) return;
        if (!isFocusEpochCurrent(epoch)) return;
        if (editorViewRef.current !== view) return;
        if (!isHybridInputStillWanted()) return;
        if (isScratchpadElement(document.activeElement, terminalId)) return;
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
        // Only what the pane or a caller asked of this surface, and only while
        // that is still current: a press, another pane, or focus taken by
        // something else since the ask all end it.
        if (pendingPaneSurface(terminalId) !== "hybridInput") return;
        // A bar that mounts late must not take the caret from the Scratchpad
        // (#12835), unless dictation asked for it: that start is the user's own
        // move to this bar (#14770).
        if (
          !requestedForDictation(terminalId) &&
          isScratchpadElement(document.activeElement, terminalId)
        ) {
          return;
        }
        focusEditor();
      };
    });
    useEffect(() => {
      // After the commit's remaining effects: a bar mounting in the same commit
      // as its pane's arrival runs before the pane's focus pass has said where
      // the keyboard goes.
      queueMicrotask(() => claimMountFocusRef.current());
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
        // A different draft: an attachment still on its way was meant for the
        // one this replaces.
        if (view) advanceComposerDraft(view);
        applyEditorValue(result, {
          selection: EditorSelection.create([EditorSelection.cursor(result.length)]),
          focus: true,
        });
        return true;
      }
      return false;
    };

    // A `/` row run from the menu goes where a typed Enter would: to the armed
    // fleet, else to this pane (#14948).
    const runCompletedCommand = (text: string) => {
      const latest = latestRef.current;
      // The menu takes Enter before the keymap asks whether the composer is
      // disabled, and the fleet would never ask.
      if (!latest || latest.disabled) return;
      // An attachment still on its way would be left out, as on Enter.
      if (isComposerSendHeld(uploadSurface)) return;
      // The editor still reads the partial token: only that leaves the draft.
      const isDraftUnchanged = guardSentDraft(latest.projectId);
      // The draft's images go with the command, as on Enter (#15600).
      const imagePaths = readImageChipPaths(editorViewRef.current).filter((path) =>
        text.includes(path)
      );
      const intercepted = tryComposerFleetBroadcast(
        isFocusedTerminal,
        terminalId,
        text,
        () => {
          if (!isDraftUnchanged()) return;
          clearDraftInput(terminalId, projectId);
          resetEditorDoc();
        },
        noteCrossHostRefusal,
        imagePaths
      );
      if (!intercepted) void sendText(text, { imagePaths });
    };

    // The `/` token a template was picked with, as an undo step of its own: a
    // pick made straight after typing the token would otherwise merge with
    // that typing.
    const cutTemplateToken = (view: EditorView, cut: DraftSpan) => {
      view.dispatch({
        changes: cut,
        annotations: [isolateHistory.of("full"), Transaction.userEvent.of("delete")],
      });
    };

    // A template fills an empty draft and goes after a written one; routing it
    // through sendText would submit it. After the text rather than at the
    // caret, which sits wherever the `/` token was typed. That token, when one
    // is given, comes out in the same step, so one undo takes back the pick.
    const handleTemplateDraft = (rendered: string, token?: DraftSpan) => {
      // The editor stores every break as "\n", so a CRLF template would put
      // the caret past the end of the document it lands in.
      const text = rendered.replace(/\r\n?/g, "\n");
      const view = editorViewRef.current;
      const doc = view?.state.doc.toString() ?? lastEmittedValueRef.current;
      const cut = token ? promptTemplateTokenCut(doc, token) : null;
      const draft = cut ? doc.slice(0, cut.from) + doc.slice(cut.to) : doc;
      const written = draft.trim() !== "";
      if (written && text.trim() === "") {
        if (view && cut) cutTemplateToken(view, cut);
        view?.focus();
        return;
      }
      const next = composeDraftWithInstruction(draft, text);
      if (!view) {
        applyEditorValue(next, {
          selection: EditorSelection.create([EditorSelection.cursor(next.length)]),
          focus: true,
        });
        return;
      }
      // After a written draft only the new span goes in, so the words, chips
      // and undo steps already there are untouched. Either way the write is an
      // undo step of its own, or one undo straight after a quick pick would
      // take the typed token and the template back together.
      view.dispatch({
        changes: written
          ? [...(cut ? [cut] : []), { from: doc.length, insert: next.slice(draft.length) }]
          : { from: 0, to: doc.length, insert: next },
        selection: EditorSelection.cursor(next.length),
        scrollIntoView: true,
        annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.paste")],
      });
      view.focus();
    };

    // Read from the live list: the row may answer a plugin that has since gone.
    const handlePickTemplate = (templateKey: string, token: DraftSpan) => {
      const entry = promptTemplates.find((t) => t.key === templateKey);
      if (!entry) return;
      if (entry.template.args.length === 0) {
        handleTemplateDraft(renderPromptTemplate(entry.template.body, {}), token);
        return;
      }
      // The form has the pick from here, so the token it was made with is spent.
      const view = editorViewRef.current;
      if (view) cutTemplateToken(view, promptTemplateTokenCut(view.state.doc.toString(), token));
      setActiveTemplateKey(entry.key);
    };

    // Filled against the draft as it stands when the form is, so anything
    // written while it was open stays.
    const handleTemplateSubmit = (values: Record<string, string>) => {
      if (!activeTemplate) return;
      setActiveTemplateKey(null);
      handleTemplateDraft(renderPromptTemplate(activeTemplate.template.body, values));
    };

    const { applyAutocompleteSelection, handleAutocompleteSelect } = useAutocompleteApply({
      editorViewRef,
      latestRef,
      lastQueryRef,
      applyEditorValue,
      onExecute: runCompletedCommand,
      onPickTemplate: handlePickTemplate,
      setActiveCompletionContext,
      setSelectedIndex,
    });

    useImperativeHandle(
      ref,
      () => ({
        focus: focusEditor,
        focusForDictation: () => {
          const view = editorViewRef.current;
          if (!view) return;
          if (!editorOwnsDomFocus(view)) parkDictationCaret(view);
          view.focus();
        },
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
          // caret — a background state change would otherwise move it. Only the
          // dictation key's return asks for one.
          if (editorOwnsDomFocus(view)) {
            placeReturnCaret(view);
            return true;
          }
          const gen = focusGenerationRef.current;
          const epoch = captureFocusEpoch();
          // A grab a caller asked for ends with the ask. The selection moving to
          // another pane ends it without advancing the epoch, and home alone
          // must not carry the grab on into the pane the user left.
          const asked = requestedPaneSurface(terminalId);
          // Dictation starting is the user's own move to this bar, and the words
          // go in at its caret: the Scratchpad doesn't hold the keyboard back
          // and the caret stays where the composer showed it (#14770).
          const forDictation = requestedForDictation(terminalId);
          requestAnimationFrame(() => {
            if (focusGenerationRef.current !== gen) return;
            // A press or a newer request since the call (#8487).
            if (!isFocusEpochCurrent(epoch)) return;
            if (editorViewRef.current !== view) return;
            if (asked !== null && requestedPaneSurface(terminalId) !== asked) return;
            if (!isHybridInputStillWanted()) return;
            if (!forDictation && isScratchpadElement(document.activeElement, terminalId)) return;
            // The user can click into the draft between the call and this frame,
            // which calls off the epoch; the bar's own claim can focus it too.
            if (editorOwnsDomFocus(view)) {
              placeReturnCaret(view);
              return;
            }
            if (forDictation) parkDictationCaret(view);
            else caretToEnd(view);
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
          // The snapshot is what goes out; a correction landing during the
          // submit would rewrite the draft under it (#14611).
          voiceRecordingService.discardPendingCorrections(voiceId);
          const snapshot = view.state.doc.toString();
          return sendText(snapshot, {
            compose: (draft) => composeDraftWithInstruction(draft, instruction),
            submit,
            // What was sent is a snapshot; what the user has by the time the
            // submit lands may not be. Only the snapshot is ours to clear.
            isDraftUnchanged: guardSentDraft(latest.projectId),
          });
        },
      }),
      [focusEditor, guardSentDraft, sendText, terminalId, voiceId]
    );

    // Claim the type-anywhere routing target (#11134) whenever the user really
    // types here. Agent panels only — `agentId` is absent for the fleet-armed
    // raw-shell branch of `shouldShowHybridInputBar`, and routing into a shell
    // is exactly what the rescue must never do. While a broadcast is live the
    // user typed to a fleet, not to one agent, so claim nothing.
    const recordTypedTarget = () => {
      // A canopy view types to a terminal that may live in another project.
      if (isolated || agentId === undefined) return;
      if (useFleetArmingStore.getState().armedIds.size >= 2) return;
      const workspaceId = getViewWorkspaceId();
      if (workspaceId === null) return;
      useTerminalInputStore.getState().recordLastTypedAgentTarget(terminalId, workspaceId);
    };

    const { handleUpdateRef: contextUpdateRef } = useContextDetection({
      latestRef,
      activeTriggers,
      applyDocChange: (next, update) => {
        // Before the guard: the composer's own writes (a template, a completion)
        // change the draft the note was about too.
        dropSendRefusal(
          next.trim() !== "" && update.transactions.every((tr) => tr.annotation(dictationWrite))
        );
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
      sendFromEditor: (route) => sendFromEditor(undefined, undefined, route),
      startVoiceWaitSubmit,
      cancelVoiceWaitSubmit,
      handleDictationEscape,
      hasPendingVoiceCorrection,
      stashEditorState,
      // A popped stash replaces the editor's state outright, past the
      // document-change listener that drops the note.
      popStashedEditorState: (terminalId, projectId) => {
        const stashed = popStashedEditorState(terminalId, projectId);
        if (stashed) dropSendRefusal();
        return stashed;
      },
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
      // The composition and beforeinput Enter routes wait for dictation the
      // same way the keymap's Enter does.
      sendFromEditor: submitFromEditor,
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
              resolveSelectedFilePath(
                view.state.sliceDoc(from, to),
                cwd,
                systemClient.getCachedHomeDir()
              )?.absolutePath ?? null;
          }
        }
        setSelectionFilePath(resolvedPath);
        if (!resolvedPath) event.preventDefault();
      },
      [cwd]
    );

    useEditorFactory({
      terminalId,
      voiceId,
      draftKeyRef,
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
      if (isolated) return;
      registerInputController(terminalId, { stash: handleStash, pop: handlePopStash });
      return () => unregisterInputController(terminalId);
    }, [terminalId, handleStash, handlePopStash, isolated]);

    // --- Compartment reconfigure effects ---

    useCompartmentDriver({
      editorViewRef,
      themeCompartmentRef,
      effectiveTheme,
      placeholderCompartmentRef,
      placeholder,
      editableCompartmentRef,
      disabled,
      sendLocked: isVoiceSubmitting,
      chipCompartmentRef,
      commandMap,
      tooltipCompartmentRef,
      fileChipTooltipCompartmentRef,
      imageChipTooltipCompartmentRef,
      fileDropChipTooltipCompartmentRef,
      diffChipTooltipCompartmentRef,
      terminalChipTooltipCompartmentRef,
      selectionChipTooltipCompartmentRef,
      contextChipTooltipCompartmentRef,
      forgeReferenceTooltipCompartmentRef,
      isAutocompleteOpen,
    });

    const { expanded: isListboxExpanded, activeOptionId } = getComboboxState({
      isOpen: isAutocompleteOpen,
      items: autocompleteItems,
      selectedIndex,
      staleKeys: staleItemKeys,
      listboxId,
    });
    useEffect(() => {
      editorViewRef.current?.dispatch({
        effects: compartments.comboboxCompartmentRef.current.reconfigure(
          createComboboxAttributes({ listboxId, expanded: isListboxExpanded, activeOptionId })
        ),
      });
    }, [compartments.comboboxCompartmentRef, listboxId, isListboxExpanded, activeOptionId]);

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

    // Three looks: rest; selected (the pane is the one, the keyboard is in its
    // terminal or elsewhere), a neutral lift; and typing, which adds the accent
    // outline on top of the selected look. Hover on a selected shell keeps it.
    const shellVars = {
      "--ib-bg": showSelectedChrome ? inputBarColors.shellSelectedBg : inputBarColors.shellBg,
      "--ib-border": showSelectedChrome
        ? inputBarColors.shellBorderSelected
        : inputBarColors.shellBorder,
      "--ib-border-hover": showSelectedChrome
        ? inputBarColors.shellBorderSelected
        : inputBarColors.shellBorderHover,
      "--ib-hover-bg": showSelectedChrome
        ? inputBarColors.shellSelectedBg
        : inputBarColors.shellHoverBg,
      "--ib-shadow": inputBarColors.shellShadow,
      "--ib-focus-ring": inputBarColors.shellFocusRing,
      // An unavailable composer is dimmed by its inks, not by opacity: an
      // opacity dim also halved the one line that says why (its reason, or
      // its draft), which then read under 4.5:1 on every palette. The `❯` and
      // the controls step down to an inactive ink together, as one family;
      // the words keep the resting placeholder's fitted ink.
      "--ib-marker": disabled
        ? DISABLED_CONTROL_INK
        : showSelectedChrome
          ? inputBarColors.markerSelected
          : inputBarColors.marker,
      "--ib-control-mix": disabled ? DISABLED_CONTROL_MIX : inputBarColors.controlMix,
      "--ib-placeholder": disabled
        ? inputBarColors.placeholder
        : showSelectedChrome
          ? inputBarColors.placeholderSelected
          : inputBarColors.placeholder,
      "--ib-placeholder-more": inputBarColors.placeholderMore,
      "--ib-interim": inputBarColors.interim,
      "--ib-accent": inputBarColors.accent,
      "--ib-voice": inputBarColors.voiceSignal,
      "--ib-voice-held": inputBarColors.voiceHeld,
      "--ib-fg": inputBarColors.foreground,
      "--ib-pane": inputBarColors.background,
      "--ib-wait-edge": inputBarColors.waitEdge,
      "--ib-wait-caption": inputBarColors.waitCaption,
    } as React.CSSProperties;

    // One hook instance serves both hosts, so its hover state says a drag is
    // over the editor, not which host. The compact bar stays visible through
    // the dialog's scrim and must not light up for a drag over the modal.
    const isDragOverCompact = isDragOverFiles && !isExpanded;
    const isDragOverModal = isDragOverFiles && isExpanded;

    const isSpecialState =
      isVoiceSubmitting ||
      isVoiceListeningChrome ||
      isVoiceHeldChrome ||
      isDragOverCompact ||
      isFleetPrimary;

    // Fleet-primary uses the same amber family as FleetDraftingPill so the
    // shell itself says "Enter broadcasts" at the point of typing.
    // A voice send waiting keeps the held outline, never the listening glow:
    // the mic has stopped, and the wait's own progress is drawn inside. The
    // fill stays the one the shell had, so Enter doesn't flash the surface.
    const specialStyle: React.CSSProperties | undefined = isVoiceSubmitting
      ? {
          borderColor: `color-mix(in oklab, ${inputBarColors.accent} 25%, transparent)`,
          backgroundColor: "var(--ib-bg)",
        }
      : isVoiceListeningChrome
        ? {
            borderColor: `color-mix(in oklab, ${inputBarColors.accent} 60%, transparent)`,
            backgroundColor: `color-mix(in oklab, ${inputBarColors.accent} ${VOICE_LISTENING_FILL_MIX}%, ${inputBarColors.background})`,
            boxShadow: `0 0 0 1px color-mix(in oklab, ${inputBarColors.accent} 35%, transparent), 0 0 16px color-mix(in oklab, ${inputBarColors.accent} 15%, transparent)`,
          }
        : isVoiceHeldChrome
          ? {
              borderColor: `color-mix(in oklab, ${inputBarColors.accent} 25%, transparent)`,
              backgroundColor: inputBarColors.shellBg,
            }
          : isDragOverCompact
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
        {isRemote && <PendingUploadChips surface={uploadSurface} className="mb-1.5" />}
        <HeldBackAttachmentsBanner
          surface={uploadSurface}
          disabled={disabled}
          onAdd={addHeldBackAttachments}
          className="mb-1.5"
        />
        {/* Outside the shell, which is busy for the whole wait: a live region
            inside it would hold its announcements until the send. */}
        {!isExpanded && voiceSubmitAnnouncer}
        {/* A reply box sits inside Canopy's dialog, where the app's announcer
            that says this for every other composer goes unheard. */}
        {voiceTarget && (
          <div role="status" aria-live="polite" className="sr-only">
            {dictationCancelConfirm ? DICTATION_CANCEL_CONFIRM_PROMPT : voiceNoteStatus}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div
            ref={inputShellRef}
            className={cn(
              "group/shell relative",
              // `items-end`, not `items-center`: centred controls tracked the
              // canvas midpoint, so the `❯` sat at a different height for every
              // draft length. `data-composer-rail` is one text line of extra
              // foot (`useComposerMeasure`): the row the trailing controls take
              // when the draft's last row leaves them no room beside it.
              "flex w-full items-end gap-x-0.75 rounded-md border py-2 data-[composer-rail]:pb-7 transition-[border-color,background-color,box-shadow] duration-150 ease-out",
              !isSpecialState && [
                "bg-[var(--ib-bg)] border-[var(--ib-border)] shadow-[var(--ib-shadow)]",
                "hover:border-[var(--ib-border-hover)] hover:bg-[var(--ib-hover-bg)]",
                // The field family's focus: an outline added clear of the
                // edge, the border left as it was. Keyed to the editor, not
                // `focus-within` — a Tab onto attach or the mic is that
                // control's own ring, not the composer taking the keyboard.
                !isVoiceSubmitPresenting &&
                  "has-[.cm-content:focus-visible]:outline-2 has-[.cm-content:focus-visible]:outline-offset-2 has-[.cm-content:focus-visible]:outline-[var(--ib-focus-ring)]",
              ]
            )}
            data-voice-active={isVoiceListeningChrome ? "true" : undefined}
            data-fleet-armed={isFleetPrimary ? "true" : undefined}
            // The high-contrast blocks in index.css key off this; the special
            // states above paint their own shell and take no part.
            data-composer-state={
              isSpecialState ? undefined : showSelectedChrome ? "selected" : "rest"
            }
            data-voice-receipt={isVoiceSubmitPresenting ? "" : undefined}
            style={specialStyle}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            aria-disabled={disabled}
            aria-busy={
              isInitializing ||
              isVoiceConnecting ||
              isVoiceSubmitting ||
              isVoiceSendHandingOver ||
              (isVoiceMicStarting && voiceMicSignal === "pending")
            }
          >
            {/* First, so everything after it in the shell paints above. */}
            <VoiceSubmitProgress
              key={voiceSubmitAttempt}
              wait={voiceSubmitWait}
              keys={voiceSubmitKeys}
              outcome={voiceSubmitOutcome}
              streamed={voiceCorrectionStreamed}
              onPresentChange={setIsVoiceSubmitPresenting}
            />
            {dictationCancelConfirm && (
              <DictationCancelConfirmOverlay
                key={dictationCancelConfirm.expiresAt}
                confirm={dictationCancelConfirm}
              />
            )}
            {showVoiceSessionCaption && (
              <div
                aria-hidden="true"
                data-voice-session-caption=""
                className={COMPOSER_BORDER_CAPTION_CLASS}
              >
                {voiceSessionStatus}
              </div>
            )}
            {showDisabledCaption && (
              <div data-disabled-caption="" className={COMPOSER_BORDER_CAPTION_CLASS}>
                {disabledPlaceholder}
              </div>
            )}
            {showSendReopenedCaption && (
              <div
                aria-hidden="true"
                data-send-reopened-caption=""
                className={COMPOSER_BORDER_CAPTION_CLASS}
              >
                {VOICE_SEND_REOPENED_CAPTION}
              </div>
            )}
            {showSendRefusedCaption && (
              <div
                aria-hidden="true"
                data-send-refused-caption=""
                className={COMPOSER_BORDER_CAPTION_CLASS}
              >
                {sendRefusedCaption}
              </div>
            )}
            {showScratchRefusalCaption && (
              <div
                aria-hidden="true"
                data-scratch-refused-caption=""
                className={COMPOSER_BORDER_CAPTION_CLASS}
              >
                {SCRATCH_REFUSAL_CAPTION[scratchRefusal.reason]}
              </div>
            )}
            {showFileReferenceCaption && (
              <div
                aria-hidden="true"
                data-file-reference-caption=""
                className={cn(
                  COMPOSER_BORDER_CAPTION_CLASS,
                  "max-w-[calc(100%-1.25rem)] overflow-hidden text-ellipsis"
                )}
              >
                {unresolvedFileReferencesCaption(fileReferenceNote.references)}
              </div>
            )}
            <AutocompleteMenu
              ref={menuRef}
              isOpen={isAutocompleteOpen}
              items={autocompleteItems}
              selectedIndex={selectedIndex}
              isLoading={isLoading}
              staleKeys={staleItemKeys}
              onSelect={handleAutocompleteSelect}
              onHoverIndex={setSelectedIndex}
              style={{
                left: `${menuPlacement.left}px`,
                maxWidth: menuPlacement.maxWidth,
                maxHeight: menuPlacement.maxHeight,
                marginBottom: MENU_SHELL_GAP_PX,
              }}
              listboxId={listboxId}
              title={
                triggerChar === "/"
                  ? "Commands"
                  : triggerChar === "$"
                    ? "Capabilities"
                    : triggerChar === "#"
                      ? "Issues and pull requests"
                      : atClaim === "terminal"
                        ? "Terminal output"
                        : atClaim === "selection"
                          ? "Terminal selection"
                          : atClaim === "diff"
                            ? "Diffs"
                            : "Files"
              }
              ariaLabel={
                triggerChar === "/"
                  ? "Command autocomplete"
                  : triggerChar === "$"
                    ? "Capability autocomplete"
                    : triggerChar === "#"
                      ? "Issue and pull request autocomplete"
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
            {isDragOverCompact && <FileDropOverlay className="rounded-md" />}
            {/* A prompt marker, not a control: it is what makes the box read as
                somewhere to type. A press on it focuses the editor through the
                root's handlers, like one anywhere else in the shell. `h-6` keeps
                it centred on the draft's last 24px row; `ml-2` is the shell's
                left inset, so the box is only as wide as the glyph. */}
            <span
              aria-hidden="true"
              data-composer-marker=""
              className={cn(
                "ml-2 flex h-6 shrink-0 select-none items-center font-mono text-xs font-semibold leading-5",
                COMPOSER_MARKER_TEXT_CLASS
              )}
            >
              ❯
            </span>
            <ContextMenu>
              <ContextMenuTrigger asChild onContextMenu={handleEditorContextMenu}>
                {/* `min-w-0`: a flex item defaults to `min-width: auto`, so the
                    canvas refused to shrink past its longest unbreakable token.

                    `py-0.5` sets every row of the draft in a 24px band, the
                    controls' height: one line is 24px with the line centred,
                    and each wrap adds exactly 20px. So the `❯` and the trailing
                    controls, both bottom-anchored, sit centred on the last row
                    at any length, and the controls' row beneath (the shell's
                    rail foot, also 20px) is the same size as the text row that
                    later fills it — the composer grows one line at a time.

                    The canvas shares its row with the `❯` in every state: it
                    is a prompt marker and sits beside the line being typed, and
                    the column it takes, only the glyph's width, is paid on every
                    line of a wrapped draft on purpose, the same way it is
                    elsewhere in the app. The trailing controls take no column
                    (see below), so the text runs to the shell's right inset.
                    `pr-1` plus the editor's own 4px puts its last glyph about
                    9px from the border, level with the controls' ink and with
                    the `❯`'s on the left. */}
                <div
                  ref={canvasTrackRef}
                  data-composer-canvas
                  // The fades take the shell's own fill, resting or hovered.
                  className="relative flex min-h-6 min-w-0 flex-1 items-center py-0.5 pr-1 [--scroll-shadow-color:var(--ib-bg)] group-hover/shell:[--scroll-shadow-color:var(--ib-hover-bg)]"
                >
                  {/* At the height cap the draft scrolls inside the editor, and
                      its first visible row otherwise sits where a first line
                      would: the app's scroll fade says rows are out of sight. */}
                  <ScrollShadowOverlay edge="top" visible={scrollEdges.above} compact />
                  <ScrollShadowOverlay edge="bottom" visible={scrollEdges.below} compact />
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
                    style={{
                      color: disabled ? inputBarColors.placeholder : inputBarColors.textInk,
                    }}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {selectionFilePath && <SelectedFileMenuItems absolutePath={selectionFilePath} />}
              </ContextMenuContent>
            </ContextMenu>
            {/* The trailing controls sit out of the flow, in the shell's
                bottom-right corner: beside the draft's last row when it ends
                short of them, on the rail foot beneath it when it does not,
                or beside a column the canvas gives up when that is shorter
                (`useComposerMeasure`). Out of the flow is what lets the text
                run the full width above them, and what keeps the decision free
                of a feedback loop — the text wraps at the same width wherever
                they sit, and they sit at the same x either way. `bottom-2` is
                the shell's own foot padding, so in every arrangement they are
                centred on the bottom row and never move relative to the pane
                foot. `right-2` matches it on the other edge: a recording
                session fills the mic's 24px circle, and that circle sits as
                far from the right border as from the top and bottom, so the
                corner stays even in every state.

                Content-sized, so the width `useComposerMeasure` reads is the
                buttons' and nothing else. */}
            <div
              ref={trailingGroupRef}
              className="absolute right-2 bottom-2 flex shrink-0 items-center"
            >
              {/* One control in both modes. In a remote window it opens a
                  menu, since a file can come from this machine or the host;
                  the root renders nothing, so a local window keeps a plain
                  button. */}
              {!thisMachineOff && (
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {isRemote ? (
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            disabled={disabled}
                            className={cn(
                              "flex items-center justify-center h-6 w-6 rounded-full transition-colors cursor-pointer",
                              COMPOSER_CONTROL_TEXT_CLASS,
                              COMPOSER_CONTROL_HOVER_BG_CLASS,
                              COMPOSER_CONTROL_FOCUS_CLASS
                            )}
                            aria-label="Attach files"
                          >
                            <Paperclip className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleAttachFiles()}
                          disabled={disabled}
                          className={cn(
                            "flex items-center justify-center h-6 w-6 rounded-full transition-colors cursor-pointer",
                            COMPOSER_CONTROL_TEXT_CLASS,
                            COMPOSER_CONTROL_HOVER_BG_CLASS,
                            COMPOSER_CONTROL_FOCUS_CLASS
                          )}
                          aria-label="Attach files"
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="top">Attach files</TooltipContent>
                  </Tooltip>
                  {isRemote && (
                    <DropdownMenuContent align="end" side="top">
                      <DropdownMenuItem onSelect={() => void handleAttachFiles()}>
                        {isMac() ? "From this Mac…" : "From this computer…"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void handleAttachFromHost()}>
                        {`From ${hostPlatform.hostName ?? "the host"}…`}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  )}
                </DropdownMenu>
              )}
              {hasStash && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handlePopStash}
                      disabled={disabled}
                      // 24px to clear the WCAG 2.5.8 floor. The spacing
                      // exception cannot rescue a smaller one here — its circle
                      // overlaps the attach and mic targets either side.
                      className={cn(
                        "flex items-center justify-center h-6 w-6 rounded-full transition-colors cursor-pointer",
                        COMPOSER_CONTROL_TEXT_CLASS,
                        COMPOSER_CONTROL_HOVER_BG_CLASS,
                        COMPOSER_CONTROL_FOCUS_CLASS
                      )}
                      aria-label="Restore stashed input"
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {createTooltipContent("Restore stashed input", popStashShortcut)}
                  </TooltipContent>
                </Tooltip>
              )}
              {/* Dictation writes to the pane's own draft, in the current
                  project. An isolated composer's draft is its own, so it
                  offers dictation only when it has its own to take, rather
                  than filling the pane's behind it. */}
              {/* The mic and the wait's Cancel send take turns in one slot.
                  Swapping one for the other removes the focused button, so
                  the keyboard is handed to whichever takes its place. */}
              <span
                ref={voiceSlotRef}
                className="contents"
                onFocusCapture={() => {
                  voiceSlotFocusedRef.current = true;
                }}
                onBlurCapture={(event) => {
                  if (event.relatedTarget) voiceSlotFocusedRef.current = false;
                }}
              >
                {isVoiceSubmitting && (voiceTarget || !isolated) ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          cancelVoiceWaitSubmit();
                          focusEditor();
                        }}
                        className={cn(
                          "flex items-center justify-center h-6 w-6 rounded-full transition-colors cursor-pointer",
                          COMPOSER_CONTROL_TEXT_CLASS,
                          COMPOSER_CONTROL_HOVER_BG_CLASS,
                          COMPOSER_CONTROL_FOCUS_CLASS
                        )}
                        aria-label="Cancel send"
                        aria-keyshortcuts="Escape"
                        data-voice-wait-cancel=""
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {createTooltipContent("Cancel send", "Escape")}
                    </TooltipContent>
                  </Tooltip>
                ) : voiceTarget ? (
                  <VoiceInputButton
                    panelId={voiceTarget.panelId}
                    panelTitle={voiceTarget.panelTitle}
                    projectId={voiceTarget.projectId}
                    projectName={voiceTarget.projectName}
                    worktreeId={voiceTarget.worktreeId}
                    worktreeLabel={voiceTarget.worktreeLabel}
                    surface={voiceTarget.surface}
                    terminalId={voiceTarget.terminalId}
                    otherHostId={voiceTarget.otherHostId}
                    canopyRow={voiceTarget.canopyRow}
                    disabled={disabled}
                  />
                ) : (
                  !isolated && (
                    <VoiceInputButton
                      panelId={terminalId}
                      panelTitle={
                        panelOwnTitle?.trim() ||
                        (agentId ? getAgentConfig(agentId)?.name : undefined)
                      }
                      projectId={currentProject?.id}
                      projectName={currentProject?.name}
                      worktreeId={panelWorktreeId}
                      worktreeLabel={panelWorktreeLabel}
                      disabled={disabled}
                    />
                  )
                )}
              </span>
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
          <DictionaryLearnPrompt
            terminalId={voiceId}
            projectId={voiceProjectId}
            onReturnFocus={focusEditor}
          />
          {barContent}
        </div>
        {activeTemplate && (
          <PromptTemplateForm
            key={activeTemplate.key}
            title={activeTemplate.template.title}
            pluginName={activeTemplate.pluginName}
            args={activeTemplate.template.args}
            onSubmit={handleTemplateSubmit}
            onCancel={() => setActiveTemplateKey(null)}
            restoreFocusTo={() => editorViewRef.current?.contentDOM ?? null}
          />
        )}
        {isRemote && <LazyUploadConfirmHost />}
        <AppDialog
          isOpen={isExpanded}
          onClose={collapseEditor}
          onCloseComplete={handleExpandedEditorClosed}
          size="5xl"
          maxHeight="max-h-[70vh]"
          dismissible
        >
          <AppDialog.Header>
            <AppDialog.Title>Expanded editor</AppDialog.Title>
            {isExpanded && expandedSubmitLabel}
            <AppDialog.CloseButton />
          </AppDialog.Header>
          {/* CodeMirror claims file drops to suppress its own text insertion
              (#11710), so a drop only lands through these handlers (#12570).
              Outside the scrolling host, so the overlay covers the visible
              editor instead of scrolling away with a long draft. */}
          <div
            ref={releaseModalDropTarget}
            className="relative flex-1 min-h-0 flex flex-col overflow-hidden"
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
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
                  // The expanded editor portals out of the isolated composer's
                  // wrapper: it keeps that isolation, or the grid's shortcuts
                  // would act on the pane behind Canopy, and the dictation key
                  // its own dictation takes.
                  {...(isolated ? { "data-keybindings-isolated": "" } : {})}
                  {...(isolated && voiceTarget ? { [DICTATION_OWNER_ATTR]: "" } : {})}
                  className="flex-1 min-h-[200px] overflow-auto text-text-primary p-4"
                />
              </ContextMenuTrigger>
              <ContextMenuContent>
                {selectionFilePath && <SelectedFileMenuItems absolutePath={selectionFilePath} />}
              </ContextMenuContent>
            </ContextMenu>
            {isDragOverModal && <FileDropOverlay />}
            {isExpanded && voiceSubmitAnnouncer}
            {/* The app's announcer outside this modal goes unheard in it. */}
            {isExpanded && (
              <div role="status" aria-live="polite" className="sr-only">
                {voiceNoteStatus}
              </div>
            )}
          </div>
        </AppDialog>
        {/* One palette per id: while Canopy is open its own composer's is the
            one, not the grid pane's behind it. */}
        {/* History spans this machine's projects, whose prompts name its files:
            none is offered for a terminal on another host. */}
        {((isFocusedTerminal && !canopyOpen) || (isolated && !thisMachineOff)) && (
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
