import { Fragment, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isMac, isWindows } from "@/lib/platform";
import type React from "react";
import { type PanelLocation } from "@/types";
import { usePanelStore } from "@/store";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

import { useSidebarWorktreeOrder } from "@/hooks/useSidebarWorktreeOrder";
import { getWorktreeHeadline } from "@/lib/worktreeHeadline";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import {
  AGENT_SNOOZE_DURATION_OPTIONS,
  AGENT_SNOOZE_LABEL,
  type AgentSnoozeDurationOption,
} from "@shared/utils/agentSnoozeDurations";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";
import { actionService } from "@/services/ActionService";
import {
  getPanelKindRegistrySnapshot,
  panelKindHasPty,
  subscribeToPanelKindRegistry,
} from "@shared/config/panelKindRegistry";
import type { ActionId } from "@shared/types/actions";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { canDuplicatePanelKind } from "@/services/terminal/panelDuplicationService";
import {
  consultPanelCloseGuards,
  hasPanelCloseGuard,
  isPanelClosePending,
} from "@/services/panelCloseGuard";
import {
  isBrowserPanel,
  isDevPreviewPanel,
  isDiffPanel,
  isFileBrowserPanel,
  isFilePanel,
  isPtyPanel,
  isReviewPanel,
} from "@shared/types/panel";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { reportFileLinkFailure } from "@/services/terminal/FileLinksAddon";
import { resolveSelectedFilePath } from "@/services/terminal/filePathDetection";
import { resolveWorktreePathScope } from "@shared/utils/path";
import { SelectedFileMenuItems } from "./SelectedFileMenuItems";
import { useIsHibernated } from "@/hooks/useIsHibernated";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { closeAndAnnounce } from "@/lib/accessibility";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import {
  buildKillRunningAgentCopy,
  buildRestartRunningAgentCopy,
  DestructiveConsequence,
  type DestructiveConfirmCopy,
} from "@/components/Terminal/TerminalDestructiveActionConfirmDialog";
import {
  TerminalHandOverDialog,
  TerminalHandOverMenuItems,
  useOrchestratorCandidates,
} from "./TerminalHandOver";
import {
  ArrowDownFromLine,
  Bell,
  BellOff,
  Clipboard,
  Copy,
  CopyPlus,
  ExternalLink,
  Globe,
  Info,
  Link,
  Lock,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  OctagonX,
  PanelBottomClose,
  PanelTopClose,
  Pencil,
  Play,
  Radio,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Unlock,
} from "lucide-react";
import { FolderGit2, FolderOpen, FolderTree } from "@/components/icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuActionSourceContext, type MenuActionSourceValue } from "@/components/ui/menu-source";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { PopoverAnchor } from "@/components/ui/popover";
import { MoveToWorktreePicker } from "@/components/Panel/MoveToWorktreePicker";
import {
  GENERIC_PANEL_RELOAD_ACTION_ID,
  canReloadPanelKind,
  getGenericPanelMenuGroups,
  hasGenericPanelMenu,
  readPanelKindMenuCapabilities,
} from "@/components/Panel/genericPanelMenu";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

// Main, the pins and the most recent few: what a hover submenu is good for.
// Anything past that is found by searching the picker.
const MOVE_TO_WORKTREE_SUBMENU_LIMIT = 10;

/** A menu item's shortcut: the action's live keybinding, or nothing. */
function ContextMenuKeybinding({ actionId }: { actionId: ActionId }) {
  const combo = useKeybindingDisplay(actionId);
  return combo ? <ContextMenuShortcut>{combo}</ContextMenuShortcut> : null;
}

/** A pending hand-over consent (#12490): which terminal, to which pane. */
interface HandOverRequest {
  id: number;
  terminalId: string;
  orchestratorPaneId: string;
}

/** A zero-size point the picker hangs off, tracking the pane it sits in. */
interface MovePickerAnchor {
  contextElement: HTMLElement;
  getBoundingClientRect: () => DOMRect;
}

interface TerminalContextMenuProps {
  terminalId: string;
  children: React.ReactNode;
  forceLocation?: PanelLocation;
}

/**
 * Right-click context menu for panel headers (terminal, agent, browser, dev-preview).
 * Used by both DockedTerminalItem and PanelHeader.
 */
export function TerminalContextMenu({
  terminalId,
  children,
  forceLocation,
}: TerminalContextMenuProps) {
  const terminal = usePanelStore((state) => state.panelsById[terminalId]);
  const maximizeTarget = usePanelStore((s) => s.maximizeTarget);
  const getPanelGroup = usePanelStore((s) => s.getPanelGroup);

  const isMaximized = useMemo(() => {
    if (!maximizeTarget) return false;
    if (maximizeTarget.type === "panel") {
      return maximizeTarget.id === terminalId;
    } else {
      const group = getPanelGroup(terminalId);
      return group?.id === maximizeTarget.id;
    }
  }, [maximizeTarget, terminalId, getPanelGroup]);

  const worktrees = useSidebarWorktreeOrder();
  // Subscribed so a plugin registering or dropping its kind reaches the menu;
  // the generic panel menu reads its capabilities from this snapshot.
  const panelKindRegistry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );

  // Which panel the picker was opened for, not a bare flag: the dock's tab
  // group hands this menu a new terminal when its active tab changes, and the
  // picker must not quietly retarget. Dropped during render so switching back
  // can't reopen it.
  const [movePickerPanelId, setMovePickerPanelId] = useState<string | null>(null);
  if (movePickerPanelId !== null && movePickerPanelId !== terminalId) {
    setMovePickerPanelId(null);
  }
  const isMovePickerOpen = movePickerPanelId !== null;
  // Mounted from the first opening on, not with the menu: every pane has one,
  // and the content carries its own positioning observers. Kept after that so
  // the picker still gets its exit animation.
  const [hasOpenedMovePicker, setHasOpenedMovePicker] = useState(false);
  const [movePickerAnchor, setMovePickerAnchor] = useState<MovePickerAnchor | null>(null);
  // Selecting "More worktrees…" records the intent and the root content's
  // close hook spends it — the only one that runs, since Radix pins the
  // submenu's own. Opening straight from `onSelect` would raise the picker while
  // the menu still holds the focus trap, and the menu's focus return would then
  // land after the picker had focused its search field.
  const pendingMovePickerRef = useRef<string | null>(null);
  // Captured on every gesture that can open the menu. A context menu has no
  // trigger to hang the picker off or hand a keyboard dismissal back to, so the
  // pane stands in.
  const capturedMovePickerAnchorRef = useRef<MovePickerAnchor | null>(null);
  const movePickerReturnFocusRef = useRef<HTMLElement | null>(null);

  const handleMovePickerOpenChange = useCallback(
    (open: boolean) => setMovePickerPanelId(open ? terminalId : null),
    [terminalId]
  );

  const handleMoveToWorktreeMore = useCallback(() => {
    pendingMovePickerRef.current = terminalId;
  }, [terminalId]);

  const { candidateIds: orchestratorCandidateIds, refresh: refreshOrchestratorCandidates } =
    useOrchestratorCandidates(terminalId);
  // The consent dialog's request, carrying the terminal it is for: the dock
  // hands this menu a new terminal when its active tab changes, and a consent
  // must never quietly retarget. Dropped during render so switching back
  // can't reopen it, the way the move picker is.
  const [handOverRequest, setHandOverRequest] = useState<HandOverRequest | null>(null);
  if (handOverRequest !== null && handOverRequest.terminalId !== terminalId) {
    setHandOverRequest(null);
  }
  // Picking a pane records the request and the root content's close hook
  // opens the dialog — the same handoff as the move picker, so the menu's own
  // focus return can't land after the dialog has taken focus.
  const pendingHandOverRef = useRef<HandOverRequest | null>(null);
  const nextHandOverIdRef = useRef(0);
  const handleRequestHandOver = useCallback(
    (orchestratorPaneId: string) => {
      pendingHandOverRef.current = {
        id: ++nextHandOverIdRef.current,
        terminalId,
        orchestratorPaneId,
      };
    },
    [terminalId]
  );
  // Closes only the request it was handed: a confirm that resolves after the
  // user dismissed its dialog and opened another must not close the new one.
  const closeHandOverRequest = useCallback((request: HandOverRequest) => {
    setHandOverRequest((current) => (current?.id === request.id ? null : current));
  }, []);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      // A menu reopened inside its exit animation never unmounts, so the close
      // hook never runs for that close; drop the intent rather than let it open
      // the picker on some later, unrelated close.
      if (open) {
        pendingMovePickerRef.current = null;
        pendingHandOverRef.current = null;
        // Only a PTY can be handed over; the other kinds' menus never ask.
        if (terminal !== undefined && panelKindHasPty(terminal.kind ?? "terminal")) {
          refreshOrchestratorCandidates();
        }
      }
    },
    [refreshOrchestratorCandidates, terminal]
  );

  const captureMovePickerAnchor = useCallback((event: React.MouseEvent<HTMLElement>) => {
    // The trigger wrapper is `display: contents` and has no box of its own.
    const pane = event.currentTarget.firstElementChild;
    if (!(pane instanceof HTMLElement)) {
      capturedMovePickerAnchorRef.current = null;
      movePickerReturnFocusRef.current = null;
      return;
    }
    // Where the menu opened, kept relative to the pane: the picker takes the
    // menu's place. Hung off the pane's own rect, it would have to sit outside
    // a box that usually fills the window's height, with no room either side.
    const bounds = pane.getBoundingClientRect();
    const offsetX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
    const offsetY = Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height);
    movePickerReturnFocusRef.current = pane;
    capturedMovePickerAnchorRef.current = {
      // Lets Floating UI follow the pane itself when it moves or resizes.
      contextElement: pane,
      getBoundingClientRect: () => {
        const rect = pane.getBoundingClientRect();
        return DOMRect.fromRect({
          x: rect.left + Math.min(offsetX, rect.width),
          y: rect.top + Math.min(offsetY, rect.height),
          width: 0,
          height: 0,
        });
      },
    };
  }, []);

  // Radix also opens the menu from a touch or pen long-press, which never
  // raises the contextmenu event the capture above hangs off.
  const captureMovePickerAnchorOnPress = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") captureMovePickerAnchor(event);
    },
    [captureMovePickerAnchor]
  );

  const isWatched = usePanelStore((state) => state.watchedPanels.has(terminalId));
  const isArmed = useFleetArmingStore((s) => s.armedIds.has(terminalId));
  const fleetSize = useFleetArmingStore((s) => s.armedIds.size);
  const isHibernated = useIsHibernated(terminalId);
  const isVoiceLockedHere = useVoiceRecordingStore((s) => s.lockedTarget?.panelId === terminalId);
  const recentVoiceTargets = useVoiceRecordingStore((s) => s.recentTargets);
  // Pull the panel directly here (rather than indexing through the shallow
  // selector above) so the eligibility check sees the live record. The
  // dropdown only renders fleet items when the panel is fleet-arm-eligible
  // — non-agent terminals, trashed/backgrounded panels, and PTY-less panels
  // don't get the option, matching the gesture-level rules in
  // `multiSelectGestures`.
  const fleetEligible = isFleetArmEligible(terminal);
  // Snooze needs more than fleet eligibility: that only means "live PTY in a
  // grid location", while `snoozeRun` rejects any id the fleet snapshot can't
  // see. A plain shell terminal is eligible and never on the snapshot, so
  // without this the menu would offer a Snooze that always failed — and the
  // rejection is fire-and-forget, so the user would see nothing at all. Gate on
  // the same set the handler validates against.
  const isKnownRun = useFleetSnapshotStore(
    (s) => s.snapshot?.runs.some((run) => run.runId === terminalId) ?? false
  );
  // Main strips expired snoozes before a row ships, so presence on the snapshot
  // IS "currently snoozed" — the menu needs no clock and never has to decide
  // whether a wake time has passed.
  const isSnoozed = useFleetSnapshotStore(
    (s) =>
      s.snapshot?.runs.some((run) => run.runId === terminalId && run.snooze !== undefined) ?? false
  );
  const sourceRef = useRef<MenuActionSourceValue>("user");

  const handleSnooze = useCallback(
    (option: AgentSnoozeDurationOption) => {
      safeFireAndForget(window.electron.fleet.snoozeRun(terminalId, option), {
        context: "TerminalContextMenu snoozeRun",
      });
    },
    [terminalId]
  );

  const handleUnsnooze = useCallback(() => {
    safeFireAndForget(window.electron.fleet.unsnoozeRun(terminalId), {
      context: "TerminalContextMenu unsnoozeRun",
    });
  }, [terminalId]);

  const pluginMenuContext = useMemo<WhenClauseContext>(
    () => ({ panelId: terminalId, panelKind: terminal?.kind }),
    [terminalId, terminal?.kind]
  );
  const pluginItems = usePluginContextMenuItems("terminal", pluginMenuContext);

  const [hasSelection, setHasSelection] = useState(false);
  const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);
  const [hoveredFilePath, setHoveredFilePath] = useState<string | null>(null);
  const [hoveredFileKind, setHoveredFileKind] = useState<"file" | "directory" | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const suppressNextCloseAutoFocusRef = useRef(false);
  // Local confirm dialog for single-terminal kill/restart when an agent
  // session is mid-work. Bare PTY terminals skip this gate and run
  // immediately (matches the action's run-body gate at
  // `terminalLifecycleActions.ts`).
  const [destructiveConfirm, setDestructiveConfirm] = useState<
    ({ kind: "kill" | "restart" } & DestructiveConfirmCopy) | null
  >(null);

  // Recent dictation targets surfaced in the context menu must resolve to a
  // live, non-trashed PTY panel that isn't the current one. Persisted entries
  // come back without a panelId (stripped on rehydrate) — we try to match each
  // to a live panel by (worktreeId + panelTitle) so cross-session recall works
  // when the user reopens with the same worktree layout. Entries that can't
  // be resolved are hidden rather than shown as dead links. Resolved at
  // menu-open time via getState() so the wrapper doesn't re-render on every
  // panel-store write.
  const [liveRecentVoiceTargets, setLiveRecentVoiceTargets] = useState<
    Array<{ panelId: string; label: string }>
  >([]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      captureMovePickerAnchor(e);
      const { panelsById } = usePanelStore.getState();
      const resolved: Array<{ panelId: string; label: string }> = [];
      const seenIds = new Set<string>([terminalId]);
      for (const t of recentVoiceTargets) {
        let livePanelId: string | undefined;
        if (t.panelId) {
          const panel = panelsById[t.panelId];
          if (panel && panel.location !== "trash") livePanelId = t.panelId;
        } else if (t.worktreeId && t.panelTitle) {
          const titleMatch = Object.values(panelsById).find(
            (panel) =>
              panel.worktreeId === t.worktreeId &&
              panel.title === t.panelTitle &&
              panel.location !== "trash"
          );
          if (titleMatch) livePanelId = titleMatch.id;
        }
        if (!livePanelId || seenIds.has(livePanelId)) continue;
        seenIds.add(livePanelId);
        const label =
          t.panelTitle?.trim() ||
          t.worktreeLabel?.trim() ||
          t.projectName?.trim() ||
          "Untitled panel";
        resolved.push({ panelId: livePanelId, label });
      }
      setLiveRecentVoiceTargets(resolved);

      const managed = terminalInstanceService.get(terminalId);
      if (!managed?.terminal) {
        setHasSelection(false);
        setHoveredUrl(null);
        setHoveredFilePath(null);
        setHoveredFileKind(null);
        setSelectedText(null);
        return;
      }
      // Read the selection synchronously here — xterm clears it on the next
      // forwarded keystroke (#7649), so a deferred read would see nothing.
      const selection = managed.terminal.getSelection();
      setHasSelection(!!selection);
      setSelectedText(selection || null);
      setHoveredUrl(terminalInstanceService.getHoveredLinkText(terminalId));
      setHoveredFilePath(terminalInstanceService.getHoveredFilePath(terminalId));
      setHoveredFileKind(terminalInstanceService.getHoveredFileKind(terminalId));
    },
    [captureMovePickerAnchor, terminalId, recentVoiceTargets]
  );

  const terminalPty = terminal && isPtyPanel(terminal) ? terminal : undefined;
  const terminalBrowser = terminal && isBrowserPanel(terminal) ? terminal : undefined;

  // A selection that resolves to a file path unlocks the "View file" / "Open
  // folder" section. Relative paths resolve against the terminal's cwd;
  // absolute selections resolve without one (empty cwd is fine for those).
  const selectionFilePath = useMemo(
    () =>
      selectedText
        ? (resolveSelectedFilePath(selectedText, terminalPty?.cwd ?? "")?.absolutePath ?? null)
        : null,
    [selectedText, terminalPty?.cwd]
  );
  // Where the hovered path sits in the *live* worktree list — never
  // `terminal.worktreeId`, which stamps the worktree that was active when the
  // panel was created and can name one the path isn't in (#11276). null means
  // no known worktree contains it, and the file browser (worktree-scoped) has
  // nothing to show, so the item is hidden rather than dispatching a no-op.
  const hoveredFileScope = useMemo(
    () => (hoveredFilePath ? resolveWorktreePathScope(hoveredFilePath, worktrees) : null),
    [hoveredFilePath, worktrees]
  );

  const isPaused =
    terminalPty?.flowStatus === "paused-backpressure" ||
    terminalPty?.flowStatus === "paused-resource-governor";

  const currentLocation: PanelLocation = forceLocation ?? terminal?.location ?? "grid";

  const mac = isMac();
  const modifierKey = mac ? "⌘" : "Ctrl";

  const handleAction = useCallback(
    (actionId: string) => {
      if (!terminal) return;

      if (actionId === "open-link") {
        void terminalInstanceService.openHoveredLink(terminalId);
        return;
      }

      if (actionId.startsWith("copy-link:")) {
        const url = actionId.slice("copy-link:".length);
        void actionService.dispatch("terminal.copyLink", { url }, { source: sourceRef.current });
        return;
      }

      if (actionId.startsWith("reveal-in-finder:")) {
        const path = actionId.slice("reveal-in-finder:".length);
        // Unlike copy-link, guard rejections (OUTSIDE_ROOT) and a since-deleted
        // file (NOT_FOUND) are real, expected failure modes here — surface them
        // rather than fire-and-forget. dispatch wraps the thrown error as
        // EXECUTION_ERROR, so the original coded error lives on `.details`.
        void actionService
          .dispatch("file.showItemInFolder", { path }, { source: sourceRef.current })
          .then((result) => {
            if (!result.ok) {
              reportFileLinkFailure("Failed to reveal in file manager", result.error.details, path);
            }
          });
        return;
      }

      if (actionId.startsWith("move-to-worktree:")) {
        const worktreeId = actionId.slice("move-to-worktree:".length);
        void actionService.dispatch(
          "terminal.moveToWorktree",
          { terminalId, worktreeId },
          { source: sourceRef.current }
        );
        return;
      }

      if (actionId.startsWith("recall-voice-target:")) {
        const targetPanelId = actionId.slice("recall-voice-target:".length);
        void actionService.dispatch(
          "voiceInput.recallRecentTarget",
          { panelId: targetPanelId },
          { source: sourceRef.current }
        );
        return;
      }

      switch (actionId) {
        case "fleet-toggle":
          // Mirror the gesture rule from multiSelectGestures: a toggle on
          // an empty fleet implicitly seeds the focused pane so the user
          // ends up with a 2-pane fleet rather than a single armed peer.
          if (
            !useFleetArmingStore.getState().armedIds.has(terminalId) &&
            useFleetArmingStore.getState().armedIds.size === 0
          ) {
            const focusedId = usePanelStore.getState().focusedId;
            if (focusedId && focusedId !== terminalId) {
              const focusedTerminal = usePanelStore.getState().panelsById[focusedId];
              if (focusedTerminal && isFleetArmEligible(focusedTerminal)) {
                useFleetArmingStore.getState().armId(focusedId);
              }
            }
          }
          useFleetArmingStore.getState().toggleId(terminalId);
          break;
        case "fleet-arm-worktree":
          void actionService.dispatch("terminal.bulkCommand", undefined, {
            source: sourceRef.current,
          });
          break;
        case "fleet-clear":
          void actionService.dispatch("terminal.disarmAll", undefined, {
            source: sourceRef.current,
          });
          break;
        case "copy":
          void actionService.dispatch(
            "terminal.copy",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "paste":
          void actionService.dispatch(
            "terminal.paste",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "move-to-dock":
          void actionService.dispatch(
            "terminal.moveToDock",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "move-to-grid":
          void actionService.dispatch(
            "terminal.moveToGrid",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "toggle-maximize":
          void actionService.dispatch(
            "terminal.toggleMaximize",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "redraw":
          void actionService.dispatch(
            "terminal.redraw",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "restart":
          if (terminalHasRunningAgentSession(terminal)) {
            setDestructiveConfirm({
              kind: "restart",
              ...buildRestartRunningAgentCopy(terminal?.title),
            });
            return;
          }
          void actionService.dispatch(
            "terminal.restart",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "force-resume":
          void actionService.dispatch(
            "terminal.forceResume",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "toggle-input-lock":
          void actionService.dispatch(
            "terminal.toggleInputLock",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "voice-lock-target":
          void actionService.dispatch(
            "voiceInput.lockTarget",
            { panelId: terminalId },
            { source: sourceRef.current }
          );
          break;
        case "voice-unlock-target":
          void actionService.dispatch("voiceInput.unlockTarget", undefined, {
            source: sourceRef.current,
          });
          break;
        case "toggle-watch":
          void actionService.dispatch(
            "terminal.watch",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "duplicate":
          void actionService.dispatch(
            "terminal.duplicate",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "rename":
          suppressNextCloseAutoFocusRef.current = true;
          void actionService.dispatch(
            "terminal.rename",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "view-info":
          void actionService.dispatch(
            "terminal.viewInfo",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "background":
          void actionService.dispatch(
            "terminal.background",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "trash":
          void actionService.dispatch(
            "terminal.trash",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "kill":
          if (terminalHasRunningAgentSession(terminal)) {
            setDestructiveConfirm({ kind: "kill", ...buildKillRunningAgentCopy(terminal?.title) });
            return;
          }
          if (hasPanelCloseGuard(terminalId)) {
            // Removing skips the trash, not the unsaved-work prompt (#12323). A
            // second pick while that prompt is up waits on it; it must not
            // queue a second removal behind the same answer.
            if (isPanelClosePending(terminalId)) return;
            const source = sourceRef.current;
            void consultPanelCloseGuards([terminalId]).then((proceed) => {
              if (!proceed) return;
              void actionService.dispatch("terminal.kill", { terminalId }, { source });
            });
            return;
          }
          void actionService.dispatch(
            "terminal.kill",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "reload":
          void actionService.dispatch(
            GENERIC_PANEL_RELOAD_ACTION_ID,
            { panelId: terminalId },
            { source: sourceRef.current }
          );
          break;
        case "reload-browser":
          void actionService.dispatch(
            "browser.reload",
            { terminalId },
            { source: sourceRef.current }
          );
          break;
        case "open-external":
          if (terminalBrowser?.browserUrl && isValidBrowserUrl(terminalBrowser.browserUrl)) {
            void actionService.dispatch(
              "browser.openExternal",
              { url: terminalBrowser.browserUrl },
              { source: sourceRef.current }
            );
          }
          break;
        case "copy-url":
          if (terminalBrowser?.browserUrl && isValidBrowserUrl(terminalBrowser.browserUrl)) {
            void actionService.dispatch(
              "browser.copyUrl",
              { url: terminalBrowser.browserUrl },
              { source: sourceRef.current }
            );
          }
          break;
      }
    },
    [terminal, terminalId, terminalPty, terminalBrowser]
  );

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      if (suppressNextCloseAutoFocusRef.current) {
        suppressNextCloseAutoFocusRef.current = false;
        event.preventDefault();
      }
      const pendingHandOver = pendingHandOverRef.current;
      pendingHandOverRef.current = null;
      if (pendingHandOver !== null && pendingHandOver.terminalId === terminalId) {
        // Restoration is left to run: focus goes back to the pane before the
        // dialog mounts, so the dialog records the pane as where to return it.
        setHandOverRequest(pendingHandOver);
        return;
      }
      const pendingPanelId = pendingMovePickerRef.current;
      pendingMovePickerRef.current = null;
      if (pendingPanelId === null || pendingPanelId !== terminalId) return;
      const anchor = capturedMovePickerAnchorRef.current;
      if (!anchor?.contextElement.isConnected) return;
      // The picker takes focus into its search field; handing it back to the
      // pane first would only flash a ring on the way.
      event.preventDefault();
      setMovePickerAnchor(anchor);
      setHasOpenedMovePicker(true);
      setMovePickerPanelId(terminalId);
    },
    [terminalId]
  );

  const handleDestructiveConfirm = useCallback(() => {
    if (!destructiveConfirm) return;
    const actionId = destructiveConfirm.kind === "kill" ? "terminal.kill" : "terminal.restart";
    const announcement =
      destructiveConfirm.kind === "kill" ? "Terminal killed" : "Terminal restarted";
    void actionService.dispatch(
      actionId,
      { terminalId, confirmed: true },
      { source: sourceRef.current }
    );
    closeAndAnnounce(() => setDestructiveConfirm(null), announcement);
  }, [destructiveConfirm, terminalId]);

  const closeDestructiveConfirm = useCallback(() => {
    setDestructiveConfirm(null);
  }, []);

  const destructiveConfirmDialog = destructiveConfirm ? (
    <ConfirmDialog
      isOpen
      onClose={closeDestructiveConfirm}
      title={destructiveConfirm.title}
      description={<DestructiveConsequence copy={destructiveConfirm} />}
      confirmLabel={destructiveConfirm.confirmLabel}
      variant="destructive"
      onConfirm={handleDestructiveConfirm}
    />
  ) : null;

  if (!terminal) {
    return <div className="contents">{children}</div>;
  }

  const isBrowser = isBrowserPanel(terminal);
  const isDevPreview = isDevPreviewPanel(terminal);
  const isReview = isReviewPanel(terminal);
  const isFile = isFilePanel(terminal);
  const isFileBrowser = isFileBrowserPanel(terminal);
  const isDiff = isDiffPanel(terminal);
  const kind = terminal.kind ?? "terminal";
  const kindCapabilities = readPanelKindMenuCapabilities(panelKindRegistry, kind);
  const hasPty = terminal.kind ? kindCapabilities.hasPty : true;
  // A non-PTY plugin kind matches none of the built-in guards, so without this
  // it falls through to the terminal menu and is offered "Duplicate terminal",
  // "Kill terminal", and friends — none of which apply (#11228). The header's
  // overflow menu decides with the same predicate, so the two menus always
  // agree on which panels get the generic list (#12606). PTY-backed plugin
  // kinds stay out: they render through TerminalPane and are genuine
  // terminals, so they keep copy/paste, redraw, restart and the rest.
  const hasGenericMenu = hasGenericPanelMenu(kind, hasPty);

  const submenuWorktrees = worktrees.slice(0, MOVE_TO_WORKTREE_SUBMENU_LIMIT);
  const hasMoreWorktrees = worktrees.length > submenuWorktrees.length;

  // Somewhere other than the panel's own worktree, which may already be gone —
  // the header's overflow menu counts it the same way.
  const canMoveToWorktree = worktrees.some((wt) => wt.id !== terminal.worktreeId);
  const renderMoveToWorktreeSubmenu = (label: string) => (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderGit2 className={ICON_CLASS} />
        {label}
      </ContextMenuSubTrigger>
      {/* No search field in here: Radix's typeahead claims printable keys
          inside a submenu, so finding a worktree past the cap is the
          picker's job. */}
      <ContextMenuSubContent>
        {submenuWorktrees.map((wt) => {
          const isCurrent = wt.id === terminal.worktreeId;
          return (
            <ContextMenuItem
              key={wt.id}
              disabled={isCurrent}
              onSelect={() => handleAction(`move-to-worktree:${wt.id}`)}
            >
              <FolderGit2 className={ICON_CLASS} />
              {getWorktreeHeadline(wt).label}
            </ContextMenuItem>
          );
        })}
        {hasMoreWorktrees && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem aria-haspopup="dialog" onSelect={handleMoveToWorktreeMore}>
              <FolderGit2 className={ICON_CLASS} />
              More worktrees…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );

  const layoutSection = (
    <>
      {canMoveToWorktree && renderMoveToWorktreeSubmenu("Move to worktree")}
      {terminalPty?.launchAgentId && (
        <ContextMenuItem
          onSelect={() =>
            void actionService.dispatch(
              "terminal.moveToNewWorktree",
              { terminalId },
              { source: sourceRef.current }
            )
          }
        >
          <FolderGit2 className={ICON_CLASS} />
          Move to new worktree…
        </ContextMenuItem>
      )}
      <ContextMenuItem
        // Move-to-grid is always safe; move-to-dock only for kinds the dock
        // renders (PTY + dockable non-PTY like file panels).
        disabled={currentLocation === "grid" && !kindCapabilities.isDockable}
        onSelect={() => handleAction(currentLocation === "grid" ? "move-to-dock" : "move-to-grid")}
      >
        {currentLocation === "grid" ? (
          <PanelBottomClose className={ICON_CLASS} />
        ) : (
          <PanelTopClose className={ICON_CLASS} />
        )}
        {currentLocation === "grid" ? "Move to dock" : "Move to grid"}
      </ContextMenuItem>
      {currentLocation === "grid" && (
        <ContextMenuItem onSelect={() => handleAction("toggle-maximize")}>
          {isMaximized ? (
            <Minimize2 className={ICON_CLASS} aria-hidden="true" />
          ) : (
            <Maximize2 className={ICON_CLASS} aria-hidden="true" />
          )}
          {isMaximized ? "Restore" : "Maximize"}
          <ContextMenuShortcut>^⇧F</ContextMenuShortcut>
        </ContextMenuItem>
      )}
    </>
  );

  const movePicker = hasOpenedMovePicker && (
    // Beside the trigger in every branch, never wrapped around `children`: in
    // the dock those are the dock's own popover trigger, which the nearest
    // popover root would claim.
    <AppPalettePopover
      isOpen={isMovePickerOpen}
      onOpenChange={handleMovePickerOpenChange}
      // Modal like the header's: Tab cycles inside, and the outside press that
      // dismisses it doesn't also land on what it hit.
      modal={true}
    >
      <PopoverAnchor virtualRef={{ current: movePickerAnchor }} />
      <MoveToWorktreePicker
        panelId={terminalId}
        currentWorktreeId={terminal.worktreeId}
        isOpen={isMovePickerOpen}
        onOpenChange={handleMovePickerOpenChange}
        returnFocusRef={movePickerReturnFocusRef}
        // Opens from the point the way the menu did.
        align="start"
      />
    </AppPalettePopover>
  );

  if (isBrowser) {
    const hasUrl = Boolean(terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl));
    return (
      <ContextMenu onOpenChange={handleMenuOpenChange}>
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div
            className="contents"
            data-context-trigger={terminalId}
            onContextMenu={captureMovePickerAnchor}
            onPointerDown={captureMovePickerAnchorOnPress}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("reload-browser")}>
            <RefreshCw className={ICON_CLASS} aria-hidden="true" />
            Reload page
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("open-external")}>
            <Globe className={ICON_CLASS} aria-hidden="true" />
            Open in browser
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("copy-url")}>
            <Link className={ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate browser
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename browser
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash browser
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Remove browser
          </ContextMenuItem>
        </ContextMenuContent>
        {movePicker}
      </ContextMenu>
    );
  }

  if (isDevPreview) {
    const hasUrl = Boolean(terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl));
    return (
      <ContextMenu onOpenChange={handleMenuOpenChange}>
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div
            className="contents"
            data-context-trigger={terminalId}
            onContextMenu={captureMovePickerAnchor}
            onPointerDown={captureMovePickerAnchorOnPress}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("reload-browser")}>
            <RefreshCw className={ICON_CLASS} aria-hidden="true" />
            Reload preview
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("open-external")}>
            <Globe className={ICON_CLASS} aria-hidden="true" />
            Open in browser
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasUrl} onSelect={() => handleAction("copy-url")}>
            <Link className={ICON_CLASS} aria-hidden="true" />
            Copy URL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate dev preview
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename dev preview
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash dev preview
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Stop dev server
          </ContextMenuItem>
        </ContextMenuContent>
        {movePicker}
      </ContextMenu>
    );
  }

  if (isReview) {
    return (
      <ContextMenu onOpenChange={handleMenuOpenChange}>
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div
            className="contents"
            data-context-trigger={terminalId}
            onContextMenu={captureMovePickerAnchor}
            onPointerDown={captureMovePickerAnchorOnPress}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
          {layoutSection}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("duplicate")}>
            <CopyPlus className={ICON_CLASS} aria-hidden="true" />
            Duplicate review
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename review
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash review
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Remove review
          </ContextMenuItem>
        </ContextMenuContent>
        {movePicker}
      </ContextMenu>
    );
  }

  // Diff joins the file/plugin branch: all three are non-PTY reading surfaces
  // whose menu is the generic panel one. Without an early return here the PTY
  // menu below would narrow against DiffPanelData and lose `isInputLocked`.
  if (isFile || isFileBrowser || isDiff || hasGenericMenu) {
    return (
      <ContextMenu onOpenChange={handleMenuOpenChange}>
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div
            className="contents"
            data-context-trigger={terminalId}
            onContextMenu={captureMovePickerAnchor}
            onPointerDown={captureMovePickerAnchorOnPress}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
          {/* The header's overflow menu renders this same list (#12606). */}
          {getGenericPanelMenuGroups({
            location: currentLocation === "grid" ? "grid" : "dock",
            isMaximized,
            isDockable: kindCapabilities.isDockable,
            canMoveToWorktree,
            canReload: canReloadPanelKind(kind),
          }).map((group, groupIndex) => (
            <Fragment key={group[0]?.id ?? groupIndex}>
              {groupIndex > 0 && <ContextMenuSeparator />}
              {group.map((command) =>
                command.id === "move-to-worktree" ? (
                  <Fragment key={command.id}>{renderMoveToWorktreeSubmenu(command.label)}</Fragment>
                ) : (
                  <ContextMenuItem
                    key={command.id}
                    disabled={command.disabled}
                    destructive={command.destructive}
                    onSelect={() => handleAction(command.id)}
                  >
                    <command.icon className={ICON_CLASS} aria-hidden="true" />
                    {command.label}
                    {command.shortcutActionId && (
                      <ContextMenuKeybinding actionId={command.shortcutActionId} />
                    )}
                  </ContextMenuItem>
                )
              )}
            </Fragment>
          ))}
        </ContextMenuContent>
        {movePicker}
      </ContextMenu>
    );
  }

  return (
    <>
      {destructiveConfirmDialog}
      {handOverRequest !== null && (
        <TerminalHandOverDialog
          key={handOverRequest.id}
          terminalId={handOverRequest.terminalId}
          orchestratorPaneId={handOverRequest.orchestratorPaneId}
          onClose={() => closeHandOverRequest(handOverRequest)}
          restoreFocusTo={movePickerReturnFocusRef}
        />
      )}
      <ContextMenu onOpenChange={handleMenuOpenChange}>
        <MenuActionSourceContext.Consumer>
          {(value) => {
            sourceRef.current = value ?? "user";
            return null;
          }}
        </MenuActionSourceContext.Consumer>
        <ContextMenuTrigger asChild>
          <div
            className="contents"
            data-context-trigger={terminalId}
            onContextMenu={handleContextMenu}
            onPointerDown={captureMovePickerAnchorOnPress}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
          {hasPty && (
            <>
              <ContextMenuItem disabled={!hasSelection} onSelect={() => handleAction("copy")}>
                <Copy className={ICON_CLASS} aria-hidden="true" />
                Copy
                <ContextMenuShortcut>{modifierKey}C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => handleAction("paste")}>
                <Clipboard className={ICON_CLASS} aria-hidden="true" />
                Paste
                <ContextMenuShortcut>{mac ? `${modifierKey}V` : "Ctrl+⇧V"}</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!hasSelection}
                onSelect={() =>
                  void actionService.dispatch(
                    "terminal.sendToAgent",
                    { terminalId },
                    { source: sourceRef.current }
                  )
                }
              >
                <Send className={ICON_CLASS} aria-hidden="true" />
                Send to agent
                <ContextMenuShortcut>{mac ? "⌘⇧E" : "Ctrl+⇧E"}</ContextMenuShortcut>
              </ContextMenuItem>
              {hoveredUrl && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => handleAction("open-link")}>
                    <ExternalLink className={ICON_CLASS} aria-hidden="true" />
                    Open link
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => handleAction(`copy-link:${hoveredUrl}`)}>
                    <Link className={ICON_CLASS} aria-hidden="true" />
                    Copy link address
                  </ContextMenuItem>
                </>
              )}
              {hoveredFilePath && (
                <>
                  <ContextMenuSeparator />
                  {hoveredFileScope && (
                    <ContextMenuItem
                      onSelect={() => {
                        void actionService
                          .dispatch(
                            "worktree.openFileBrowser",
                            {
                              worktreeId: hoveredFileScope.worktreeId,
                              revealPath: hoveredFileScope.relativePath || undefined,
                              // Carried through rather than assumed: a
                              // directory is expanded as well as selected, so
                              // guessing "file" would leave a right-clicked
                              // folder collapsed while left-clicking the same
                              // link opens it.
                              revealKind: hoveredFileKind ?? "file",
                            },
                            { source: sourceRef.current }
                          )
                          .then((result) => {
                            if (!result.ok) {
                              reportFileLinkFailure(
                                "Failed to open file browser",
                                result.error.details,
                                hoveredFilePath,
                                hoveredFileKind === "directory" ? "folder" : "file"
                              );
                            }
                          });
                      }}
                    >
                      <FolderTree className={ICON_CLASS} aria-hidden="true" />
                      Open in file browser
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    onSelect={() => handleAction(`reveal-in-finder:${hoveredFilePath}`)}
                  >
                    <FolderOpen className={ICON_CLASS} aria-hidden="true" />
                    {mac ? "Reveal in Finder" : isWindows() ? "Show in Explorer" : "Show in folder"}
                  </ContextMenuItem>
                </>
              )}
              {selectionFilePath && (
                <>
                  <ContextMenuSeparator />
                  <SelectedFileMenuItems absolutePath={selectionFilePath} />
                </>
              )}
              <ContextMenuSeparator />
            </>
          )}
          {fleetEligible && (
            <>
              <ContextMenuItem onSelect={() => handleAction("fleet-toggle")}>
                {isArmed ? (
                  <Radio className={ICON_CLASS} aria-hidden="true" />
                ) : (
                  <RadioTower className={ICON_CLASS} aria-hidden="true" />
                )}
                {isArmed ? "Remove from fleet" : "Add to fleet"}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => handleAction("fleet-arm-worktree")}>
                <RadioTower className={ICON_CLASS} aria-hidden="true" />
                Arm all in this worktree
              </ContextMenuItem>
              {isArmed && fleetSize >= 2 && (
                <ContextMenuItem destructive onSelect={() => handleAction("fleet-clear")}>
                  <Radio className={ICON_CLASS} aria-hidden="true" />
                  Clear fleet
                </ContextMenuItem>
              )}
              {isKnownRun && (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <BellOff className={ICON_CLASS} aria-hidden="true" />
                    Snooze
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {AGENT_SNOOZE_DURATION_OPTIONS.map((option) => (
                      <ContextMenuItem key={option} onSelect={() => handleSnooze(option)}>
                        <BellOff className={ICON_CLASS} aria-hidden="true" />
                        {AGENT_SNOOZE_LABEL[option]}
                      </ContextMenuItem>
                    ))}
                    {/* Only once there is something to lift. An always-present
                        "Wake now" would be a no-op the user has to read past on
                        every run that was never snoozed. */}
                    {isSnoozed && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={handleUnsnooze}>
                          <Bell className={ICON_CLASS} aria-hidden="true" />
                          Wake now
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              )}
              <ContextMenuSeparator />
            </>
          )}
          {layoutSection}
          <ContextMenuSeparator />
          {hasPty && (
            <ContextMenuItem disabled={isHibernated} onSelect={() => handleAction("redraw")}>
              <RefreshCw className={ICON_CLASS} aria-hidden="true" />
              Redraw terminal
            </ContextMenuItem>
          )}
          {hasPty && (
            <ContextMenuItem onSelect={() => handleAction("restart")}>
              <RotateCcw className={ICON_CLASS} aria-hidden="true" />
              Restart terminal
            </ContextMenuItem>
          )}
          {isPaused && (
            <ContextMenuItem onSelect={() => handleAction("force-resume")}>
              <Play className={ICON_CLASS} aria-hidden="true" />
              Force resume (paused)
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => handleAction("toggle-input-lock")}>
            {terminal.isInputLocked ? (
              <Unlock className={ICON_CLASS} aria-hidden="true" />
            ) : (
              <Lock className={ICON_CLASS} aria-hidden="true" />
            )}
            {terminal.isInputLocked ? "Unlock input" : "Lock input"}
          </ContextMenuItem>
          {hasPty && (
            <ContextMenuItem
              onSelect={() =>
                handleAction(isVoiceLockedHere ? "voice-unlock-target" : "voice-lock-target")
              }
            >
              {isVoiceLockedHere ? (
                <MicOff className={ICON_CLASS} aria-hidden="true" />
              ) : (
                <Mic className={ICON_CLASS} aria-hidden="true" />
              )}
              {isVoiceLockedHere ? "Unlock dictation" : "Lock dictation to this panel"}
            </ContextMenuItem>
          )}
          {hasPty && liveRecentVoiceTargets.length > 0 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Mic className={ICON_CLASS} aria-hidden="true" />
                Recent dictation targets
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {liveRecentVoiceTargets.map((target) => (
                  <ContextMenuItem
                    key={target.panelId}
                    onSelect={() => handleAction(`recall-voice-target:${target.panelId}`)}
                  >
                    <Mic className={ICON_CLASS} aria-hidden="true" />
                    {target.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {terminal.detectedAgentId && (
            <ContextMenuItem onSelect={() => handleAction("toggle-watch")}>
              {isWatched ? (
                <BellOff className={ICON_CLASS} aria-hidden="true" />
              ) : (
                <Bell className={ICON_CLASS} aria-hidden="true" />
              )}
              {isWatched ? "Cancel watch" : "Watch terminal"}
              <ContextMenuShortcut>{mac ? "⌘⇧W" : "Ctrl+⇧W"}</ContextMenuShortcut>
            </ContextMenuItem>
          )}
          {hasPty && (
            <TerminalHandOverMenuItems
              terminalId={terminalId}
              candidateIds={orchestratorCandidateIds}
              onRequestHandOver={handleRequestHandOver}
            />
          )}
          <ContextMenuSeparator />
          {/* A PTY-backed plugin kind has no duplicate recipe. */}
          {canDuplicatePanelKind(kind) && (
            <ContextMenuItem onSelect={() => handleAction("duplicate")}>
              <CopyPlus className={ICON_CLASS} aria-hidden="true" />
              Duplicate terminal
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => handleAction("rename")}>
            <Pencil className={ICON_CLASS} aria-hidden="true" />
            Rename terminal
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleAction("view-info")}>
            <Info className={ICON_CLASS} aria-hidden="true" />
            View terminal info
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("background")}>
            <ArrowDownFromLine className={ICON_CLASS} aria-hidden="true" />
            Send to background
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleAction("trash")}>
            <Trash2 className={ICON_CLASS} aria-hidden="true" />
            Trash terminal
          </ContextMenuItem>
          <ContextMenuItem destructive onSelect={() => handleAction("kill")}>
            <OctagonX className={ICON_CLASS} aria-hidden="true" />
            Kill terminal
          </ContextMenuItem>
          <PluginContextMenuSection items={pluginItems} />
        </ContextMenuContent>
        {movePicker}
      </ContextMenu>
    </>
  );
}
