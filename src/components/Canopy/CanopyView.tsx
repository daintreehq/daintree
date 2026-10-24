import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import { Keyboard, RefreshCw } from "lucide-react";
import { formatWaitAge } from "@/lib/projectRowStatus";
import { Telescope } from "@/components/icons";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { latestUndoOnly, UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { pluralize } from "@/lib/pluralize";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { isMac } from "@/lib/platform";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { clientErrorCode } from "@/utils/clientAppError";
import {
  CANOPY_URGENT_PRIORITY,
  type CanopyReadMark,
  type CanopyScreenSearchTarget,
} from "@shared/types/ipc/canopy";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { CANOPY_SEEN_HEARTBEAT_MS, canopyViewIsWatched, reportCanopySeen } from "@/lib/canopySeen";
import {
  isProjectViewCached,
  subscribeProjectViewLifecycle,
  subscribeProjectViewObservability,
} from "@/lib/viewCacheState";
import { useOverlayClaim } from "@/hooks/useOverlayState";
import { useEffectiveCombo } from "@/hooks";
import { usePreferencesStore } from "@/store/preferencesStore";
import { AppDialog } from "@/components/ui/AppDialog";
import { consumePaletteFocusRestoreSuppression } from "@/components/ui/paletteFocusRestore";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { SearchField } from "@/components/ui/SearchField";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { systemClient } from "@/clients/systemClient";
import { useFrozenBackdrop } from "./useFrozenBackdrop";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Callout } from "@/components/ui/Callout";
import { buildPilotGroups, type PilotWorkspaceMeta } from "@/components/Pilot/pilotRows";
import {
  buildCanopyInbox,
  itemArchived,
  itemNeedsAttention,
  itemPriority,
  itemSubject,
  repliedAt,
  searchTerms,
  splitInbox,
  unmatchedTerms,
  type CanopyItem,
} from "./canopyModel";
import { CANOPY_REVEAL_MS, nextCanopyOrder } from "./canopyOrder";
import {
  CanopyCard,
  canopyCardDomId,
  type CanopyCardHandle,
  type CanopyCardHandlers,
  type CanopyPaneFocus,
} from "./CanopyCard";
import { CanopyRow } from "./CanopyRow";
import { CanopyRowMenu, type CanopyRowMenuActions } from "./CanopyRowMenu";
import { SectionBar } from "./CanopySectionBar";
import { CanopyStatusBar } from "./CanopyStatusBar";
import { CanopyPlace } from "./CanopyPlace";
import { CanopyPitch } from "./CanopyPitch";
import { CANOPY_BETA_TERMS, CANOPY_TITLE, CANOPY_WAITLIST_URL } from "./canopyTerms";
import { useListReorderMotion } from "./useListReorderMotion";
import {
  ALL_HOSTS_LABEL,
  CanopyHeaderCenter,
  CanopyHostPicker,
  useCanopyHostRows,
} from "./CanopyHostPicker";
import { CanopyHostOffer } from "./CanopyHostOffer";
import { useCanopyInboxData } from "./useCanopyInboxData";
import { useCanopyInboxOrder } from "./useCanopyInboxOrder";
import { useCanopyInboxSearch } from "./useCanopyInboxSearch";
import { useCanopyInboxFilters } from "./useCanopyInboxFilters";
import { useCanopyInboxFocus } from "./useCanopyInboxFocus";
import { useCanopyInboxUndo } from "./useCanopyInboxUndo";
import { useCanopyInboxActions } from "./useCanopyInboxActions";
import { placeOf } from "./canopyInboxPlace";
import { CanopyAssistantPane, CanopyAssistantRow } from "./CanopyAssistantList";
import {
  CANOPY_ROLE_FILTERS,
  assistantMatches,
  canopyAssistantId,
  buildAssistantItems,
  type CanopyAssistantItem,
  type CanopyRoleFilter,
} from "./canopyAssistants";
import { canopyAssistantDomId, openAssistantItem } from "./openAssistantItem";
import {
  hostsWithPartialWork,
  isWorkOf,
  workLinkLabel,
  workLinkOf,
  workLinksByRun,
} from "./canopyRelationships";
import { useAgentDirectory } from "@/hooks/useAgentDirectory";
import { useAssistantWork } from "@/hooks/useAssistantWork";
import { isFullAgentDirectory } from "@shared/types/agentDirectory";
import { CanopyBulkEnableDialog } from "./CanopyBulkEnableDialog";
import type { BulkTarget } from "@shared/utils/canopyBulkEnable";
import {
  canopyBulkTransport,
  ownCanopyApi,
  ownCanopyTerminalApi,
  remoteCanopyApi,
  remoteCanopyTerminalApi,
  useRemoteCanopies,
  useRemoteCanopy,
} from "./canopyHostSource";
import {
  allHostsKey,
  createAllHostsRoute,
  mergeHostReadings,
  parseAllHostsKey,
  type HostReading,
} from "./canopyAllHosts";
import { ALL_HOSTS_ID, canopyOwnHostId, type CanopyScope } from "@/store/canopyStore";
import { retryHostProjects, useHostProjectLists } from "@/components/Hosts/hostProjects";
import { describeHostMenuState, type HostMenuRow } from "@/components/Hosts/hostModel";
import { isNewWindowClick, switchToHost } from "@/components/Hosts/hostSwitching";
import type { HostId } from "@shared/types/remoteHosts";

interface HostIssue {
  hostId: HostId;
  text: string;
  action: string | null;
  act: (() => void) | null;
}

/** "3m ago", or "just now" — never "just now ago". */
function agoPhrase(sinceMs: number, nowMs: number): string {
  const age = formatWaitAge(sinceMs, nowMs);
  return age === "just now" ? age : `${age} ago`;
}

/**
 * ⌘↑/⌘↓ on macOS, Alt+↑/↓ elsewhere (Slack's channel switch): the agent above
 * or below, from anywhere in the panel. Ctrl+↑/↓ is not used off the Mac
 * because terminals send it to the program as its own key.
 */
function agentStepOf(event: KeyboardEvent<HTMLElement>): -1 | 1 | null {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
  // An input method's own keys: switching agents would unmount what it is composing in.
  if (event.nativeEvent.isComposing || event.keyCode === 229) return null;
  if (event.shiftKey) return null;
  const chord = isMac()
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.altKey && !event.ctrlKey && !event.metaKey;
  if (!chord) return null;
  return event.key === "ArrowUp" ? -1 : 1;
}

/** Where the keyboard is inside the pane: the reply composer, the live terminal, or neither. */
function paneFocusOf(element: Element | null): CanopyPaneFocus {
  if (!element) return null;
  if (element.closest("[data-canopy-detail] .cm-editor")) return "composer";
  if (element.closest("[data-canopy-detail] [data-canopy-terminal]")) return "terminal";
  return null;
}

const FEEDBACK_MAILTO = "mailto:greg@daintree.org?subject=Canopy%20beta%20feedback";

/** The beta's standing terms, said every time the inbox is open. */
function BetaNotice() {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-border-default px-4 py-2">
      <p className="flex min-w-0 flex-1 items-center gap-2 text-xs text-text-secondary">
        <Badge tone="warning" size="sm">
          Beta
        </Badge>
        <span className="min-w-0">{CANOPY_BETA_TERMS}</span>
      </p>
      <Button
        variant="link"
        size="xs"
        className="shrink-0"
        onClick={() => void systemClient.openExternal(FEEDBACK_MAILTO)}
      >
        Send feedback
      </Button>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => void systemClient.openExternal(CANOPY_WAITLIST_URL)}
      >
        Paid plan waitlist
      </Button>
    </div>
  );
}

/**
 * Hides Canopy from its offer. The panel closes as the hidden snapshot lands;
 * the toast says where it went and takes it back — unless Canopy was shown,
 * hidden again or turned on since, here or in another view, which stands.
 */
async function hideCanopy(): Promise<void> {
  const { applySnapshot } = useCanopyStore.getState();
  const hidden = await window.electron.canopy.setMode("hidden");
  applySnapshot(hidden);
  // The revision this hide left, as main counts them: an Undo applies only
  // while main still stands there.
  const revision = hidden.modeRevision ?? 0;
  notify({
    type: "success",
    title: "Canopy hidden",
    message: "Show it again from Settings > Canopy.",
    context: { eventKind: "settings" },
    priority: "high",
    transient: true,
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: "Undo",
      onClick: latestUndoOnly("canopy-hide", () => {
        if (useCanopyStore.getState().mode !== "hidden") return;
        window.electron.canopy.setMode("unset", revision).then(applySnapshot, () =>
          notify({
            type: "error",
            title: "Couldn't show Canopy",
            message: "Show it again from Settings > Canopy.",
            // Settings events default to the inbox alone; a failed Undo is seen now.
            priority: "high",
            context: { eventKind: "settings" },
            action: {
              label: "Open settings",
              onClick: () =>
                void actionService.dispatch(
                  "app.settings.openTab",
                  { tab: "canopy" },
                  { source: "user" }
                ),
            },
          })
        );
      }),
    },
  });
}

/**
 * Every agent across every project, read off its screen and ranked in one list
 * by what it needs from you: menus to answer, questions to reply to, finished
 * work to look at, and working agents gone a while without a look. Pilot's
 * population, with the words and the controls to act without leaving the panel.
 */
export function CanopyView() {
  const [bulkTargets, setBulkTargets] = useState<readonly BulkTarget[] | null>(null);
  // Frozen when the person opens it: hosts listed later are not in this run.
  const openBulk = useCallback((rows: readonly HostMenuRow[]) => {
    setBulkTargets(
      rows.map((row) => ({
        hostId: row.hostId,
        name: row.name,
        connected: row.connection === null || row.connection.status === "connected",
      }))
    );
  }, []);
  // The panel put away — closed, or its project view cached — takes the run with it.
  const panelOpen = useCanopyStore((s) => s.isOpen);
  useEffect(() => {
    if (!panelOpen) setBulkTargets(null);
  }, [panelOpen]);
  const transportFor = useCallback(
    (target: BulkTarget) =>
      canopyBulkTransport(target.hostId, {
        own: target.hostId === canopyOwnHostId(),
        keepOpen: () => {
          const { isOpen, hostId } = useCanopyStore.getState();
          return isOpen && target.hostId === hostId;
        },
      }),
    []
  );
  return (
    <>
      <CanopyPanel onEnableAll={openBulk} />
      <CanopyBulkEnableDialog
        isOpen={bulkTargets !== null}
        onClose={() => setBulkTargets(null)}
        targets={bulkTargets ?? NO_BULK_TARGETS}
        deps={{ transportFor }}
      />
    </>
  );
}

const NO_BULK_TARGETS: readonly BulkTarget[] = [];

function CanopyPanel({ onEnableAll }: { onEnableAll: (rows: readonly HostMenuRow[]) => void }) {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const close = useCanopyStore((s) => s.close);
  const activated = useCanopyStore((s) => s.snapshot?.activated ?? null);
  const applySnapshot = useCanopyStore((s) => s.applySnapshot);
  // Another host the panel shows, or null for the window's own.
  const hostId = useCanopyStore((s) => s.hostId);
  const setHostId = useCanopyStore((s) => s.setHostId);
  const allHosts = hostId === ALL_HOSTS_ID;
  const hostRows = useCanopyHostRows(hostId ?? canopyOwnHostId());
  const hostPicker = hostRows ? (
    <CanopyHostPicker
      rows={hostRows}
      onPick={setHostId}
      onEnableAll={() => onEnableAll(hostRows)}
      allHostsShown={allHosts}
      onPickAll={() => setHostId(ALL_HOSTS_ID)}
    />
  ) : null;
  // The host shown was removed, or hosts can't be shown here at all: the panel
  // goes back to the window's own host, and the picker says so.
  const hostListed =
    hostId === null || allHosts || (hostRows?.some((row) => row.hostId === hostId) ?? false);
  useEffect(() => {
    if (!hostListed) setHostId(null);
  }, [hostListed, setHostId]);
  useOverlayClaim("canopy", isOpen);
  const still = useFrozenBackdrop(isOpen);
  // A view put in the background — another project shown in its place — can
  // be seen by no one: an inbox left open there would acknowledge asks nobody
  // saw, keep its pages held back, and hold an agent's terminal at its size.
  useEffect(() => {
    if (!isOpen) return;
    // Already there: opened by a key while the panel's code loaded, and the
    // project switched away before it mounted.
    if (isProjectViewCached()) {
      close();
      return;
    }
    return subscribeProjectViewLifecycle((phase) => {
      if (phase === "cached") close();
    });
  }, [isOpen, close]);
  // What had the keyboard when the panel opened, kept here because the dialog
  // can be replaced while open (loading, then the offer or the inbox), and a
  // new one would take the old one's own content for its opener.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [isOpen]);
  const restoreOpener = useCallback(
    () => (openerRef.current?.isConnected ? openerRef.current : null),
    []
  );
  // A dialog replaced while the panel stays open — loading giving way to the
  // offer or the inbox, the offer to the inbox — hands the keyboard straight
  // to the one replacing it: back on the opener, even for the frames before
  // the next one places it, keys would reach a terminal behind the panel.
  const restoreOnReplace = useCallback(() => {
    if (useCanopyStore.getState().isOpen) {
      const successor = document.querySelector<HTMLElement>(
        '[data-testid="canopy-dialog"] [tabindex="-1"]'
      );
      if (successor?.isConnected) return successor;
    }
    return restoreOpener();
  }, [restoreOpener]);
  const loadingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen || activated !== null) return;
    const frame = requestAnimationFrame(() => {
      loadingRef.current?.focus({ preventScroll: true, focusVisible: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, activated]);

  // Main watches screens closely, and writes words, only while some view says
  // a panel is open on its host: another host's own Canopy does that for it.
  // All hosts reads this one too, and needs no host list to be of any use: with
  // no other host to join, it is this host alone.
  const readingAll = allHosts && hostRows !== null;
  const showingOwnHost = hostId === null || allHosts;
  useEffect(() => {
    if (!isOpen || !showingOwnHost) return;
    const unsubscribe = window.electron.canopy.onSnapshotUpdated(applySnapshot);
    safeFireAndForget(window.electron.canopy.setActive(true).then(applySnapshot));
    return () => {
      unsubscribe();
      safeFireAndForget(window.electron.canopy.setActive(false));
    };
  }, [isOpen, showingOwnHost, applySnapshot]);

  const backdrop =
    still === null ? undefined : (
      <img src={still} alt="" draggable={false} className="h-screen w-screen max-w-none" />
    );

  // Every host together: each host's own Canopy says whether it is on, inside
  // the inbox, and none is turned on by being listed.
  if (readingAll) {
    return (
      <CanopyInbox
        backdrop={backdrop}
        restoreOpener={restoreOnReplace}
        hostId={ALL_HOSTS_ID}
        hostRow={null}
        hostRows={hostRows}
        hostPicker={hostPicker}
      />
    );
  }

  // Another host: its own Canopy says whether it is on, inside the inbox.
  if (hostId !== null && !allHosts) {
    const hostRow = hostRows?.find((row) => row.hostId === hostId) ?? null;
    return (
      <CanopyInbox
        backdrop={backdrop}
        restoreOpener={restoreOnReplace}
        hostId={hostId}
        hostRow={hostRow}
        hostRows={null}
        hostPicker={hostPicker}
      />
    );
  }

  // Main hasn't said yet whether Canopy is on: neither the offer nor the
  // inbox, so neither flashes before the other replaces it.
  if (activated === null) {
    return (
      <AppDialog
        isOpen={isOpen}
        onClose={close}
        size="workspace"
        maxHeight="h-[min(90vh,1100px)]"
        // Nothing to land on yet, and Close is no place for a reflexive Enter.
        initialFocus="none"
        restoreFocusTo={restoreOnReplace}
        preferRestoreFocusTo
        backdrop={backdrop}
        data-testid="canopy-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<Telescope />}>{CANOPY_TITLE}</AppDialog.Title>
          <CanopyHeaderCenter>{hostPicker}</CanopyHeaderCenter>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        {/* The keyboard waits here, inside the dialog, rather than on
            whatever opened it — a terminal behind the scrim would take the
            keys — and not on Close, where a reflexive Enter would dismiss it. */}
        <div ref={loadingRef} tabIndex={-1} className="flex-1" aria-busy="true" />
      </AppDialog>
    );
  }

  // Until the user turns it on, Canopy is offered, not run: no list, no
  // terminals, and nothing read.
  if (activated === false) {
    return (
      <CanopyPitch
        isOpen={isOpen}
        onClose={close}
        backdrop={backdrop}
        onTurnOn={() => window.electron.canopy.setMode("on").then(applySnapshot)}
        onHide={hideCanopy}
        restoreFocusTo={restoreOnReplace}
        hostPicker={hostPicker}
      />
    );
  }
  return (
    <CanopyInbox
      backdrop={backdrop}
      restoreOpener={restoreOnReplace}
      hostId={null}
      hostRow={null}
      hostRows={null}
      hostPicker={hostPicker}
    />
  );
}

interface ShortcutRow {
  keys: string[];
  /** The keys are the two ends of a range, not alternatives. */
  range?: boolean;
  label: string;
}

/**
 * Every key the panel answers to, one press away instead of always on screen,
 * grouped by where the keyboard is: the pane's keys are the agent's.
 */
function CanopyShortcuts() {
  const step = isMac() ? "Cmd" : "Alt";
  // How to get here again: the user's own binding, and double-Shift while on.
  const toggle = useEffectiveCombo("canopy.toggle");
  // Close as the user has it bound, and only where it works: a chord can't
  // reach the pane, and off the Mac the terminal keeps Ctrl+W for the shell.
  const closeCombo = useEffectiveCombo("terminal.close");
  const paneClose = closeCombo !== undefined && !closeCombo.includes(" ") ? closeCombo : undefined;
  const doubleShift = usePreferencesStore((s) => s.doubleShiftOpensCanopy);
  const groups: Array<{ heading: string; rows: ShortcutRow[] }> = [
    {
      heading: "Anywhere",
      rows: [
        ...(toggle ? [{ keys: [toggle], label: "Open or close Canopy" }] : []),
        ...(doubleShift ? [{ keys: ["Shift"], label: "Twice quickly: open or close Canopy" }] : []),
      ],
    },
    {
      heading: "In the search",
      rows: [
        { keys: ["ArrowUp", "ArrowDown"], label: "Move" },
        { keys: ["Enter"], label: "Go to terminal" },
        { keys: ["Tab"], label: "Into the list, where the keys below act" },
        { keys: ["Escape"], label: "Clear the search, then close" },
      ],
    },
    {
      heading: "In the list",
      rows: [
        { keys: ["ArrowUp", "ArrowDown"], label: "Move" },
        { keys: ["J", "K"], label: "Move down or up" },
        { keys: ["Home", "End"], label: "First or last agent" },
        { keys: ["Enter"], label: "Go to terminal" },
        {
          keys: ["1", "9"],
          range: true,
          label: "Answer with that choice (twice when it's risky)",
        },
        { keys: ["Y"], label: "Take the first choice, when it's read as safe" },
        { keys: ["R"], label: "Reply" },
        { keys: ["E"], label: "Archive, or move back to the inbox" },
        { keys: ["F2"], label: "Rename" },
        { keys: ["U"], label: "Mark as read or unread" },
        { keys: ["Alt+U"], label: "Mark all as read" },
        { keys: ["Z"], label: "Undo" },
        { keys: ["Shift+F10"], label: "More actions" },
        { keys: ["/"], label: "Search" },
        { keys: ["Cmd+Backspace"], label: "Trash, pressed twice; Z takes it back" },
        { keys: ["Escape"], label: "Close" },
        ...(closeCombo ? [{ keys: [closeCombo], label: "Close Canopy" }] : []),
      ],
    },
    {
      heading: "In a reply or the terminal",
      rows: [
        { keys: [`${step}+ArrowUp`, `${step}+ArrowDown`], label: "Next agent" },
        { keys: ["Enter"], label: "In a reply: send, then move to the next agent" },
        { keys: ["Shift+Enter"], label: "New line in a reply" },
        { keys: ["Escape"], label: "Back to the list from a reply" },
        ...(paneClose
          ? [
              {
                keys: [paneClose],
                label: isMac() ? "Close Canopy" : "In a reply: close Canopy",
              },
            ]
          : []),
      ],
    },
  ];
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Keyboard shortcuts">
              <Keyboard />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Keyboard shortcuts</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" className="flex w-auto flex-col gap-3 p-3">
        {groups
          .filter((group) => group.rows.length > 0)
          .map((group) => (
            <section key={group.heading} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-text-primary">{group.heading}</h3>
              {/* One key column for every group, so the labels line up down the whole list. */}
              <dl className="grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-1.5 text-xs text-text-secondary">
                {group.rows.map((row) => (
                  <div key={row.label} className="contents">
                    <dt className="inline-flex items-center gap-1">
                      {row.keys.map((key, index) => (
                        <span key={key} className="inline-flex items-center gap-1">
                          {index > 0 && row.range && (
                            <>
                              <span aria-hidden="true">–</span>
                              <span className="sr-only">to</span>
                            </>
                          )}
                          <KbdChord shortcut={key} />
                        </span>
                      ))}
                    </dt>
                    <dd>{row.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        <p className="text-xs text-text-secondary">
          In the terminal, every other key goes to the agent, Esc included.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function CanopyInbox({
  backdrop,
  restoreOpener,
  hostId,
  hostRow,
  hostRows,
  hostPicker,
}: {
  backdrop: React.ReactNode;
  /** What had the keyboard when the panel opened, while it is still there. */
  restoreOpener: () => HTMLElement | null;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  /** That host as the host menu draws it, while it is in the host list. */
  hostRow: HostMenuRow | null;
  /** The hosts read together when `hostId` is All hosts. */
  hostRows: readonly HostMenuRow[] | null;
  hostPicker: React.ReactNode;
}) {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const close = useCanopyStore((s) => s.close);
  const {
    otherHost,
    everyHost,
    ownHostId,
    hostName,
    remote,
    remotes,
    participants,
    api,
    terminalApi,
    readings,
    canopy,
    fleet,
    projects,
    storedScope,
    setScope,
    scope,
    recoveries,
    nowMs,
    baseItems,
  } = useCanopyInboxData({ isOpen, hostId, hostRow, hostRows });

  const {
    items,
    inbox,
    owedOnOpen,
    revealed,
    refreshedAt,
    bodyRef,
    enterList,
    leaveList,
    listHidden,
    menuOpenChanged,
    requestRank,
  } = useCanopyInboxOrder({ isOpen, hostId, otherHost, scope, canopy, baseItems, nowMs });
  const { query, setQuery, appliedQuery, terms, searching, searchKey, screenAsk, onScreen } =
    useCanopyInboxSearch({ isOpen, hostId, items, api, refreshedAt });
  const {
    roleFilter,
    setRoleFilter,
    workersShown,
    assistantsShown,
    assistantsReadable,
    directory,
    seeAssistantHandback,
    assistantItems,
    assistantAsks,
    workOf,
    showWorkOf,
    workPartial,
    workLabelOf,
    shownAssistants,
    showWork,
    inWork,
    shownInbox,
    unreadOnly,
    setUnreadOnly,
    listed,
    archivedExpanded,
    setArchivedExpanded,
    archivedShown,
    visible,
    listRef,
    onlyReadMatch,
  } = useCanopyInboxFilters({
    isOpen,
    hostId,
    otherHost,
    everyHost,
    ownHostId,
    hostRows,
    hasHostPicker: hostPicker !== null,
    participants,
    projects,
    storedScope,
    scope,
    setScope,
    api,
    recoveries,
    fleet,
    inbox,
    query,
    appliedQuery,
    terms,
    searching,
    searchKey,
    screenAsk,
    onScreen,
    listHidden,
  });
  const {
    searchRef,
    refreshRef,
    detailRef,
    focusedIndex,
    activeIndex,
    focusedItem,
    paneFocus,
    assistantRefusal,
    selectedAssistant,
    selectNow,
    focusCardNow,
    openPaneNow,
    selectRow,
    selectAssistant,
    focusAssistantNow,
    openAssistant,
    settlePaneFocus,
    nextAfter,
    leavePane,
    showsHost,
    isSelected,
    captureFocusAfterClose,
    focusAfterClose,
  } = useCanopyInboxFocus({
    isOpen,
    close,
    hostId,
    ownHostId,
    otherHost,
    everyHost,
    items,
    listed,
    visible,
    workersShown,
    shownAssistants,
    inWork,
    searching,
    appliedQuery,
    setQuery,
    roleFilter,
    seeAssistantHandback,
  });

  const { reserveUndo, undoReads } = useCanopyInboxUndo({ hostId, api });
  const {
    readNow,
    handlers,
    toggleRead,
    markAllRead,
    askRename,
    rowMenu,
    trashArm,
    renameAsk,
    refreshes,
    refresh,
  } = useCanopyInboxActions({
    hostId,
    ownHostId,
    close,
    api,
    terminalApi,
    listed,
    focusedItem,
    searchRef,
    detailRef,
    selectNow,
    focusCardNow,
    openPaneNow,
    nextAfter,
    leavePane,
    showsHost,
    isSelected,
    captureFocusAfterClose,
    reserveUndo,
    undoReads,
    menuOpenChanged,
    requestRank,
  });

  // The host a selected run is on, for the pane beside it; null for the window's own.
  const focusedHostId = focusedItem ? placeOf(focusedItem, hostId, ownHostId).hostId : null;

  const focusedRow =
    everyHost && focusedHostId !== null
      ? (hostRows ?? []).find((row) => row.hostId === focusedHostId)
      : undefined;
  const focusedLinkStatus =
    focusedRow?.isLocal === false ? focusedRow.connection?.status : undefined;

  // Each group is its own Tab stop: the selected row when it is in the group,
  // else the group's first.
  const tabStop = (group: readonly CanopyItem[], item: CanopyItem, index: number) =>
    focusedItem !== null && group.some((run) => run.runId === focusedItem.runId)
      ? focusedItem.runId === item.runId
      : index === 0;
  // The assistant list's own keys: its rows walk among themselves, and step
  // off either end into the worker list around them, or back to the search.
  const onAssistantKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const last = shownAssistants.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") {
      if (index === last && archivedShown && shownInbox.archived.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        focusCardNow(shownInbox.archived[0]!.runId);
        return;
      }
      next = Math.min(last, index + 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      if (index === 0) {
        event.preventDefault();
        event.stopPropagation();
        if (listed.length > 0) focusCardNow(listed[listed.length - 1]!.runId);
        else searchRef.current?.focus();
        return;
      }
      next = index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    } else if (event.key === "/") {
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      openAssistant(shownAssistants[index]!);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    focusAssistantNow(shownAssistants[next]!.id);
  };

  // ⌘↑/⌘↓ from anywhere in the panel, the live terminal and the composer
  // included: taken in the capture phase, before xterm or CodeMirror can, so
  // the user can work down the list — reply, next, reply — without leaving the
  // keyboard where it is. The keyboard lands in the same place on the next run.
  const onAgentStepKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    const step = agentStepOf(event);
    if (step === null || visible.length === 0) return;
    // Renaming: ⌘↑/↓ move the caret in the name, not to another agent.
    if (event.target instanceof Element && event.target.closest("[data-canopy-rename]")) return;
    event.preventDefault();
    event.stopPropagation();
    // From the open run, clamped at the ends rather than wrapping: the bottom
    // of the list is the end of it. An open run that is not in the list
    // (archived and folded away) steps onto the list's first or last row.
    const current = visible.findIndex((item) => item.runId === focusedItem?.runId);
    const next =
      current === -1
        ? visible[step > 0 ? 0 : visible.length - 1]!
        : visible[Math.min(visible.length - 1, Math.max(0, current + step))]!;
    if (next.runId === focusedItem?.runId) return;
    const focus = paneFocusOf(document.activeElement);
    // From the search the selection moves and the keyboard stays to type.
    if (event.target === searchRef.current) selectNow(next.runId);
    else if (focus === null) focusCardNow(next.runId);
    else openPaneNow(next.runId, focus);
  };

  // On the list's own wrapper rather than the palette body: the body only acts
  // on keys aimed at itself, and here focus is always on a card or its controls.
  const onNavigationKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (visible.length === 0) return;
    // Only from a row of the list: the pane holds a live terminal and a
    // composer whose keys belong to the agent, and the fold owns its own keys.
    if (!(event.target instanceof Element) || !event.target.closest("[data-canopy-card]")) return;
    // Shift+F10 or the Menu key: the selected row's menu, as a right-click
    // opens it. Replayed as a contextmenu on the row, since the menu has no
    // way to be opened by hand, and macOS sends none for these keys itself.
    if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)
    ) {
      const row = visible[activeIndex]
        ? document.getElementById(canopyCardDomId(visible[activeIndex]!.runId))
        : null;
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 8,
          clientY: rect.top + rect.height / 2,
        })
      );
      return;
    }
    // The selected run's own chords (Trash is ⌘⌫) go to it before the
    // modifier guard below, which keeps app shortcuts out of plain navigation.
    if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
      if (detailRef.current?.handleKey(event)) return;
    }
    // ⌥U marks every unread run listed read. By the key's place, not its
    // character: on a Mac ⌥U is the umlaut dead key and types no "u".
    if (event.code === "KeyU" && event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (!event.repeat) markAllRead();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // The assistants sit between the inbox and the archived runs: down off the
    // inbox's end, or up off the archived runs' top, steps into them.
    if (shownAssistants.length > 0 && focusedIndex !== -1) {
      const down = event.key === "ArrowDown" || event.key === "j";
      const up = event.key === "ArrowUp" || event.key === "k";
      if ((down && focusedIndex === listed.length - 1) || (up && focusedIndex === listed.length)) {
        event.preventDefault();
        focusAssistantNow(shownAssistants[down ? 0 : shownAssistants.length - 1]!.id);
        return;
      }
    }
    // Back to the search: "/" from any row, or up off the top of the list.
    const search = searchRef.current;
    if (search && (event.key === "/" || (event.key === "ArrowUp" && activeIndex === 0))) {
      event.preventDefault();
      search.focus();
      if (event.key === "/") search.select();
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") {
      next = Math.min(visible.length - 1, activeIndex + 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      next = Math.max(0, activeIndex - 1);
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = visible.length - 1;
    }
    if (next !== null) {
      event.preventDefault();
      focusCardNow(visible[next]!.runId);
      return;
    }
    // Keys aimed at the list's selected row act on the selected agent.
    const selected = visible[activeIndex];
    if (!selected) return;
    if (event.key === "Enter") {
      event.preventDefault();
      handlers.onOpen(selected);
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      askRename(selected);
      return;
    }
    if ((event.key === "u" || event.key === "U") && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) toggleRead(selected);
      return;
    }
    detailRef.current?.handleKey(event);
  };

  // The search keeps every plain key for its text; only the list's moves, Go to
  // terminal and the modifier chords act from it, on the selected run. Tab takes
  // the keyboard down to that run's row, where the one-key actions are.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The IME owns the key: nothing of the search's or the panel's acts on it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    // An assistant in the pane, or no worker row ahead of the assistants: the
    // keys go to the assistant, never to a worker the person can't see.
    const toAssistant =
      selectedAssistant ??
      (listed.length === 0 && shownAssistants.length > 0 ? shownAssistants[0]! : null);
    if (plain && toAssistant !== null) {
      const target = toAssistant;
      if (event.key === "Tab" || (event.key === "ArrowDown" && listed.length === 0)) {
        event.preventDefault();
        event.stopPropagation();
        focusAssistantNow(target.id);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openAssistant(target);
        return;
      }
    }
    const selected = focusedIndex !== -1 ? visible[focusedIndex]! : (visible[0] ?? null);
    if (plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      if (visible.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      selectNow(visible[Math.min(visible.length - 1, Math.max(0, activeIndex + step))]!.runId);
      return;
    }
    if (plain && event.key === "Enter") {
      if (!selected) return;
      event.preventDefault();
      handlers.onOpen(selected);
      return;
    }
    if (plain && event.key === "Tab") {
      if (!selected) return;
      event.preventDefault();
      // The dialog's own Tab wrap must not take the keyboard on from the row.
      event.stopPropagation();
      focusCardNow(selected.runId);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
      if (selected?.runId === focusedItem?.runId) detailRef.current?.handleKey(event);
      return;
    }
    if (event.code === "KeyU" && event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (!event.repeat) markAllRead();
    }
  };

  // Over the whole inbox, whatever the filter shows: a read approval still blocks its agent.
  const needsYou = inbox.inbox.filter(itemNeedsAttention).length;

  const unreadCount = inbox.inbox.filter((item) => item.unread).length;
  // The section bar speaks for what the search shows; the header keeps the whole inbox.
  const shownUnreadCount = shownInbox.inbox.filter((item) => item.unread).length;
  const listedUnread = listed.some((item) => item.unread);

  // Another host the panel can't read right now: why, in the host menu's own
  // words, with nothing of another host's put in its place.
  const linkWords = otherHost && hostRow ? describeHostMenuState(hostRow) : null;
  const linkStatus = hostRow?.isLocal === false ? hostRow.connection?.status : undefined;
  // Picking a host that isn't connected dials it: its first read is refused
  // while the link comes up, which is connecting, not trouble.
  const connecting =
    linkStatus === "connecting" ||
    (linkStatus === "disconnected" && clientErrorCode(remote.error) === "HOST_DISCONNECTED");
  // The link dropped after the agents were read: what is listed is what it last showed.
  const linkDown = fleet !== null && linkStatus !== undefined && linkStatus !== "connected";
  // Connecting stays quiet only until there are rows: rows kept from before say they are old.
  const hostTrouble =
    otherHost && (remote.error !== null || linkDown) && !(connecting && fleet === null);
  // Canopy is off on that host: its own offer, for it alone.
  const hostOffer = otherHost && canopy?.activated === false;

  // What the panel can say about another host before it has its agents.
  const hostSummary =
    hostTrouble && fleet === null
      ? `Can't reach ${hostName}`
      : otherHost && fleet === null && connecting
        ? `Connecting to ${hostName}…`
        : hostOffer
          ? `Canopy is off on ${hostName}`
          : null;
  const summaryLine =
    fleet === null
      ? "Reading agents…"
      : fleet.degraded && items.length === 0
        ? "Can't tell who needs you right now"
        : items.length === 0
          ? scope === "project" && fleet.runs.length > 0
            ? "No agents in this project"
            : "No agents are running"
          : // What needs you leads; what is new follows. The list's own heading
            // counts the agents.
            [
              needsYou > 0
                ? `${pluralize(needsYou, "agent")} ${needsYou === 1 ? "needs" : "need"} you`
                : // "Nothing" is a conclusion: qualified while some screens
                  // can't be read at all, withheld while Daintree can't see its
                  // agents, and held back while any run in the inbox has yet to
                  // be read at all — readings owed, a retry waiting, however
                  // long they take, and after a scope switch too.
                  (canopy?.lastError ?? null) !== null
                  ? "Nothing needs you that Canopy could read"
                  : fleet.degraded
                    ? "Can't tell who needs you right now"
                    : owedOnOpen ||
                        canopy?.waiting !== undefined ||
                        (canopy?.busy === true && inbox.inbox.some((item) => item.card === null))
                      ? "Checking who needs you…"
                      : // A screen that can't be read yet (starting, hibernating)
                        // has no reading at all: nothing is concluded about it.
                        inbox.inbox.some((item) => item.card === null)
                        ? "Not every agent could be read yet"
                        : "Nothing needs you",
              unreadCount > 0 ? `${unreadCount.toLocaleString()} unread` : null,
            ]
              .filter(Boolean)
              .join(" · ");

  // Each host in All hosts says for itself why it can't be read; the list says so too.
  const hostIssues = useMemo((): HostIssue[] => {
    if (!everyHost) return [];
    return readings.flatMap((reading): HostIssue[] => {
      const row = (hostRows ?? []).find((candidate) => candidate.hostId === reading.hostId);
      const name = row?.name ?? "This Mac";
      const remoteHost = reading.hostId !== ownHostId;
      if (reading.error !== null && remoteHost) {
        return [
          {
            hostId: reading.hostId,
            text: `Can't reach ${name}`,
            action: "Retry",
            act: () => remotes.retry(reading.hostId),
          },
        ];
      }
      // A host not heard in full says nothing yet: no conclusion is drawn about it.
      if (reading.canopy === null || reading.fleet === null) {
        return [
          {
            hostId: reading.hostId,
            text: remoteHost ? `Connecting to ${name}…` : `Reading ${name}…`,
            action: null,
            act: null,
          },
        ];
      }
      if (!reading.canopy.activated) {
        return [
          {
            hostId: reading.hostId,
            text: `Canopy is off on ${name}`,
            action: "Set up",
            act: () => useCanopyStore.getState().setHostId(reading.hostId),
          },
        ];
      }
      const linkStatus = remoteHost && row?.isLocal === false ? row.connection?.status : undefined;
      if (linkStatus !== undefined && linkStatus !== "connected") {
        return [
          {
            hostId: reading.hostId,
            text: `${name} isn't connected. Its agents are as last seen`,
            action: "Retry",
            act: () => remotes.retry(reading.hostId),
          },
        ];
      }
      if (reading.canopy.lastError) {
        return [
          {
            hostId: reading.hostId,
            text: `Canopy couldn't read every agent on ${name}`,
            action: null,
            act: null,
          },
        ];
      }
      return [];
    });
  }, [everyHost, readings, hostRows, ownHostId, remotes]);
  const retryingSomewhere =
    everyHost &&
    readings.some((reading) => reading.canopy?.activated === true && reading.canopy.waiting);
  const headerWords =
    hostSummary ??
    (needsYou === 0 && fleet !== null && hostIssues.length > 0
      ? "Not every host could be read"
      : needsYou === 0 && fleet !== null && retryingSomewhere
        ? "Checking who needs you…"
        : summaryLine);

  // With assistants to list, or only assistants asked for, the list shows
  // even when no worker runs.
  // The relationship filter keeps the list, and its banner, up even with nothing in it.
  const listsAssistants =
    (assistantsShown && (assistantItems.length > 0 || !workersShown)) || workOf !== null;
  const assistantsEmpty: string | null = !assistantsReadable
    ? `Assistants on ${hostName} can't be listed from this window yet.`
    : workOf !== null
      ? directory !== null && isFullAgentDirectory(directory)
        ? "This assistant isn't running any more."
        : null
      : directory === null
        ? null
        : searching
          ? `No assistant matches “${appliedQuery.trim()}”.`
          : !isFullAgentDirectory(directory)
            ? "Daintree couldn't list every assistant just now."
            : scope === "project"
              ? "No assistant is running in this project."
              : "No assistant is running. Start one from the Assistant panel.";

  const headerControls = (
    <>
      <SegmentedRadioGroup<CanopyRoleFilter>
        aria-label="Roles to show"
        density="compact"
        className="mr-3"
        value={roleFilter}
        onChange={setRoleFilter}
        testId="canopy-role-filter"
        options={CANOPY_ROLE_FILTERS.map((filter) =>
          filter.id === "assistants" && assistantAsks > 0
            ? {
                value: filter.id,
                label: filter.label,
                ariaLabel: `${filter.label}, ${assistantAsks} asking for you`,
                trailing: <span className="tabular-nums">{assistantAsks}</span>,
              }
            : { value: filter.id, label: filter.label }
        )}
      />
      {!otherHost && (
        <SegmentedRadioGroup<"all" | "project">
          aria-label="Agents to show"
          density="compact"
          className="mr-3"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All projects" },
            { value: "project", label: "This project" },
          ]}
        />
      )}
      <CanopyShortcuts />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={refreshRef}
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh"
            aria-busy={refreshes > 0 || undefined}
            disabled={canopy === null}
            onClick={refresh}
          >
            <SpinningIcon icon={RefreshCw} active={refreshes > 0} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Refresh</TooltipContent>
      </Tooltip>
      <AppDialog.CloseButton />
    </>
  );

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={close}
      size="workspace"
      maxHeight="h-[min(90vh,1100px)]"
      // The panel lands on its first run itself, two frames in; the dialog's own
      // first-control focus would race it. With no rows to land on, the first
      // control takes focus instead of leaving it on whatever opened the panel.
      initialFocus={items.length > 0 && !hostOffer ? "none" : "first"}
      restoreFocusTo={() => focusAfterClose() ?? restoreOpener()}
      preferRestoreFocusTo
      backdrop={backdrop}
      data-testid="canopy-dialog"
    >
      <AppDialog.Header>
        {hostPicker ? (
          // Three parts, the outer two sharing what is left, so the picker
          // stands in the middle of the header.
          <>
            <span className="flex min-w-0 flex-1 basis-0 items-center">
              <AppDialog.Title icon={<Telescope />}>{CANOPY_TITLE}</AppDialog.Title>
              <span className="mx-3 min-w-0 flex-1 truncate text-sm text-text-secondary">
                {headerWords}
              </span>
            </span>
            {hostPicker}
            <span className="ml-3 flex min-w-0 flex-1 basis-0 items-center justify-end">
              {headerControls}
            </span>
          </>
        ) : (
          <>
            <AppDialog.Title icon={<Telescope />}>{CANOPY_TITLE}</AppDialog.Title>
            <span className="mr-3 ml-3 min-w-0 flex-1 truncate text-sm text-text-secondary">
              {headerWords}
            </span>
            {headerControls}
          </>
        )}
      </AppDialog.Header>

      <div
        ref={bodyRef}
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onAgentStepKeyDownCapture}
        onKeyDown={onNavigationKeyDown}
      >
        {canopy?.tier === "free" && <BetaNotice />}
        {hostTrouble && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-border-default p-3">
            <Callout
              severity="warning"
              size="compact"
              title={connecting ? `Reconnecting to ${hostName}…` : `Can't reach ${hostName}`}
              action={
                <Button variant="outline" size="xs" onClick={remote.retry}>
                  Retry
                </Button>
              }
            >
              {connecting
                ? ""
                : linkWords?.state && linkWords.state !== "Connected"
                  ? [linkWords.state, linkWords.note].filter(Boolean).join(". ") + "."
                  : formatErrorMessage(remote.error, `${hostName} didn't answer.`)}{" "}
              {fleet !== null
                ? "These are the agents it last showed."
                : "Its agents show here once it answers."}
            </Callout>
          </div>
        )}
        {everyHost && hostIssues.length > 0 && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-border-default p-3">
            <Callout severity="warning" size="compact" title="Not every host is being read">
              <ul className="flex flex-col gap-1.5">
                {hostIssues.map((issue) => (
                  <li key={issue.hostId} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{issue.text}</span>
                    {issue.act && (
                      <Button variant="outline" size="xs" onClick={issue.act}>
                        {issue.action}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Callout>
          </div>
        )}
        {otherHost && fleet === null && !hostTrouble && connecting && (
          <p className="flex flex-1 items-center justify-center text-sm text-text-secondary">
            Connecting to {hostName}…
          </p>
        )}
        {hostOffer && (
          <CanopyHostOffer
            hostName={hostName}
            onTurnOn={async () => {
              // Hidden there, it can't be turned on until it is shown again:
              // the press here, on an offer naming the host, is the user's ask for both.
              if (canopy?.mode === "hidden") await api.setMode("unset");
              await api.setMode("on");
              // Read it again only while it is still the host shown.
              if (useCanopyStore.getState().hostId === hostId) remote.retry();
            }}
          />
        )}
        {!hostOffer && (fleet?.degraded === true || canopy?.lastError) && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-border-default p-3">
            {/* Daintree can't see its agents right now: the rows are the last
                it saw, and nothing is read until it can again. */}
            {fleet?.degraded === true && (
              <Callout severity="warning" size="compact" title="Agent status is unavailable">
                {fleet.lastSuccessfulAt !== null
                  ? `These are the agents Daintree saw ${agoPhrase(fleet.lastSuccessfulAt, nowMs)}. Canopy reads them again once it can.`
                  : "Daintree hasn't been able to list its agents yet. Canopy reads them once it can."}
              </Callout>
            )}
            {canopy?.lastError && (
              <Callout
                severity="warning"
                size="compact"
                title="Canopy couldn't read some screens"
                action={
                  <Button variant="outline" size="xs" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {canopy.lastError} Rows marked “Read failed” keep what was read before, and Canopy
                keeps trying.
              </Callout>
            )}
          </div>
        )}
        {!hostOffer && (items.length > 0 || listsAssistants) && (
          // An inbox: what needs you down a sidebar, most urgent first, the rest
          // folded away beneath it, and the selected agent's own terminal beside
          // it, drawn as its pane.
          <div className="flex min-h-0 flex-1">
            <div className="canopy-inbox-column flex min-h-0 w-[28rem] shrink-0 flex-col self-stretch border-r border-border-default">
              <div className="shrink-0 px-3 pt-3 pb-1">
                <SearchField
                  size="compact"
                  focusedOnOpen
                  inputRef={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onClear={() => setQuery("")}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Search agents and their terminals"
                  aria-label="Search agents"
                  role="combobox"
                  aria-expanded={visible.length > 0}
                  aria-controls={
                    [
                      listed.length > 0 ? "canopy-inbox-list" : null,
                      shownAssistants.length > 0 ? "canopy-assistants" : null,
                      archivedShown && shownInbox.archived.length > 0 ? "canopy-archived" : null,
                    ]
                      .filter((id) => id !== null)
                      .join(" ") || undefined
                  }
                  aria-autocomplete="list"
                  aria-activedescendant={
                    focusedItem && visible.includes(focusedItem)
                      ? canopyCardDomId(focusedItem.runId)
                      : undefined
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div
                className="canopy-inbox flex min-h-0 flex-1 flex-col overflow-y-auto select-none"
                data-canopy-list=""
                // Its rows have menus of their own: the app's Shift+F10 stands down here.
                data-row-menu=""
                // Still placing runs as the open's readings land.
                data-revealing={revealed ? undefined : "true"}
              >
                {workOf !== null && (
                  <div
                    className="flex shrink-0 items-center gap-2 px-3 py-2 text-xs"
                    data-testid="canopy-work-of"
                  >
                    <span className="min-w-0 flex-1 text-text-primary">
                      Showing the work of {workOf.name}
                      {workPartial && (
                        <span className="text-text-secondary">
                          {" "}
                          · Some hosts couldn't be read, so this may be incomplete
                        </span>
                      )}
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={(event) => {
                        // The button leaves with the banner: the keyboard stays in the
                        // panel, on the search unless the whole list leaves with it.
                        const listStays =
                          items.length > 0 ||
                          (assistantsShown && (assistantItems.length > 0 || !workersShown));
                        (listStays ? searchRef : refreshRef).current?.focus({
                          preventScroll: true,
                          focusVisible: event.detail === 0,
                        });
                        showWorkOf(null);
                      }}
                    >
                      Show all
                    </Button>
                  </div>
                )}
                {workersShown && (
                  <>
                    <SectionBar
                      id="canopy-inbox-label"
                      label="Inbox"
                      count={listed.length}
                      trailing={
                        // The last button's padding hangs into the bar's own, so its
                        // words end on the field's right edge and the rows' meters.
                        <span className="-mr-2.5 flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="xs"
                            pressed={unreadOnly}
                            onClick={() => setUnreadOnly(!unreadOnly)}
                          >
                            Unread
                            {shownUnreadCount > 0 && (
                              <span className="tabular-nums">{shownUnreadCount}</span>
                            )}
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="xs"
                                disabled={!listedUnread}
                                onClick={markAllRead}
                              >
                                Mark all read
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom">
                              <KbdChord shortcut="Alt+U" />
                            </TooltipContent>
                          </Tooltip>
                        </span>
                      }
                    />
                    {listed.length > 0 ? (
                      <div
                        ref={listRef}
                        id="canopy-inbox-list"
                        role="listbox"
                        aria-labelledby="canopy-inbox-label"
                        onPointerEnter={(event) => enterList(event.pointerType)}
                        onPointerLeave={leaveList}
                      >
                        {listed.map((item, index) => {
                          const replied = repliedAt(item);
                          return (
                            <CanopyRowMenu key={item.runId} item={item} {...rowMenu}>
                              <CanopyRow
                                item={item}
                                domId={canopyCardDomId(item.runId)}
                                isSelected={focusedItem?.runId === item.runId}
                                // Words are coming whenever screens are read, so the slot
                                // for them is held from the start.
                                reserveDetail
                                tabbable={tabStop(listed, item, index)}
                                unread={item.unread}
                                nowMs={nowMs}
                                asideLabel={
                                  replied !== null ? `Replied ${agoPhrase(replied, nowMs)}` : null
                                }
                                workLabel={workLabelOf(item)}
                                onSelect={() => selectRow(item.runId)}
                                onClick={() => readNow(item)}
                                onOpen={(event) => handlers.onOpen(item, isNewWindowClick(event))}
                                onArchive={() => handlers.onArchive(item)}
                              />
                            </CanopyRowMenu>
                          );
                        })}
                      </div>
                    ) : (searching || workOf !== null) &&
                      shownInbox.inbox.length === 0 &&
                      shownInbox.archived.length > 0 ? null : (
                      // A search whose only matches are archived lets their bar below say so.
                      <p className="px-3 pb-3 text-xs text-text-secondary">
                        {searching
                          ? shownInbox.inbox.length > 0
                            ? `Nothing unread matches “${appliedQuery.trim()}”.`
                            : `Nothing matches “${appliedQuery.trim()}”.`
                          : workOf !== null
                            ? workPartial
                              ? "None found on the hosts that could be read."
                              : "No worker in the inbox was started by or handed to this assistant."
                            : unreadOnly && inbox.inbox.length > 0
                              ? "Nothing unread. Each agent shows here again when it does something new."
                              : "Every agent is archived. Each comes back when it has something new to say."}
                      </p>
                    )}
                  </>
                )}
                {assistantsShown && (
                  <>
                    <SectionBar
                      id="canopy-assistants-label"
                      label="Assistants"
                      count={shownAssistants.length}
                      countNoun="assistant"
                    />
                    {shownAssistants.length > 0 ? (
                      <div
                        id="canopy-assistants"
                        role="listbox"
                        aria-labelledby="canopy-assistants-label"
                      >
                        {shownAssistants.map((item, index) => (
                          <CanopyAssistantRow
                            key={item.id}
                            item={item}
                            isSelected={selectedAssistant?.id === item.id}
                            tabbable={
                              selectedAssistant !== null
                                ? selectedAssistant.id === item.id
                                : index === 0
                            }
                            onSelect={() => selectAssistant(item.id)}
                            onOpen={() => openAssistant(item)}
                            onKeyDown={(event) => onAssistantKeyDown(event, index)}
                          />
                        ))}
                      </div>
                    ) : (
                      assistantsEmpty !== null && (
                        <p className="px-3 pb-3 text-xs text-text-secondary">{assistantsEmpty}</p>
                      )
                    )}
                  </>
                )}
                {shownInbox.archived.length > 0 && (
                  <>
                    <SectionBar
                      id="canopy-archived-label"
                      label="Archived"
                      count={shownInbox.archived.length}
                      // A search shows its archived matches open; the fold is the user's again after.
                      fold={
                        searching
                          ? undefined
                          : {
                              expanded: archivedExpanded,
                              controls: "canopy-archived",
                              onToggle: () => setArchivedExpanded(!archivedExpanded),
                              onEnter: () => focusCardNow(shownInbox.archived[0]!.runId),
                            }
                      }
                    />
                    {archivedShown && (
                      <div
                        id="canopy-archived"
                        role="listbox"
                        aria-labelledby="canopy-archived-label"
                      >
                        {shownInbox.archived.map((item, index) => (
                          <CanopyRowMenu key={item.runId} item={item} {...rowMenu}>
                            <CanopyRow
                              item={item}
                              domId={canopyCardDomId(item.runId)}
                              isSelected={focusedItem?.runId === item.runId}
                              reserveDetail={false}
                              tabbable={tabStop(shownInbox.archived, item, index)}
                              unread={false}
                              compact
                              nowMs={nowMs}
                              asideLabel={
                                item.disposition
                                  ? `Archived ${agoPhrase(item.disposition.at, nowMs)}`
                                  : null
                              }
                              workLabel={workLabelOf(item)}
                              onSelect={() => selectRow(item.runId)}
                              onClick={() => readNow(item)}
                              onOpen={(event) => handlers.onOpen(item, isNewWindowClick(event))}
                              onArchive={() => handlers.onArchive(item)}
                            />
                          </CanopyRowMenu>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              <CanopyStatusBar link={canopy?.link} waiting={canopy?.waiting} />
            </div>
            {/* Inset on every side: the top one puts the place line level with the
                search beside it, and the card's top with the Inbox bar's. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-canvas p-2">
              {selectedAssistant !== null ? (
                <CanopyAssistantPane
                  key={selectedAssistant.id}
                  item={selectedAssistant}
                  refusal={
                    assistantRefusal?.id === selectedAssistant.id ? assistantRefusal.text : null
                  }
                  onOpen={() => openAssistant(selectedAssistant)}
                  showingWork={workOf?.assistantId === selectedAssistant.id}
                  onShowWork={() => showWork(selectedAssistant)}
                />
              ) : (
                <>
                  {focusedItem && (
                    <CanopyPlace
                      item={focusedItem}
                      id={`canopy-place-${focusedItem.runId}`}
                      hostId={everyHost ? (focusedHostId ?? "") : (hostId ?? "")}
                      runBranch={api.runBranch}
                    />
                  )}
                  {focusedItem ? (
                    <CanopyCard
                      key={`${hostId ?? ""}:${focusedItem.runId}`}
                      ref={detailRef}
                      item={focusedItem}
                      domId={`canopy-detail-${focusedItem.runId}`}
                      describedBy={`canopy-place-${focusedItem.runId}`}
                      initialFocus={paneFocus?.runId === focusedItem.runId ? paneFocus.focus : null}
                      armTrash={
                        trashArm?.runId === focusedItem.runId ? trashArm.request : undefined
                      }
                      renameRequest={
                        renameAsk?.runId === focusedItem.runId ? renameAsk.request : undefined
                      }
                      onInitialFocusSettled={() => settlePaneFocus(focusedItem.runId)}
                      otherHostId={(everyHost ? focusedHostId : hostId) ?? undefined}
                      terminalApi={terminalApi}
                      reconnecting={
                        everyHost
                          ? focusedLinkStatus !== undefined && focusedLinkStatus !== "connected"
                          : otherHost && linkStatus !== undefined && linkStatus !== "connected"
                      }
                      {...handlers}
                    />
                  ) : (
                    <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
                      {!workersShown ? (
                        <>
                          <p className="text-sm text-text-primary">No assistant to show</p>
                          <p className="text-xs text-text-secondary">
                            Start one from the Assistant panel and it shows up here.
                          </p>
                        </>
                      ) : onlyReadMatch ? (
                        <>
                          <p className="text-sm text-text-primary">No unread agent matches</p>
                          <p className="text-xs text-text-secondary">
                            Turn off Unread to see every agent that matches.
                          </p>
                        </>
                      ) : searching ? (
                        <>
                          <p className="text-sm text-text-primary">No agent matches</p>
                          <p className="text-xs text-text-secondary">
                            Try other words, or press Esc to clear the search.
                          </p>
                        </>
                      ) : unreadOnly && inbox.inbox.length > 0 ? (
                        <>
                          <p className="text-sm text-text-primary">Nothing unread</p>
                          <p className="text-xs text-text-secondary">
                            Turn off Unread to see every agent's terminal here.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm text-text-primary">Nothing in the inbox</p>
                          <p className="text-xs text-text-secondary">
                            Open an archived agent to see its terminal here.
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {!hostOffer &&
          fleet !== null &&
          !fleet.degraded &&
          items.length === 0 &&
          !listsAssistants && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              {scope === "project" && fleet.runs.length > 0 ? (
                <>
                  <p className="text-sm text-text-secondary">
                    No agents in this project. Other projects have{" "}
                    {pluralize(fleet.runs.length, "agent")}.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setScope("all")}>
                    Show all projects
                  </Button>
                </>
              ) : everyHost ? (
                <p className="text-sm text-text-secondary">
                  {hostIssues.length > 0
                    ? "No agents on the hosts that answered."
                    : "No agents are running on any host. Each one shows up here once it starts."}
                </p>
              ) : otherHost ? (
                <p className="text-sm text-text-secondary">
                  No agents are running on {hostName}. Each one shows up here once it starts.
                </p>
              ) : (
                <p className="text-sm text-text-secondary">
                  Launch an agent from the toolbar and it shows up here.
                </p>
              )}
            </div>
          )}
      </div>
    </AppDialog>
  );
}
