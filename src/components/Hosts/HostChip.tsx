import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import {
  DropdownMenu,
  DropdownMenuActionItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AppWindow,
  CircleArrowUp,
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
import { isNewWindowClick, switchToHost } from "./hostSwitching";
import { hostUpdateOffer, runHostUpdate, type HostUpdateOffer } from "./hostUpdate";
import { hasRemoteHosts, useHostList } from "./hostList";
import { openHostsSettingsTab } from "@/components/Settings/Hosts/hostSettingsRequests";
import {
  HOSTS_OVERVIEW_ACTION_ID,
  buildHostMenuRows,
  clientPlatform,
  describeHostMenuState,
  hostChipStatus,
  hostMenuNoteAge,
  hostMenuRowHasTrouble,
  hostChipStatusText,
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
  return (
    <>
      <span className="mr-2 flex self-start">
        <HostMark row={row} />
      </span>
      {/* Laid out like the host list: the name keeps the row, and its state
          drops to a line of its own rather than squeezing the name's end. */}
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4">
        <span className="max-w-full break-words">{row.name}</span>
        {state && (
          <span
            className={cn(
              "ml-auto shrink-0 text-2xs",
              trouble ? "text-text-primary" : "text-text-secondary"
            )}
          >
            {state}
          </span>
        )}
      </span>
    </>
  );
}

function HostMenuItem({
  row,
  onPick,
}: {
  row: HostMenuRow;
  onPick: (row: HostMenuRow, newWindow: boolean) => void;
}) {
  const { state, note } = describeHostMenuState(row);
  // A link that has gone wrong carries the chip's own warning mark and full
  // ink; connecting and not connected stay quiet, and connected never goes green.
  const trouble = hostMenuRowHasTrouble(row);
  const noteAge = hostMenuNoteAge(row);
  const TroubleGlyph = SEVERITY_GLYPH.warning;
  return (
    <DropdownMenuItem
      className="items-start gap-2"
      data-host-id={row.hostId}
      aria-current={row.isCurrent ? "true" : undefined}
      textValue={row.name}
      onClick={(event) => onPick(row, isNewWindowClick(event))}
    >
      <span className="flex h-4 w-3.5 shrink-0 items-center" aria-hidden="true">
        {row.isCurrent && <Check className="h-3.5 w-3.5 text-text-primary" />}
      </span>
      <HostMark row={row} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The name keeps the whole row when it needs it and the state drops
            below it: "build-east-01" and "build-east-02" differ at the end. */}
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
          <span
            className={cn(
              "max-w-full break-words text-text-primary",
              row.isCurrent ? "font-semibold" : "font-medium"
            )}
          >
            {row.name}
          </span>
          {state && (
            <span
              data-host-trouble={trouble ? "" : undefined}
              className={cn(
                "ml-auto flex shrink-0 items-baseline gap-1 text-2xs",
                trouble || row.isCurrent ? "font-medium text-text-primary" : "text-text-secondary"
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
  // Forwards riding on the link when Disconnect asked first; null while not asking.
  const [disconnectAsk, setDisconnectAsk] = useState<number | null>(null);
  const visible = supported && hasRemoteHosts(hostList);

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
  const via = remoteConnectionKind() === "wsl" ? "WSL" : "SSH";
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
  const statusText = hostChipStatusText(status);
  // How far away the host feels, while the link is healthy: a quiet reading
  // that steps up to full ink once typing would lag. Any state word replaces it.
  const latency =
    !isLocalWindow && statusText === null && latencyMs !== null ? Math.round(latencyMs) : null;
  const latencySlow = latency !== null && latencySlowReading;
  // A link that has gone quiet, can't be reached or refused the build is a problem
  // the person must see in the chip; connecting and a deliberate disconnect are not.
  const linkTrouble =
    status === "quiet" ||
    status === "unreachable" ||
    status === "host-mode-off" ||
    status === "access-denied" ||
    status === "version-mismatch";
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

  // Navigation only: the host opens as it is (this window's last project
  // there, or its picker). Nothing is fetched, pushed or created.
  const pick = (row: HostMenuRow, newWindow: boolean) => {
    if (row.isCurrent && !newWindow) return;
    void switchToHost(row.hostId, newWindow);
  };
  const otherHosts = rows.filter((row) => !row.isCurrent);
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
              <span className="shrink-0 whitespace-pre font-normal">{via} · </span>
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
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="bottom">
            {isLocalWindow
              ? "Working on this machine"
              : via === "WSL"
                ? `Working in ${name} on WSL. Project files, terminals and agents run in that Linux distribution${latency !== null ? `. ${latency} ms round trip` : ""}`
                : `Working on ${name} over SSH. Project files, terminals and agents run there${latency !== null ? `. ${latency} ms round trip` : ""}`}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="center" pointer className="w-72">
          <DropdownMenuLabel>Working on</DropdownMenuLabel>
          {rows.map((row) => (
            <HostMenuItem key={row.hostId} row={row} onPick={pick} />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <TickColumn />
              <AppWindow data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
              Open in new window
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-60">
              {rows.map((row) => (
                <DropdownMenuItem
                  key={row.hostId}
                  textValue={row.name}
                  data-new-window-host-id={row.hostId}
                  onSelect={() => void switchToHost(row.hostId, true)}
                >
                  <HostSubmenuLabel row={row} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {projectId && otherHosts.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <TickColumn />
                <GitBranch data-menu-icon className={MENU_ICON_CLASS} aria-hidden="true" />
                Continue this branch on…
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                {otherHosts.map((row) => (
                  <DropdownMenuItem
                    key={row.hostId}
                    textValue={row.name}
                    data-continue-host-id={row.hostId}
                    onSelect={() => void openProjectOnHost(row.hostId, projectId)}
                  >
                    <HostSubmenuLabel row={row} />
                  </DropdownMenuItem>
                ))}
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
    </>
  );
}
