import { ChevronDown } from "lucide-react";
import type { HostId } from "@shared/types/remoteHosts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Server } from "@/components/icons";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { cn } from "@/lib/utils";
import { ALL_HOSTS_ID } from "@/store/canopyStore";
import { AgentCounts } from "@/components/Hosts/AgentCounts";
import { HostNameText } from "@/components/Hosts/HostNameText";
import { PlatformGlyph } from "@/components/Hosts/PlatformGlyph";
import {
  hasRemoteHosts,
  useHostFigures,
  useHostList,
  type HostListSnapshot,
} from "@/components/Hosts/hostList";
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

export const ALL_HOSTS_LABEL = "All hosts";

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

/** Every host together: the host switcher's machine, standing for all of them. */
function AllHostsMark() {
  return (
    <span
      data-menu-icon=""
      className="flex h-4 w-3.5 shrink-0 items-center justify-center text-text-secondary"
      aria-hidden="true"
    >
      <Server className="h-3 w-3" aria-hidden="true" />
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

function withFigures(row: HostMenuRow, figures: HostListSnapshot): HostMenuRow {
  const summary = row.isLocal
    ? figures.localSummary
    : (figures.hosts.find((entry) => entry.descriptor.id === row.hostId)?.summary ?? null);
  return summary === null ? row : { ...row, summary };
}

/**
 * The menu's hosts with their agent counts. The header's rows carry no
 * figures, so each host's summary is followed only while the menu is open.
 */
function HostPickerItems({ rows }: { rows: readonly HostMenuRow[] }) {
  const figures = useHostFigures();
  return rows.map((row) => <HostPickerItem key={row.hostId} row={withFigures(row, figures)} />);
}

function HostPickerItem({ row }: { row: HostMenuRow }) {
  const { state, note } = describeHostMenuState(row);
  const trouble = hostMenuRowHasTrouble(row);
  const noteAge = hostMenuNoteAge(row);
  const summary = liveSummary(row);
  // A link that simply works says nothing: the counts beside it are the news.
  const shownState = state === "Local" || state === "Connected" ? null : state;
  return (
    <DropdownMenuRadioItem
      value={row.hostId}
      className="items-start gap-2"
      data-host-id={row.hostId}
      textValue={row.name}
    >
      <HostMark row={row} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* One line per host so names, states and counts each keep a column: a
            long name clips from the middle and keeps the tail that tells
            build-east-01 from build-east-02. */}
        <span className="flex min-w-0 items-baseline gap-3">
          <HostNameText
            name={row.name}
            className={cn(
              "flex-1 text-text-primary",
              row.isCurrent ? "font-semibold" : "font-medium"
            )}
          />
          {shownState && (
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
              {shownState}
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
      {/* Only what the host is reporting now: a host that isn't connected has
          said nothing new, so its state takes the column instead. */}
      <span
        className={cn("w-16 shrink-0 justify-end", summary ? "flex" : "hidden")}
        data-host-agents=""
      >
        {summary && <AgentCounts summary={summary} quietZero />}
      </span>
    </DropdownMenuRadioItem>
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
  onEnableAll,
  allHostsShown = false,
  onPickAll,
}: {
  rows: readonly HostMenuRow[];
  onPick: (hostId: HostId) => void;
  /** Opens the one disclosure that turns Canopy on across every host listed. */
  onEnableAll?: () => void;
  /** The panel reads every host together instead of one. */
  allHostsShown?: boolean;
  onPickAll?: () => void;
}) {
  const shown = rows.find((row) => row.isCurrent) ?? rows[0]!;
  const state = allHostsShown ? null : triggerState(shown);
  const trouble = !allHostsShown && hostMenuRowHasTrouble(shown);
  const scope = allHostsShown ? ALL_HOSTS_ID : shown.hostId;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="canopy-host-picker"
          data-host-id={scope}
          aria-label={
            allHostsShown
              ? "Showing agents on all hosts"
              : `Showing agents on ${shown.name}${state ? `, ${state}` : ""}`
          }
          className={cn(
            "flex h-7 min-w-0 max-w-72 shrink items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-xs text-text-primary",
            "transition-colors hover:bg-overlay-subtle aria-expanded:bg-overlay-subtle",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2"
          )}
        >
          {allHostsShown ? <AllHostsMark /> : <HostMark row={shown} />}
          <HostNameText
            name={allHostsShown ? ALL_HOSTS_LABEL : shown.name}
            className="font-medium"
          />
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
      <DropdownMenuContent align="center" className="w-88 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Show agents on</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={scope}
          onValueChange={(value) => (value === ALL_HOSTS_ID ? onPickAll?.() : onPick(value))}
        >
          {onPickAll && (
            <>
              <DropdownMenuRadioItem
                value={ALL_HOSTS_ID}
                className="gap-2"
                data-host-id={ALL_HOSTS_ID}
                textValue={ALL_HOSTS_LABEL}
              >
                <AllHostsMark />
                <span
                  className={cn(
                    "flex-1 text-text-primary",
                    allHostsShown ? "font-semibold" : "font-medium"
                  )}
                >
                  {ALL_HOSTS_LABEL}
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuSeparator />
            </>
          )}
          <HostPickerItems rows={rows} />
        </DropdownMenuRadioGroup>
        {onEnableAll && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="canopy-enable-all-hosts" onSelect={onEnableAll}>
              Enable Canopy on all hosts…
            </DropdownMenuItem>
          </>
        )}
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
