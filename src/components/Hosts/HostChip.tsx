import { useEffect, useState } from "react";
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
import { Server } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { pluralize } from "@/lib/pluralize";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
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
import { onHostMenuRequest } from "./hostMenuRequests";
import { openHostsSettingsTab } from "@/components/Settings/Hosts/hostSettingsRequests";
import {
  HOSTS_OVERVIEW_ACTION_ID,
  buildHostMenuRows,
  clientPlatform,
  describeHostMenuState,
  shortHostName,
  hostChipStatus,
  hostChipStatusText,
  localHostLabel,
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

function HostSubmenuLabel({ row }: { row: HostMenuRow }) {
  return (
    <>
      <span className="mr-2 flex w-3.5 shrink-0 justify-center text-text-secondary">
        <PlatformGlyph platform={row.platform} />
      </span>
      <span className="truncate">{row.name}</span>
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
  return (
    <DropdownMenuItem
      className="items-start gap-2"
      data-host-id={row.hostId}
      aria-current={row.isCurrent ? "true" : undefined}
      onClick={(event) => onPick(row, isNewWindowClick(event))}
    >
      <span className="flex h-4 w-3.5 shrink-0 items-center" aria-hidden="true">
        {row.isCurrent && <Check className="h-3.5 w-3.5 text-text-secondary" />}
      </span>
      <span className="flex h-4 shrink-0 items-center text-text-secondary">
        <PlatformGlyph platform={row.platform} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-3">
          {/* Wraps rather than truncates: "build-east-01" and "build-east-02" differ at the end. */}
          <span className="min-w-0 break-words font-medium text-text-primary">{row.name}</span>
          {state && <span className="ml-auto shrink-0 text-2xs text-text-secondary">{state}</span>}
        </span>
        {note && <span className="text-2xs text-text-secondary">{note}</span>}
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
 * "SSH · studio-01" on a host's tinted surface so a remote window reads as a
 * different place at a glance. Hidden until a host other than this machine
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
  const lease = useDriveLeaseView();
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const [open, setOpen] = useState(false);
  // Forwards riding on the link when Disconnect asked first; null while not asking.
  const [disconnectAsk, setDisconnectAsk] = useState<number | null>(null);
  const visible = supported && hasRemoteHosts(hostList);

  useEffect(() => {
    if (!visible) return;
    return onHostMenuRequest(() => setOpen(true));
  }, [visible]);

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
  const locationLabel = isLocalWindow ? name : `SSH · ${name}`;
  const shortName = shortHostName(name);
  const nameTail = shortName.slice(-8);
  const nameHead = shortName.slice(0, -8);
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
          // steps up a size, since working elsewhere is the thing to notice.
          "app-no-drag pointer-events-auto ml-1.5 flex min-w-0 shrink items-center rounded-[var(--radius-md)]",
          "transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2",
          isLocalWindow
            ? "h-7 max-w-56 gap-1.5 px-2 text-xs text-text-secondary hover:bg-overlay-subtle hover:text-text-primary aria-expanded:bg-overlay-subtle aria-expanded:text-text-primary"
            : // A different place, not a problem, and not a second accent: the same
              // neutral bordered surface as the toolbar's other pills, one step up in
              // size and weight. The server glyph and "SSH ·" say where the window
              // is; a status fill read as a warning stripe beside the project pill.
              // The border also carries the shape under forced colours.
              "h-8 max-w-64 gap-2 border border-border-default bg-overlay-subtle px-2.5 text-sm text-text-primary hover:bg-overlay-hover aria-expanded:bg-overlay-hover"
        )}
      >
        {isLocalWindow ? (
          <PlatformGlyph platform={currentRow.platform} className="shrink-0" />
        ) : (
          <Server className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        )}
        {/* The place is what this control exists to say: a state note truncates first. */}
        <span className="flex min-w-0 max-w-48 shrink-0 font-medium">
          {isLocalWindow ? (
            <span className="truncate">{name}</span>
          ) : (
            <>
              {/* "SSH · " and the name's end never clip; only its middle gives way. */}
              <span className="shrink-0 whitespace-pre">SSH · </span>
              <span className="min-w-0 truncate">{nameHead}</span>
              <span className="shrink-0">{nameTail}</span>
            </>
          )}
        </span>
        {statusText && (
          <span className="min-w-0 truncate text-2xs text-text-secondary">
            {statusText}
          </span>
        )}
        <ChevronDown
          className="h-3 w-3 shrink-0 text-text-secondary"
          aria-hidden="true"
        />
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
              : `Working on ${name} over SSH. Project files, terminals and agents run there`}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="center" pointer className="w-64">
          <DropdownMenuLabel>Working on</DropdownMenuLabel>
          {rows.map((row) => (
            <HostMenuItem key={row.hostId} row={row} onPick={pick} />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Open in new window</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-44">
              {rows.map((row) => (
                <DropdownMenuItem
                  key={row.hostId}
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
              <DropdownMenuSubTrigger>Continue this branch on…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                {otherHosts.map((row) => (
                  <DropdownMenuItem
                    key={row.hostId}
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
              {offer.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {overviewAvailable && (
            <DropdownMenuActionItem actionId={HOSTS_OVERVIEW_ACTION_ID}>
              Hosts overview…
            </DropdownMenuActionItem>
          )}
          <DropdownMenuActionItem actionId="host.add">Add host…</DropdownMenuActionItem>
          <DropdownMenuItem onSelect={openHostsSettingsTab}>Manage hosts…</DropdownMenuItem>
          {canDisconnect && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-testid="host-chip-disconnect" onSelect={requestDisconnect}>
                Disconnect {name} from this device
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
