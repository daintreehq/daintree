import {
  useEffect,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import type { HostId } from "@shared/types/remoteHosts";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import { ScrollPill } from "@/components/ui/ScrollPill";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { pluralize } from "@/lib/pluralize";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Server } from "@/components/icons";
import { HostNameText } from "@/components/Hosts/HostNameText";
import { PlatformGlyph } from "@/components/Hosts/PlatformGlyph";
import { openProjectOnHost } from "@/components/Hosts/OpenOnHostSubmenu";
import { isNewWindowClick, switchToHost } from "@/components/Hosts/hostSwitching";
import { useProjectHosts, type ProjectHost } from "@/components/Hosts/projectHosts";
import {
  ROW_BANDS,
  summarizeHostProject,
  type HostProjectSummary,
  type RowBand,
} from "@/components/Hosts/projectHostSummary";
import { hostRowLabel, hostRowStatus, hostRowTooltip } from "@/components/Hosts/projectHostLines";
import {
  handOffOrder,
  isOrderSettled,
  priorityOrder,
  useOrderPatience,
  useSteadyOrder,
} from "@/components/Hosts/projectHostOrder";
import { useProjectStore } from "@/store/projectStore";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  setProjectHostsAllShown,
  setProjectHostsExpanded,
  useProjectHostsAllShown,
  useProjectHostsExpanded,
} from "./projectHostsExpanded";

/**
 * Rows shown before the rest fold into one: this machine and four more. The
 * section shares the sidebar with the worktree list, and on a small screen
 * five rows is already a fair share of it.
 */
export const VISIBLE_HOSTS = 5;

const LIST_ID = "project-hosts-list";
const TOTALS_ID = "project-hosts-totals";
const FOLDED_ID = "project-hosts-folded";

interface ProjectHostsGroupProps {
  /** The project this view shows; its agents on every host are summarised. */
  projectId: string | null;
}

/** Rows tighten below 15rem of sidebar (its minimum is 200px), so a host name keeps room beside its counts. */
const ROW_CLASS = cn(
  "flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-xs @[15rem]/hosts:px-3",
  "transition-colors hover:bg-overlay-subtle",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline"
);

/** The window's own host: the selection lift. */
const CURRENT_ROW_CLASS = "bg-overlay-soft hover:bg-overlay-soft";

/**
 * One fixed-width cell per counted column, the same columns on every row, so
 * a count sits in the same place whichever host it belongs to. Each holds a
 * glyph and two digits.
 */
const CELL_CLASS =
  "flex w-7.5 shrink-0 items-center justify-end gap-0.5 tabular-nums text-text-primary @[15rem]/hosts:w-8";

/** Rows the section's own arrow keys move between, header included. */
const NAV_SELECTOR = "[data-project-hosts-nav]";

function newWindowKey(): string {
  return isMac() ? "Cmd" : "Ctrl";
}

/** The glyph column every row shares, so names start on one edge. */
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

type Counts = Readonly<Record<RowBand, number>>;

const NO_COUNTS: Counts = { asking: 0, quiet: 0, review: 0, running: 0 };

function addCounts(a: Counts, b: Counts): Counts {
  return {
    asking: a.asking + b.asking,
    quiet: a.quiet + b.quiet,
    review: a.review + b.review,
    running: a.running + b.running,
  };
}

/**
 * A row's counts in the section's columns, right-aligned so each column lines
 * up across rows. A zero leaves its cell empty; the empty cells before a
 * row's first count are left out, so its name runs across them, and below
 * 15rem the empty cells between two counts go too, so names keep their tails.
 * The empty cells after a row's last count stay: they are what keep that
 * count in its column.
 */
function CountCells({
  counts,
  askingBand,
  columns,
}: {
  counts: Counts;
  askingBand: "blocked" | "needs-you";
  columns: readonly RowBand[];
}) {
  const first = columns.findIndex((band) => counts[band] > 0);
  let last = -1;
  columns.forEach((band, i) => {
    if (counts[band] > 0) last = i;
  });
  return (
    <span aria-hidden="true" className="ml-auto flex shrink-0">
      {columns.slice(Math.max(first, 0)).map((band, i) => {
        const n = counts[band];
        const gap = n === 0 && Math.max(first, 0) + i < last;
        return (
          <span
            key={band}
            data-count-cell={band}
            data-band={n > 0 ? band : undefined}
            className={cn(CELL_CLASS, gap && "@max-[15rem]/hosts:hidden")}
          >
            {n > 0 && (
              <>
                <PilotRunState
                  band={band === "asking" ? askingBand : band}
                  agentState={undefined}
                />
                {n}
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}

interface Totals {
  asking: number;
  working: number;
}

const BAND_WORDS: Record<RowBand, string> = {
  asking: "asking",
  quiet: "quiet",
  review: "unread",
  running: "working",
};

/** "1 asking, 3 working (observed)": a row's counts for whoever can't see the cells. */
function describeCounts(counts: Counts): string {
  const parts = ROW_BANDS.filter((band) => counts[band] > 0).map(
    (band) => `${counts[band]} ${BAND_WORDS[band]}`
  );
  return `${parts.join(", ")} (observed)`;
}

function describeTotals(totals: Totals): string {
  const parts: string[] = [];
  if (totals.asking > 0) parts.push(`${totals.asking} asking`);
  if (totals.working > 0) parts.push(`${totals.working} working`);
  return `${parts.join(", ")} on other hosts (observed)`;
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

interface HiddenPast {
  rows: number;
  /** The row to bring into view: the nearest one past the edge. */
  nearest: HTMLElement | null;
}

interface HiddenEdges {
  above: HiddenPast;
  below: HiddenPast;
}

const NOTHING_PAST: HiddenPast = { rows: 0, nearest: null };
const NOTHING_HIDDEN: HiddenEdges = { above: NOTHING_PAST, below: NOTHING_PAST };

function samePast(a: HiddenPast, b: HiddenPast): boolean {
  return a.rows === b.rows && a.nearest === b.nearest;
}

/** How many rows the section's own scroll has past each edge, kept current as it scrolls, resizes and changes. */
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
      let above = 0;
      let below = 0;
      let nearestAbove: HTMLElement | null = null;
      let nearestBelow: HTMLElement | null = null;
      for (const row of el.querySelectorAll<HTMLElement>("[data-project-hosts-row]")) {
        // A row more than half past an edge is one the eye can't read.
        const middle = row.offsetTop + row.offsetHeight / 2;
        if (middle < top) {
          above += 1;
          nearestAbove = row;
        } else if (middle > bottom) {
          below += 1;
          if (nearestBelow === null) nearestBelow = row;
        }
      }
      const next: HiddenEdges = {
        above: { rows: above, nearest: nearestAbove },
        below: { rows: below, nearest: nearestBelow },
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
    const changed = new MutationObserver(measure);
    changed.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", measure);
      resized.disconnect();
      changed.disconnect();
    };
  }, [el]);
  return hidden;
}

/**
 * The sidebar's own scroll pill, for this section's overflow: how many rows
 * are past the edge. Rows stay in Tab order, which scrolls them in, so the
 * pill is the pointer's shortcut and stays out of the accessibility tree.
 */
function OverflowCue({ direction, past }: { direction: "above" | "below"; past: HiddenPast }) {
  const { isVisible, shouldRender } = useAnimatedPresence({ isOpen: past.rows > 0 });
  // Fading out, it keeps saying what it last said rather than "0".
  const [lastShown, setLastShown] = useState<HiddenPast>(past);
  if (past.rows > 0 && !samePast(past, lastShown)) setLastShown(past);
  const shown = past.rows > 0 ? past : lastShown;
  if (!shouldRender) return null;
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
            <span className="font-medium tabular-nums">{shown.rows}</span>
          </ScrollPill>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          {pluralize(shown.rows, "more host", "more hosts")} {direction}
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

/**
 * This project on every host, the window's own included, one row per host: a
 * quick way to get to any of them. Each row shows how many of this project's
 * agents there it observed asking, quiet, unread and working, or the one
 * phrase that stands in for them (the link's words while it is down, "Not
 * added" where no project there shares the repository). Observation only:
 * every count is the band that host's own fleet placed, never one decided
 * here. A row opens that host's project in this window, or a new one on
 * Cmd/Ctrl-click.
 *
 * Hosts come in priority order (this machine, then the ones asking, working,
 * and so on), held still while the section is in use and carried across a
 * switch, so a row never moves under a click. The first few show; the rest
 * fold into one row. The header names the project and collapses the section,
 * once for every window on every host; collapsed, it keeps the totals for the
 * other machines.
 */
export function ProjectHostsGroup({ projectId }: ProjectHostsGroupProps) {
  const hosts = useProjectHosts(projectId);
  const projectName = useProjectStore((state) => state.currentProject?.name ?? null);
  const expanded = useProjectHostsExpanded();
  const [section, setSection] = useState<HTMLElement | null>(null);
  // State, not a ref: the list mounts only once a host is there, after the first render.
  const [scroller, setScroller] = useState<HTMLUListElement | null>(null);
  const edges = useHiddenEdges(scroller);
  // Unknown until the section is there to ask: a view opened by a click on
  // this section opens under a pointer that hasn't moved, and must not
  // reorder before it knows.
  const [pointerIn, setPointerIn] = useState<boolean | null>(null);
  const [focusIn, setFocusIn] = useState(false);
  const patient = useOrderPatience();
  const allShownPreference = useProjectHostsAllShown();

  const summaries = new Map<HostId, HostProjectSummary>();
  for (const host of hosts) {
    if (host.entries) summaries.set(host.hostId, summarizeHostProject(host.entries));
  }
  const free = (isOrderSettled(hosts) || !patient) && pointerIn === false && !focusIn;
  const order = useSteadyOrder(priorityOrder(hosts, summaries), free);

  // The fold is held like the order: a host joining, or another window
  // opening or closing the fold, waits until the section is out of use, so a
  // row never turns into "N more" under the pointer. This view's own click
  // applies at once.
  const foldsNow = order.length > VISIBLE_HOSTS + 1;
  const [heldFolds, setHeldFolds] = useState<boolean | null>(null);
  if (order.length > 0 && (heldFolds === null || (free && heldFolds !== foldsNow))) {
    setHeldFolds(foldsNow);
  }
  const [allShown, setAllShown] = useState(allShownPreference);
  if (free && allShown !== allShownPreference) setAllShown(allShownPreference);

  useEffect(() => {
    if (section) setPointerIn(section.matches(":hover"));
  }, [section]);

  if (hosts.length === 0) return null;

  const byId = new Map(hosts.map((host) => [host.hostId, host]));
  const ordered = order.flatMap((hostId) => byId.get(hostId) ?? []);
  // Folding one host would spend a row to save a row.
  const folds = (heldFolds ?? foldsNow) && ordered.length > VISIBLE_HOSTS;
  const shown = folds ? ordered.slice(0, VISIBLE_HOSTS) : ordered;
  const folded = folds ? ordered.slice(VISIBLE_HOSTS) : [];

  // The same columns on every row: every band any host is counting right now.
  const columns = ROW_BANDS.filter((band) =>
    [...summaries.values()].some((summary) => summary.counts[band] > 0)
  );
  let otherTotals: Totals = { asking: 0, working: 0 };
  let foldedCounts = NO_COUNTS;
  let foldedBlocked = false;
  for (const host of ordered) {
    const summary = summaries.get(host.hostId);
    if (!summary) continue;
    if (!host.isLocal) {
      otherTotals = {
        asking: otherTotals.asking + summary.counts.asking,
        working: otherTotals.working + summary.counts.running,
      };
    }
    if (folded.includes(host)) {
      foldedCounts = addCounts(foldedCounts, summary.counts);
      if (summary.askingBand === "blocked") foldedBlocked = true;
    }
  }
  const foldedCounted = ROW_BANDS.some((band) => foldedCounts[band] > 0);
  const key = newWindowKey();

  const openHost = (host: ProjectHost, e: MouseEvent) => {
    if (host.isCurrent) return;
    const newWindow = isNewWindowClick(e);
    // The window this opens starts from the order the click was made in.
    handOffOrder(order);
    // Nothing there to switch to: the switch dialog finds the copy, or offers to set one up.
    if (!host.away && (host.presence === "none" || host.presence === "unknown")) {
      if (projectId !== null) void openProjectOnHost(host.hostId, projectId, newWindow, "user");
      return;
    }
    void switchToHost(host.hostId, newWindow, host.projectIds[0]);
  };
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) {
      setFocusIn(false);
    }
  };

  const title = projectName ?? "This project";
  const hostRow = (host: ProjectHost) => {
    const summary = summaries.get(host.hostId) ?? null;
    const status = hostRowStatus(host, summary);
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
            className={cn(ROW_CLASS, host.isCurrent && CURRENT_ROW_CLASS)}
          >
            <GlyphSlot>
              {host.platform ? (
                <PlatformGlyph platform={host.platform} className="text-text-secondary" />
              ) : (
                <Server className="size-3 text-text-secondary" />
              )}
            </GlyphSlot>
            <span className="min-w-0 flex-1 overflow-hidden">
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
            {status.kind === "counts" && summary ? (
              <CountCells
                counts={summary.counts}
                askingBand={summary.askingBand}
                columns={columns}
              />
            ) : status.kind === "away" || status.kind === "note" ? (
              <span aria-hidden="true" className="shrink-0 whitespace-nowrap text-text-secondary">
                {status.text}
              </span>
            ) : null}
          </button>
        </RowTooltip>
      </li>
    );
  };

  return (
    <section
      ref={setSection}
      aria-label={`${title} across hosts`}
      // At most half the sidebar, so the local worktrees always keep the rest.
      className="@container/hosts flex max-h-[50%] shrink-0 flex-col border-t border-border-default"
      data-testid="project-hosts-group"
      onKeyDown={moveFocus}
      onPointerEnter={() => setPointerIn(true)}
      onPointerLeave={() => setPointerIn(false)}
      onFocus={() => setFocusIn(true)}
      onBlur={onBlur}
    >
      <button
        type="button"
        data-project-hosts-nav=""
        data-testid="project-hosts-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? LIST_ID : undefined}
        aria-label={`${title} across hosts`}
        aria-describedby={
          !expanded && (otherTotals.asking > 0 || otherTotals.working > 0) ? TOTALS_ID : undefined
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
        <span className="flex min-w-0 flex-1 text-2xs font-medium text-text-secondary select-none group-hover/toggle:text-text-primary">
          <span className="min-w-0 truncate">{title}</span>
          <span className="shrink-0 whitespace-pre"> across hosts</span>
        </span>
        {!expanded && <CollapsedTotals totals={otherTotals} />}
      </button>
      {expanded && (
        <div className="relative flex min-h-0 flex-col">
          <ul id={LIST_ID} ref={setScroller} className="relative min-h-0 overflow-y-auto pb-2">
            {shown.map(hostRow)}
            {folds && (
              <li>
                <button
                  type="button"
                  data-testid="project-hosts-more-row"
                  data-project-hosts-row="more"
                  data-project-hosts-nav=""
                  aria-expanded={allShown}
                  aria-describedby={!allShown && foldedCounted ? FOLDED_ID : undefined}
                  onClick={() => {
                    setAllShown(!allShown);
                    setProjectHostsAllShown(!allShown);
                  }}
                  className={ROW_CLASS}
                >
                  <GlyphSlot>
                    <ChevronRight
                      data-animated-chevron
                      className={cn(
                        "size-3 text-text-secondary transition-transform duration-150 ease-out",
                        allShown && "rotate-90"
                      )}
                    />
                  </GlyphSlot>
                  <span className="min-w-0 flex-1 truncate text-text-secondary">
                    {pluralize(folded.length, "more host", "more hosts")}
                  </span>
                  {!allShown && foldedCounted && (
                    <>
                      <span id={FOLDED_ID} className="sr-only">
                        {describeCounts(foldedCounts)}
                      </span>
                      <CountCells
                        counts={foldedCounts}
                        askingBand={foldedBlocked ? "blocked" : "needs-you"}
                        columns={columns}
                      />
                    </>
                  )}
                </button>
              </li>
            )}
            {allShown && folded.map(hostRow)}
          </ul>
          <OverflowCue direction="above" past={edges.above} />
          <OverflowCue direction="below" past={edges.below} />
        </div>
      )}
    </section>
  );
}
