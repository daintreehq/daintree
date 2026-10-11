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
import {
  HOSTS_OVERVIEW_ACTION_ID,
  buildHostMenuRows,
  clientPlatform,
  describeHostAgentClis,
  describeHostRowMetrics,
  describeHostRowStatus,
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

function HostMenuItem({
  row,
  onPick,
}: {
  row: HostMenuRow;
  onPick: (row: HostMenuRow, newWindow: boolean) => void;
}) {
  const status = describeHostRowStatus(row);
  const metrics = describeHostRowMetrics(row);
  const clis = describeHostAgentClis(row);
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
          <span className="truncate font-medium text-text-primary">{row.name}</span>
          {metrics && (
            <span className="ml-auto shrink-0 text-2xs tabular-nums text-text-secondary">
              {metrics}
            </span>
          )}
        </span>
        {status && <span className="text-2xs text-text-secondary">{status}</span>}
        {clis && <span className="truncate text-2xs text-text-secondary">{clis}</span>}
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
  const status = hostChipStatus(isLocalWindow, connection, drivenElsewhereBy(lease));
  const statusText = hostChipStatusText(status);
  const mismatch =
    connection?.status === "version-mismatch"
      ? connection.mismatch
      : connection?.status === "connected"
        ? (connection.buildMismatch ?? null)
        : null;
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
          "app-no-drag pointer-events-auto ml-1.5 flex h-7 min-w-0 max-w-56 shrink items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-xs",
          "transition-colors focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2",
          isLocalWindow
            ? "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary aria-expanded:bg-overlay-subtle aria-expanded:text-text-primary"
            : // A different place, not a problem: a solid informational block (the
              // remote indicator other editors use), never a warning colour. Its
              // text takes whichever of black or white reads on the fill, so it
              // holds in every theme and colour-vision override; forced colours
              // drop the fill, so a system border keeps the block visible.
              "bg-status-info [color:contrast-color(var(--color-status-info))] forced-colors:border forced-colors:border-[CanvasText]"
        )}
      >
        {isLocalWindow ? (
          <PlatformGlyph platform={currentRow.platform} className="shrink-0" />
        ) : (
          <Server className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate font-medium">{locationLabel}</span>
        {statusText && (
          <span className={cn("shrink-0 text-2xs", isLocalWindow && "text-text-secondary")}>
            {statusText}
          </span>
        )}
        <ChevronDown
          className={cn("h-3 w-3 shrink-0", isLocalWindow && "text-text-secondary")}
          aria-hidden="true"
        />
      </button>
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="bottom">
          {isLocalWindow
            ? "Working on this machine"
            : `Working on ${name} over SSH. Project files, terminals and agents run there`}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Working on</DropdownMenuLabel>
        {rows.map((row) => (
          <HostMenuItem key={row.hostId} row={row} onPick={pick} />
        ))}
        {projectId && otherHosts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Continue this branch on…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-44">
                {otherHosts.map((row) => (
                  <DropdownMenuItem
                    key={row.hostId}
                    data-continue-host-id={row.hostId}
                    onSelect={() => void openProjectOnHost(row.hostId, projectId)}
                  >
                    <span className="mr-2 flex w-3.5 shrink-0 justify-center text-text-secondary">
                      <PlatformGlyph platform={row.platform} />
                    </span>
                    <span className="truncate">{row.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
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
        <DropdownMenuActionItem actionId="host.add">Add host…</DropdownMenuActionItem>
        {overviewAvailable && (
          <DropdownMenuActionItem actionId={HOSTS_OVERVIEW_ACTION_ID}>
            Hosts overview…
          </DropdownMenuActionItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
