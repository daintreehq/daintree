import { useEffect, useState } from "react";
import { ScreenShare } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { isRemoteHostSupported } from "@/lib/remoteHosts";
import { hostModeClient } from "@/clients/hostModeClient";
import { getViewHostId } from "@/hooks/useHostConnection";
import { actionService } from "@/services/ActionService";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { AttachedClientInfo, HostModeStatus } from "@shared/types/ipc/hostMode";

/** Who is attached, from a status that may be missing (no Host mode answer yet). */
function attachedOf(status: HostModeStatus | null | undefined): AttachedClientInfo[] {
  return status?.listening ? (status.attachedClients ?? []) : [];
}

/** The machines attached to this one now, kept current by Host mode's pushes. */
function useAttachedMachines(enabled: boolean): AttachedClientInfo[] {
  const [clients, setClients] = useState<AttachedClientInfo[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // A push that lands first is newer than the read that was already out.
    let pushed = false;
    const off = hostModeClient.onEvent((event) => {
      if (active && event.type === "status-changed") {
        pushed = true;
        setClients(attachedOf(event.status));
      }
    });
    hostModeClient.getStatus().then(
      (status) => {
        if (active && !pushed) setClients(attachedOf(status));
      },
      () => {}
    );
    return () => {
      active = false;
      off();
    };
  }, [enabled]);
  return enabled ? clients : [];
}

function describeClient(client: AttachedClientInfo): string {
  const driving = client.drivingProjectIds.length;
  // A clock time, not "5 minutes ago": nothing re-renders the menu as time passes.
  const since = `connected at ${new Date(client.connectedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
  return driving > 0 ? `${since} · driving ${pluralize(driving, "project")}` : since;
}

/**
 * On the host's own screen: another machine is attached to this one. Shown
 * only while the host has a live session from it, and only in a window that
 * runs here; a window showing another host is about that host, not this one.
 */
export function AttachedMachinesIndicator() {
  const enabled = isRemoteHostSupported() && getViewHostId() === null;
  const clients = useAttachedMachines(enabled);
  if (clients.length === 0) return null;

  const label =
    clients.length === 1 ? clients[0]!.clientName : pluralize(clients.length, "machine");
  const names = clients.map((c) => c.clientName).join(", ");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-toolbar-item=""
          data-testid="attached-machines-indicator"
          aria-label={`In use from ${names}`}
          className={cn(
            "app-no-drag pointer-events-auto ml-1.5 flex h-7 min-w-0 max-w-48 shrink items-center gap-1.5 rounded-[var(--radius-md)] border border-border-default px-2 text-xs",
            "text-text-primary transition-colors hover:bg-overlay-subtle aria-expanded:bg-overlay-subtle",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2"
          )}
        >
          <ScreenShare className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="min-w-0 truncate">In use from {label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>In use from</DropdownMenuLabel>
        {clients.map((client) => (
          <div key={client.clientId} className="px-2 py-1.5">
            <div className="truncate text-sm font-medium text-text-primary">
              {client.clientName}
            </div>
            <div className="text-2xs text-text-secondary">{describeClient(client)}</div>
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            safeFireAndForget(
              actionService.dispatch("app.settings.openTab", { tab: "hosts" }, { source: "user" }),
              { context: "Opening host settings from the in-use indicator" }
            )
          }
        >
          Host settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
