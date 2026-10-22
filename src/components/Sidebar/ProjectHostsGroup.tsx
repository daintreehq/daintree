import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import type { HostId } from "@shared/types/remoteHosts";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import { ScrollPill } from "@/components/ui/ScrollPill";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { pluralize } from "@/lib/pluralize";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HollowCircle, Server } from "@/components/icons";
import { HostNameText } from "@/components/Hosts/HostNameText";
import { PlatformGlyph } from "@/components/Hosts/PlatformGlyph";
import { openProjectOnHost } from "@/components/Hosts/OpenOnHostSubmenu";
import { isNewWindowClick, switchToHost } from "@/components/Hosts/hostSwitching";
import { useProjectHosts, type ProjectHost } from "@/components/Hosts/projectHosts";
import {
  ROW_BANDS,
  summarizeHostProject,
  type HostAsk,
  type HostProjectSummary,
  type RowBand,
} from "@/components/Hosts/projectHostSummary";
import {
  askLabel,
  askRowLabel,
  askTooltip,
  hostRowLabel,
  hostRowStatus,
  hostRowTooltip,
} from "@/components/Hosts/projectHostLines";
import { actionService } from "@/services/ActionService";
import { useProjectStore } from "@/store/projectStore";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { setProjectHostsExpanded, useProjectHostsExpanded } from "./projectHostsExpanded";

/** Asking agents named under one host before the rest fold into "N more". */
export const ASKS_PER_HOST = 2;

/** Hidden asking agents a "more" row's tooltip names before it stops listing. */
const MORE_TOOLTIP_NAMES = 4;

const LIST_ID = "project-hosts-list";
const TOTALS_ID = "project-hosts-totals";

interface ProjectHostsGroupProps {
  /** The project this view shows; its agents on every host are summarised. */
  projectId: string | null;
}

/**
 * Rows tighten below 15rem of sidebar (its minimum is 200px), so a host name
 * keeps room beside the three count columns.
 */
const ROW_BASE_CLASS = cn(
  "w-full min-w-0 items-center px-2 py-1 text-left text-xs @[15rem]/hosts:px-3",
  "transition-colors",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline"
);

const ROW_CLASS = cn(ROW_BASE_CLASS, "hover:bg-overlay-subtle");

/**
 * A host row is a grid: glyph, name, then one fixed column per counted band,
 * so a count never moves when another band comes or goes and position tells
 * quiet from working even with the spinners still. Each column holds a glyph
 * and two digits, right-aligned to the edge the asking rows' words end on.
 */
const HOST_ROW_CLASS = cn(
  ROW_BASE_CLASS,
  // Held at the top of the scroll while its own asking rows are still in view,
  // so a named agent never sits under the wrong host. Opaque like the list's
  // group headers; the hover is layered as an image, because the overlay
  // ladder is alpha-only and as a colour it would replace the fill.
  "sticky top-0 z-[1] bg-surface-sidebar",
  "hover:bg-[linear-gradient(var(--color-overlay-subtle),var(--color-overlay-subtle))]",
  "grid grid-cols-[1.375rem_minmax(0,1fr)_repeat(3,1.875rem)]",
  "@[15rem]/hosts:grid-cols-[1.375rem_minmax(0,1fr)_repeat(3,2rem)]"
);

/** The window's own host: the selection lift, under the same hover layering. */
const CURRENT_HOST_ROW_CLASS = cn(
  "bg-[linear-gradient(var(--color-overlay-soft),var(--color-overlay-soft)),linear-gradient(var(--color-surface-sidebar),var(--color-surface-sidebar))]",
  "hover:bg-[linear-gradient(var(--color-overlay-soft),var(--color-overlay-soft)),linear-gradient(var(--color-surface-sidebar),var(--color-surface-sidebar))]"
);

/**
 * An asking row sits one host row in, and keeps that much scroll margin so
 * revealing or tabbing to it never parks it under its pinned host.
 */
const ASK_ROW_CLASS = "flex gap-2 pl-7.5 scroll-mt-6 @[15rem]/hosts:pl-8.5";

/** Where each counted band's column starts, as literal classes for Tailwind to see. */
const BAND_COLUMN: Record<RowBand, string> = {
  quiet: "col-start-3",
  review: "col-start-4",
  running: "col-start-5",
};

/** How far the name runs: across every blank column up to the first count shown. */
const NAME_SPAN = ["col-span-1", "col-span-2", "col-span-3", "col-span-4"] as const;

/** Rows the section's own arrow keys move between, header included. */
const NAV_SELECTOR = "[data-project-hosts-nav]";

function newWindowKey(): string {
  return isMac() ? "Cmd" : "Ctrl";
}

/** The glyph column every row shares, so names and branches start on one edge. */
function GlyphSlot({ children }: { children?: ReactNode }) {
  return (
    <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
      {children}
    </span>
  );
}

/** A row's full text, on hover and on focus alike. */
function RowTooltip({ lines, children }: { lines: readonly string[]; children: ReactNode }) {
  const last = lines.length - 1;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">
        {lines.map((line, i) => (
          <div
            key={`${i}:${line}`}
            className={cn("[overflow-wrap:anywhere]", i === last && "text-text-secondary")}
          >
            {line}
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/** The host's quiet, unread and working counts in their own columns; a zero draws nothing. */
function HostCounts({ summary }: { summary: HostProjectSummary }) {
  return ROW_BANDS.map((band) => {
    const n = summary.counts[band];
    if (n === 0) return null;
    return (
      <span
        key={band}
        aria-hidden="true"
        data-band={band}
        className={cn(
          "row-start-1 flex items-center justify-end gap-0.5 tabular-nums text-text-primary",
          BAND_COLUMN[band]
        )}
      >
        <PilotRunState band={band} agentState={undefined} />
        {n}
      </span>
    );
  });
}

/** Columns the name may run across: itself, plus every blank count column before the first shown. */
function nameSpan(summary: HostProjectSummary | null, counts: boolean): (typeof NAME_SPAN)[number] {
  if (!counts) return NAME_SPAN[0];
  const first = ROW_BANDS.findIndex((band) => (summary?.counts[band] ?? 0) > 0);
  return NAME_SPAN[first === -1 ? ROW_BANDS.length : first] ?? NAME_SPAN[0];
}

interface Totals {
  asking: number;
  working: number;
}

/** What the collapsed header still says: agents asking, and agents working, on every host. */
function totalsOf(summaries: ReadonlyMap<HostId, HostProjectSummary>): Totals {
  let asking = 0;
  let working = 0;
  for (const summary of summaries.values()) {
    asking += summary.asks.length;
    working += summary.counts.running;
  }
  return { asking, working };
}

function CollapsedTotals({ totals }: { totals: Totals }) {
  if (totals.asking === 0 && totals.working === 0) return null;
  return (
    <span
      data-testid="project-hosts-totals"
      className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-text-primary"
    >
      {/* The toggle's name never changes with its state; the totals describe it instead. */}
      <span id={TOTALS_ID} className="sr-only">
        {describeTotals(totals)}
      </span>
      {totals.asking > 0 && (
        <span aria-hidden="true" data-total="asking" className="flex items-center gap-0.5">
          <PilotRunState band="needs-you" agentState={undefined} />
          {totals.asking}
        </span>
      )}
      {totals.working > 0 && (
        <span aria-hidden="true" data-total="working" className="flex items-center gap-0.5">
          <PilotRunState band="running" agentState={undefined} />
          {totals.working}
        </span>
      )}
    </span>
  );
}

function describeTotals(totals: Totals): string {
  const parts: string[] = [];
  if (totals.asking > 0) parts.push(`${totals.asking} asking`);
  if (totals.working > 0) parts.push(`${totals.working} working`);
  return `${parts.join(", ")} (observed)`;
}

interface HiddenPast {
  hosts: number;
  asking: number;
  /** The row to bring into view: the nearest asking agent past the edge, else the nearest host. */
  nearest: HTMLElement | null;
}

interface HiddenEdges {
  above: HiddenPast;
  below: HiddenPast;
}

const NOTHING_PAST: HiddenPast = { hosts: 0, asking: 0, nearest: null };
const NOTHING_HIDDEN: HiddenEdges = { above: NOTHING_PAST, below: NOTHING_PAST };

interface Tally {
  hosts: number;
  asking: number;
  nearestAsk: HTMLElement | null;
  nearestHost: HTMLElement | null;
}

const tally = (): Tally => ({ hosts: 0, asking: 0, nearestAsk: null, nearestHost: null });

function samePast(a: HiddenPast, b: HiddenPast): boolean {
  return a.hosts === b.hosts && a.asking === b.asking && a.nearest === b.nearest;
}

/**
 * What the section's own scroll has past each edge, kept current as it
 * scrolls, resizes, and as rows come, go, or change what they stand for.
 */
function useHiddenEdges(el: HTMLUListElement | null): HiddenEdges {
  const [hidden, setHidden] = useState<HiddenEdges>(NOTHING_HIDDEN);
  useEffect(() => {
    if (!el) {
      setHidden(NOTHING_HIDDEN);
      return;
    }
    const measure = () => {
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      // An asking row's host is pinned over the top of the scroll, so the
      // first row's height of it is covered rather than in view.
      const pinned =
        el.querySelector<HTMLElement>("[data-project-hosts-row='host']")?.offsetHeight ?? 0;
      const above = tally();
      const below = tally();
      for (const row of el.querySelectorAll<HTMLElement>("[data-project-hosts-row]")) {
        // A row more than half past an edge is one the eye can't read.
        const isHost = row.dataset.projectHostsRow === "host";
        const middle = row.offsetTop + row.offsetHeight / 2;
        const side = middle < top + (isHost ? 0 : pinned) ? above : middle > bottom ? below : null;
        if (!side) continue;
        const asks = Number(row.dataset.asks ?? "0");
        if (isHost) side.hosts += 1;
        else side.asking += asks;
        // Above, the nearest is the last one passed; below, the first one met.
        if (side === above) {
          if (isHost) above.nearestHost = row;
          else if (asks > 0) above.nearestAsk = row;
        } else if (isHost) {
          // Plain assignments: the compiler can't lower `??=` and would skip the hook.
          if (below.nearestHost === null) below.nearestHost = row;
        } else if (asks > 0 && below.nearestAsk === null) {
          below.nearestAsk = row;
        }
      }
      const next: HiddenEdges = {
        above: {
          hosts: above.hosts,
          asking: above.asking,
          nearest: above.nearestAsk ?? above.nearestHost,
        },
        below: {
          hosts: below.hosts,
          asking: below.asking,
          nearest: below.nearestAsk ?? below.nearestHost,
        },
      };
      setHidden((previous) =>
        samePast(previous.above, next.above) && samePast(previous.below, next.below)
          ? previous
          : next
      );
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resized = new ResizeObserver(measure);
    resized.observe(el);
    // A "1 more" becoming "5 more" changes an attribute, not the rows.
    const changed = new MutationObserver(measure);
    changed.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-asks"],
    });
    return () => {
      el.removeEventListener("scroll", measure);
      resized.disconnect();
      changed.disconnect();
    };
  }, [el]);
  return hidden;
}

/**
 * The sidebar's own scroll pill, for this section's overflow: asking agents
 * past the edge first, in the waiting mark the worktree list's pill uses, else
 * the hosts past it. Rows stay in Tab order, which scrolls them in, so the
 * pill is the pointer's shortcut and stays out of the accessibility tree.
 */
function OverflowCue({ direction, past }: { direction: "above" | "below"; past: HiddenPast }) {
  const live = past.asking > 0 ? past.asking : past.hosts;
  const { isVisible, shouldRender } = useAnimatedPresence({ isOpen: live > 0 });
  // Fading out, it keeps saying what it last said rather than "0".
  const [lastShown, setLastShown] = useState<HiddenPast>(past);
  if (live > 0 && !samePast(past, lastShown)) setLastShown(past);
  const shown = live > 0 ? past : lastShown;
  const count = shown.asking > 0 ? shown.asking : shown.hosts;
  if (!shouldRender) return null;
  const description =
    shown.asking > 0
      ? `${pluralize(shown.asking, "agent")} asking ${direction}`
      : `${pluralize(shown.hosts, "more host", "more hosts")} ${direction}`;
  const Chevron = direction === "above" ? ChevronUp : ChevronDown;
  return (
    <div
      aria-hidden="true"
      data-project-hosts-overflow={direction}
      className={cn(
        "pointer-events-none absolute right-0 left-0 z-10 flex justify-end pr-3",
        direction === "above" ? "top-0 pt-1.5" : "bottom-0 pb-1.5"
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ScrollPill
            isVisible={isVisible}
            translateDirection={direction === "above" ? "up" : "down"}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => shown.nearest?.scrollIntoView({ block: "nearest" })}
            className="flex items-center gap-1.5 px-2.5 py-1"
          >
            <Chevron className="h-3 w-3" />
            <span className="font-medium tabular-nums">{count}</span>
            {shown.asking > 0 && (
              <HollowCircle className={cn("h-3 w-3 shrink-0", STATE_COLORS.waiting)} />
            )}
          </ScrollPill>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          {description}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Up and Down between the section's rows, Home and End to its ends; Tab is left alone. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(NAV_SELECTOR)];
  const at = rows.findIndex((row) => row === document.activeElement);
  if (at === -1) return;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
  event.preventDefault();
  rows[next]?.focus();
}

interface ShownAll {
  projectId: string | null;
  hosts: ReadonlySet<HostId>;
}

/**
 * This project on every host, the window's own included, one row per host in
 * the host menu's fixed order: this machine first, then the rest by name. A
 * row shows how many of this project's agents there it observed quiet, unread
 * and working, or the one phrase that stands in for them (the link's words
 * while it is down, "Not added" where no project there shares the repository).
 * An agent that is asking (blocked or waiting) is named under its host
 * instead, and picking it lands on that agent's pane. Observation only: every
 * count is the band that host's own fleet placed, never one decided here. A
 * row opens that host's project in this window, or a new one on Cmd/Ctrl-click.
 *
 * The header names the project and collapses the section, once for every
 * window on every host; collapsed, it keeps the asking and working totals.
 */
export function ProjectHostsGroup({ projectId }: ProjectHostsGroupProps) {
  const hosts = useProjectHosts(projectId);
  const projectName = useProjectStore((state) => state.currentProject?.name ?? null);
  const expanded = useProjectHostsExpanded();
  // State, not a ref: the list mounts only once a host is there, after the first render.
  const [scroller, setScroller] = useState<HTMLUListElement | null>(null);
  const edges = useHiddenEdges(scroller);
  const [shownAll, setShownAll] = useState<ShownAll>(() => ({ projectId, hosts: new Set() }));
  // Another project starts folded, and so does this one when it comes back.
  if (shownAll.projectId !== projectId) setShownAll({ projectId, hosts: new Set() });
  if (hosts.length === 0) return null;

  const allShownFor = shownAll.projectId === projectId ? shownAll.hosts : new Set<HostId>();
  const summaries = new Map<HostId, HostProjectSummary>();
  for (const host of hosts) {
    if (host.entries) summaries.set(host.hostId, summarizeHostProject(host.entries));
  }
  const totals = totalsOf(summaries);
  const key = newWindowKey();

  const openHost = (host: ProjectHost, e: MouseEvent) => {
    if (host.isCurrent) return;
    const newWindow = isNewWindowClick(e);
    // Nothing there to switch to: the switch dialog finds the copy, or offers to set one up.
    if (!host.away && (host.presence === "none" || host.presence === "unknown")) {
      if (projectId !== null) void openProjectOnHost(host.hostId, projectId, newWindow, "user");
      return;
    }
    void switchToHost(host.hostId, newWindow, host.projectIds[0]);
  };
  const openAsk = (host: ProjectHost, ask: HostAsk, e: MouseEvent) => {
    if (host.isCurrent) {
      void (ask.terminalId === null
        ? actionService.dispatch("agent.focusNextWaiting", undefined, { source: "user" })
        : actionService.dispatch(
            "pilot.openRun",
            { runId: ask.terminalId, workspaceId: ask.projectId },
            { source: "user" }
          ));
      return;
    }
    void switchToHost(host.hostId, isNewWindowClick(e), ask.projectId, {
      focusIntent:
        ask.terminalId === null
          ? { intent: "focus-next-waiting" }
          : { intent: "focus-panel", panelId: ask.terminalId },
    });
  };
  const showAll = (hostId: HostId, e: MouseEvent<HTMLButtonElement>) => {
    const item = e.currentTarget.closest<HTMLElement>("[data-host-id]");
    const hadFocus = document.activeElement === e.currentTarget;
    // Committed now, so the row it stood for is there to take focus before
    // the "more" row it replaces leaves focus on nothing.
    flushSync(() => setShownAll({ projectId, hosts: new Set(allShownFor).add(hostId) }));
    if (!hadFocus) return;
    const revealed = item?.querySelectorAll<HTMLElement>("[data-project-hosts-row='ask']")[
      ASKS_PER_HOST
    ];
    // A pointer press keeps its ringless focus; a key press keeps its ring.
    revealed?.focus({ preventScroll: true, focusVisible: e.detail === 0 });
  };

  const title = projectName ?? "This project";

  return (
    <section
      aria-label={`${title} across hosts`}
      // At most half the sidebar, so the local worktrees always keep the rest.
      className="@container/hosts flex max-h-[50%] shrink-0 flex-col border-t border-border-default"
      data-testid="project-hosts-group"
      onKeyDown={moveFocus}
    >
      <button
        type="button"
        data-project-hosts-nav=""
        data-testid="project-hosts-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? LIST_ID : undefined}
        aria-label={`${title} across hosts`}
        aria-describedby={
          !expanded && (totals.asking > 0 || totals.working > 0) ? TOTALS_ID : undefined
        }
        onClick={() => setProjectHostsExpanded(!expanded)}
        className={cn(
          "group/toggle flex w-full shrink-0 items-center gap-1 px-2 pt-2 pb-1 text-left @[15rem]/hosts:px-3",
          !expanded && "pb-2",
          "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline"
        )}
      >
        <ChevronRight
          data-animated-chevron
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out",
            expanded && "rotate-90"
          )}
        />
        <span
          className={cn(
            PALETTE_SECTION_LABEL_CLASS,
            "flex min-w-0 flex-1 group-hover/toggle:text-text-primary"
          )}
        >
          <span className="min-w-0 truncate">{title}</span>
          <span className="shrink-0 whitespace-pre"> across hosts</span>
        </span>
        {!expanded && <CollapsedTotals totals={totals} />}
      </button>
      {expanded && (
        <div className="relative flex min-h-0 flex-col">
          <ul id={LIST_ID} ref={setScroller} className="relative min-h-0 overflow-y-auto pb-2">
            {hosts.map((host) => {
              const summary = summaries.get(host.hostId) ?? null;
              const status = hostRowStatus(host, summary);
              const counts = status.kind === "counts";
              const asks = counts && summary ? summary.asks : [];
              const all = allShownFor.has(host.hostId);
              const shown = all ? asks : asks.slice(0, ASKS_PER_HOST);
              const hidden = all ? [] : asks.slice(ASKS_PER_HOST);
              return (
                <li key={host.hostId} data-host-id={host.hostId}>
                  <RowTooltip lines={hostRowTooltip(host, summary, key)}>
                    <button
                      type="button"
                      data-testid="project-hosts-host-row"
                      data-project-hosts-row="host"
                      data-project-hosts-nav=""
                      data-status={status.kind}
                      aria-current={host.isCurrent ? "true" : undefined}
                      aria-label={hostRowLabel(host, summary)}
                      onClick={(event) => openHost(host, event)}
                      className={cn(HOST_ROW_CLASS, host.isCurrent && CURRENT_HOST_ROW_CLASS)}
                    >
                      <GlyphSlot>
                        {host.platform ? (
                          <PlatformGlyph platform={host.platform} className="text-text-secondary" />
                        ) : (
                          <Server className="size-3 text-text-secondary" />
                        )}
                      </GlyphSlot>
                      <span
                        className={cn(
                          // Clipped rather than painted into the counts at the narrowest widths.
                          "col-start-2 row-start-1 mr-2 min-w-0 overflow-hidden",
                          nameSpan(summary, counts)
                        )}
                      >
                        <HostNameText
                          name={host.hostName}
                          title={false}
                          // At the sidebar's minimum the tail, which tells hosts apart, outranks the head.
                          headFloor="min-w-[2ch] @[15rem]/hosts:min-w-[4ch]"
                          className={cn(
                            "font-medium",
                            host.away ? "text-text-secondary" : "text-text-primary"
                          )}
                        />
                      </span>
                      {counts && summary ? (
                        <HostCounts summary={summary} />
                      ) : status.kind === "away" || status.kind === "note" ? (
                        <span
                          aria-hidden="true"
                          className="col-span-3 col-start-3 row-start-1 justify-self-end whitespace-nowrap text-text-secondary"
                        >
                          {status.text}
                        </span>
                      ) : null}
                    </button>
                  </RowTooltip>
                  {shown.length > 0 && (
                    <ul>
                      {shown.map((ask) => (
                        <li key={`${ask.worktreeId}:${ask.terminalId ?? ""}`}>
                          <RowTooltip lines={askTooltip(ask, host, key)}>
                            <button
                              type="button"
                              data-testid="project-hosts-ask-row"
                              data-project-hosts-row="ask"
                              data-project-hosts-nav=""
                              data-asks="1"
                              aria-label={askRowLabel(ask, host.hostName)}
                              onClick={(event) => openAsk(host, ask, event)}
                              className={cn(ROW_CLASS, ASK_ROW_CLASS)}
                            >
                              <GlyphSlot>
                                <PilotRunState
                                  band={ask.band}
                                  agentState={ask.agentState ?? undefined}
                                />
                              </GlyphSlot>
                              <span
                                aria-hidden="true"
                                className="min-w-0 truncate text-text-primary"
                              >
                                {ask.label}
                              </span>
                              <span
                                aria-hidden="true"
                                className="ml-auto shrink-0 text-text-secondary"
                              >
                                {askLabel(ask)}
                              </span>
                            </button>
                          </RowTooltip>
                        </li>
                      ))}
                      {hidden.length > 0 && (
                        <li>
                          <RowTooltip
                            lines={[
                              ...hidden.slice(0, MORE_TOOLTIP_NAMES).map((ask) => ask.branch),
                              ...(hidden.length > MORE_TOOLTIP_NAMES ? ["…"] : []),
                              "Click to show all",
                            ]}
                          >
                            <button
                              type="button"
                              data-testid="project-hosts-more-row"
                              data-project-hosts-row="more"
                              data-project-hosts-nav=""
                              data-asks={hidden.length}
                              aria-label={`Show ${hidden.length} more asking on ${host.hostName}`}
                              onClick={(event) => showAll(host.hostId, event)}
                              className={cn(ROW_CLASS, ASK_ROW_CLASS, "text-text-secondary")}
                            >
                              <GlyphSlot />
                              <span aria-hidden="true">{hidden.length} more</span>
                            </button>
                          </RowTooltip>
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          <OverflowCue direction="above" past={edges.above} />
          <OverflowCue direction="below" past={edges.below} />
        </div>
      )}
    </section>
  );
}
