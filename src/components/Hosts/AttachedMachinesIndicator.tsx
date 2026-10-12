import { useEffect, useId, useState } from "react";
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
import { useProjectStore } from "@/store/projectStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { useDriveLeaseView } from "@/components/Recovery/driveLeaseState";
import { takeControl, useTakeControlPending } from "@/components/Recovery/takeControl";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type { AttachedClientInfo, HostModeStatus } from "@shared/types/ipc/hostMode";

/** Who is attached, from a status that may be missing (no Host mode answer yet). */
function attachedOf(status: HostModeStatus | null | undefined): AttachedClientInfo[] {
  return status?.listening ? (status.attachedClients ?? []) : [];
}

/**
 * Say who connected or left, and which other projects a connected machine
 * took or let go, from a push; the pill's own label changing is silent. This
 * window's own project is said by its lease state, so it is left out here.
 */
function announcePresenceChanges(previous: AttachedClientInfo[], next: AttachedClientInfo[]): void {
  const announce = useAnnouncerStore.getState().announce;
  const thisProjectId = getViewWorkspaceId();
  const names = new Map(useProjectStore.getState().projects.map((p) => [p.id, p.name]));
  const projectName = (id: string) => names.get(id) ?? "a project";
  const earlier = new Map(previous.map((c) => [c.clientId, c]));
  const later = new Set(next.map((c) => c.clientId));
  for (const client of next) {
    const was = earlier.get(client.clientId);
    if (!was) {
      announce(`${client.clientName} connected to this machine`);
      continue;
    }
    const held = new Set(was.drivingProjectIds);
    const holds = new Set(client.drivingProjectIds);
    for (const id of holds) {
      if (!held.has(id) && id !== thisProjectId) {
        announce(`${client.clientName} has control of ${projectName(id)}`);
      }
    }
    for (const id of held) {
      if (!holds.has(id) && id !== thisProjectId) {
        announce(`${client.clientName} no longer controls ${projectName(id)}`);
      }
    }
  }
  for (const client of previous) {
    if (!later.has(client.clientId)) announce(`${client.clientName} disconnected`);
  }
}

/** The machines attached to this one now, kept current by Host mode's pushes. */
function useAttachedMachines(enabled: boolean): AttachedClientInfo[] {
  const [clients, setClients] = useState<AttachedClientInfo[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // A push that lands first is newer than the read that was already out.
    let pushed = false;
    let current: AttachedClientInfo[] = [];
    const off = hostModeClient.onEvent((event) => {
      if (active && event.type === "status-changed") {
        pushed = true;
        const next = attachedOf(event.status);
        announcePresenceChanges(current, next);
        current = next;
        setClients(next);
      }
    });
    hostModeClient.getStatus().then(
      (status) => {
        if (!active || pushed) return;
        current = attachedOf(status);
        setClients(current);
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

/** Project names, this window's first; ids the host doesn't list here are counted, not named. */
function controlledProjects(
  client: AttachedClientInfo,
  names: ReadonlyMap<string, string>,
  thisProjectId: string | null
): { named: string[]; unnamed: number; includesThis: boolean } {
  const ids = [...client.drivingProjectIds].sort((a, b) =>
    a === thisProjectId ? -1 : b === thisProjectId ? 1 : 0
  );
  const named = ids.flatMap((id) => {
    const name = names.get(id);
    return name ? [id === thisProjectId ? `${name} (this window)` : name] : [];
  });
  return {
    named,
    unnamed: ids.length - named.length,
    includesThis: thisProjectId !== null && ids.includes(thisProjectId),
  };
}

const listFormat = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" });

function describeControl(
  client: AttachedClientInfo,
  names: ReadonlyMap<string, string>,
  thisProjectId: string | null
): string {
  const { named, unnamed } = controlledProjects(client, names, thisProjectId);
  if (named.length === 0 && unnamed === 0) return "Controls no projects";
  const parts = [...named];
  if (unnamed > 0) {
    parts.push(
      named.length > 0 ? pluralize(unnamed, "other project") : pluralize(unnamed, "project")
    );
  }
  return `Has control of ${listFormat.format(parts)}`;
}

function connectedAt(client: AttachedClientInfo): string {
  // A clock time, not "5 minutes ago": nothing re-renders the menu as time passes.
  return `Connected at ${new Date(client.connectedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

/**
 * The pill's words, as who and what: the state is what the pill exists to say,
 * so only the name gives way when the toolbar is tight.
 */
export function describeAttachedMachines(clients: readonly AttachedClientInfo[]): {
  who: string;
  state: string;
} {
  const controlling = clients.filter((c) => c.drivingProjectIds.length > 0);
  if (clients.length === 1) {
    const only = clients[0]!;
    return {
      who: only.clientName,
      state:
        controlling.length === 0
          ? "connected"
          : `controls ${pluralize(only.drivingProjectIds.length, "project")}`,
    };
  }
  return {
    who: pluralize(clients.length, "machine"),
    state:
      controlling.length === 0
        ? "connected"
        : `· ${controlling.length} ${controlling.length === 1 ? "has" : "have"} control`,
  };
}

/**
 * On the host's own screen: other machines connected to this one, and which
 * projects each has control of. Shown only while the host has a live session
 * from one, and only in a window that runs here; a window showing another host
 * is about that host, not this one. Connected and in control read differently,
 * so a machine that is only connected never looks like it took anything.
 */
export function AttachedMachinesIndicator() {
  const enabled = isRemoteHostSupported() && getViewHostId() === null;
  const clients = useAttachedMachines(enabled);
  const projects = useProjectStore((s) => s.projects);
  const lease = useDriveLeaseView();
  const taking = useTakeControlPending(lease?.projectId);
  const rosterId = useId();
  if (clients.length === 0) return null;

  const names = new Map(projects.map((p) => [p.id, p.name]));
  const thisProjectId = lease?.projectId ?? null;
  const { who, state } = describeAttachedMachines(clients);
  const label = `${who} ${state}`;
  const controlledHere =
    lease !== null && lease.holder !== null && !lease.drivingHere && !lease.holder.isHostLocal
      ? lease
      : null;
  const thisProjectName = (thisProjectId && names.get(thisProjectId)) ?? "this project";

  // The menu's rows aren't items, so arrowing through it never reaches them;
  // the trigger carries the same roster as its description.
  const roster = clients
    .map((c) => `${c.clientName}: ${describeControl(c, names, thisProjectId)}`)
    .join(". ");

  return (
    <DropdownMenu>
      <span id={rosterId} className="sr-only">
        {roster}
      </span>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-toolbar-item=""
          data-testid="attached-machines-indicator"
          aria-label={label}
          aria-describedby={rosterId}
          className={cn(
            "app-no-drag pointer-events-auto ml-1.5 flex h-7 min-w-0 max-w-56 shrink items-center gap-1.5 rounded-[var(--radius-md)] border border-border-default px-2 text-xs",
            "text-text-primary transition-colors hover:bg-overlay-subtle aria-expanded:bg-overlay-subtle",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2"
          )}
        >
          <ScreenShare className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
          {/* One phrase: only the name gives way, and the space before the state stays a space. */}
          <span className="flex min-w-0">
            <span className="min-w-0 truncate">{who}</span>
            <span className="shrink-0 whitespace-pre">{` ${state}`}</span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-88">
        <DropdownMenuLabel>Connected to this machine</DropdownMenuLabel>
        {clients.map((client) => {
          const { includesThis } = controlledProjects(client, names, thisProjectId);
          return (
            <div key={client.clientId} className="px-2 py-1.5">
              {/* The menu is where a name the pill shortened is read in full. */}
              <div className="min-w-0 wrap-anywhere text-sm font-medium text-text-primary">
                {client.clientName}
              </div>
              <div
                className={cn(
                  "mt-0.5 text-xs",
                  includesThis ? "text-text-primary" : "text-text-secondary"
                )}
              >
                {describeControl(client, names, thisProjectId)}
              </div>
              <div className="mt-0.5 text-2xs text-text-secondary">{connectedAt(client)}</div>
            </div>
          );
        })}
        <DropdownMenuSeparator />
        {controlledHere && (
          <DropdownMenuItem
            disabled={taking}
            onSelect={() => void takeControl(controlledHere.projectId)}
          >
            Take control of {thisProjectName}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() =>
            safeFireAndForget(
              actionService.dispatch("app.settings.openTab", { tab: "hosts" }, { source: "user" }),
              { context: "Opening host settings from the connected-machines menu" }
            )
          }
        >
          Host settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
