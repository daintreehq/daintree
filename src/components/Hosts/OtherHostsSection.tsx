import { RefreshCw, Server } from "lucide-react";
import { LOCAL_HOST_ID, type HostId, type HostPlatform } from "@shared/types/remoteHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { cn } from "@/lib/utils";
import { PathTail } from "@/components/ui/PathTail";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { CommandTile, ProjectTile, StatusSlotSpacer } from "@/components/Project/paletteTiles";
import { HostNameText } from "./HostNameText";
import { LinkMark } from "./LinkMark";
import { PlatformGlyph } from "./PlatformGlyph";
import { useHostList } from "./hostList";
import { clientPlatform, localHostLabel, type HostLinkTone } from "./hostModel";
import {
  listingProjects,
  retryHostProjects,
  useHostProjectsListable,
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
 * nothing to show is a row of its own: it connects, retries a failed listing,
 * or — connected and listing nothing — switches to the host.
 */
export type OtherHostOption = OtherHostOptionBase &
  (
    | {
        kind: "project";
        project: HostProjectRef;
        stale: boolean;
        /**
         * The folder is drawn under the name only when it earns the line: the
         * host lists another project by the same name, or the query matched
         * the path rather than the name.
         */
        showPath?: boolean;
      }
    | { kind: "connect" }
    /** `busy` while the host is being asked again: the row holds its place and does nothing. */
    | { kind: "retry"; busy?: boolean }
    | { kind: "host" }
  );

/**
 * One host and its rows. A host with projects is drawn as a header over them;
 * a host whose only row is its own action is drawn as that one row.
 */
export interface OtherHostGroup {
  hostId: HostId;
  hostName: string;
  platform: HostPlatform | null;
  /** The link, in the host menu's mark and words; no words for this machine. */
  link: { tone: HostLinkTone; state: string | null };
  /** What the host's list is doing, when that's worth saying: "Listing…", "listed 5 min ago". */
  listing: string | null;
  /** The link and the listing together, e.g. "Not connected · listed 5 min ago". */
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

function listedAgo(listedAt: number, now: number): string {
  // The clock ticks by the minute, so a list just given can be newer than it.
  return `listed ${formatRelativeTime(listedAt, Math.max(now, listedAt))}`;
}

/**
 * The listing's own words, apart from the link's: a connected host can fail to
 * list, and a list can outlive the link that gave it.
 */
function describeListing(listing: HostListingState, now: number): string | null {
  const age = (listedAt: number | undefined) =>
    listedAt === undefined ? null : listedAgo(listedAt, now);
  const join = (...parts: Array<string | null>) => parts.filter(Boolean).join(" · ") || null;
  switch (listing.status) {
    case "loaded":
      return listing.list.projects.length === 0 ? "No projects yet" : null;
    case "loading":
      return join("Listing…", age(listing.lastGood?.listedAt));
    case "failed":
      return join("Couldn't list projects", age(listing.lastGood?.listedAt));
    case "not-connected":
      return age(listing.lastGood?.listedAt);
  }
}

/**
 * The other hosts' rows matching `query`, grouped by host. A host that isn't
 * connected keeps the list it gave earlier this session, marked as such, or
 * offers to connect; one whose listing failed keeps its last list and offers
 * Retry — never an empty list. A connected host that lists nothing offers to
 * switch to it, and one still giving its first list shows as listing, so no
 * host drops out of the band while browsing. Empty for anyone with no remote
 * host, or where Remote Hosts doesn't exist.
 */
export function useOtherHostProjectOptions(query: string): OtherHostOptions {
  const supported = isRemoteShellSupported();
  const targets = useOtherHostTargets(clientPlatform());
  // Without a loader every list comes back empty: that's "can't ask", not
  // "nothing there", so it never earns a host its "No projects yet" row.
  const listable = useHostProjectsListable();
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
    const nameCounts = new Map<string, number>();
    for (const project of projects) {
      const name = project.name.toLocaleLowerCase();
      remoteNames.add(name);
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const stale = listing.status !== "loaded";
    const options: OtherHostOption[] = projects
      .filter((project) => matchesTokens(tokens, [project.name, project.path, target.name]))
      .map((project) => ({
        ...base,
        key: optionKey("project", target.hostId, project.id),
        kind: "project",
        project,
        stale,
        showPath:
          (nameCounts.get(project.name.toLocaleLowerCase()) ?? 0) > 1 ||
          (tokens.length > 0 && !matchesTokens(tokens, [project.name, target.name])),
      }));
    // A search names the host to reach these; browsing always shows them, so
    // a failure or a host never listed is never passed off as having nothing.
    const offersAction = matchesTokens(tokens, [target.name]);
    // A Retry stays put while the host is asked again, so the cursor on it
    // isn't handed to an unrelated row the moment it is pressed.
    const retrying = listing.status === "loading" && listing.afterFailure === true;
    if ((listing.status === "failed" || retrying) && offersAction) {
      options.push({
        ...base,
        key: optionKey("retry", target.hostId),
        kind: "retry",
        busy: retrying,
      });
    } else if (listing.status === "not-connected" && projects.length === 0 && offersAction) {
      options.push({ ...base, key: optionKey("connect", target.hostId), kind: "connect" });
    } else if (listing.status === "loaded" && projects.length === 0 && listable && offersAction) {
      options.push({ ...base, key: optionKey("host", target.hostId), kind: "host" });
    }
    const firstListing =
      listing.status === "loading" && projects.length === 0 && !retrying && listable;
    if (options.length > 0 || (firstListing && offersAction)) {
      const listingWords = describeListing(listing, now);
      groups.push({
        ...base,
        link: target.link,
        listing: listingWords,
        note: [target.link.state, listingWords].filter(Boolean).join(" · ") || null,
        options,
      });
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
    case "host":
      void switchToHost(option.hostId, newWindow);
      return;
    case "retry":
      // Already being asked: a second press would only restart the wait.
      if (!option.busy) retryHostProjects(option.hostId);
  }
}

function optionLabel(option: OtherHostOption, group: OtherHostGroup): string {
  // "Not connected" is what a Connect row already implies; anything else the
  // link says ("Unreachable", "Can't log in") changes what picking it will do.
  const linkAside =
    group.link.state && group.link.state !== "Not connected" ? `, ${group.link.state}` : "";
  switch (option.kind) {
    case "project": {
      const where = `${option.project.name} on ${option.hostName}, ${option.project.path}`;
      return option.stale && group.note ? `${where}, ${group.note}` : where;
    }
    case "connect":
      return `Connect to ${option.hostName}${linkAside}`;
    case "retry":
      return option.busy
        ? `Listing projects on ${option.hostName}`
        : `Retry listing projects on ${option.hostName}`;
    case "host":
      return `Switch to ${option.hostName}, no projects yet`;
  }
}

/** The word a host's own row ends on: what picking it does. */
const HOST_ROW_VERB: Record<Exclude<OtherHostOption["kind"], "project">, string> = {
  connect: "Connect",
  retry: "Retry",
  host: "Switch",
};

/** The host's platform mark, or a plain server until a handshake has said which. */
function HostGlyph({ platform, size }: { platform: HostPlatform | null; size: number }) {
  if (platform === null) return <Server width={size} height={size} aria-hidden="true" />;
  return <PlatformGlyph platform={platform} size={size} />;
}

/**
 * A host's link and listing as one quiet line, led by the host menu's link
 * mark. The link's words give way to the listing's while the link is up: a
 * host that is listing, or failed to, is plainly connected, and the filled
 * mark still says so.
 *
 * Beside the words rather than in the rows' status column: that column is
 * where a workspace's agents report, and a filled disc there already means
 * something else.
 */
function HostState({ group, className }: { group: OtherHostGroup; className?: string }) {
  const linkWords = group.link.tone === "live" && group.listing ? null : group.link.state;
  const words = [linkWords, group.listing].filter(Boolean).join(" · ");
  if (!words) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-text-secondary", className)}>
      <LinkMark tone={group.link.tone} className="h-3 w-2.5" />
      <span className="truncate">{words}</span>
    </span>
  );
}

/**
 * A host over its projects: on the rows' columns — an empty status slot, the
 * platform mark where tiles sit, the name where names sit — so a header and a
 * host's own row line up as the same kind of thing.
 */
function HostHeader({ group, labelId }: { group: OtherHostGroup; labelId?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 border border-transparent px-2 pt-2 pb-1">
      <StatusSlotSpacer />
      <span className="flex w-8 shrink-0 justify-center text-text-secondary" aria-hidden="true">
        <HostGlyph platform={group.platform} size={14} />
      </span>
      {/* Name and state together name the group: both are what it is. */}
      <span id={labelId} className="flex min-w-0 items-center gap-2.5">
        <HostNameText
          name={group.hostName}
          className="text-sm font-semibold leading-tight text-text-primary"
        />
        {group.note && <span className="sr-only">, </span>}
        <HostState group={group} className="text-xs" />
      </span>
    </div>
  );
}

/**
 * Rows under a host header sit one 16px step in from the band's rail: the
 * header owns the host, and the indent says these are its. The highlight still
 * runs the full width, like every row in the palette.
 */
const CHILD_INSET = "pl-6";
/** A host's own row starts on the rail, like every row above the band. */
const HOST_INSET = "pl-2";
/** A little more air above each host than between its projects, so a group ends visibly. */
const HOST_GAP = "not-first:mt-1";

function rowClass(inset: string) {
  return cn(
    PALETTE_ROW_CLASS,
    "group flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] py-1.5 pr-2 text-left cursor-pointer",
    inset,
    inset === HOST_INSET && HOST_GAP
  );
}

function ProjectRowContent({ option }: { option: Extract<OtherHostOption, { kind: "project" }> }) {
  return (
    <>
      <StatusSlotSpacer />
      <ProjectTile emoji={option.project.emoji} neutral />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-sm font-semibold leading-tight",
            // A remembered list is said once on its header; its rows step down
            // a tier so they never pass for live ones.
            option.stale ? "text-text-secondary" : "text-text-primary",
            "group-aria-selected:text-text-primary"
          )}
        >
          {option.project.name}
        </div>
        {option.showPath && (
          <PathTail className="mt-0.5 block text-2xs leading-tight text-text-secondary">
            {option.project.path}
          </PathTail>
        )}
      </div>
    </>
  );
}

/**
 * The project switcher's "Other hosts" band: every other host, and the
 * projects each one lists. A host with projects is a header — its link mark,
 * platform and name, and what its link and list are doing — with its projects
 * one step in, drawn like the switcher's own. A host with nothing to list is
 * one row whose tile is the host and whose trailing word is what picking it
 * does: Connect, Retry, or Switch. Choosing a project switches the window to
 * that host and project together.
 *
 * Its rows take part in the switcher's roving selection rather than the tab
 * order, the same as every other result, so `activeKey` is the switcher's
 * cursor when it sits in this band. Renders nothing when there are no hosts.
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

  const renderOption = (option: OtherHostOption, group: OtherHostGroup, inset: string) => {
    const isActive = option.key === activeKey;
    return (
      <div
        key={option.key}
        id={otherHostOptionId(option)}
        role="option"
        aria-selected={isActive}
        aria-label={optionLabel(option, group)}
        aria-disabled={option.kind === "retry" && option.busy ? true : undefined}
        data-host-id={option.hostId}
        data-option-kind={option.kind}
        onPointerMove={onHoverKey ? () => onHoverKey(option.key) : undefined}
        className={cn(
          rowClass(inset),
          option.kind === "project" ? undefined : "text-text-secondary"
        )}
        onClick={(event) => {
          if (otherHostOptionCloses(option)) onChosen();
          activateOtherHostOption(option, isNewWindowClick(event));
        }}
      >
        {option.kind === "project" ? (
          <ProjectRowContent option={option} />
        ) : group.options.length === 1 ? (
          // The host's own row: the host is the tile, its state the second line.
          <>
            <StatusSlotSpacer />
            <CommandTile tone="manage">
              <HostGlyph platform={group.platform} size={14} />
            </CommandTile>
            <div className="min-w-0 flex-1">
              <HostNameText
                name={group.hostName}
                className="text-sm font-semibold leading-tight text-text-primary"
              />
              {/* `leading-tight`, not the status line's `leading-none`: this line
                  truncates, and clipping at the line box takes the descenders. */}
              <HostState group={group} className="mt-0.5 text-2xs leading-tight" />
            </div>
            {!(option.kind === "retry" && option.busy) && (
              <span className="shrink-0 text-xs text-text-secondary group-aria-selected:text-text-primary">
                {HOST_ROW_VERB[option.kind]}
              </span>
            )}
          </>
        ) : (
          // A retry under a remembered list: a command, drawn as the switcher's are.
          <>
            <StatusSlotSpacer />
            <CommandTile icon={RefreshCw} tone="manage" />
            <span className="truncate text-sm font-medium leading-tight">
              {option.kind === "retry" && option.busy
                ? "Listing projects…"
                : "Retry listing projects"}
            </span>
          </>
        )}
      </div>
    );
  };

  return (
    <section className="px-1 py-1" data-testid="project-switcher-other-hosts">
      <h3
        id="project-switcher-other-hosts"
        className={cn("px-2 py-1", PALETTE_SECTION_LABEL_CLASS)}
      >
        Other hosts
      </h3>
      <div id={OTHER_HOSTS_LIST_ID} role="listbox" aria-labelledby="project-switcher-other-hosts">
        {groups.map((group) => {
          if (group.options.length === 0) {
            // Still giving its first list: the host is shown, but a group has
            // to hold options, so it stands as one that can't be picked. The
            // arrow keys never land on it — it isn't in the band's options.
            return (
              <div
                key={group.hostId}
                className={HOST_GAP}
                role="option"
                aria-selected={false}
                aria-disabled={true}
                aria-label={`${group.hostName}, ${group.note ?? "listing projects"}`}
                data-host-id={group.hostId}
              >
                <HostHeader group={group} />
              </div>
            );
          }
          const only = group.options.length === 1 ? group.options[0]! : null;
          // A host with nothing but its own action needs no header naming it:
          // the row is the host.
          if (only && only.kind !== "project") return renderOption(only, group, HOST_INSET);
          const headerId = `project-switcher-other-host-${encodeURIComponent(group.hostId)}`;
          return (
            <div key={group.hostId} role="group" aria-labelledby={headerId} className={HOST_GAP}>
              <HostHeader group={group} labelId={headerId} />
              {group.options.map((option) => renderOption(option, group, CHILD_INSET))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
