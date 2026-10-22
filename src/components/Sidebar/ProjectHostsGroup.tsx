import {
  useEffect,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import type { HostId } from "@shared/types/remoteHosts";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import { pluralize, pluralNoun } from "@/lib/pluralize";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LIST_DETAIL_ROW_CLASS } from "@/components/ui/paletteRowStyles";
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
import {
  hostRowLabel,
  hostRowStatus,
  hostRowTooltip,
  type HostTooltip,
} from "@/components/Hosts/projectHostLines";
import {
  handOffOrder,
  isOrderSettled,
  priorityOrder,
  useOrderPatience,
  useSteadyOrder,
} from "@/components/Hosts/projectHostOrder";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
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

/**
 * Every row of the section sits on the sidebar footer's grid, at every width:
 * the footer's 16px inset, its 12px glyph column, then the text, and the Run
 * command toggle's 12px on the right. So the header's chevron, each host's
 * platform mark and the footer's status dot share one column, and the header,
 * the host names and "N projects active" start on one edge.
 */
const GRID_CLASS = "flex w-full min-w-0 items-center gap-2 pl-4 pr-3 text-left";

const FOCUS_CLASS =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline";

/**
 * A host row, and the fold row with it: the list-detail row, so the window's
 * own host takes the one highlighted-row fill the app uses for "the row you
 * are on" and the pointer a lighter step that never paints over it.
 */
const ROW_CLASS = cn(
  GRID_CLASS,
  LIST_DETAIL_ROW_CLASS,
  // Without the palette row's 1px transparent border, which would set every
  // name 1px right of the header and the footer.
  "border-0 py-1 text-xs",
  FOCUS_CLASS
);

/**
 * One fixed-width cell per counted column, the same columns on every row, so
 * a count sits in the same place whichever host it belongs to. Each holds a
 * glyph and two digits.
 */
const CELL_CLASS =
  "flex w-7.5 shrink-0 items-center justify-end gap-0.5 tabular-nums @[15rem]/hosts:w-8";

/** Rows the section's own arrow keys move between, header included. */
const NAV_SELECTOR = "[data-project-hosts-nav]";

function newWindowKey(): string {
  return isMac() ? "Cmd" : "Ctrl";
}

/** The footer's glyph column, so a row's mark sits over its status dot. */
function GlyphSlot({ children }: { children?: ReactNode }) {
  return (
    <span aria-hidden="true" className="flex w-3 shrink-0 items-center justify-center">
      {children}
    </span>
  );
}

/**
 * A row's tooltip, read top to bottom: the full name, what is going on there,
 * then what a click does. It stays while the row is hovered or focused: its
 * body is the row's detail, not a passing hint.
 */
function RowTooltip({ tooltip, children }: { tooltip: HostTooltip; children: ReactNode }) {
  return (
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-baseline gap-1.5">
            <span className="font-medium [overflow-wrap:anywhere]">{tooltip.title}</span>
            {tooltip.note && (
              <span className="shrink-0 text-2xs text-text-secondary">{tooltip.note}</span>
            )}
          </span>
          {tooltip.lines.map((line) => (
            <span key={line} className="text-text-secondary">
              {line}
            </span>
          ))}
          {tooltip.hint && (
            <span className="mt-1 text-2xs text-text-secondary">{tooltip.hint}</span>
          )}
        </span>
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
 * count in its column. A summary of other rows (the fold) draws its numbers
 * in secondary ink, so it never reads as one more host.
 */
function CountCells({
  counts,
  askingBand,
  columns,
  summary = false,
}: {
  counts: Counts;
  askingBand: "blocked" | "needs-you";
  columns: readonly RowBand[];
  summary?: boolean;
}) {
  const first = columns.findIndex((band) => counts[band] > 0);
  let last = -1;
  columns.forEach((band, i) => {
    if (counts[band] > 0) last = i;
  });
  return (
    <span
      aria-hidden="true"
      className={cn("ml-auto flex shrink-0", summary ? "text-text-secondary" : "text-text-primary")}
    >
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
  /** Whether any of the asking agents is blocked, so the total wears that mark as a row would. */
  blocked: boolean;
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

/** The collapsed header's totals, in the footer readout's type so the two rows read as a pair. */
function CollapsedTotals({ totals }: { totals: Totals }) {
  if (totals.asking === 0 && totals.working === 0) return null;
  return (
    <span
      data-testid="project-hosts-totals"
      className="flex shrink-0 items-center gap-2 text-2xs font-medium tabular-nums text-text-primary"
    >
      {/* The toggle's name never changes with its state; the totals describe it instead. */}
      <span id={TOTALS_ID} className="sr-only">
        {describeTotals(totals)}
      </span>
      {totals.asking > 0 && (
        <span aria-hidden="true" data-total="asking" className="flex items-center gap-0.5">
          <PilotRunState band={totals.blocked ? "blocked" : "needs-you"} agentState={undefined} />
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

interface HostRowProps {
  host: ProjectHost;
  summary: HostProjectSummary | null;
  columns: readonly RowBand[];
  newWindowKey: string;
  onOpen: (host: ProjectHost, event: MouseEvent) => void;
}

/** One host: its mark, its name, and its counts or the phrase standing in for them. */
function HostRow({ host, summary, columns, newWindowKey: key, onOpen }: HostRowProps) {
  const status = hostRowStatus(host, summary);
  // A lookup or a read still out says so only once it is slow enough to notice.
  const showChecking = useDeferredLoading(status.kind === "checking", UI_INLINE_LOADING_GATE_MS);
  return (
    <li data-host-id={host.hostId}>
      <RowTooltip tooltip={hostRowTooltip(host, summary, key)}>
        <button
          type="button"
          data-testid="project-hosts-host-row"
          data-project-hosts-row="host"
          data-project-hosts-nav=""
          data-status={status.kind}
          data-selected={host.isCurrent ? "true" : undefined}
          aria-current={host.isCurrent ? "true" : undefined}
          aria-label={hostRowLabel(host, summary)}
          onClick={(event) => onOpen(host, event)}
          className={ROW_CLASS}
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
              // Primary in every state: a host that is down is still a row you can click.
              className="font-medium text-text-primary"
            />
          </span>
          {status.kind === "counts" && summary ? (
            <CountCells counts={summary.counts} askingBand={summary.askingBand} columns={columns} />
          ) : status.kind === "away" || status.kind === "note" ? (
            <span aria-hidden="true" className="shrink-0 whitespace-nowrap text-text-secondary">
              {status.text}
            </span>
          ) : showChecking ? (
            <span aria-hidden="true" className="shrink-0 whitespace-nowrap text-text-secondary">
              Checking…
            </span>
          ) : null}
        </button>
      </RowTooltip>
    </li>
  );
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
 * other machines. It sits directly on the sidebar footer and is built on the
 * footer's grid, so the two read as one stack of 28px rows.
 */
export function ProjectHostsGroup({ projectId }: ProjectHostsGroupProps) {
  const hosts = useProjectHosts(projectId);
  const projectName = useProjectStore((state) => state.currentProject?.name ?? null);
  const expanded = useProjectHostsExpanded();
  const [section, setSection] = useState<HTMLElement | null>(null);
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
  let otherTotals: Totals = { asking: 0, working: 0, blocked: false };
  let foldedCounts = NO_COUNTS;
  let foldedBlocked = false;
  for (const host of ordered) {
    const summary = summaries.get(host.hostId);
    if (!summary) continue;
    if (!host.isLocal) {
      otherTotals = {
        asking: otherTotals.asking + summary.counts.asking,
        working: otherTotals.working + summary.counts.running,
        blocked: otherTotals.blocked || summary.askingBand === "blocked",
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
  const hostRow = (host: ProjectHost) => (
    <HostRow
      key={host.hostId}
      host={host}
      summary={summaries.get(host.hostId) ?? null}
      columns={columns}
      newWindowKey={key}
      onOpen={openHost}
    />
  );

  return (
    <section
      ref={setSection}
      aria-label={`${title} across hosts`}
      // At most half the sidebar, so the local worktrees always keep the rest.
      // The footer's divider, so the stack under the worktree list reads as one family.
      className="@container/hosts flex max-h-[50%] shrink-0 flex-col border-t border-divider"
      data-testid="project-hosts-group"
      onKeyDown={moveFocus}
      onPointerEnter={() => setPointerIn(true)}
      onPointerLeave={() => setPointerIn(false)}
      onFocus={() => setFocusIn(true)}
      onBlur={onBlur}
    >
      {/* The footer's row: its height, its type, its glyph column and its hover. */}
      <button
        type="button"
        data-project-hosts-nav=""
        data-testid="project-hosts-toggle"
        aria-expanded={expanded}
        aria-controls={LIST_ID}
        aria-label={`${title} across hosts`}
        aria-describedby={
          !expanded && (otherTotals.asking > 0 || otherTotals.working > 0) ? TOTALS_ID : undefined
        }
        onClick={() => setProjectHostsExpanded(!expanded)}
        className={cn(
          GRID_CLASS,
          "group/toggle min-h-7 shrink-0 transition-colors hover:bg-overlay-subtle",
          FOCUS_CLASS
        )}
      >
        <GlyphSlot>
          <ChevronRight
            data-animated-chevron
            className={cn(
              "size-3 text-text-secondary transition-transform duration-150 ease-out",
              expanded && "rotate-90"
            )}
          />
        </GlyphSlot>
        <span className="flex min-w-0 flex-1 text-2xs font-medium text-text-secondary select-none group-hover/toggle:text-text-primary">
          <span className="min-w-0 truncate">{title}</span>
          <span className="shrink-0 whitespace-pre"> across hosts</span>
        </span>
        {!expanded && <CollapsedTotals totals={otherTotals} />}
      </button>
      {/* Always in the tree, so the header's aria-controls names it open or closed. */}
      <div id={LIST_ID} hidden={!expanded} className="flex min-h-0 flex-col">
        {expanded && (
          <ul className="min-h-0 overflow-y-auto pb-1.5">
            {shown.map(hostRow)}
            {folds && (
              <li>
                <button
                  type="button"
                  data-testid="project-hosts-more-row"
                  data-project-hosts-row="more"
                  data-project-hosts-nav=""
                  aria-expanded={allShown}
                  aria-label={pluralize(folded.length, "more host", "more hosts")}
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
                  {/* "5 more" at the sidebar's narrowest, so the label never clips before its counts. */}
                  <span aria-hidden="true" className="min-w-0 flex-1 truncate text-text-secondary">
                    {folded.length} more
                    <span className="@max-[15rem]/hosts:hidden">
                      {` ${pluralNoun(folded.length, "host")}`}
                    </span>
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
                        summary
                      />
                    </>
                  )}
                </button>
              </li>
            )}
            {allShown && folded.map(hostRow)}
          </ul>
        )}
      </div>
    </section>
  );
}
