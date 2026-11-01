import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Keyboard, RefreshCw } from "lucide-react";
import { formatWaitAge } from "@/lib/projectRowStatus";
import { Telescope } from "@/components/icons";
import { useCanopyStore } from "@/store/canopyStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { latestUndoOnly, UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { pluralize } from "@/lib/pluralize";
import { isMac } from "@/lib/platform";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { clientErrorCode } from "@/utils/clientAppError";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useOverlayClaim } from "@/hooks/useOverlayState";
import { useEffectiveCombo } from "@/hooks";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { SearchField } from "@/components/ui/SearchField";
import { Spinner } from "@/components/ui/Spinner";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Callout } from "@/components/ui/Callout";
import { DismissButton } from "@/components/ui/DismissButton";
import { itemNeedsAttention, repliedAt, type CanopyItem } from "./canopyModel";
import { isWorkerEntry } from "./canopyInboxProjection";
import { CanopyCard, canopyCardDomId } from "./CanopyCard";
import { CanopyRow } from "./CanopyRow";
import { CanopyRowMenu } from "./CanopyRowMenu";
import { SectionBar } from "./CanopySectionBar";
import {
  CanopyTrashSection,
  useTrashExpiryAnnouncer,
  type CanopyTrashSectionHandle,
} from "./CanopyTrashSection";
import { CanopyEmptyLine } from "./CanopyEmptyLine";
import { CanopyStatusBar, formatModelBytes } from "./CanopyStatusBar";
import { CanopyPlace } from "./CanopyPlace";
import { CanopyPitch } from "./CanopyPitch";
import { CanopyListColumn } from "./CanopyListColumn";
import { CANOPY_TITLE } from "./canopyTerms";
import { CanopyHeaderCenter, CanopyHostPicker, useCanopyHostRows } from "./CanopyHostPicker";
import { CanopyHostOffer, CanopyHostOutdated } from "./CanopyHostOffer";
import { useCanopyInboxData } from "./useCanopyInboxData";
import { useCanopyInboxOrder } from "./useCanopyInboxOrder";
import { useCanopyInboxSearch } from "./useCanopyInboxSearch";
import { useCanopyInboxFilters } from "./useCanopyInboxFilters";
import { useCanopyInboxFocus } from "./useCanopyInboxFocus";
import { useCanopyInboxUndo } from "./useCanopyInboxUndo";
import { useCanopyInboxActions } from "./useCanopyInboxActions";
import { useCanopyInboxKeyboard } from "./useCanopyInboxKeyboard";
import {
  NO_CANOPY_REPLY,
  isCanopyReplyTarget,
  registerCanopyReplyDictation,
  type CanopyReplyDictation,
} from "@/services/canopyReplyDictation";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { isActiveVoiceSession } from "@shared/types";
import { placeOf } from "./canopyInboxPlace";
import { restoreInItsProject } from "./canopyRestoreElsewhere";
import type { CanopyTrashItem } from "./canopyTrash";
import { parseAllHostsKey } from "./canopyAllHosts";
import { CanopyAssistantPane, CanopyAssistantRow } from "./CanopyAssistantList";
import { canopyAssistantDomId } from "./openAssistantItem";
import { CANOPY_ROLE_FILTERS, type CanopyRoleFilter } from "./canopyAssistants";
import { isFullAgentDirectory } from "@shared/types/agentDirectory";
import { CanopyBulkEnableDialog } from "./CanopyBulkEnableDialog";
import type { BulkTarget } from "@shared/utils/canopyBulkEnable";
import {
  canopyBulkTransport,
  ownCanopyApi,
  remoteCanopyApi,
  unlessHostDisconnected,
} from "./canopyHostSource";
import { ALL_HOSTS_ID, canopyOwnHostId } from "@/store/canopyStore";
import { describeHostMenuState, type HostMenuRow } from "@/components/Hosts/hostModel";
import { isNewWindowClick } from "@/components/Hosts/hostSwitching";
import type { HostId } from "@shared/types/remoteHosts";
import { readsWithHostedService, type CanopyTrashEntry } from "@shared/types/ipc/canopy";

// Loaded on first use: the dialog pulls in Pilot's row and band modules.
const LazyParkRunDialog = lazy(() =>
  import("@/components/Fleet/ParkRunDialog").then((m) => ({ default: m.ParkRunDialog }))
);

interface HostIssue {
  hostId: HostId;
  text: string;
  action: string | null;
  act: (() => void) | null;
  /** Something wrong with the host, not a read still on its way. */
  trouble: boolean;
  /** A choice the user made, neither wrong nor on its way: listed plainly, and no read is retrying. */
  settled?: boolean;
  /** A link coming up or a first read on its way: still owed, so the all-clear waits, but never drawn. */
  connecting?: boolean;
}

/**
 * A host's link coming up: dialling, or a first read refused while it dials.
 * The link reads `connected` a moment before the `resync` reread lands, so the
 * refusal outlives the dial by that much.
 */
function hostDialling(linkStatus: string | undefined, error: unknown): boolean {
  return (
    linkStatus === "connecting" ||
    ((linkStatus === "disconnected" || linkStatus === "connected") &&
      clientErrorCode(error) === "HOST_DISCONNECTED")
  );
}

/** The link to a host was tried and failed, as the host menu says. */
function hostLinkFailed(linkStatus: string | undefined): boolean {
  return (
    linkStatus === "unreachable" ||
    linkStatus === "version-mismatch" ||
    linkStatus === "driven-elsewhere"
  );
}

function HostIssueList({ issues }: { issues: readonly HostIssue[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {issues.map((issue) => (
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
  );
}

/** "3m ago", or "just now" — never "just now ago". */
const NO_TRASH: readonly CanopyTrashEntry[] = [];
/** How long a run put back from the Trash is waited for, to select it once it is back. */
const RESTORED_SELECT_MS = 5000;

function agoPhrase(sinceMs: number, nowMs: number): string {
  const age = formatWaitAge(sinceMs, nowMs);
  return age === "just now" ? age : `${age} ago`;
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
  // The offer to turn reading on is one press from the list, never in front of it.
  const [pitchOpen, setPitchOpen] = useState(false);
  useEffect(() => {
    if (!isOpen || activated !== false) setPitchOpen(false);
  }, [isOpen, activated]);
  const outdatedOwnHost = useCanopyStore((s) => s.outdatedHost);
  const applySnapshot = useCanopyStore((s) => s.applySnapshot);
  // Another host the panel shows, or null for the window's own.
  const hostId = useCanopyStore((s) => s.hostId);
  const setHostId = useCanopyStore((s) => s.setHostId);
  useEffect(() => setPitchOpen(false), [hostId]);
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
  // A view put in the background — another project shown in its place — can
  // be seen by no one: an inbox left open there would keep its pages held
  // back, and hold an agent's terminal at its size.
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
    // A window on another host asks that host, whose link may be down.
    safeFireAndForget(
      unlessHostDisconnected(window.electron.canopy.setActive(true).then(applySnapshot))
    );
    return () => {
      unsubscribe();
      safeFireAndForget(unlessHostDisconnected(window.electron.canopy.setActive(false)));
    };
  }, [isOpen, showingOwnHost, applySnapshot]);

  // Every host together: each host's own Canopy says whether it is on, inside
  // the inbox, and none is turned on by being listed.
  if (readingAll) {
    return (
      <CanopyInbox
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
        placement="window"
        // Nothing to land on yet, and Close is no place for a reflexive Enter.
        initialFocus="none"
        restoreFocusTo={restoreOnReplace}
        preferRestoreFocusTo
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

  // The window's own host is on a Daintree from before Canopy read locally:
  // nothing it read is shown, and Canopy isn't offered until it is updated.
  if (outdatedOwnHost && !allHosts) {
    return (
      <AppDialog
        isOpen={isOpen}
        onClose={close}
        placement="window"
        restoreFocusTo={restoreOnReplace}
        preferRestoreFocusTo
        data-testid="canopy-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<Telescope />}>{CANOPY_TITLE}</AppDialog.Title>
          <CanopyHeaderCenter>{hostPicker}</CanopyHeaderCenter>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <CanopyHostOutdated hostName="this host" />
      </AppDialog>
    );
  }

  // Until the user turns it on, nothing is read: the list is what Daintree
  // observes, and the pitch waits behind the offer in the status bar.
  if (activated === false && pitchOpen) {
    return (
      <CanopyPitch
        isOpen={isOpen}
        onClose={close}
        onTurnOn={() => window.electron.canopy.setMode("on").then(applySnapshot)}
        onHide={hideCanopy}
        restoreFocusTo={restoreOnReplace}
        hostPicker={hostPicker}
      />
    );
  }
  return (
    <CanopyInbox
      restoreOpener={restoreOnReplace}
      hostId={null}
      hostRow={null}
      hostRows={null}
      hostPicker={hostPicker}
      onOfferReading={activated === false ? () => setPitchOpen(true) : null}
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
/** Sets the title bar's status apart from the title, as the status's own parts are. */
function TitleDot() {
  return (
    <span aria-hidden="true" className="mx-2 shrink-0 text-sm text-text-secondary">
      ·
    </span>
  );
}

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
        { keys: ["Enter"], label: "In a reply: send" },
        {
          keys: ["Cmd+Enter"],
          label: "In a reply: send, then go to the next agent below that needs you or is unread",
        },
        { keys: ["Shift+Enter"], label: "New line in a reply" },
        { keys: ["Escape"], label: "Back to the list from a reply" },
        ...(paneClose
          ? [
              {
                keys: [paneClose],
                label: isMac()
                  ? "Trash the agent's terminal; Z takes it back"
                  : "In a reply: trash the agent's terminal; Z takes it back",
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
            <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
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
  restoreOpener,
  hostId,
  hostRow,
  hostRows,
  hostPicker,
  onOfferReading = null,
}: {
  /** What had the keyboard when the panel opened, while it is still there. */
  restoreOpener: () => HTMLElement | null;
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  /** That host as the host menu draws it, while it is in the host list. */
  hostRow: HostMenuRow | null;
  /** The hosts read together when `hostId` is All hosts. */
  hostRows: readonly HostMenuRow[] | null;
  hostPicker: React.ReactNode;
  /** The window's own host with its reader off: opens the pitch. */
  onOfferReading?: (() => void) | null;
}) {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const close = useCanopyStore((s) => s.close);
  const {
    otherHost,
    everyHost,
    readerOff,
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
    workspaces,
  } = useCanopyInboxData({ isOpen, hostId, hostRow, hostRows });

  const {
    items,
    inbox,
    band,
    owedOnOpen,
    revealed,
    reorderWaiting,
    refreshedAt,
    bodyRef,
    enterList,
    leaveList,
    listHidden,
    menuOpenChanged,
    requestRank,
    placeOrder,
    orderWake,
  } = useCanopyInboxOrder({
    isOpen,
    hostId,
    otherHost,
    scope,
    canopy,
    baseItems,
    nowMs,
    observedAt: readerOff ? (fleet?.changedAt ?? null) : null,
  });
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
    bandAssistants,
    listedAssistants,
    showWork,
    inWork,
    shownInbox,
    unreadOnly,
    setUnreadOnly,
    listed,
    bandSize,
    archivedExpanded,
    setArchivedExpanded,
    archivedShown,
    visible,
    projection,
    workerNavigation,
    firstAssistant,
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
    band,
    query,
    appliedQuery,
    terms,
    searching,
    searchKey,
    screenAsk,
    onScreen,
    listHidden,
  });
  // The band has rows of its own: only then do the band headings show.
  const bandShown = bandSize > 0 || bandAssistants.length > 0;
  // A row asked for from the recording indicator is looked for once its
  // host's runs are in, or its host has failed: in All hosts, that host's own.
  const revealRunId = useCanopyStore((s) => s.replyReveal?.runId ?? null);
  const revealHost =
    everyHost && revealRunId !== null ? (parseAllHostsKey(revealRunId)?.hostId ?? null) : null;
  const revealReading =
    revealHost === null ? undefined : readings.find((reading) => reading.hostId === revealHost);
  const revealRunsLoaded =
    revealReading === undefined
      ? fleet !== null
      : revealReading.fleet !== null || revealReading.error !== null;
  const {
    searchRef,
    refreshRef,
    detailRef,
    focusedIndex,
    activeIndex,
    focusedItem,
    paneFocus,
    replyFocus,
    settleReplyFocus,
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
    moveOnTo,
    moveOnTarget,
    leavePane,
    showsHost,
    isSelected,
    captureFocusAfterClose,
    closeForTerminal,
    focusAfterClose,
  } = useCanopyInboxFocus({
    isOpen,
    close,
    hostId,
    ownHostId,
    otherHost,
    everyHost,
    items,
    loaded: revealRunsLoaded,
    listed,
    visible,
    workerNavigation,
    workersShown,
    shownAssistants,
    firstAssistant,
    inWork,
    searching,
    query,
    appliedQuery,
    setQuery,
    roleFilter,
    seeAssistantHandback,
  });

  useLayoutEffect(() => placeOrder(), [placeOrder, orderWake]);
  const { reserveUndo, undoReads, undoLine } = useCanopyInboxUndo({ hostId, api });

  // A held reorder is said once, not row by row as its scores land.
  const sortShown = workersShown && reorderWaiting;
  useEffect(() => {
    if (sortShown) {
      useAnnouncerStore
        .getState()
        .announce("The inbox has a new order. Sort now applies it", "polite");
    }
  }, [sortShown]);
  // Sort now leaves once the order is applied, by the user or a pause: the
  // keyboard on it stays in the panel, on the search.
  const sortFocusedRef = useRef(false);
  useLayoutEffect(() => {
    if (sortShown || !sortFocusedRef.current) return;
    sortFocusedRef.current = false;
    searchRef.current?.focus({ preventScroll: true });
  }, [sortShown, searchRef]);
  const {
    readNow,
    handlers,
    toggleRead,
    markAllRead,
    askRename,
    rowMenu,
    setAside,
    parkRunId,
    closePark,
    trashArm,
    renameAsk,
    refreshes,
    refresh,
  } = useCanopyInboxActions({
    hostId,
    ownHostId,
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
    moveOnTarget,
    leavePane,
    showsHost,
    isSelected,
    captureFocusAfterClose,
    closeForTerminal,
    reserveUndo,
    undoReads,
    menuOpenChanged,
    requestRank,
  });

  // The dictation key goes to the selected agent's reply wherever the keyboard
  // is in Canopy; with no agent's pane showing, nowhere, never the grid behind.
  const dictationRef = useRef<() => CanopyReplyDictation>(() => NO_CANOPY_REPLY);
  useEffect(() => {
    dictationRef.current = () =>
      (selectedAssistant === null && focusedItem !== null
        ? detailRef.current?.dictation()
        : undefined) ?? NO_CANOPY_REPLY;
  });
  useEffect(() => registerCanopyReplyDictation(() => dictationRef.current()), []);
  // The row a dictation is writing its reply into, wherever the selection has
  // gone since: marked in the list while it records (#14778).
  const dictatingRow = useVoiceRecordingStore((s) =>
    isActiveVoiceSession(s.status) && isCanopyReplyTarget(s.activeTarget)
      ? s.activeTarget?.canopyRow
      : undefined
  );
  const dictatingRunId = dictatingRow?.hostScope === hostId ? dictatingRow.runId : null;

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
  // The inbox list is one listbox over workers and band assistants, so it has
  // one Tab stop between them: a selected band assistant, else the worker rows'.
  const assistantHoldsStop = bandAssistants.some((a) => a.id === selectedAssistant?.id);
  // Over the whole inbox, whatever the filter shows: a read approval still blocks its agent.
  const needsYouWorkers = projection.needsYou.filter(isWorkerEntry).length;
  const needsYouAssistants = projection.needsYou.length - needsYouWorkers;
  const needsYou = projection.needsYou.length;

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
  const connecting = hostDialling(linkStatus, remote.error);
  // The link dropped after the agents were read: what is listed is what it last showed.
  const linkDown = fleet !== null && linkStatus !== undefined && linkStatus !== "connected";
  // Connecting stays quiet only until there are rows: rows kept from before say
  // they are old, until the link is back up and only their reread is owed.
  const hostTrouble =
    otherHost &&
    (remote.error !== null || linkDown) &&
    !(connecting && (fleet === null || linkStatus === "connected"));
  // That host runs a Daintree from before Canopy read locally, and still sends
  // its screens to the former hosted service: none of it is shown here, nor is
  // it offered to be turned on, until the host is updated.
  const hostOutdated = otherHost && canopy != null && readsWithHostedService(canopy);
  // Canopy is off on that host: its own offer, for it alone.
  const hostOffer = otherHost && canopy?.activated === false && !hostOutdated;
  // Its list is what that host observed; the offer takes the panel only once asked for.
  const [hostOfferOpen, setHostOfferOpen] = useState(false);
  useEffect(() => {
    if (!hostOffer) setHostOfferOpen(false);
  }, [hostOffer]);
  useEffect(() => {
    setHostOfferOpen(false);
  }, [hostId]);
  const hostOfferShown = hostOffer && hostOfferOpen;
  const hostHeld = hostOfferShown || hostOutdated;
  const offerReading =
    readerOff && !hostOutdated
      ? (onOfferReading ?? (hostOffer ? () => setHostOfferOpen(true) : null))
      : null;
  const readingOfferDismissed = useCanopyStore((s) => s.readingOfferDismissed);
  const dismissReadingOffer = useCanopyStore((s) => s.dismissReadingOffer);

  // Canopy's Trash: every agent run the host's trash holds, any project's.
  const trashRef = useRef<CanopyTrashSectionHandle>(null);
  // A run put back from the Trash comes into the inbox selected, once it is
  // back in the fleet: the same run, or the pane resuming its session. Anything
  // the user selects from the press on, another host or the panel closing, wins.
  const shownRunId = selectedAssistant?.id ?? focusedItem?.runId ?? null;
  const shownRunIdRef = useRef(shownRunId);
  useLayoutEffect(() => {
    shownRunIdRef.current = shownRunId;
  });
  const [restored, setRestored] = useState<{
    runId: string;
    from: string | null;
    request: number;
  } | null>(null);
  const restoreRequests = useRef(0);
  const onRestoring = useCallback(() => {
    const request = ++restoreRequests.current;
    const from = shownRunIdRef.current;
    // Waited for from when main says which run it is: a resume takes longer
    // than a restore, and its run has a new id.
    return (runId: string | null) => {
      if (runId === null || request !== restoreRequests.current) return;
      // The run itself, arrived first and shown with nothing else to show, is no choice of the user's.
      if (shownRunIdRef.current !== from && shownRunIdRef.current !== runId) return;
      setRestored({ runId, from, request });
    };
  }, []);
  useEffect(() => {
    restoreRequests.current += 1;
    setRestored(null);
  }, [hostId, isOpen]);
  const onRestoreElsewhere = useCallback(
    (item: CanopyTrashItem) =>
      restoreInItsProject(
        item,
        { hostId, ownHostId },
        {
          closeForTerminal,
          // A panel since closed, or showing another host, is the user's newer choice.
          stillShows: () => showsHost(hostId) && useCanopyStore.getState().isOpen,
        }
      ),
    [hostId, ownHostId, closeForTerminal, showsHost]
  );
  useEffect(() => {
    if (restored === null) return;
    const handle = setTimeout(() => {
      setRestored(null);
      // It never came back: a keyboard left waiting for it goes to the search.
      const active = document.activeElement;
      if (active === null || active === document.body) searchRef.current?.focus();
    }, RESTORED_SELECT_MS);
    return () => clearTimeout(handle);
  }, [restored, searchRef]);
  useEffect(() => {
    if (restored === null) return;
    // Another run picked meanwhile is the user's choice; the inbox landing on
    // the restored run itself, with nothing else to show, is this one arriving.
    if (shownRunId !== restored.from && shownRunId !== restored.runId) {
      setRestored(null);
      return;
    }
    if (!visible.some((item) => item.runId === restored.runId)) return;
    setRestored(null);
    // The keyboard follows it from the Trash, or from nowhere; the search keeps it.
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      active.closest("#canopy-trash, [aria-controls=canopy-trash], [data-canopy-card]") !== null
    ) {
      focusCardNow(restored.runId);
    } else {
      selectNow(restored.runId);
    }
  }, [restored, shownRunId, visible, focusCardNow, selectNow]);
  // Back in the fleet, whatever the panel's filters show: a run that left the
  // trash near its deadline was restored, not let go.
  const fleetRunIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    fleetRunIdsRef.current = new Set((fleet?.runs ?? []).map((run) => run.runId));
  }, [fleet]);
  const isBackInFleet = useCallback((runId: string) => fleetRunIdsRef.current.has(runId), []);
  const trashEntries = canopy?.trash ?? NO_TRASH;
  // This view's own project's trash is in its dock too, which says its expiries itself.
  const dockAnnounces = useCallback(
    (workspaceId: string) => {
      if (otherHost && !everyHost) return false;
      const here = getViewWorkspaceId();
      if (!everyHost) return workspaceId === here;
      const place = parseAllHostsKey(workspaceId);
      return place !== null && place.hostId === ownHostId && place.id === here;
    },
    [otherHost, everyHost, ownHostId]
  );
  const trashActed = useTrashExpiryAnnouncer({
    active: isOpen,
    entries: trashEntries,
    workspaces,
    scopeKey: hostId ?? "",
    dockAnnounces,
    isBackInFleet,
  });
  // Up off the Trash bar: the inbox's last row, else the search.
  const leaveTrashUp = () => {
    const last = projection.navigation[projection.navigation.length - 1];
    if (!last) searchRef.current?.focus();
    else if (last.role === "worker") focusCardNow(last.item.runId);
    else focusAssistantNow(last.item.id);
  };

  const { onAssistantKeyDown, onAgentStepKeyDownCapture, onNavigationKeyDown, onSearchKeyDown } =
    useCanopyInboxKeyboard({
      visible,
      listed,
      shownAssistants,
      navigation: projection.navigation,
      focusedIndex,
      activeIndex,
      focusedItem,
      selectedAssistant,
      searchRef,
      detailRef,
      selectNow,
      focusCardNow,
      openPaneNow,
      focusAssistantNow,
      selectAssistant,
      openAssistant,
      onOpen: handlers.onOpen,
      askRename,
      toggleRead,
      markAllRead,
      onPastEnd: () => trashRef.current?.focusHeader() ?? false,
    });

  // What the panel can say about another host before it has its agents.
  const hostSummary =
    hostTrouble && fleet === null
      ? `Can't reach ${hostName}`
      : otherHost && fleet === null && connecting
        ? `Connecting to ${hostName}…`
        : hostOutdated
          ? `Update Daintree on ${hostName}`
          : hostOfferShown
            ? `Canopy is off on ${hostName}`
            : null;
  // The band is behind who needs the user until the list may re-rank — a run
  // that needs them held out of it, or one that no longer does held in it:
  // nothing is concluded meanwhile.
  const unsorted = inbox.inbox.some((item) => itemNeedsAttention(item) !== band.has(item.runId))
    ? { words: "Not every agent is sorted yet", allClear: false }
    : null;
  // What the line and the empty band both say while no agent needs the user, and
  // whether it is the all-clear itself: only the last branch draws it.
  const nothingWaiting: { words: string; allClear: boolean } = readerOff
    ? (unsorted ?? { words: "No agent is waiting on you", allClear: false })
    : // "Nothing" is a conclusion: qualified while some screens
      // can't be read at all, withheld while Daintree can't see its
      // agents, and held back while any run in the inbox has yet to
      // be read at all — readings owed, a retry waiting, however
      // long they take, and after a scope switch too.
      (canopy?.lastError ?? null) !== null
      ? (unsorted ?? { words: "Nothing needs you that Canopy could read", allClear: false })
      : // Rows kept from a host that can't be reached are as last seen, as a
        // degraded fleet's are: nothing current is concluded from them.
        fleet?.degraded || hostTrouble
        ? { words: "Can't tell who needs you right now", allClear: false }
        : owedOnOpen ||
            canopy?.waiting !== undefined ||
            (canopy?.busy === true && inbox.inbox.some((item) => item.card === null))
          ? { words: "Checking who needs you…", allClear: false }
          : // A screen that can't be read yet (starting, hibernating)
            // has no reading at all: nothing is concluded about it.
            inbox.inbox.some((item) => item.card === null)
            ? { words: "Not every agent could be read yet", allClear: false }
            : (unsorted ?? { words: "Nothing needs you", allClear: true });
  const ownHostLabel = (hostRows ?? []).find((row) => row.hostId === ownHostId)?.name ?? "This Mac";
  const needsYouLead = `${[
    needsYouWorkers > 0 ? pluralize(needsYouWorkers, "agent") : null,
    needsYouAssistants > 0 ? pluralize(needsYouAssistants, "assistant") : null,
  ]
    .filter(Boolean)
    .join(" and ")} ${needsYou === 1 ? "needs" : "need"} you`;
  const summaryLine =
    fleet === null
      ? "Reading agents…"
      : fleet.degraded && items.length === 0 && needsYou === 0
        ? "Can't tell who needs you right now"
        : items.length === 0 && needsYou === 0
          ? scope === "project" && fleet.runs.length > 0
            ? "No agents in this project"
            : "No agents are running"
          : // What needs you leads; what is new follows. The list's own heading
            // counts the agents. A count the band is behind says so too.
            [
              needsYou > 0 ? needsYouLead : nothingWaiting.words,
              needsYou > 0 ? unsorted?.words : null,
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
      const linkStatus = remoteHost && row?.isLocal === false ? row.connection?.status : undefined;
      const retry = () => remotes.retry(reading.hostId);
      // Its agents were read before the link dropped: they are kept, and old,
      // whatever the reads since have said.
      if (reading.fleet !== null && linkStatus !== undefined && linkStatus !== "connected") {
        return [
          {
            hostId: reading.hostId,
            text: `${name} isn't connected. Its agents are as last seen`,
            action: "Retry",
            act: retry,
            trouble: true,
          },
        ];
      }
      const linkFailed = hostLinkFailed(linkStatus);
      if (remoteHost && (reading.error !== null || (linkFailed && reading.fleet === null))) {
        if (linkFailed || !hostDialling(linkStatus, reading.error)) {
          return [
            {
              hostId: reading.hostId,
              text: `Can't reach ${name}`,
              action: "Retry",
              act: retry,
              trouble: true,
            },
          ];
        }
        return [
          {
            hostId: reading.hostId,
            text: `Connecting to ${name}…`,
            action: null,
            act: null,
            trouble: false,
            connecting: true,
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
            trouble: false,
            connecting: true,
          },
        ];
      }
      if (readsWithHostedService(reading.canopy)) {
        return [
          {
            hostId: reading.hostId,
            text: `Update Daintree on ${name} to read its agents`,
            action: "Show",
            act: () => useCanopyStore.getState().setHostId(reading.hostId),
            trouble: true,
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
            trouble: false,
            settled: true,
          },
        ];
      }
      // Its own model, downloaded on that host: until it is there, nothing there is read.
      const model = reading.canopy.model;
      if (model && model.status !== "ready") {
        const where = remoteHost ? ` on ${name}` : "";
        const hostApi = remoteHost ? remoteCanopyApi(reading.hostId) : ownCanopyApi;
        return [
          model.status === "failed"
            ? {
                hostId: reading.hostId,
                text: `Couldn't download Canopy's model${where}`,
                action: "Retry",
                act: () => void hostApi.retryModel().catch(() => {}),
                trouble: true,
              }
            : {
                hostId: reading.hostId,
                text:
                  model.status === "downloading"
                    ? `Downloading Canopy's model${where}… ${formatModelBytes(model.received)} of ${formatModelBytes(model.total)}`
                    : `Waiting for Canopy's model${where}…`,
                action: null,
                act: null,
                trouble: false,
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
            trouble: true,
          },
        ];
      }
      return [];
    });
  }, [everyHost, readings, hostRows, ownHostId, remotes]);
  const hostTroubles = hostIssues.filter((issue) => issue.trouble);
  const hostProgress = hostIssues.filter((issue) => !issue.trouble);
  // Connecting is the same on every open, so it is silent: the header and the band
  // still hold back the all-clear, and a spinner by the picker says so past the gate.
  const hostProgressShown = hostProgress.filter((issue) => !issue.connecting);
  // A closed panel holds no readings, so it would be connecting for as long as it stays shut.
  const connectingSomewhere = isOpen && hostIssues.some((issue) => issue.connecting);
  const showConnecting = useDohertyGate(connectingSomewhere) && connectingSomewhere;
  const retryingSomewhere =
    everyHost &&
    (hostProgress.some((issue) => !issue.settled) ||
      readings.some((reading) => reading.canopy?.activated === true && reading.canopy.waiting));
  // The header's count moves to the first run in the band, first lifting whatever
  // keeps one of the band's runs out of the list.
  const countedWorkers = projection.needsYou.filter(isWorkerEntry).map((entry) => entry.item);
  const showNeedsYou = () => {
    const first = countedWorkers[0];
    // Workers lead the band; with none asking, the first assistant that is.
    const askingAssistant = assistantItems.find((item) => item.ask !== null);
    if (!first && !askingAssistant) return;
    const listedIds = new Set(listed.map((item) => item.runId));
    const shownIds = new Set(shownAssistants.map((item) => item.id));
    const hiddenWorker = countedWorkers.some((item) => !listedIds.has(item.runId));
    const hiddenAssistant = assistantItems.some(
      (item) => item.ask !== null && !shownIds.has(item.id)
    );
    if (hiddenWorker || hiddenAssistant) {
      if (unreadOnly) setUnreadOnly(false);
      if (query !== "") setQuery("");
      if (workOf !== null) showWorkOf(null);
    }
    // Whatever the role filter hides of what the header counts comes back.
    if ((first && !workersShown) || (askingAssistant && !assistantsShown)) setRoleFilter("all");
    if (first) {
      selectNow(first.runId);
      // The row may only mount once the filters are lifted: scroll to it then too.
      requestAnimationFrame(() => selectNow(first.runId));
    } else {
      const id = askingAssistant!.id;
      selectAssistant(id);
      requestAnimationFrame(() => selectAssistant(id));
    }
    searchRef.current?.focus({ preventScroll: true });
  };
  // What the empty band says: the header's own caution about hosts and readings,
  // or that a filter is hiding what the header counts. Only the all-clear has
  // words of its own, so the band settles the header's conclusion rather than
  // repeating it; a qualified line is the header's own, word for word.
  const bandEmptyWords =
    needsYou > 0
      ? `${needsYouLead}, but a filter hides ${needsYou === 1 ? "it" : "them"}`
      : (hostSummary ??
        (fleet !== null && hostTroubles.length > 0
          ? "Not every host could be read"
          : fleet !== null && retryingSomewhere
            ? "Checking who needs you…"
            : nothingWaiting.allClear
              ? "No action needed"
              : nothingWaiting.words));
  const headerText =
    hostSummary ??
    (needsYou === 0 && fleet !== null && hostTroubles.length > 0
      ? "Not every host could be read"
      : needsYou === 0 && fleet !== null && retryingSomewhere
        ? "Checking who needs you…"
        : summaryLine);
  // The count is a control when it leads the line: it takes the user to the band.
  const headerWords =
    needsYou > 0 && headerText === summaryLine ? (
      <>
        <button
          type="button"
          data-testid="canopy-needs-you-count"
          onClick={showNeedsYou}
          className="rounded-sm font-medium text-text-primary tabular-nums outline-hidden hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selection-outline"
        >
          {needsYouLead}
        </button>
        {headerText.slice(needsYouLead.length)}
      </>
    ) : (
      headerText
    );

  // With assistants to list, or only assistants asked for, the list shows
  // even when no worker runs.
  // The relationship filter keeps the list, and its banner, up even with nothing in it.
  const listsAssistants =
    (assistantsShown && (assistantItems.length > 0 || !workersShown)) || workOf !== null;
  // A trash, or the undo line of one just made, keeps the list up with no
  // agent left running: the way back stays where the user left it.
  const trashListed = trashEntries.length > 0;
  const listsTrash = trashListed || undoLine !== null;
  // One clause each, as the empty line wants; with none running anywhere, it
  // names the way to start one.
  const assistantsEmpty: string | null = !assistantsReadable
    ? `Assistants on ${hostName} can't be listed from this window yet`
    : workOf !== null
      ? directory !== null && isFullAgentDirectory(directory)
        ? "This assistant isn't running any more"
        : null
      : directory === null
        ? null
        : searching
          ? `No assistant matches “${appliedQuery.trim()}”`
          : !isFullAgentDirectory(directory)
            ? "Daintree couldn't list every assistant just now"
            : scope === "project"
              ? "No assistant is running in this project"
              : "Start an assistant from the Assistant panel";
  // Shown in place of rows only when none is in the band either.
  const assistantsEmptyShown =
    listedAssistants.length === 0 && bandAssistants.length === 0 && assistantsEmpty !== null;
  // All hosts lists this machine's assistants alone: said once, with the list or its empty line.
  const ownAssistantsOnly = `Only ${ownHostLabel}'s assistants are listed`;
  const inboxEmpty: { words: string; note?: string } = searching
    ? {
        words:
          shownInbox.inbox.length > 0
            ? `Nothing unread matches “${appliedQuery.trim()}”`
            : `Nothing matches “${appliedQuery.trim()}”`,
      }
    : workOf !== null
      ? {
          words: workPartial
            ? "None found on the hosts that could be read"
            : "No worker in the inbox was started by or handed to this assistant",
        }
      : items.length === 0
        ? {
            words: "No agents are running",
            ...(trashListed ? { note: "Restore one from the Trash below" } : {}),
          }
        : unreadOnly && inbox.inbox.length > 0
          ? {
              words: "Nothing unread",
              note: "Each agent shows here again when it does something new",
            }
          : {
              words: "Every agent is archived",
              note: "Each comes back when it has something new to say",
            };

  const headerControls = (
    <>
      <SegmentedRadioGroup<CanopyRoleFilter>
        aria-label="Roles to show"
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
      {/* Nothing is read while the reader is off, so there is nothing to refresh;
          its slot stays, so the filters don't move when reading turns on or off. */}
      <span className="flex size-7 shrink-0 items-center justify-center">
        {!readerOff && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={refreshRef}
                variant="ghost"
                size="icon-sm"
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
        )}
      </span>
      <AppDialog.CloseButton />
    </>
  );

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={close}
      placement="window"
      // The panel lands on its first run itself, two frames in; the dialog's own
      // first-control focus would race it. With no rows to land on, the first
      // control takes focus instead of leaving it on whatever opened the panel.
      initialFocus={items.length > 0 && !hostHeld ? "none" : "first"}
      restoreFocusTo={() => focusAfterClose() ?? restoreOpener()}
      preferRestoreFocusTo
      data-testid="canopy-dialog"
    >
      <AppDialog.Header>
        {hostPicker ? (
          // Three parts, the outer two sharing what is left, so the picker
          // stands in the middle of the header. The controls' part never
          // goes below their own width: in a narrow window the words give way
          // and the picker leaves the middle rather than run under them.
          <>
            <span className="flex min-w-0 flex-1 basis-0 items-center">
              <AppDialog.Title icon={<Telescope />}>{CANOPY_TITLE}</AppDialog.Title>
              <TitleDot />
              <span
                className="mr-3 min-w-0 flex-1 truncate text-sm text-text-secondary"
                data-testid="canopy-summary"
              >
                {headerWords}
              </span>
            </span>
            <span className="relative flex min-w-0 items-center">
              {hostPicker}
              {showConnecting && (
                // Out of the picker's flow, so it stays where it was, and inside the 12px the
                // header's right part leaves beside it.
                <span
                  role="status"
                  aria-label="Connecting to hosts"
                  data-testid="canopy-hosts-connecting"
                  className="absolute top-1/2 left-full -translate-y-1/2 text-text-secondary"
                >
                  <Spinner size="xs" />
                </span>
              )}
            </span>
            <span className="ml-3 flex flex-1 basis-0 items-center justify-end">
              {headerControls}
            </span>
          </>
        ) : (
          <>
            <AppDialog.Title icon={<Telescope />}>{CANOPY_TITLE}</AppDialog.Title>
            <TitleDot />
            <span
              className="mr-3 min-w-0 flex-1 truncate text-sm text-text-secondary"
              data-testid="canopy-summary"
            >
              {headerWords}
            </span>
            {headerControls}
          </>
        )}
      </AppDialog.Header>

      <div
        ref={bodyRef}
        className="canopy-frame flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onAgentStepKeyDownCapture}
        onKeyDown={onNavigationKeyDown}
      >
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
        {everyHost && (hostTroubles.length > 0 || hostProgressShown.length > 0) && (
          <div
            data-testid="canopy-host-issues"
            className="flex shrink-0 flex-col gap-2 border-b border-border-default p-3"
          >
            {hostTroubles.length > 0 && (
              <Callout severity="warning" size="compact" title="Not every host is being read">
                <HostIssueList issues={hostTroubles} />
              </Callout>
            )}
            {/* Reads still on their way, and a reader the user left off: noted, never a warning. */}
            {hostProgressShown.length > 0 && (
              <Callout severity="neutral" size="compact">
                <HostIssueList issues={hostProgressShown} />
              </Callout>
            )}
          </div>
        )}
        {otherHost && fleet === null && !hostTrouble && connecting && (
          <p className="flex flex-1 items-center justify-center text-sm text-text-secondary">
            Connecting to {hostName}…
          </p>
        )}
        {hostOutdated && (
          <CanopyHostOutdated
            hostName={hostName}
            {...(canopy?.mode === "on"
              ? {
                  onTurnOff: async () => {
                    await api.setMode("unset");
                    if (useCanopyStore.getState().hostId === hostId) remote.retry();
                  },
                }
              : {})}
          />
        )}
        {hostOfferShown && (
          <CanopyHostOffer
            onBack={() => setHostOfferOpen(false)}
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
        {!hostHeld && (fleet?.degraded === true || canopy?.lastError) && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-border-default p-3">
            {/* Daintree can't see its agents right now: the rows are the last
                it saw, and nothing is read until it can again. */}
            {fleet?.degraded === true && (
              <Callout severity="warning" size="compact" title="Agent status is unavailable">
                {fleet.lastSuccessfulAt !== null
                  ? `These are the agents Daintree saw ${agoPhrase(fleet.lastSuccessfulAt, nowMs)}.${readerOff ? "" : " Canopy reads them again once it can."}`
                  : `Daintree hasn't been able to list its agents yet.${readerOff ? "" : " Canopy reads them once it can."}`}
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
        {/* A listed inbox with the reader off reads as broken unless it says
            why: the offer once, above it, until put away. An empty one has
            the status bar's offer under its own message, and the assistants
            alone aren't what reading reads. */}
        {offerReading &&
          !readingOfferDismissed &&
          !hostHeld &&
          workersShown &&
          items.length > 0 && (
            <div
              data-canopy-reading-offer=""
              className="flex shrink-0 flex-col gap-2 border-b border-border-default p-3"
            >
              <Callout
                severity="neutral"
                size="compact"
                action={
                  <Button variant="outline" size="xs" onClick={offerReading}>
                    Turn on reading
                  </Button>
                }
                dismiss={
                  <DismissButton
                    aria-label="Dismiss reading offer"
                    className="-my-1"
                    onClick={(event) => {
                      // The X leaves with the callout: the keyboard stays in the
                      // panel, on the search.
                      searchRef.current?.focus({
                        preventScroll: true,
                        focusVisible: event.detail === 0,
                      });
                      dismissReadingOffer();
                    }}
                  />
                }
              >
                Get a short summary of what each agent did, from a small model on{" "}
                {otherHost ? hostName : "this computer"}.
              </Callout>
            </div>
          )}
        {!hostHeld && (items.length > 0 || listsAssistants || listsTrash) && (
          // An inbox: what needs you down a sidebar, most urgent first, the rest
          // folded away beneath it, and the selected agent's own terminal beside
          // it, drawn as its pane.
          <div className="flex min-h-0 flex-1">
            <CanopyListColumn className="canopy-inbox-column flex min-h-0 shrink-0 flex-col self-stretch border-r border-border-default">
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
                      listed.length > 0 || bandAssistants.length > 0 ? "canopy-inbox-list" : null,
                      listedAssistants.length > 0 ? "canopy-assistants" : null,
                      archivedShown && shownInbox.archived.length > 0 ? "canopy-archived" : null,
                    ]
                      .filter((id) => id !== null)
                      .join(" ") || undefined
                  }
                  aria-autocomplete="list"
                  aria-activedescendant={
                    selectedAssistant !== null
                      ? canopyAssistantDomId(selectedAssistant.id)
                      : focusedItem && visible.includes(focusedItem)
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
                // A band heading pins under the Inbox bar: rows scrolled to clear both.
                data-band-headings={workersShown && bandShown ? "" : undefined}
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
                          {sortShown && (
                            <Button
                              variant="ghost"
                              size="xs"
                              onFocus={() => {
                                sortFocusedRef.current = true;
                              }}
                              onBlur={() => {
                                sortFocusedRef.current = false;
                              }}
                              onClick={requestRank}
                            >
                              Sort now
                            </Button>
                          )}
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
                    {/* An empty band says so above the listbox, not inside it: an option
                        group holds options, and this one would hold only words. Its name
                        is for the screen reader; on screen the words stand alone, rather
                        than a heading stacked over a line about nothing. */}
                    {!bandShown && listed.length > 0 && (
                      <div role="group" aria-labelledby="canopy-needs-you-label">
                        <span
                          id="canopy-needs-you-label"
                          className="sr-only"
                          data-testid="canopy-needs-you"
                        >
                          Needs you
                        </span>
                        <CanopyEmptyLine>{bandEmptyWords}</CanopyEmptyLine>
                      </div>
                    )}
                    {listed.length > 0 || bandAssistants.length > 0 ? (
                      <div
                        ref={listRef}
                        id="canopy-inbox-list"
                        role="listbox"
                        aria-labelledby="canopy-inbox-label"
                        onPointerEnter={(event) => enterList(event.pointerType)}
                        onPointerLeave={leaveList}
                      >
                        {[
                          {
                            id: "canopy-needs-you",
                            label: "Needs you",
                            from: 0,
                            to: bandSize,
                            assistants: bandAssistants,
                          },
                          {
                            id: "canopy-everything-else",
                            label: "Everything else",
                            from: bandSize,
                            to: listed.length,
                            assistants: [],
                          },
                        ]
                          // An empty band is already said above the listbox, under the same id.
                          .filter(
                            (group) =>
                              group.from < group.to ||
                              group.assistants.length > 0 ||
                              group.id !== "canopy-needs-you"
                          )
                          .map((group) => (
                            <div
                              key={group.id}
                              role="group"
                              aria-labelledby={`${group.id}-label`}
                              hidden={group.from === group.to && group.assistants.length === 0}
                            >
                              {/* Pinned under the Inbox bar while its own rows scroll, so a
                                scrolled list still says which band it is in; the next
                                group's heading takes its place. With the band empty,
                                everything else is the whole list: its name is only
                                the screen reader's. */}
                              <div
                                id={`${group.id}-label`}
                                className={
                                  bandShown
                                    ? "canopy-inbox-band-heading flex h-7 items-center px-3 text-xs font-medium text-text-secondary"
                                    : "sr-only"
                                }
                                data-testid={group.id}
                              >
                                {group.label}
                              </div>
                              {listed.slice(group.from, group.to).map((item, offset) => {
                                const index = group.from + offset;
                                const replied = repliedAt(item);
                                return (
                                  <CanopyRowMenu key={item.runId} item={item} {...rowMenu}>
                                    <CanopyRow
                                      item={item}
                                      domId={canopyCardDomId(item.runId)}
                                      isSelected={focusedItem?.runId === item.runId}
                                      tabbable={!assistantHoldsStop && tabStop(listed, item, index)}
                                      unread={item.unread}
                                      nowMs={nowMs}
                                      asideLabel={
                                        replied !== null
                                          ? `Replied ${agoPhrase(replied, nowMs)}`
                                          : null
                                      }
                                      workLabel={workLabelOf(item)}
                                      dictating={dictatingRunId === item.runId}
                                      onSelect={() => selectRow(item.runId)}
                                      onClick={() => readNow(item)}
                                      onOpen={(event) =>
                                        handlers.onOpen(item, isNewWindowClick(event))
                                      }
                                      onArchive={() => handlers.onArchive(item)}
                                    />
                                  </CanopyRowMenu>
                                );
                              })}
                              {group.assistants.map((item, index) => (
                                <CanopyAssistantRow
                                  key={item.id}
                                  item={item}
                                  isSelected={selectedAssistant?.id === item.id}
                                  tabbable={
                                    assistantHoldsStop
                                      ? selectedAssistant?.id === item.id
                                      : listed.length === 0 && index === 0
                                  }
                                  nowMs={nowMs}
                                  onSelect={() => selectAssistant(item.id)}
                                  onOpen={() => openAssistant(item)}
                                  onKeyDown={(event) => onAssistantKeyDown(event, item)}
                                />
                              ))}
                            </div>
                          ))}
                      </div>
                    ) : (searching || workOf !== null) &&
                      shownInbox.inbox.length === 0 &&
                      shownInbox.archived.length > 0 ? null : (
                      // A search whose only matches are archived lets their bar below say so.
                      <CanopyEmptyLine note={inboxEmpty.note}>{inboxEmpty.words}</CanopyEmptyLine>
                    )}
                  </>
                )}
                {assistantsShown &&
                  (listedAssistants.length > 0 || bandAssistants.length === 0 || everyHost) && (
                    <>
                      <SectionBar
                        id="canopy-assistants-label"
                        label="Assistants"
                        count={listedAssistants.length > 0 ? listedAssistants.length : undefined}
                        countNoun="assistant"
                      />
                      {everyHost && !assistantsEmptyShown && (
                        <p className="px-3 pb-2 text-xs text-text-secondary">{ownAssistantsOnly}</p>
                      )}
                      {listedAssistants.length > 0 ? (
                        <div
                          id="canopy-assistants"
                          role="listbox"
                          aria-labelledby="canopy-assistants-label"
                        >
                          {listedAssistants.map((item, index) => (
                            <CanopyAssistantRow
                              key={item.id}
                              item={item}
                              isSelected={selectedAssistant?.id === item.id}
                              tabbable={
                                selectedAssistant !== null
                                  ? selectedAssistant.id === item.id
                                  : index === 0
                              }
                              nowMs={nowMs}
                              onSelect={() => selectAssistant(item.id)}
                              onOpen={() => openAssistant(item)}
                              onKeyDown={(event) => onAssistantKeyDown(event, item)}
                            />
                          ))}
                        </div>
                      ) : (
                        assistantsEmptyShown && (
                          <CanopyEmptyLine note={everyHost ? ownAssistantsOnly : undefined}>
                            {assistantsEmpty}
                          </CanopyEmptyLine>
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
                              dictating={dictatingRunId === item.runId}
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
                <CanopyTrashSection
                  ref={trashRef}
                  entries={trashEntries}
                  workspaces={workspaces}
                  terms={terms}
                  api={api}
                  scopeKey={hostId ?? ""}
                  onLeaveUp={leaveTrashUp}
                  onSearch={() => {
                    searchRef.current?.focus();
                    searchRef.current?.select();
                  }}
                  onRestoring={onRestoring}
                  onRestoreElsewhere={onRestoreElsewhere}
                  acted={trashActed}
                />
              </div>
              {undoLine && (
                <div
                  data-canopy-undo-line=""
                  className="flex h-8 shrink-0 items-center gap-2 border-t border-divider px-3 text-xs text-text-secondary"
                >
                  <span role="status" className="min-w-0 flex-1 truncate">
                    {undoLine.message}
                  </span>
                  <KbdChord shortcut="Z" />
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto shrink-0 p-0"
                    onClick={undoLine.undo}
                  >
                    Undo
                  </Button>
                </div>
              )}
              <CanopyStatusBar
                host={otherHost ? hostName : null}
                onRetryModel={() => void api.retryModel().catch(() => {})}
                reader={canopy?.reader}
                model={canopy?.model}
                waiting={canopy?.waiting}
                offer={offerReading}
              />
            </CanopyListColumn>
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
                      dictationRequest={
                        replyFocus?.runId === focusedItem.runId ? replyFocus.id : undefined
                      }
                      onDictationSettled={settleReplyFocus}
                      otherHostId={(everyHost ? focusedHostId : hostId) ?? undefined}
                      hostScope={hostId}
                      aside={setAside}
                      terminalApi={terminalApi}
                      workLabel={workLabelOf(focusedItem)}
                      moveOnTo={moveOnTo}
                      reading={!readerOff}
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
        {!hostHeld &&
          fleet !== null &&
          !fleet.degraded &&
          items.length === 0 &&
          !listsAssistants &&
          !listsTrash && (
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
        {offerReading && !hostHeld && items.length === 0 && !listsAssistants && !listsTrash && (
          <CanopyStatusBar
            host={otherHost ? hostName : null}
            model={undefined}
            reader={undefined}
            waiting={undefined}
            offer={offerReading}
          />
        )}
      </div>
      {parkRunId !== null && (
        <Suspense fallback={null}>
          <LazyParkRunDialog key={parkRunId} runId={parkRunId} onClose={closePark} />
        </Suspense>
      )}
    </AppDialog>
  );
}
