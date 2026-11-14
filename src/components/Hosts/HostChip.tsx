import { useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import {
  DropdownMenu,
  DropdownMenuActionItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AppWindow,
  CircleArrowUp,
  Cloud,
  Power,
  PowerOff,
  GitBranch,
  Plus,
  Server,
  ServerOff,
  Settings2,
  Unplug,
} from "@/components/icons";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { pluralize } from "@/lib/pluralize";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isRemoteShellSupported, remoteConnectionKind } from "@/lib/remoteHosts";
import { drivenElsewhereBy, getViewHostId } from "@/hooks/useHostConnection";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { actionService } from "@/services/ActionService";
import { useDriveLeaseView } from "@/components/Recovery/driveLeaseState";
import { useProjectStore } from "@/store/projectStore";
import { notify } from "@/lib/notify";
import { logWarn } from "@/utils/logger";
import { PlatformGlyph } from "./PlatformGlyph";
import { useCloudHosts } from "./cloud/cloudHostsState";
import { useCloudMachineActions } from "./cloud/useCloudMachineActions";
import { useCloudLifecycleNews } from "./cloud/useCloudLifecycleNews";
import {
  canStartMachine,
  canStopMachine,
  cloudCostFacts,
  cloudChipStatus,
  cloudStatusLabel,
  isObservationStale,
} from "./cloud/cloudHostLabels";
import { useNow } from "@/hooks/useNow";
import { formatTimeAgo } from "@/utils/timeAgo";
import type { CloudHostStatus } from "@shared/types/cloudHosts";
import { HostNameText } from "./HostNameText";
import { isNewWindowClick, switchToHost } from "./hostSwitching";
import { hostUpdateOffer, runHostUpdate, type HostUpdateOffer } from "./hostUpdate";
import { hasRemoteHosts, useHostList } from "./hostList";
import { openHostsSettingsTab } from "@/components/Settings/Hosts/hostSettingsRequests";
import {
  HOSTS_OVERVIEW_ACTION_ID,
  buildHostMenuRows,
  clientPlatform,
  describeAwayHost,
  describeHostMenuState,
  hostChipStatus,
  hostMenuNoteAge,
  hostMenuRowHasTrouble,
  hostChipStatusText,
  isHostMenuRowAway,
  localHostLabel,
  splitHostName,
  updateActionLabel,
  updateTargetFor,
  type HostMenuRow,
} from "./hostModel";

/** Take the open project to another host: the switch dialog finds or clones it there. */
async function openProjectOnHost(hostId: string, projectId: string): Promise<void> {
  const result = await actionService.dispatch(
    "project.openOnHost",
    { hostId, projectId },
    { source: "user" }
  );
  if (result.ok) return;
  logWarn("[Hosts] Opening the project on another host failed", { error: result.error });
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "error",
    context: { eventKind: "connectivity" },
    title: "Couldn't open project on host",
    message: "The host switch dialog couldn't open. Try again from the host menu.",
  });
}

/** Close this device's link to a host; nothing on the host stops. */
async function disconnectFromHost(hostId: string, hostName: string): Promise<void> {
  try {
    await window.electron.remoteHosts.disconnect({ hostId });
  } catch (error) {
    logWarn("[Hosts] Disconnecting from a host failed", { error });
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      context: { eventKind: "connectivity" },
      title: `Couldn't disconnect from ${hostName}`,
      message: "The connection is still open. Try again from the host menu.",
    });
  }
}

const MENU_ICON_CLASS = "mr-2 h-3.5 w-3.5 shrink-0 text-text-secondary";

/**
 * The column the current host's tick lives in. Action rows keep it empty, so
 * their icons stand under the hosts' platform marks and every label in the
 * menu starts on one edge.
 */
function TickColumn() {
  return <span className="mr-2 w-3.5 shrink-0" aria-hidden="true" />;
}

/** The host's platform mark, or a plain machine until a handshake says which. */
function HostMark({ row }: { row: HostMenuRow }) {
  return (
    <span
      data-menu-icon=""
      className="flex h-4 w-3.5 shrink-0 items-center justify-center text-text-secondary"
      aria-hidden="true"
    >
      {row.platform ? (
        <PlatformGlyph platform={row.platform} />
      ) : (
        <Server className="h-3 w-3" aria-hidden="true" />
      )}
    </span>
  );
}

/** A destination in a submenu: the same mark and state the host list shows. */
function HostSubmenuLabel({ row }: { row: HostMenuRow }) {
  const { state } = describeHostMenuState(row);
  const trouble = hostMenuRowHasTrouble(row);
  const TroubleGlyph = SEVERITY_GLYPH.warning;
  return (
    <>
      <span className="mr-2 flex shrink-0">
        <HostMark row={row} />
      </span>
      {/* One line per destination so the state column lines up: a name too
          long for the submenu clips (full name in its title), never the state. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-x-4">
        <HostNameText name={row.name} className="flex-1" />
        {state && (
          <span
            data-host-trouble={trouble ? "" : undefined}
            className={cn(
              "flex shrink-0 items-baseline gap-1 whitespace-nowrap text-2xs",
              trouble ? "font-medium text-text-primary" : "text-text-secondary"
            )}
          >
            {trouble && (
              <TroubleGlyph
                className="h-3 w-3 shrink-0 translate-y-0.5 text-status-warning"
                aria-hidden="true"
              />
            )}
            {state}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * An away host's name and its one quiet line: when it was last seen, or what
 * it said instead of answering. Secondary ink throughout and no warning mark;
 * the exact time is on the age's own hover.
 */
function AwayHostLabel({
  row,
  machineState = null,
}: {
  row: HostMenuRow;
  machineState?: string | null;
}) {
  const described = describeAwayHost(row);
  // A cloud machine that isn't running says so, not that its link is down.
  const state = machineState ?? described.state;
  const at = machineState ? null : described.at;
  return (
    <span className="flex min-w-0 flex-1 items-baseline">
      {/* Full ink under the pointer or keyboard: quiet, never disabled-looking. */}
      <HostNameText
        name={row.name}
        className="flex-1 text-text-secondary group-data-[highlighted]/host:text-text-primary"
      />
      <DropdownMenuMeta aria-hidden={false} className="whitespace-nowrap">
        {at !== null ? <TimeAgo prefix={state ? `${state} · ` : "Seen "} timestamp={at} /> : state}
      </DropdownMenuMeta>
    </span>
  );
}

/**
 * A submenu destination in the treatment its link calls for now: a host that
 * wakes while the menu is open says so in place, without changing section.
 */
function SubmenuHostLabel({ row }: { row: HostMenuRow }) {
  if (!isHostMenuRowAway(row)) return <HostSubmenuLabel row={row} />;
  return (
    <>
      <span className="mr-2 flex shrink-0">
        <HostMark row={row} />
      </span>
      <AwayHostLabel row={row} />
    </>
  );
}

/**
 * The hosts that aren't answering, after the ones you can go to: their own
 * labelled group, still pickable, since picking one tries to connect.
 */
function AwayHostsGroup({
  rows,
  renderRow,
  separated = true,
}: {
  rows: readonly HostMenuRow[];
  renderRow: (row: HostMenuRow) => ReactNode;
  /** False when nothing sits above it to separate from. */
  separated?: boolean;
}) {
  const labelId = useId();
  if (rows.length === 0) return null;
  return (
    <>
      {separated && <DropdownMenuSeparator />}
      <DropdownMenuGroup aria-labelledby={labelId}>
        <DropdownMenuLabel id={labelId}>Unavailable</DropdownMenuLabel>
        {rows.map(renderRow)}
      </DropdownMenuGroup>
    </>
  );
}

function HostMenuItem({
  row,
  onPick,
  cloud = null,
  now = 0,
}: {
  row: HostMenuRow;
  onPick: (row: HostMenuRow, newWindow: boolean) => void;
  /** A cloud host's machine: while its link is down, what the machine is doing says more. */
  cloud?: CloudHostStatus | null;
  /** The clock its reading is judged against. */
  now?: number;
}) {
  // Drawn by what the link says now; which section it sits in was fixed when
  // the menu opened. One item either way, so a row that changes keeps focus.
  const away = isHostMenuRowAway(row);
  const described = describeHostMenuState(row);
  const machineDown = cloud !== null && (cloud.machine !== "running" || cloud.operation !== null);
  const stale = cloud !== null && cloud.machine !== "unknown" && isObservationStale(cloud, now);
  const state = machineDown ? cloudStatusLabel(cloud, stale) : described.state;
  // An old reading says how old, wherever the row sits.
  const staleAge =
    machineDown && stale
      ? cloud.observedAt !== null
        ? `checked ${formatTimeAgo(cloud.observedAt, now)}`
        : "never checked"
      : null;
  // A running cloud machine's row says what it costs and when it stops, beside the link.
  const note = machineDown
    ? [staleAge, canStartMachine(cloud) ? "Opening it starts the machine" : null]
        .filter(Boolean)
        .join(" · ") || null
    : cloud !== null
      ? cloudCostFacts(cloud).join(" · ") || described.note
      : described.note;
  // A link that has gone wrong carries the chip's own warning mark and full
  // ink; connecting and not connected stay quiet, and connected never goes green.
  // A cloud machine that isn't running is no link trouble: it says what the machine is doing.
  const trouble = !machineDown && hostMenuRowHasTrouble(row);
  const noteAge = machineDown ? null : hostMenuNoteAge(row);
  const TroubleGlyph = SEVERITY_GLYPH.warning;
  return (
    <DropdownMenuItem
      className={cn("group/host gap-2", !away && "items-start")}
      data-host-id={row.hostId}
      data-host-away={away ? "" : undefined}
      aria-current={row.isCurrent ? "true" : undefined}
      textValue={row.name}
      onClick={(event) => onPick(row, isNewWindowClick(event))}
    >
      <span className="flex h-4 w-3.5 shrink-0 items-center" aria-hidden="true">
        {row.isCurrent && <Check className="h-3.5 w-3.5 text-text-primary" />}
      </span>
      <HostMark row={row} />
      {away ? (
        <AwayHostLabel
          row={row}
          machineState={machineDown ? [state, staleAge].filter(Boolean).join(" · ") : null}
        />
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* The name keeps the whole row when it needs it and the state drops
              below it: "build-east-01" and "build-east-02" differ at the end. */}
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span className="max-w-full break-words font-medium text-text-primary">{row.name}</span>
            {state && (
              <span
                data-host-trouble={trouble ? "" : undefined}
                className={cn(
                  "ml-auto flex shrink-0 items-baseline gap-1 text-2xs",
                  trouble
                    ? "font-medium text-text-primary"
                    : row.isCurrent
                      ? "text-text-primary"
                      : "text-text-secondary"
                )}
              >
                {trouble && (
                  <TroubleGlyph
                    className="h-3 w-3 shrink-0 translate-y-0.5 text-status-warning"
                    aria-hidden="true"
                  />
                )}
                {state}
              </span>
            )}
          </span>
          {noteAge ? (
            <TimeAgo
              verbose
              prefix={noteAge.prefix}
              timestamp={noteAge.at}
              className="text-2xs text-text-secondary"
            />
          ) : (
            note && <span className="text-2xs text-text-secondary">{note}</span>
          )}
        </span>
      )}
    </DropdownMenuItem>
  );
}

/**
 * Every update a mismatched build asks for: the window's own host first, then
 * any other host whose switch was refused for its build. Updating this
 * machine is offered once however many hosts ask for it.
 */
function hostUpdateOffers(
  fromList: Array<HostUpdateOffer | null>,
  current: HostUpdateOffer | null
): HostUpdateOffer[] {
  const offers: HostUpdateOffer[] = [];
  let local = false;
  for (const offer of [current, ...fromList]) {
    if (!offer) continue;
    if (offer.target === "local") {
      if (local) continue;
      local = true;
    } else if (offers.some((seen) => seen.target === "host" && seen.hostId === offer.hostId)) {
      continue;
    }
    offers.push(offer);
  }
  return offers;
}

/**
 * Where this window works, right of the project switcher: "This Mac", or
 * "SSH · studio-01" with the window's light behind it, so a remote window reads
 * as a different place at a glance. Hidden until a host other than this machine
 * exists, and never in a build without Remote Hosts. Picking a host only goes
 * there, as it is; bringing the current branch along is its own item.
 */
export function HostChip() {
  const supported = isRemoteShellSupported();
  const hostList = useHostList();
  const windowHostId = getViewHostId() ?? LOCAL_HOST_ID;
  const isLocalWindow = windowHostId === LOCAL_HOST_ID;
  const connection = useHostConnectionStore((s) => s.connection);
  const storeHostName = useHostConnectionStore((s) => s.hostName);
  const latencyMs = useHostConnectionStore((s) => s.latencyMs);
  const latencySlowReading = useHostConnectionStore((s) => s.latencySlow);
  const lease = useDriveLeaseView();
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const [open, setOpen] = useState(false);
  // Which hosts were away when the menu opened: a host that wakes or drops
  // while it is open changes its words in place and changes section next time,
  // so no row moves under the pointer.
  const [awayAtOpen, setAwayAtOpen] = useState<ReadonlySet<string> | null>(null);
  const workingOnLabelId = useId();
  const cloudSnapshot = useCloudHosts().snapshot;
  const cloudHosts = cloudSnapshot.hosts;
  const cloudProviders = cloudSnapshot.providers;
  const cloudFor = (hostId: string) => cloudHosts.find((host) => host.hostId === hostId) ?? null;
  const machines = useCloudMachineActions();
  // Judges how old each machine's reading is; ticks only while there are cloud hosts.
  const now = useNow(cloudHosts.length > 0);
  // Each pick bumps it: a start that finishes after a newer pick doesn't switch the window.
  const pickGeneration = useRef(0);
  // Forwards riding on the link when Disconnect asked first; null while not asking.
  const [disconnectAsk, setDisconnectAsk] = useState<number | null>(null);
  const visible = supported && hasRemoteHosts(hostList);
  // Starting → Running and the rest, heard while Settings is closed too.
  const cloudNews = useCloudLifecycleNews(
    cloudHosts,
    (hostId) =>
      hostList.hosts.find((entry) => entry.descriptor.id === hostId)?.descriptor.name ?? hostId
  );

  if (!visible) return null;

  const localPlatform = clientPlatform();
  const rows = buildHostMenuRows(hostList.hosts, {
    localPlatform,
    currentHostId: windowHostId,
    localSummary: hostList.localSummary,
  });
  const currentRow = rows.find((row) => row.isCurrent) ?? rows[0]!;
  const name = isLocalWindow
    ? localHostLabel(localPlatform)
    : (storeHostName ?? currentRow.name ?? windowHostId);
  // "SSH · studio-01": the place and how it is reached, so a remote window never reads as local.
  // A Windows Shell reaches its hosts, WSL distros, one way only.
  const windowCloud = isLocalWindow ? null : cloudFor(windowHostId);
  const cloudProviderName = windowCloud
    ? (cloudProviders.find((provider) => provider.id === windowCloud.providerId)?.name ?? "Cloud")
    : null;
  const via = cloudProviderName ?? (remoteConnectionKind() === "wsl" ? "WSL" : "SSH");
  const locationLabel = isLocalWindow ? name : `${via} · ${name}`;
  // "build-east-01" and "build-east-02" differ only at the end of the machine's
  // own label: its head gives way, its tail never does, and a domain after it
  // ("….corp.example") gives way before either. An address keeps its whole tail.
  const { nameHead, nameTail, nameDomain } = splitHostName(name);
  // Straight away when only this window uses the link; when forwards ride on
  // it too, say what closes first. Nothing on the host stops either way.
  const requestDisconnect = () => {
    window.electron.portForwards.list().then(
      (forwards) => {
        const riding = forwards.filter((forward) => forward.hostId === windowHostId).length;
        if (riding > 0) setDisconnectAsk(riding);
        else void disconnectFromHost(windowHostId, name);
      },
      () => setDisconnectAsk(0)
    );
  };
  const status = hostChipStatus(isLocalWindow, connection, drivenElsewhereBy(lease));
  // A window on a cloud machine that isn't running says so, not that it can't log in.
  const windowMachineDown =
    windowCloud !== null && (windowCloud.machine !== "running" || windowCloud.operation !== null);
  const statusText = windowMachineDown ? cloudChipStatus(windowCloud) : hostChipStatusText(status);
  // How far away the host feels, while the link is healthy: a quiet reading
  // that steps up to full ink once typing would lag. Any state word replaces it.
  const latency =
    !isLocalWindow && statusText === null && latencyMs !== null ? Math.round(latencyMs) : null;
  const latencySlow = latency !== null && latencySlowReading;
  // A link that has gone quiet, can't be reached or refused the build is a problem
  // the person must see in the chip; connecting and a deliberate disconnect are not.
  const linkTrouble =
    !windowMachineDown &&
    (status === "quiet" ||
      status === "unreachable" ||
      status === "host-mode-off" ||
      status === "access-denied" ||
      status === "version-mismatch");
  const TroubleGlyph = SEVERITY_GLYPH.warning;
  // Down, deliberately or not: the same machine, crossed out, and the words in
  // full ink. Calm, since the window's banner already offers to connect.
  const linkDown = status === "disconnected";
  const HostGlyph = linkDown ? ServerOff : Server;
  // Only a refused build is offered an update; one that connected anyway is
  // noted in the host's details instead of competing with where you are.
  const mismatch = connection?.status === "version-mismatch" ? connection.mismatch : null;
  const updates = hostUpdateOffers(
    hostList.hosts.map(hostUpdateOffer),
    mismatch && !isLocalWindow
      ? {
          hostId: windowHostId,
          target: updateTargetFor(mismatch),
          label: updateActionLabel(mismatch, name),
        }
      : null
  );
  const overviewAvailable = actionService.has(HOSTS_OVERVIEW_ACTION_ID);

  // Navigation only: the host opens as it is (its copy of this project, else
  // this window's last project there, else its picker). Nothing is fetched,
  // pushed or created.
  const pick = (row: HostMenuRow, newWindow: boolean) => {
    if (row.isCurrent && !newWindow) return;
    const generation = ++pickGeneration.current;
    // A stopped cloud machine starts only on a yes that names what it costs.
    const cloud = cloudFor(row.hostId);
    if (cloud && canStartMachine(cloud) && row.connection?.status !== "connected") {
      machines.confirmStart({
        hostId: row.hostId,
        name: row.name,
        then: () => void switchToHost(row.hostId, newWindow),
        stale: () => pickGeneration.current !== generation,
      });
      return;
    }
    void switchToHost(row.hostId, newWindow);
  };
  const isAway = (row: HostMenuRow) => awayAtOpen?.has(row.hostId) ?? isHostMenuRowAway(row);
  const hereRows = rows.filter((row) => !isAway(row));
  const awayRows = rows.filter(isAway);
  const otherHosts = rows.filter((row) => !row.isCurrent);
  const otherHereRows = otherHosts.filter((row) => !isAway(row));
  const otherAwayRows = otherHosts.filter(isAway);
  const onOpenChange = (next: boolean) => {
    setAwayAtOpen(next ? new Set(rows.filter(isHostMenuRowAway).map((row) => row.hostId)) : null);
    setOpen(next);
  };
  // Only this device's link to the window's host: remote work keeps running,
  // and the window stays on the host to reconnect from.
  const canDisconnect =
    !isLocalWindow && (connection?.status === "connected" || connection?.status === "connecting");

  const trigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        data-toolbar-item=""
        data-testid="host-chip"
        data-host-status={status}
        data-host-location={isLocalWindow ? "local" : "remote"}
        aria-label={
          statusText ? `Working on ${locationLabel}, ${statusText}` : `Working on ${locationLabel}`
        }
        className={cn(
          // Quieter than the project pill beside it; only its menu takes a
          // select's shape. Locally it is a small text chip; on a host it
          // takes the pill's material a size down, lit by the light behind it.
          "app-no-drag pointer-events-auto ml-1.5 flex min-w-0 shrink items-center rounded-[var(--radius-md)] text-xs",
          "transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2",
          isLocalWindow
            ? "h-7 max-w-56 gap-1.5 px-2 text-text-secondary hover:bg-overlay-subtle hover:text-text-primary aria-expanded:bg-overlay-subtle aria-expanded:text-text-primary"
            : // A different place, not a problem, and not a second accent: the
              // window's light (toolbar/surface.css) says where it is, never a status
              // fill, which read as a warning beside the project pill. The
              // border also carries the shape under forced colours.
              "host-chip-remote relative h-8 max-w-72 gap-1.5 border px-2.5 text-text-primary"
        )}
      >
        {isLocalWindow ? (
          <PlatformGlyph platform={currentRow.platform} className="shrink-0" />
        ) : (
          <HostGlyph className="host-chip-source h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        {/* The name's middle gives way before the link's state, which never truncates. */}
        <span className="flex min-w-0 max-w-40 shrink font-medium">
          {isLocalWindow ? (
            <span className="truncate">{name}</span>
          ) : (
            <>
              {/* "SSH · " and the name's end never clip; only its middle gives way. */}
              <span className="shrink-0 whitespace-pre font-normal">
                {via} <FactSeparator />{" "}
              </span>
              <span className="min-w-0 truncate">{nameHead}</span>
              <span className="shrink-0">{nameTail}</span>
              {nameDomain && (
                <span className="host-chip-quiet-ink min-w-0 shrink-[100] truncate">
                  {nameDomain}
                </span>
              )}
            </>
          )}
        </span>
        {statusText && (
          // Never truncated: "no reply" is why typing goes nowhere.
          <span
            data-link-trouble={linkTrouble ? "" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1 whitespace-nowrap text-xs",
              linkTrouble || linkDown ? "font-medium text-text-primary" : "host-chip-quiet-ink"
            )}
          >
            {linkTrouble && (
              <TroubleGlyph
                className="h-3.5 w-3.5 shrink-0 text-status-warning"
                aria-hidden="true"
              />
            )}
            {statusText}
          </span>
        )}
        {latency !== null && (
          <span
            data-host-latency={latencySlow ? "slow" : ""}
            className={cn(
              "shrink-0 whitespace-nowrap text-xs tabular-nums",
              latencySlow ? "font-medium text-text-primary" : "host-chip-quiet-ink"
            )}
          >
            {latency} ms
          </span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
  );

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="bottom">
            {isLocalWindow
              ? "Working on this machine"
              : cloudProviderName
                ? `Working on ${name}, a ${cloudProviderName} machine, over SSH. Project files, terminals and agents run there${latency !== null ? `. ${latency} ms round trip` : ""}`
                : via === "WSL"
                  ? `Working in ${name} on WSL. Project files, terminals and agents run in that Linux distribution${latency !== null ? `. ${latency} ms round trip` : ""}`
                  : `Working on ${name} over SSH. Project files, terminals and agents run there${latency !== null ? `. ${latency} ms round trip` : ""}`}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="center" pointer className="w-72">
          <DropdownMenuGroup aria-labelledby={workingOnLabelId}>
            <DropdownMenuLabel id={workingOnLabelId}>Working on</DropdownMenuLabel>
            {hereRows.map((row) => (
              <HostMenuItem
                key={row.hostId}
                row={row}
                onPick={pick}
                cloud={cloudFor(row.hostId)}
                now={now}
              />
            ))}
          </DropdownMenuGroup>
          <AwayHostsGroup
            rows={awayRows}
            renderRow={(row) => (
              <HostMenuItem
                key={row.hostId}
                row={row}
                onPick={pick}
                cloud={cloudFor(row.hostId)}
                now={now}
              />
            )}
          />
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <TickColumn />
              <AppWindow data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
              Open in new window
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72">
              {hereRows.map((row) => (
                <DropdownMenuItem
                  key={row.hostId}
                  textValue={row.name}
                  className="group/host"
                  data-new-window-host-id={row.hostId}
                  onSelect={() => pick(row, true)}
                >
                  <SubmenuHostLabel row={row} />
                </DropdownMenuItem>
              ))}
              <AwayHostsGroup
                rows={awayRows}
                renderRow={(row) => (
                  <DropdownMenuItem
                    key={row.hostId}
                    textValue={row.name}
                    className="group/host"
                    data-new-window-host-id={row.hostId}
                    onSelect={() => pick(row, true)}
                  >
                    <SubmenuHostLabel row={row} />
                  </DropdownMenuItem>
                )}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {projectId && otherHosts.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <TickColumn />
                <GitBranch data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
                Continue this branch on…
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72">
                {otherHereRows.map((row) => (
                  <DropdownMenuItem
                    key={row.hostId}
                    textValue={row.name}
                    className="group/host"
                    data-continue-host-id={row.hostId}
                    onSelect={() => void openProjectOnHost(row.hostId, projectId)}
                  >
                    <SubmenuHostLabel row={row} />
                  </DropdownMenuItem>
                ))}
                <AwayHostsGroup
                  rows={otherAwayRows}
                  separated={otherHereRows.length > 0}
                  renderRow={(row) => (
                    <DropdownMenuItem
                      key={row.hostId}
                      textValue={row.name}
                      className="group/host"
                      data-continue-host-id={row.hostId}
                      onSelect={() => void openProjectOnHost(row.hostId, projectId)}
                    >
                      <SubmenuHostLabel row={row} />
                    </DropdownMenuItem>
                  )}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {cloudHosts.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="host-chip-cloud-machines">
                <TickColumn />
                <Cloud data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
                Cloud machines
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72">
                {cloudHosts.map((cloud) => {
                  const hostName =
                    rows.find((row) => row.hostId === cloud.hostId)?.name ?? cloud.hostId;
                  const busy = machines.isPending(cloud.hostId) || cloud.operation !== null;
                  const stoppable = canStopMachine(cloud);
                  const startable = canStartMachine(cloud);
                  // Unknown is no reason to start or stop it: the way forward is asking again.
                  const checkable = !stoppable && !startable && cloud.machine === "unknown";
                  const stale = isObservationStale(cloud, now);
                  const Glyph = stoppable ? PowerOff : checkable ? RefreshCw : Power;
                  const verb = stoppable ? "Stop" : checkable ? "Check" : "Start";
                  // The price beside both verbs: what it costs now, or what starting it costs.
                  const detail = [
                    cloudStatusLabel(cloud, stale),
                    ...cloudCostFacts(cloud),
                    cloud.accountName,
                    stale || checkable
                      ? cloud.observedAt !== null
                        ? `checked ${formatTimeAgo(cloud.observedAt, now)}`
                        : "never checked"
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <DropdownMenuItem
                      key={cloud.hostId}
                      className="items-start"
                      data-cloud-machine-host-id={cloud.hostId}
                      disabled={busy || (!stoppable && !startable && !checkable)}
                      textValue={hostName}
                      onSelect={() =>
                        stoppable
                          ? machines.requestStop(cloud.hostId, hostName)
                          : checkable
                            ? machines.check(cloud.hostId)
                            : machines.start(cloud.hostId)
                      }
                    >
                      <Glyph
                        data-menu-icon
                        className={cn(MENU_ICON_CLASS, "mt-px")}
                        aria-hidden="true"
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="break-words">
                          {verb} {hostName}
                        </span>
                        <span className="text-2xs text-text-secondary">{detail}</span>
                        {/* The provider's last refusal, from wherever it was asked, until something succeeds. */}
                        {(machines.errorFor(cloud.hostId) ??
                          (cloud.operation === null ? cloud.lastError?.message : null)) && (
                          <span className="text-2xs text-status-error">
                            {machines.errorFor(cloud.hostId) ?? cloud.lastError?.message}
                          </span>
                        )}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {updates.length > 0 && <DropdownMenuSeparator />}
          {updates.map((offer) => (
            <DropdownMenuItem
              key={offer.target === "local" ? "local" : offer.hostId}
              data-update-host-id={offer.hostId}
              onSelect={() => runHostUpdate(offer.target, offer.hostId)}
            >
              <TickColumn />
              <CircleArrowUp data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
              {offer.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {overviewAvailable && (
            <DropdownMenuActionItem actionId={HOSTS_OVERVIEW_ACTION_ID}>
              <TickColumn />
              <Server data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
              Hosts overview…
            </DropdownMenuActionItem>
          )}
          <DropdownMenuActionItem actionId="host.add">
            <TickColumn />
            <Plus data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
            Add host…
          </DropdownMenuActionItem>
          <DropdownMenuItem onSelect={openHostsSettingsTab}>
            <TickColumn />
            <Settings2 data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
            Manage hosts…
          </DropdownMenuItem>
          {canDisconnect && (
            <>
              <DropdownMenuSeparator />
              {/* Two lines rather than one that wraps: the host it names and
                  the scope ("this device", nothing on the host stops). */}
              <DropdownMenuItem
                data-testid="host-chip-disconnect"
                className="items-start"
                aria-label={`Disconnect ${name} from this device`}
                onSelect={requestDisconnect}
              >
                <TickColumn />
                <Unplug
                  data-menu-icon
                  className={cn(MENU_ICON_CLASS, "mt-px")}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="break-words">Disconnect {name}</span>
                  <span className="text-2xs text-text-secondary">From this device</span>
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        isOpen={disconnectAsk !== null}
        onClose={() => setDisconnectAsk(null)}
        variant="default"
        title={`Disconnect ${name} from this device?`}
        description={
          disconnectAsk
            ? `${pluralize(disconnectAsk, "forwarded port")} from ${name} ${disconnectAsk === 1 ? "closes" : "close"} here. Remote work on ${name} isn't stopped, and this window can reconnect.`
            : `Remote work on ${name} isn't stopped, and this window can reconnect.`
        }
        confirmLabel="Disconnect"
        onConfirm={() => {
          setDisconnectAsk(null);
          void disconnectFromHost(windowHostId, name);
        }}
      />
      {machines.dialogs}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {cloudNews}
      </div>
    </>
  );
}
