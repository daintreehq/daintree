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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
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
 * The window's host, left of the project switcher. Hidden until a host other
 * than this machine exists, and never in a build without Remote Hosts. Neutral
 * on purpose: which machine the window is on is context, not a call to act.
 */
export function HostChip() {
  const supported = isRemoteHostsSupported();
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
  const status = hostChipStatus(isLocalWindow, connection, drivenElsewhereBy(lease));
  const statusText = hostChipStatusText(status);
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

  const pick = (row: HostMenuRow, newWindow: boolean) => {
    if (row.isCurrent && !newWindow) return;
    // With a project open, switching this window means bringing the project
    // along; a new window just opens the host.
    if (projectId && !newWindow) {
      void openProjectOnHost(row.hostId, projectId);
      return;
    }
    void switchToHost(row.hostId, newWindow);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-toolbar-item=""
          data-testid="host-chip"
          data-host-status={status}
          aria-label={statusText ? `Host: ${name}, ${statusText}` : `Host: ${name}`}
          className={cn(
            "app-no-drag pointer-events-auto mr-2 flex h-7 min-w-0 max-w-48 shrink items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-xs",
            "text-text-secondary transition-colors hover:bg-overlay-subtle hover:text-text-primary aria-expanded:bg-overlay-subtle aria-expanded:text-text-primary",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2"
          )}
        >
          <PlatformGlyph platform={currentRow.platform} className="shrink-0" />
          <span className="min-w-0 truncate font-medium">{name}</span>
          {statusText && <span className="shrink-0 text-2xs">{statusText}</span>}
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>Hosts</DropdownMenuLabel>
        {rows.map((row) => (
          <HostMenuItem key={row.hostId} row={row} onPick={pick} />
        ))}
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
