import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type React from "react";
import { type PanelLocation } from "@/types";
import type { TerminalLink } from "@/services/terminal/types";
import { usePanelStore } from "@/store";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useSidebarWorktreeOrder } from "@/hooks/useSidebarWorktreeOrder";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import {
  getPanelKindRegistrySnapshot,
  panelKindHasPty,
  subscribeToPanelKindRegistry,
} from "@shared/config/panelKindRegistry";
import { canDuplicatePanelKind } from "@/services/terminal/panelDuplicationService";
import {
  isBrowserPanel,
  isDevPreviewPanel,
  isDiffPanel,
  isFileBrowserPanel,
  isFilePanel,
  isPtyPanel,
  isReviewPanel,
} from "@shared/types/panel";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { systemClient } from "@/clients/systemClient";
import { resolveSelectedFilePath } from "@/services/terminal/filePathDetection";
import { resolveWorktreePathScope } from "@shared/utils/path";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";
import { actionService } from "@/services/ActionService";
import { useIsHibernated } from "@/hooks/useIsHibernated";
import { usePluginContextMenuItems } from "@/hooks/usePluginContextMenuItems";
import { PluginContextMenuSection } from "@/components/Plugin/PluginContextMenuSection";
import type { WhenClauseContext } from "@shared/utils/whenClause";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  RestartOnPresetConfirmDialog,
  type RestartOnPresetRequest,
} from "@/components/Terminal/RestartOnPreset";
import { DestructiveConsequence } from "@/components/Terminal/TerminalDestructiveActionConfirmDialog";
import { TerminalHandOverDialog, useOrchestratorCandidates } from "./TerminalHandOver";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  stopContextMenuPropagation,
} from "@/components/ui/context-menu";
import { MenuActionSourceContext, type MenuActionSourceValue } from "@/components/ui/menu-source";
import {
  getRegisteredTourIdsSnapshot,
  subscribeToTourRegistry,
} from "@/components/Tour/tourRegistry";
import { PanelContextMenuTriggerScope } from "./PanelContextMenuTrigger";
import { panelHasComposer } from "./terminalComposer";
import {
  canReloadPanelKind,
  hasGenericPanelMenu,
  readPanelKindMenuCapabilities,
  resolvePluginMenuItems,
} from "@/components/Panel/genericPanelMenu";
import {
  getRegisteredPluginActionsSnapshot,
  subscribeToRegisteredPluginActions,
} from "@/services/plugin/registeredPluginActions";
import { usePanelViewMenuItems, usePanelWorkerMenus } from "@/store/pluginPanelMenuStore";
import type { MenuPanel, PendingMenuDispatch } from "./contextMenu/menuShared";
import { useTerminalMenuCommands } from "./contextMenu/useTerminalMenuCommands";
import {
  MoveToWorktreeMenuPicker,
  useMovePickerCoordination,
} from "./contextMenu/useMovePickerCoordination";
import { useFleetRunMenuState } from "./contextMenu/useFleetRunMenuState";
import { LayoutMenuItems, MoveToWorktreeSubmenu } from "./contextMenu/LayoutMenuItems";
import {
  GenericPanelMenuItems,
  PluginOwnedMenuItems,
  ReviewMenuItems,
  TourMenuItem,
  UrlPanelMenuItems,
} from "./contextMenu/PanelKindMenuItems";
import {
  TerminalFleetMenuItems,
  TerminalIdentityMenuItems,
  TerminalSelectionMenuItems,
  TerminalSessionMenuItems,
} from "./contextMenu/TerminalMenuItems";

// Loaded on first use: every pane and session row mounts this menu, and the
// dialog pulls in Pilot's row and band modules that nothing else here needs.
const LazyParkRunDialog = lazy(() =>
  import("@/components/Fleet/ParkRunDialog").then((m) => ({ default: m.ParkRunDialog }))
);

/** A task turn after the close hook, which is where the menu primitive restores focus. */
const AFTER_MENU_FOCUS_RESTORE_MS = 0;

/** A pending hand-over consent (#12490): which terminal, to which pane. */
interface HandOverRequest {
  id: number;
  terminalId: string;
  orchestratorPaneId: string;
}

interface TerminalContextMenuProps {
  terminalId: string;
  children: React.ReactNode;
  forceLocation?: PanelLocation;
  /**
   * The trigger stands for the panel rather than being its surface: a tab in a
   * strip, a sidebar session row, a rescue chip. A proxy owns the right-click
   * under it, so the event stops here instead of reaching an enclosing menu —
   * the active panel's own in a tab strip, the worktree card's in the sidebar.
   * It also leaves `data-context-trigger` to the panel, so opening a panel's
   * menu from the keyboard never lands on a row standing in for it.
   */
  proxy?: boolean;
  /**
   * Which part of the panel opens the menu. `"surface"` (the default) makes
   * every pixel of the children a trigger, which suits a terminal pane whose
   * content has no menu of its own. `"header"` leaves the children alone and
   * hands the trigger to a `PanelContextMenuTrigger` inside them — the title
   * bar — so a file, diff or browser body keeps the right-click for itself.
   */
  triggerScope?: "surface" | "header";
}

/**
 * Keeps what the menu's portalled layers do — a menu item, the move picker, a
 * confirm dialog — from reaching the row or tab the proxy sits in. React
 * bubbles portal events through the component tree, so without this choosing
 * an item on a sidebar session row also clicked its worktree card, and
 * selected that worktree. Events from the proxy's own element pass through.
 */
function containPortalEvent(event: React.SyntheticEvent) {
  const origin = event.target;
  if (!(origin instanceof Node) || !event.currentTarget.contains(origin)) event.stopPropagation();
}

/**
 * Radix opens a context menu from a touch or pen long-press as well, timed
 * from pointerdown. A proxy nested in another trigger (a session row in a
 * worktree card) would otherwise start both timers and open both menus.
 */
function containPortalOrLongPress(event: React.PointerEvent) {
  if (event.pointerType !== "mouse") event.stopPropagation();
  else containPortalEvent(event);
}

/**
 * Every pane, tab, dock item and sidebar row keeps this menu mounted, so while
 * it is closed the panel record is held until one of the fields the closed
 * menu renders from changes: the branch (kind), the move picker's current
 * worktree, and existence. Activity, agent-state and focus writes would
 * otherwise re-render every closed menu. The live menu gets every write.
 */
const NO_CUSTOM_TITLES: Readonly<Record<string, string>> = {};

function createMenuPanelSelector(terminalId: string, isMenuLive: boolean) {
  let held: MenuPanel | undefined;
  return (state: { panelsById: Record<string, MenuPanel> }): MenuPanel | undefined => {
    const panel = state.panelsById[terminalId];
    if (
      !isMenuLive &&
      held !== undefined &&
      panel !== undefined &&
      panel.kind === held.kind &&
      panel.worktreeId === held.worktreeId &&
      panel.location === held.location
    ) {
      return held;
    }
    held = panel;
    return panel;
  };
}

/**
 * Keeps the menu live while its content is mounted: raises it for content that
 * opened without a right-click (a touch long-press), and drops it once the
 * content unmounts after any exit animation. Raising an already-live menu
 * would cost a render.
 */
function MenuContentMountSignal({
  isLive,
  onLiveChange,
}: {
  isLive: boolean;
  onLiveChange: (live: boolean) => void;
}) {
  useLayoutEffect(() => {
    if (!isLive) onLiveChange(true);
  }, [isLive, onLiveChange]);
  useLayoutEffect(() => () => onLiveChange(false), [onLiveChange]);
  return null;
}

/**
 * The right-click menu for one panel, scoped to that panel wherever the
 * pointer found it: its own surface, a dock item, a tab, a sidebar row.
 */
export function TerminalContextMenu(props: TerminalContextMenuProps) {
  if (!props.proxy) return <TerminalContextMenuBody {...props} />;
  return (
    <div
      className="contents"
      onClick={containPortalEvent}
      onDoubleClick={containPortalEvent}
      onMouseDown={containPortalEvent}
      onPointerDown={containPortalOrLongPress}
      onKeyDown={containPortalEvent}
    >
      <TerminalContextMenuBody {...props} />
    </div>
  );
}

function TerminalContextMenuBody({
  terminalId,
  children,
  forceLocation,
  proxy = false,
  triggerScope = "surface",
}: TerminalContextMenuProps) {
  // Open or still animating out. Raised by the right-click itself, in the same
  // batch as Radix's open, so the first open frame renders live data — Radix
  // reports `onOpenChange` only from an effect after that frame commits.
  // Dropped when the content unmounts, which Radix holds through the exit.
  const [isMenuLive, setIsMenuLive] = useState(false);
  const selectPanel = useMemo(
    () => createMenuPanelSelector(terminalId, isMenuLive),
    [terminalId, isMenuLive]
  );
  const terminal = usePanelStore(selectPanel);
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

  // Every pane, dock chip and tab carries one of these menus, closed nearly all
  // the time; only the live menu lists worktrees, so a git-status pass on any
  // worktree doesn't re-render every closed menu.
  const worktrees = useSidebarWorktreeOrder({ enabled: isMenuLive });
  const customTitles = useWorktreeFilterStore((state) =>
    isMenuLive ? state.worktreeCustomTitles : NO_CUSTOM_TITLES
  );
  // What the panel's plugin published for its menus (#13213), read only while
  // the menu is live for the same reason.
  const publishedViewMenuItems = usePanelViewMenuItems(terminalId, isMenuLive);
  const publishedWorkerMenus = usePanelWorkerMenus(terminalId, isMenuLive);
  // Subscribed so a plugin registering or dropping its kind reaches the menu;
  // the generic panel menu reads its capabilities from this snapshot.
  const panelKindRegistry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  const registeredTourIds = useSyncExternalStore(
    subscribeToTourRegistry,
    getRegisteredTourIdsSnapshot,
    getRegisteredTourIdsSnapshot
  );
  // A plugin's own menu items wait on their actions registering.
  const registeredPluginActions = useSyncExternalStore(
    subscribeToRegisteredPluginActions,
    getRegisteredPluginActionsSnapshot,
    getRegisteredPluginActionsSnapshot
  );

  const movePicker = useMovePickerCoordination(terminalId, proxy, triggerScope);
  const { captureMovePickerAnchor, clearPendingMovePicker, spendPendingMovePicker } = movePicker;
  const movePickerReturnFocusRef = movePicker.movePickerReturnFocusRef;

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
  // "Park…" opens its dialog the same way, and is dropped the same way when
  // the dock hands this menu another terminal.
  const [parkRequestId, setParkRequestId] = useState<string | null>(null);
  if (parkRequestId !== null && parkRequestId !== terminalId) {
    setParkRequestId(null);
  }
  const pendingParkRef = useRef<string | null>(null);
  const closeParkRequest = useCallback(() => setParkRequestId(null), []);
  // Picking a pane records the request and the root content's close hook
  // opens the dialog — the same handoff as the move picker, so the menu's own
  // focus return can't land after the dialog has taken focus.
  const pendingHandOverRef = useRef<HandOverRequest | null>(null);
  // "Plugin settings…", "Back up data…" and a plugin's own items are spent the
  // same way, after the menu has returned focus to the pane, so the settings
  // home, the save dialog or the plugin's own confirmation records the pane as
  // where to return it.
  const pendingMenuDispatchRef = useRef<PendingMenuDispatch | null>(null);
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

  // Captured on every open (right-click or long-press): a menu opened before
  // the home dir arrived re-resolves `~/` next time, even for an unchanged
  // selection.
  const [homeDir, setHomeDir] = useState<string | undefined>(undefined);
  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      // A menu reopened inside its exit animation never unmounts, so the close
      // hook never runs for that close; drop the intent rather than let it open
      // the picker on some later, unrelated close.
      if (open) {
        // Only when it changed: an unconditional set costs every open a render.
        const cachedHomeDir = systemClient.getCachedHomeDir();
        if (cachedHomeDir !== homeDir) setHomeDir(cachedHomeDir);
        clearPendingMovePicker();
        pendingHandOverRef.current = null;
        pendingParkRef.current = null;
        pendingMenuDispatchRef.current = null;
        // Only a PTY can be handed over; the other kinds' menus never ask.
        if (terminal !== undefined && panelKindHasPty(terminal.kind ?? "terminal")) {
          refreshOrchestratorCandidates();
        }
      }
    },
    [homeDir, clearPendingMovePicker, refreshOrchestratorCandidates, terminal]
  );

  const handleTriggerContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      // Radix skips a right-click a nested trigger already claimed, and so does this.
      if (!event.defaultPrevented) {
        setIsMenuLive(true);
        // Radix's trigger runs after this and claims the event when it opens.
        // Unclaimed — the primitives chunk still loading — no content mounts to
        // drop the flag, so drop it here.
        const nativeEvent = event.nativeEvent;
        queueMicrotask(() => {
          if (!nativeEvent.defaultPrevented) setIsMenuLive(false);
        });
      }
      if (proxy) stopContextMenuPropagation(event);
      captureMovePickerAnchor(event);
    },
    [proxy, captureMovePickerAnchor]
  );

  const isWatched = usePanelStore((state) => state.watchedPanels.has(terminalId));
  const isArmed = useFleetArmingStore((s) => s.armedIds.has(terminalId));
  const fleetSize = useFleetArmingStore((s) => s.armedIds.size);
  const isHibernated = useIsHibernated(terminalId);
  const isVoiceLockedHere = useVoiceRecordingStore((s) => s.lockedTarget?.panelId === terminalId);
  const hybridInputEnabled = useTerminalInputStore((s) => isMenuLive && s.hybridInputEnabled);
  const recentVoiceTargets = useVoiceRecordingStore((s) => s.recentTargets);
  // Pull the panel directly here (rather than indexing through the shallow
  // selector above) so the eligibility check sees the live record. The
  // dropdown only renders fleet items when the panel is fleet-arm-eligible
  // — non-agent terminals, trashed/backgrounded panels, and PTY-less panels
  // don't get the option, matching the gesture-level rules in
  // `multiSelectGestures`.
  const fleetEligible = isFleetArmEligible(terminal);
  const fleetRun = useFleetRunMenuState(terminalId, isMenuLive);
  const sourceRef = useRef<MenuActionSourceValue>("user");

  const handleRequestPark = useCallback(() => {
    pendingParkRef.current = terminalId;
  }, [terminalId]);

  const panelKind = terminal?.kind;
  const panelWorktreeId = terminal?.worktreeId;
  const pluginMenuContext = useMemo<WhenClauseContext>(
    () => ({ panelId: terminalId, panelKind, worktreeId: panelWorktreeId }),
    [terminalId, panelKind, panelWorktreeId]
  );
  const pluginDispatchArgs = useMemo(
    () => ({
      panelId: terminalId,
      panelKind,
      ...(panelWorktreeId && { worktreeId: panelWorktreeId }),
    }),
    [terminalId, panelKind, panelWorktreeId]
  );
  const pluginItems = usePluginContextMenuItems("terminal", pluginMenuContext);

  const [hasSelection, setHasSelection] = useState(false);
  const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);
  // The plugin that claims the hovered URL (#13798), read with it on open.
  const [hoveredUrlPluginName, setHoveredUrlPluginName] = useState<string | null>(null);
  // The hovered link itself, for "Open link": the hover ends as the pointer
  // moves onto the menu, so the item cannot read it when it is chosen (#14960).
  const hoveredLinkRef = useRef<TerminalLink | null>(null);
  const [hoveredFilePath, setHoveredFilePath] = useState<string | null>(null);
  const [hoveredFileKind, setHoveredFileKind] = useState<"file" | "directory" | null>(null);
  const clearHoveredLink = useCallback(() => {
    hoveredLinkRef.current = null;
    setHoveredUrl(null);
    setHoveredUrlPluginName(null);
    setHoveredFilePath(null);
    setHoveredFileKind(null);
  }, []);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const suppressNextCloseAutoFocusRef = useRef(false);
  const [restartOnPresetRequest, setRestartOnPresetRequest] =
    useState<RestartOnPresetRequest | null>(null);
  const closeRestartOnPreset = useCallback(() => setRestartOnPresetRequest(null), []);

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
      handleTriggerContextMenu(e);
      const { panelsById } = usePanelStore.getState();
      const { armedIds } = useFleetArmingStore.getState();
      const composerOptions = {
        hybridInputEnabled: useTerminalInputStore.getState().hybridInputEnabled,
        fleetSize: armedIds.size,
      };
      // Only a pane whose composer can show the words is offered (#14955).
      const canDictate = (panel: (typeof panelsById)[string] | undefined) =>
        panelHasComposer(panel, {
          ...composerOptions,
          isFleetArmed: panel !== undefined && armedIds.has(panel.id),
        });
      const resolved: Array<{ panelId: string; label: string }> = [];
      const seenIds = new Set<string>([terminalId]);
      for (const t of recentVoiceTargets) {
        let livePanelId: string | undefined;
        if (t.panelId) {
          if (canDictate(panelsById[t.panelId])) livePanelId = t.panelId;
        } else if (t.worktreeId && t.panelTitle) {
          const titleMatch = Object.values(panelsById).find(
            (panel) =>
              panel.worktreeId === t.worktreeId && panel.title === t.panelTitle && canDictate(panel)
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

      const managed = peekTerminalService()?.get(terminalId) ?? null;
      if (!managed?.terminal) {
        clearHoveredLink();
        setHasSelection(false);
        setSelectedText(null);
        return;
      }
      // Read the selection synchronously here — xterm clears it on the next
      // forwarded keystroke (#7649), so a deferred read would see nothing.
      const selection = managed.terminal.getSelection();
      setHasSelection(!!selection);
      setSelectedText(selection || null);
      setHomeDir(systemClient.getCachedHomeDir());
      hoveredLinkRef.current = managed.hoveredLink;
      setHoveredUrl(peekTerminalService()?.getHoveredLinkText(terminalId) ?? null);
      setHoveredUrlPluginName(peekTerminalService()?.getHoveredLinkPluginName(terminalId) ?? null);
      setHoveredFilePath(peekTerminalService()?.getHoveredFilePath(terminalId) ?? null);
      setHoveredFileKind(peekTerminalService()?.getHoveredFileKind(terminalId) ?? null);
    },
    [handleTriggerContextMenu, terminalId, recentVoiceTargets, clearHoveredLink]
  );

  // Radix also opens the menu from a touch or pen long-press, which never
  // raises the contextmenu event the hover capture above hangs off, so the
  // previous opening's link must not survive into this one.
  const captureMovePickerAnchorOnPress = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse") return;
      clearHoveredLink();
      captureMovePickerAnchor(event);
    },
    [captureMovePickerAnchor, clearHoveredLink]
  );

  const terminalPty = terminal && isPtyPanel(terminal) ? terminal : undefined;

  // A selection that resolves to a file path unlocks the "View file" / reveal
  // section. Relative paths resolve against the terminal's cwd;
  // absolute selections resolve without one (empty cwd is fine for those).
  const selectionFilePath = useMemo(
    () =>
      selectedText
        ? (resolveSelectedFilePath(selectedText, terminalPty?.cwd ?? "", homeDir)?.absolutePath ??
          null)
        : null,
    [selectedText, terminalPty?.cwd, homeDir]
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
  // Reachable from the dock's Background popover. Its way back is a restore to
  // wherever it was sent from; moving it or sending it to background again
  // would leave the background bookkeeping behind.
  const isBackgrounded = terminal?.location === "background";
  // A row in the dock's Waiting popover can stand for a pane in another
  // worktree, which the grid in front of the user does not render.
  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const isInActiveWorktree = (terminal?.worktreeId ?? null) === (activeWorktreeId ?? null);

  const deferMenuDispatch = useCallback((dispatch: PendingMenuDispatch) => {
    pendingMenuDispatchRef.current = dispatch;
  }, []);
  const suppressNextCloseAutoFocus = useCallback(() => {
    suppressNextCloseAutoFocusRef.current = true;
  }, []);
  const {
    handleAction,
    handleSendToAgent,
    handleMoveToNewWorktree,
    handleOpenInFileBrowser,
    destructiveConfirm,
    handleDestructiveConfirm,
    closeDestructiveConfirm,
  } = useTerminalMenuCommands({
    terminal,
    terminalId,
    panelKindRegistry,
    registeredTourIds,
    sourceRef,
    hoveredLinkRef,
    deferMenuDispatch,
    suppressNextCloseAutoFocus,
  });

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      if (suppressNextCloseAutoFocusRef.current) {
        suppressNextCloseAutoFocusRef.current = false;
        event.preventDefault();
      }
      const pendingDispatch = pendingMenuDispatchRef.current;
      pendingMenuDispatchRef.current = null;
      if (pendingDispatch !== null) {
        // Restoration is left to run, and the action runs after it: whatever it
        // opens then records the pane, not the unmounting item, as where focus
        // returns when it closes.
        setTimeout(() => {
          // A context menu restores whatever was focused before the right-click,
          // which can be another pane when the click landed on something that
          // takes no focus. The action belongs to this panel, so it starts there.
          const panel = document.querySelector(`[data-panel-id="${CSS.escape(terminalId)}"]`);
          if (!panel?.contains(document.activeElement)) focusPanelInput(terminalId);
          void actionService.dispatch(pendingDispatch.actionId, pendingDispatch.args, {
            source: pendingDispatch.source,
          });
        }, AFTER_MENU_FOCUS_RESTORE_MS);
        return;
      }
      const pendingPark = pendingParkRef.current;
      pendingParkRef.current = null;
      if (pendingPark !== null && pendingPark === terminalId) {
        // Restoration is left to run, so the dialog records the pane as where
        // to return focus — the hand-over's handoff, for the same reason.
        setParkRequestId(pendingPark);
        return;
      }
      const pendingHandOver = pendingHandOverRef.current;
      pendingHandOverRef.current = null;
      if (pendingHandOver !== null && pendingHandOver.terminalId === terminalId) {
        // Restoration is left to run: focus goes back to the pane before the
        // dialog mounts, so the dialog records the pane as where to return it.
        setHandOverRequest(pendingHandOver);
        return;
      }
      spendPendingMovePicker(event);
    },
    [terminalId, spendPendingMovePicker]
  );

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
  // A PTY-backed plugin panel is a "terminal" whose plugin kind is kept apart
  // (#13213); its tour, settings and contributed entries are that kind's, while
  // the kind is registered. What the panel structurally is (a PTY, dockable)
  // stays the terminal's: the plugin's registration can vanish or change under
  // a live terminal without taking its copy, restart or dock away.
  const pluginPanelKindId = terminal.pluginPanelKindId;
  const pluginKindApplies =
    pluginPanelKindId !== undefined && panelKindRegistry[pluginPanelKindId] !== undefined;
  const kindCapabilities = readPanelKindMenuCapabilities(
    panelKindRegistry,
    pluginKindApplies ? pluginPanelKindId : kind,
    registeredTourIds,
    registeredPluginActions
  );
  const structuralCapabilities = pluginKindApplies
    ? readPanelKindMenuCapabilities(panelKindRegistry, kind)
    : kindCapabilities;
  const pluginMenuItems = resolvePluginMenuItems(
    kindCapabilities,
    publishedViewMenuItems,
    publishedWorkerMenus,
    registeredPluginActions
  );
  const hasPty = terminal.kind ? structuralCapabilities.hasPty : true;
  // A non-PTY plugin kind matches none of the built-in guards, so without this
  // it falls through to the terminal menu and is offered "Duplicate terminal",
  // "Kill terminal", and friends — none of which apply (#11228). The header's
  // overflow menu decides with the same predicate, so the two menus always
  // agree on which panels get the generic list (#12606). PTY-backed plugin
  // kinds stay out: they render through TerminalPane and are genuine
  // terminals, so they keep copy/paste, redraw, restart and the rest.
  const hasGenericMenu = hasGenericPanelMenu(kind, hasPty);
  const kindOwnedItems = (
    <>
      <TourMenuItem tour={kindCapabilities.tour} onAction={handleAction} />
      <PluginOwnedMenuItems
        pluginBackupId={kindCapabilities.pluginBackupId}
        pluginSettingsId={kindCapabilities.pluginSettingsId}
        onAction={handleAction}
      />
    </>
  );

  // Somewhere other than the panel's own worktree, which may already be gone —
  // the header's overflow menu counts it the same way.
  const canMoveToWorktree =
    !isBackgrounded && worktrees.some((wt) => wt.id !== terminal.worktreeId);
  const renderMoveToWorktreeSubmenu = (label: string) => (
    <MoveToWorktreeSubmenu
      label={label}
      worktrees={worktrees}
      currentWorktreeId={terminal.worktreeId}
      customTitles={customTitles}
      onAction={handleAction}
      onMoreWorktrees={movePicker.handleMoveToWorktreeMore}
    />
  );

  const layoutItems = (
    <LayoutMenuItems
      moveToWorktreeSubmenu={canMoveToWorktree && renderMoveToWorktreeSubmenu("Move to worktree")}
      canMoveToNewWorktree={Boolean(terminalPty?.launchAgentId) && !isBackgrounded}
      isBackgrounded={isBackgrounded}
      currentLocation={currentLocation}
      isDockable={structuralCapabilities.isDockable}
      isInActiveWorktree={isInActiveWorktree}
      isMaximized={isMaximized}
      onMoveToNewWorktree={handleMoveToNewWorktree}
      onAction={handleAction}
    />
  );

  // Every branch draws the same menu around its own items.
  const renderMenu = (
    items: React.ReactNode,
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => void
  ) => (
    <ContextMenu onOpenChange={handleMenuOpenChange}>
      <MenuActionSourceContext.Consumer>
        {(value) => {
          sourceRef.current = value ?? "user";
          return null;
        }}
      </MenuActionSourceContext.Consumer>
      <PanelContextMenuTriggerScope
        terminalId={terminalId}
        proxy={proxy}
        scope={triggerScope}
        onContextMenu={onContextMenu}
        onPointerDown={captureMovePickerAnchorOnPress}
      >
        {children}
      </PanelContextMenuTriggerScope>
      <ContextMenuContent onCloseAutoFocus={handleCloseAutoFocus}>
        <MenuContentMountSignal isLive={isMenuLive} onLiveChange={setIsMenuLive} />
        {items}
      </ContextMenuContent>
      {/* Beside the trigger in every branch, never wrapped around `children`:
          in the dock those are the dock's own popover trigger, which the
          nearest popover root would claim. */}
      {movePicker.hasOpenedMovePicker && (
        <MoveToWorktreeMenuPicker
          panelId={terminalId}
          currentWorktreeId={terminal.worktreeId}
          isOpen={movePicker.isMovePickerOpen}
          anchor={movePicker.movePickerAnchor}
          onOpenChange={movePicker.handleMovePickerOpenChange}
          returnFocusRef={movePickerReturnFocusRef}
        />
      )}
    </ContextMenu>
  );

  // The layout rows lead every built-in kind's own section from the same
  // position, so a dock group switching its active tab between kinds keeps an
  // open "Move to worktree" submenu open.
  if (isBrowser || isDevPreview) {
    const hasUrl = Boolean(terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl));
    return renderMenu(
      <>
        {layoutItems}
        <ContextMenuSeparator />
        <UrlPanelMenuItems
          variant={isBrowser ? "browser" : "dev-preview"}
          kindOwnedItems={kindOwnedItems}
          isBackgrounded={isBackgrounded}
          hasUrl={hasUrl}
          onAction={handleAction}
        />
      </>,
      handleTriggerContextMenu
    );
  }

  if (isReview) {
    return renderMenu(
      <>
        {layoutItems}
        <ContextMenuSeparator />
        <ReviewMenuItems
          kindOwnedItems={kindOwnedItems}
          isBackgrounded={isBackgrounded}
          onAction={handleAction}
        />
      </>,
      handleTriggerContextMenu
    );
  }

  // Diff joins the file/plugin branch: all three are non-PTY reading surfaces
  // whose menu is the generic panel one. Without an early return here the PTY
  // menu below would narrow against DiffPanelData and lose `isInputLocked`.
  if (isFile || isFileBrowser || isDiff || hasGenericMenu) {
    return renderMenu(
      <GenericPanelMenuItems
        menuInput={{
          location: currentLocation === "grid" ? "grid" : "dock",
          isMaximized,
          isDockable: structuralCapabilities.isDockable,
          canMoveToWorktree,
          canReload: canReloadPanelKind(kind),
          tourLabel: kindCapabilities.tour?.label,
          hasPluginSettings: kindCapabilities.pluginSettingsId !== null,
          hasPluginDatabases: kindCapabilities.pluginBackupId !== null,
          pluginMenuItems,
        }}
        renderMoveToWorktreeSubmenu={renderMoveToWorktreeSubmenu}
        onAction={handleAction}
      />,
      handleTriggerContextMenu
    );
  }

  return (
    <>
      {destructiveConfirmDialog}
      <RestartOnPresetConfirmDialog
        request={restartOnPresetRequest}
        onClose={closeRestartOnPreset}
        sourceRef={sourceRef}
      />
      {handOverRequest !== null && (
        <TerminalHandOverDialog
          key={handOverRequest.id}
          terminalId={handOverRequest.terminalId}
          orchestratorPaneId={handOverRequest.orchestratorPaneId}
          onClose={() => closeHandOverRequest(handOverRequest)}
          restoreFocusTo={movePickerReturnFocusRef}
        />
      )}
      {parkRequestId !== null && (
        <Suspense fallback={null}>
          <LazyParkRunDialog
            key={parkRequestId}
            runId={parkRequestId}
            onClose={closeParkRequest}
            restoreFocusTo={movePickerReturnFocusRef}
          />
        </Suspense>
      )}
      {renderMenu(
        <>
          {hasPty && (
            <TerminalSelectionMenuItems
              hasSelection={hasSelection}
              hoveredUrl={hoveredUrl}
              hoveredUrlPluginName={hoveredUrlPluginName}
              hoveredFilePath={hoveredFilePath}
              hoveredFileKind={hoveredFileKind}
              hoveredFileScope={hoveredFileScope}
              selectionFilePath={selectionFilePath}
              onSendToAgent={handleSendToAgent}
              onOpenInFileBrowser={handleOpenInFileBrowser}
              onAction={handleAction}
            />
          )}
          <TerminalFleetMenuItems
            fleetEligible={fleetEligible}
            isArmed={isArmed}
            fleetSize={fleetSize}
            fleetRun={fleetRun}
            onRequestPark={handleRequestPark}
            onAction={handleAction}
          />
          {layoutItems}
          <ContextMenuSeparator />
          <TerminalSessionMenuItems
            terminalId={terminalId}
            terminalPty={terminalPty}
            hasPty={hasPty}
            isHibernated={isHibernated}
            isPaused={isPaused}
            isInputLocked={terminal.isInputLocked}
            isVoiceLockedHere={isVoiceLockedHere}
            canDictateHere={
              isMenuLive &&
              panelHasComposer(terminal, { hybridInputEnabled, isFleetArmed: isArmed, fleetSize })
            }
            liveRecentVoiceTargets={liveRecentVoiceTargets}
            detectedAgentId={terminal.detectedAgentId}
            isWatched={isWatched}
            orchestratorCandidateIds={orchestratorCandidateIds}
            onRequestHandOver={handleRequestHandOver}
            onRequestRestartOnPreset={setRestartOnPresetRequest}
            onAction={handleAction}
          />
          {/* Other plugins' rows sit above the identity group, never after
              Trash and Kill: destruction ends the menu, as on the worktree
              menu, so no third-party row is one slip from killing the agent. */}
          <PluginContextMenuSection items={pluginItems} dispatchArgs={pluginDispatchArgs} />
          <ContextMenuSeparator />
          <TerminalIdentityMenuItems
            canDuplicate={canDuplicatePanelKind(kind)}
            pluginMenuItems={pluginMenuItems}
            kindOwnedItems={kindOwnedItems}
            isBackgrounded={isBackgrounded}
            onAction={handleAction}
          />
        </>,
        handleContextMenu
      )}
    </>
  );
}
