import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
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
import { isNewWindowClick, switchToHost } from "@/components/Hosts/hostSwitching";
import {
  useOtherHostsWorktrees,
  type OtherHostWorktrees,
} from "@/components/Hosts/otherHostsWorktrees";
import {
  ROW_BANDS,
  describeObserved,
  type RowBand,
  summarizeOtherHost,
  type OtherHostAsk,
  type OtherHostSummary,
} from "@/components/Hosts/otherHostSummary";
import { bandLabel } from "@/lib/fleetAttention";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Asking agents named under one host before the rest fold into "N more". */
export const ASKS_PER_HOST = 2;

/** Hidden asking agents a "more" row's tooltip names before it stops listing. */
const MORE_TOOLTIP_NAMES = 4;

interface OtherHostsWorktreeGroupProps {
  /** The project this view shows; its agents on other hosts are summarised. */
  projectId: string | null;
}

/**
 * Rows tighten below 15rem of sidebar (its minimum is 200px), so a host name
 * keeps room beside the three count columns.
 */
const ROW_BASE_CLASS = cn(
  "w-full min-w-0 items-center px-2 py-1 text-left text-xs @[15rem]/others:px-3",
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
  "@[15rem]/others:grid-cols-[1.375rem_minmax(0,1fr)_repeat(3,2rem)]"
);

/**
 * An asking row sits one host row in, and keeps that much scroll margin so
 * revealing or tabbing to it never parks it under its pinned host.
 */
const ASK_ROW_CLASS = "flex gap-2 pl-7.5 scroll-mt-6 @[15rem]/others:pl-8.5";

/** Where each counted band's column starts, as literal classes for Tailwind to see. */
const BAND_COLUMN: Record<RowBand, string> = {
  quiet: "col-start-3",
  review: "col-start-4",
  running: "col-start-5",
};

/** How far the name runs: across every blank column up to the first count shown. */
const NAME_SPAN = ["col-span-1", "col-span-2", "col-span-3", "col-span-4"] as const;

/** The glyph column every row shares, so names and branches start on one edge. */
function GlyphSlot({ children }: { children?: ReactNode }) {
  return (
    <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center">
      {children}
    </span>
  );
}

/** A row's full text and how to open it in a new window, on hover and on focus alike. */
function RowTooltip({ lines, children }: { lines: readonly string[]; children: ReactNode }) {
  const hint = `${isMac() ? "Cmd" : "Ctrl"}-click to open in a new window`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-80">
        {lines.map((line, i) => (
          <div key={`${i}:${line}`} className="[overflow-wrap:anywhere]">
            {line}
          </div>
        ))}
        <div className="text-text-secondary">{hint}</div>
      </TooltipContent>
    </Tooltip>
  );
}

function hostDescription(host: OtherHostWorktrees, summary: OtherHostSummary | null): string {
  if (host.away) return `${host.hostName}, ${host.away.toLowerCase()}`;
  if (!summary) return host.hostName;
  if (summary.observed.size === 0) return `${host.hostName}, no agents observed`;
  return `${host.hostName}: ${describeObserved(summary.observed)} (observed)`;
}

function askDescription(ask: OtherHostAsk, hostName: string): string {
  const label = bandLabel(ask.band, { agentState: ask.agentState ?? undefined });
  return `${ask.branch} on ${hostName}, ${label.toLowerCase()} (observed)`;
}

/** The host's quiet, unread and working counts in their own columns; a zero draws nothing. */
function HostCounts({ summary }: { summary: OtherHostSummary }) {
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
function nameSpan(summary: OtherHostSummary | null, away: boolean): (typeof NAME_SPAN)[number] {
  if (away) return NAME_SPAN[0];
  const first = ROW_BANDS.findIndex((band) => (summary?.counts[band] ?? 0) > 0);
  return NAME_SPAN[first === -1 ? ROW_BANDS.length : first];
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
    if (!el) return;
    const measure = () => {
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      // An asking row's host is pinned over the top of the scroll, so the
      // first row's height of it is covered rather than in view.
      const pinned =
        el.querySelector<HTMLElement>("[data-other-hosts-row='host']")?.offsetHeight ?? 0;
      const above = tally();
      const below = tally();
      for (const row of el.querySelectorAll<HTMLElement>("[data-other-hosts-row]")) {
        // A row more than half past an edge is one the eye can't read.
        const isHost = row.dataset.otherHostsRow === "host";
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
          below.nearestHost ??= row;
        } else if (asks > 0) {
          below.nearestAsk ??= row;
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
      data-other-hosts-overflow={direction}
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

/**
 * This project on every other host, one row per host in the host menu's
 * order: its name, and how many of this project's agents there it observed
 * quiet, unread and working. An agent that is asking (blocked or waiting) is
 * named under its host instead, and picking it lands on that agent's pane; the
 * rest are counted, so the section is as tall as the number of hosts however
 * many agents they run. Observation only: every count is the band that host's
 * own fleet placed, never one decided here. A row opens that host's project in
 * this window, or a new one on Cmd/Ctrl-click.
 */
export function OtherHostsWorktreeGroup({ projectId }: OtherHostsWorktreeGroupProps) {
  const hosts = useOtherHostsWorktrees(projectId);
  // State, not a ref: the list mounts only once a host matches, after the first render.
  const [scroller, setScroller] = useState<HTMLUListElement | null>(null);
  const edges = useHiddenEdges(scroller);
  if (hosts.length === 0) return null;

  const openHost = (host: OtherHostWorktrees, summary: OtherHostSummary | null, e: MouseEvent) => {
    void switchToHost(
      host.hostId,
      isNewWindowClick(e),
      summary?.asks[0]?.projectId ?? host.projectIds[0]
    );
  };
  const openAsk = (host: OtherHostWorktrees, ask: OtherHostAsk, e: MouseEvent) => {
    void switchToHost(host.hostId, isNewWindowClick(e), ask.projectId, {
      focusIntent:
        ask.terminalId === null
          ? { intent: "focus-next-waiting" }
          : { intent: "focus-panel", panelId: ask.terminalId },
    });
  };

  return (
    <section
      aria-label="On other hosts"
      // At most half the sidebar, so the local worktrees always keep the rest.
      className="@container/others flex max-h-[50%] shrink-0 flex-col border-t border-border-default"
      data-testid="other-hosts-worktree-group"
    >
      <div className="shrink-0 px-2 pt-2 pb-1 @[15rem]/others:px-3">
        <span className={PALETTE_SECTION_LABEL_CLASS}>On other hosts</span>
      </div>
      <div className="relative flex min-h-0 flex-col">
        <ul ref={setScroller} className="relative min-h-0 overflow-y-auto pb-2">
          {hosts.map((host) => {
            const summary = host.entries ? summarizeOtherHost(host.entries) : null;
            const asks = summary?.asks ?? [];
            const shown = asks.slice(0, ASKS_PER_HOST);
            const hidden = asks.slice(ASKS_PER_HOST);
            return (
              <li key={host.hostId} data-host-id={host.hostId}>
                <RowTooltip lines={host.away ? [host.hostName, host.away] : [host.hostName]}>
                  <button
                    type="button"
                    data-testid="other-hosts-host-row"
                    data-other-hosts-row="host"
                    aria-label={hostDescription(host, summary)}
                    onClick={(event) => openHost(host, summary, event)}
                    className={HOST_ROW_CLASS}
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
                        nameSpan(summary, host.away !== null)
                      )}
                    >
                      <HostNameText
                        name={host.hostName}
                        title={false}
                        // At the sidebar's minimum the tail, which tells hosts apart, outranks the head.
                        headFloor="min-w-[2ch] @[15rem]/others:min-w-[4ch]"
                        className={cn(
                          "font-medium",
                          host.away ? "text-text-secondary" : "text-text-primary"
                        )}
                      />
                    </span>
                    {host.away ? (
                      <span
                        aria-hidden="true"
                        className="col-span-3 col-start-3 row-start-1 justify-self-end whitespace-nowrap text-text-secondary"
                      >
                        {host.away}
                      </span>
                    ) : (
                      summary && <HostCounts summary={summary} />
                    )}
                  </button>
                </RowTooltip>
                {shown.length > 0 && (
                  <ul>
                    {shown.map((ask) => (
                      <li key={`${ask.worktreeId}:${ask.terminalId ?? ""}`}>
                        <RowTooltip lines={[ask.branch]}>
                          <button
                            type="button"
                            data-testid="other-hosts-ask-row"
                            data-other-hosts-row="ask"
                            data-asks="1"
                            aria-label={askDescription(ask, host.hostName)}
                            onClick={(event) => openAsk(host, ask, event)}
                            className={cn(ROW_CLASS, ASK_ROW_CLASS)}
                          >
                            <GlyphSlot>
                              <PilotRunState
                                band={ask.band}
                                agentState={ask.agentState ?? undefined}
                              />
                            </GlyphSlot>
                            <span aria-hidden="true" className="min-w-0 truncate text-text-primary">
                              {ask.label}
                            </span>
                            <span
                              aria-hidden="true"
                              className="ml-auto shrink-0 text-text-secondary"
                            >
                              {bandLabel(ask.band, { agentState: ask.agentState ?? undefined })}
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
                          ]}
                        >
                          <button
                            type="button"
                            data-testid="other-hosts-more-row"
                            data-other-hosts-row="more"
                            data-asks={hidden.length}
                            aria-label={`${hidden.length} more asking on ${host.hostName}`}
                            onClick={(event) => openAsk(host, hidden[0]!, event)}
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
    </section>
  );
}
