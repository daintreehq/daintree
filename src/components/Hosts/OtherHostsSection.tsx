import { LOCAL_HOST_ID, type HostId, type HostPlatform } from "@shared/types/remoteHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { cn } from "@/lib/utils";
import { PathTail } from "@/components/ui/PathTail";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { PlatformGlyph } from "./PlatformGlyph";
import { useHostList } from "./hostList";
import { clientPlatform, localHostLabel } from "./hostModel";
import {
  listingProjects,
  retryHostProjects,
  useOtherHostTargets,
  type HostListingState,
  type HostProjectRef,
} from "./hostProjects";
import { matchesTokens, queryTokens } from "./hostProjectSearch";
import { isNewWindowClick, switchToHost } from "./hostSwitching";

interface OtherHostOptionBase {
  /** Stable across hosts coming and going: the switcher's cursor follows it. */
  key: string;
  hostId: HostId;
  hostName: string;
  platform: HostPlatform | null;
}

/**
 * One row of the switcher's "Other hosts" band. A project row may come from a
 * list the host gave earlier (`stale`); picking it connects first. A host with
 * nothing to show offers to connect, and one whose listing failed offers Retry.
 */
export type OtherHostOption = OtherHostOptionBase &
  (
    | { kind: "project"; project: HostProjectRef; stale: boolean }
    | { kind: "connect" }
    | { kind: "retry" }
  );

/** One host's rows under its own header, which says what the rows are. */
export interface OtherHostGroup {
  hostId: HostId;
  hostName: string;
  platform: HostPlatform | null;
  /** What the header adds after the host's name, e.g. "Not connected · listed 5 min ago". */
  note: string | null;
  options: OtherHostOption[];
}

export interface OtherHostOptions {
  groups: OtherHostGroup[];
  /** Every group's rows, flat and in drawn order: the switcher's arrow keys walk them. */
  options: OtherHostOption[];
  /**
   * Lowercased names of every project another host has listed this session,
   * whatever the query, so a local row can say which host it is on when its
   * name is ambiguous.
   */
  remoteNames: ReadonlySet<string>;
}

/** The host this window is on, as the host menu names it. */
export function useCurrentHostName(): string {
  const hostList = useHostList();
  const hostId = getViewHostId() ?? LOCAL_HOST_ID;
  if (hostId === LOCAL_HOST_ID) return localHostLabel(clientPlatform());
  return hostList.hosts.find((entry) => entry.descriptor.id === hostId)?.descriptor.name ?? hostId;
}

/** The listbox the other-host rows live in, named by the switcher input's `aria-controls`. */
export const OTHER_HOSTS_LIST_ID = "project-switcher-other-hosts-list";

function optionKey(kind: string, hostId: HostId, projectId = ""): string {
  return [kind, hostId, projectId].map(encodeURIComponent).join(":");
}

export function otherHostOptionId(option: Pick<OtherHostOption, "key">): string {
  return `project-other-host-option-${option.key}`;
}

function listedSuffix(listedAt: number | undefined, now: number): string {
  // The clock ticks by the minute, so a list just given can be newer than it.
  return listedAt === undefined
    ? ""
    : ` · listed ${formatRelativeTime(listedAt, Math.max(now, listedAt))}`;
}

function describeListing(listing: HostListingState, now: number): string | null {
  switch (listing.status) {
    case "loaded":
      return listing.list.projects.length === 0 ? "No projects yet" : null;
    case "loading":
      return listing.lastGood ? `Listing…${listedSuffix(listing.lastGood.listedAt, now)}` : null;
    case "failed":
      return `Couldn't list projects${listedSuffix(listing.lastGood?.listedAt, now)}`;
    case "not-connected":
      return `Not connected${listedSuffix(listing.lastGood?.listedAt, now)}`;
  }
}

/**
 * The other hosts' rows matching `query`, grouped by host. A host that isn't
 * connected keeps the list it gave earlier this session, marked as such, or
 * offers to connect; one whose listing failed keeps its last list and offers
 * Retry — never an empty list. Empty for anyone with no remote host, or where
 * Remote Hosts doesn't exist.
 */
export function useOtherHostProjectOptions(query: string): OtherHostOptions {
  const supported = isRemoteShellSupported();
  const targets = useOtherHostTargets(clientPlatform());
  // In state rather than read here: a render-time clock would freeze under the
  // compiler's memoisation and leave "listed 1 min ago" saying so for an hour.
  const now = useGlobalMinuteClock();
  if (!supported) return { groups: [], options: [], remoteNames: new Set() };
  const tokens = queryTokens(query);
  const remoteNames = new Set<string>();
  const groups: OtherHostGroup[] = [];
  for (const target of targets) {
    const base = { hostId: target.hostId, hostName: target.name, platform: target.platform };
    const listing = target.listing;
    const projects = listingProjects(listing);
    for (const project of projects) remoteNames.add(project.name.toLocaleLowerCase());
    const stale = listing.status !== "loaded";
    const options: OtherHostOption[] = projects
      .filter((project) => matchesTokens(tokens, [project.name, project.path, target.name]))
      .map((project) => ({
        ...base,
        key: optionKey("project", target.hostId, project.id),
        kind: "project",
        project,
        stale,
      }));
    // A search names the host to reach these; browsing always shows them, so
    // a failure or a host never listed is never passed off as having nothing.
    const offersAction = matchesTokens(tokens, [target.name]);
    if (listing.status === "failed" && offersAction) {
      options.push({ ...base, key: optionKey("retry", target.hostId), kind: "retry" });
    } else if (listing.status === "not-connected" && projects.length === 0 && offersAction) {
      options.push({ ...base, key: optionKey("connect", target.hostId), kind: "connect" });
    }
    if (options.length > 0) {
      groups.push({ ...base, note: describeListing(listing, now), options });
    }
  }
  return { groups, options: groups.flatMap((group) => group.options), remoteNames };
}

/** Retry keeps the palette open, so the answer lands where the user is looking. */
export function otherHostOptionCloses(option: OtherHostOption): boolean {
  return option.kind !== "retry";
}

/** What choosing a row does. */
export function activateOtherHostOption(option: OtherHostOption, newWindow: boolean): void {
  switch (option.kind) {
    case "project":
      void switchToHost(option.hostId, newWindow, option.project.id);
      return;
    case "connect":
      void switchToHost(option.hostId, newWindow);
      return;
    case "retry":
      retryHostProjects(option.hostId);
  }
}

function optionLabel(option: OtherHostOption, note: string | null): string {
  switch (option.kind) {
    case "project": {
      const where = `${option.project.name} on ${option.hostName}, ${option.project.path}`;
      return option.stale && note ? `${where}, ${note}` : where;
    }
    case "connect":
      return `Connect to ${option.hostName}`;
    case "retry":
      return `Retry listing projects on ${option.hostName}`;
  }
}

function OptionContent({ option }: { option: OtherHostOption }) {
  switch (option.kind) {
    case "project":
      return (
        <>
          {option.project.emoji && (
            <span className="shrink-0 leading-none" aria-hidden="true">
              {option.project.emoji}
            </span>
          )}
          <span className="shrink-0 truncate font-medium max-w-[50%]">{option.project.name}</span>
          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-2xs text-text-secondary">
            <span className="shrink-0">{option.hostName}</span>
            <span aria-hidden="true">·</span>
            <PathTail className="min-w-0">{option.project.path}</PathTail>
          </span>
        </>
      );
    case "connect":
      return <span className="truncate">Connect to {option.hostName}</span>;
    case "retry":
      return <span className="truncate">Retry</span>;
  }
}

/**
 * The project switcher's "Other hosts" band: the projects of every other host,
 * grouped under a header naming the host and the state of its list. Choosing
 * one switches the window to that host and project together. Its rows take
 * part in the switcher's roving selection rather than the tab order, the same
 * as every other result, so `activeKey` is the switcher's cursor when it sits
 * in this band. Renders nothing when there are no rows.
 */
export function OtherHostsSection({
  groups,
  activeKey,
  onChosen,
  onHoverKey,
}: {
  groups: OtherHostGroup[];
  activeKey: string | null;
  onChosen: () => void;
  /** The pointer moves the switcher's cursor, as every other result row's does. */
  onHoverKey?: (key: string) => void;
}) {
  if (groups.length === 0) return null;

  return (
    <section
      className="px-1 py-1 border-t border-border-divider"
      data-testid="project-switcher-other-hosts"
    >
      <h3
        id="project-switcher-other-hosts"
        className={cn("px-2.5 py-1.5", PALETTE_SECTION_LABEL_CLASS)}
      >
        Other hosts
      </h3>
      <div id={OTHER_HOSTS_LIST_ID} role="listbox" aria-labelledby="project-switcher-other-hosts">
        {groups.map((group) => {
          const headerId = `project-switcher-other-host-${encodeURIComponent(group.hostId)}`;
          return (
            <div key={group.hostId} role="group" aria-labelledby={headerId}>
              <div
                id={headerId}
                className="flex min-w-0 items-center gap-1.5 px-2.5 pt-1 pb-0.5 text-2xs text-text-secondary"
              >
                <PlatformGlyph platform={group.platform} size={10} />
                <span className="truncate">{group.hostName}</span>
                {group.note && <span className="shrink-0">· {group.note}</span>}
              </div>
              {group.options.map((option) => {
                const isActive = option.key === activeKey;
                return (
                  <div
                    key={option.key}
                    id={otherHostOptionId(option)}
                    role="option"
                    aria-selected={isActive}
                    aria-label={optionLabel(option, group.note)}
                    data-host-id={option.hostId}
                    data-option-kind={option.kind}
                    onPointerMove={onHoverKey ? () => onHoverKey(option.key) : undefined}
                    className={cn(
                      PALETTE_ROW_CLASS,
                      "flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-sm cursor-pointer",
                      "text-text-secondary hover:text-text-primary"
                    )}
                    onClick={(event) => {
                      if (otherHostOptionCloses(option)) onChosen();
                      activateOtherHostOption(option, isNewWindowClick(event));
                    }}
                  >
                    <OptionContent option={option} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
