import { Check, ChevronDown } from "lucide-react";
import type { HostId } from "@shared/types/remoteHosts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Server } from "@/components/icons";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { cn } from "@/lib/utils";
import { AgentCounts } from "@/components/Hosts/AgentCounts";
import { HostNameText } from "@/components/Hosts/HostNameText";
import { PlatformGlyph } from "@/components/Hosts/PlatformGlyph";
import { hasRemoteHosts, useHostList } from "@/components/Hosts/hostList";
import {
  buildHostMenuRows,
  clientPlatform,
  describeHostMenuState,
  hostMenuNoteAge,
  hostMenuRowHasTrouble,
  liveSummary,
  type HostMenuRow,
} from "@/components/Hosts/hostModel";

const TroubleGlyph = SEVERITY_GLYPH.warning;

/** The host's platform mark, or a plain machine until a handshake says which. */
function HostMark({ row }: { row: HostMenuRow }) {
  return (
    <span
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

/** The link's words worth saying on the trigger: none while it simply works. */
function triggerState(row: HostMenuRow): string | null {
  const { state } = describeHostMenuState(row);
  return state === "Local" || state === "Connected" ? null : state;
}

/**
 * The hosts this machine can see, every one in the chip's own words, with
 * each host's waiting and working agents beside it: in Canopy the question is
 * which machine has agents waiting. The host this window is on is the default.
 */
export function useCanopyHostRows(shownHostId: HostId): HostMenuRow[] | null {
  const hostList = useHostList();
  if (!isRemoteShellSupported() || !hasRemoteHosts(hostList)) return null;
  return buildHostMenuRows(hostList.hosts, {
    localPlatform: clientPlatform(),
    currentHostId: shownHostId,
    localSummary: hostList.localSummary,
  });
}

function HostPickerItem({ row, onPick }: { row: HostMenuRow; onPick: (hostId: HostId) => void }) {
  const { state, note } = describeHostMenuState(row);
  const trouble = hostMenuRowHasTrouble(row);
  const noteAge = hostMenuNoteAge(row);
  const summary = liveSummary(row);
  return (
    <DropdownMenuItem
      className="items-start gap-2"
      data-host-id={row.hostId}
      aria-current={row.isCurrent ? "true" : undefined}
      textValue={row.name}
      onSelect={() => onPick(row.hostId)}
    >
      <span className="flex h-4 w-3.5 shrink-0 items-center" aria-hidden="true">
        {row.isCurrent && <Check className="h-3.5 w-3.5 text-text-primary" />}
      </span>
      <HostMark row={row} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
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
      {/* Only what the host is reporting now: a host that isn't connected has said nothing new. */}
      <span className="flex w-16 shrink-0 justify-end" data-host-agents="">
        {summary && <AgentCounts summary={summary} />}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * Which machine's agents Canopy shows, in the centre of its header: This Mac,
 * or any host added here. Drawn like the toolbar's host chip, and shown only
 * where the chip is. Picking a host only changes what the panel reads.
 */
export function CanopyHostPicker({
  rows,
  onPick,
}: {
  rows: readonly HostMenuRow[];
  onPick: (hostId: HostId) => void;
}) {
  const shown = rows.find((row) => row.isCurrent) ?? rows[0]!;
  const state = triggerState(shown);
  const trouble = hostMenuRowHasTrouble(shown);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="canopy-host-picker"
          data-host-id={shown.hostId}
          aria-label={`Showing agents on ${shown.name}${state ? `, ${state}` : ""}`}
          className={cn(
            "flex h-7 min-w-0 max-w-72 shrink items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-xs text-text-primary",
            "transition-colors hover:bg-overlay-subtle aria-expanded:bg-overlay-subtle",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2"
          )}
        >
          <HostMark row={shown} />
          <HostNameText name={shown.name} className="font-medium" />
          {state && (
            <span
              data-link-trouble={trouble ? "" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-1 whitespace-nowrap",
                trouble ? "font-medium text-text-primary" : "text-text-secondary"
              )}
            >
              {trouble && (
                <TroubleGlyph
                  className="h-3.5 w-3.5 shrink-0 text-status-warning"
                  aria-hidden="true"
                />
              )}
              {state}
            </span>
          )}
          <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-80">
        <DropdownMenuLabel>Show agents on</DropdownMenuLabel>
        {rows.map((row) => (
          <HostPickerItem key={row.hostId} row={row} onPick={onPick} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The header's middle: the host picker centred in whatever room the title and
 * the controls leave, or just that room while there is no picker.
 */
export function CanopyHeaderCenter({ children }: { children?: React.ReactNode }) {
  return <span className="flex min-w-0 flex-1 justify-center px-3">{children}</span>;
}
