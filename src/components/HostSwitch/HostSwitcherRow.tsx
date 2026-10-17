import type { ReactNode } from "react";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { formatBytes } from "@/lib/formatBytes";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { AgentCounts, MetricDash } from "@/components/Hosts/AgentCounts";
import { PlatformGlyph } from "@/components/Hosts/PlatformGlyph";
import { LinkMark } from "@/components/Hosts/LinkMark";
import { HostNameText } from "@/components/Hosts/HostNameText";
import { isNewWindowClick } from "@/components/Hosts/hostSwitching";
import { LazyHostSparkline } from "@/components/Hosts/Overview/LazyHostOverviewParts";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { cpuSeries } from "@/components/Hosts/Overview/overviewModel";
import { describeBuildMismatch } from "@/components/Settings/Hosts/hostLabels";
import {
  describeHostMenuState,
  hostChipStatus,
  hostChipStatusText,
  hostLinkTone,
  type HostMenuRow,
} from "@/components/Hosts/hostModel";

/**
 * One grid for the header and every row, so the numbers stand in columns:
 * host, observed agents, CPU, memory, link.
 */
export const HOST_SWITCHER_GRID =
  "grid grid-cols-[minmax(0,1fr)_76px_96px_76px_56px] items-center gap-x-3";

/** Five minutes at the host's 5 s cadence: long enough to show a trend, short enough to be now. */
const SPARK_SAMPLES = 60;
/** A sparkline needs a few samples before its shape says anything. */
const MIN_SPARK_SAMPLES = 3;

const CPU_HOT = 90;

export function HostSwitcherHeader() {
  return (
    <div
      aria-hidden="true"
      className={cn(HOST_SWITCHER_GRID, "px-3 pb-1 pt-0.5 text-2xs text-text-secondary")}
    >
      <span className="pl-[45px]">Host</span>
      <span>Agents</span>
      <span>CPU</span>
      <span>Memory</span>
      <span className="text-right">Link</span>
    </div>
  );
}

/** The host's own name with its distinguishing tail kept whole when it has to clip. */
function HostName({ name, dim }: { name: string; dim: boolean }) {
  return (
    <HostNameText
      name={name}
      className={cn(
        "text-sm font-medium",
        dim ? "text-text-secondary group-aria-selected:text-text-primary" : "text-text-primary"
      )}
    />
  );
}

function CpuCell({
  summary,
  history,
}: {
  summary: HostMetricsSummary;
  history: readonly HostMetricsSummary[];
}) {
  const cpu = summary.cpuPercent;
  if (cpu === null) return <MetricDash label="CPU not measured" />;
  const series = cpuSeries(history.slice(0, SPARK_SAMPLES));
  const measured = series.filter((value) => value !== null).length;
  const hot = cpu >= CPU_HOT;
  return (
    <span className="flex items-center gap-1.5">
      {measured >= MIN_SPARK_SAMPLES ? (
        <LazyHostSparkline
          values={series}
          windowSize={SPARK_SAMPLES}
          label="CPU over the last 5 minutes"
          fit
          className="h-4 w-12 shrink-0 text-text-secondary"
        />
      ) : (
        <span className="w-12 shrink-0" aria-hidden="true" />
      )}
      <span
        className={cn(
          "w-[4ch] text-right text-xs tabular-nums",
          hot ? "text-status-warning" : "text-text-primary"
        )}
      >
        {Math.round(cpu)}%<span className="sr-only"> CPU</span>
      </span>
    </span>
  );
}

const PRESSURE = {
  normal: { word: "normal", lit: 1, tone: "text-text-primary", fill: "bg-text-secondary" },
  warn: { word: "high", lit: 2, tone: "text-status-warning", fill: "bg-status-warning" },
  critical: { word: "critical", lit: 3, tone: "text-status-error", fill: "bg-status-error" },
} as const;

/**
 * Memory pressure, the reading that says whether the machine is short: used
 * bytes alone run high on any Mac that caches. The steps lit carry the level
 * as well as the colour; capacity is in the tooltip.
 */
function MemoryCell({ summary }: { summary: HostMetricsSummary }) {
  const pressure = summary.memoryPressure;
  if (pressure === null) return <MetricDash label="Memory pressure not measured" />;
  const level = PRESSURE[pressure];
  const { memoryUsedBytes: used, memoryTotalBytes: total } = summary;
  const capacity =
    used !== null && total ? `${formatBytes(used)} of ${formatBytes(total)} in use` : undefined;
  return (
    <span className="flex items-center gap-1.5" title={capacity}>
      <span aria-hidden="true" className="flex shrink-0 items-end gap-px">
        {[0, 1, 2].map((step) => (
          <span
            key={step}
            className={cn(
              "w-1 rounded-xs",
              step === 0 ? "h-1.5" : step === 1 ? "h-2" : "h-2.5",
              step < level.lit ? level.fill : "bg-border-strong"
            )}
          />
        ))}
      </span>
      <span className={cn("text-xs", level.tone)}>
        {level.word}
        <span className="sr-only"> memory pressure{capacity ? `, ${capacity}` : ""}</span>
      </span>
    </span>
  );
}

function LinkCell({ row }: { row: HostMenuRow }) {
  if (row.isLocal) return <span className="text-right text-xs text-text-secondary">local</span>;
  const rtt = row.connection?.status === "connected" ? row.connection.rttMs : null;
  if (rtt === null) return <MetricDash label="Round trip not measured" align="right" />;
  return (
    <span className="text-right text-xs tabular-nums text-text-primary">
      {Math.round(rtt)} ms<span className="sr-only"> round trip</span>
    </span>
  );
}

/**
 * What sits under the name. Anything that changes what picking the host does
 * leads (who has control, a different build); then the host's footprint while
 * live, otherwise when it was last there.
 */
function metaLine(row: HostMenuRow, summary: HostMetricsSummary | null, now: number): ReactNode {
  const connection = row.connection;
  const warnings: string[] = [];
  if (connection?.status === "driven-elsewhere") {
    warnings.push(`${connection.driver.clientName} has control`);
  } else if (row.isLocal && summary?.driver && !summary.driver.isHostLocal) {
    // This machine, driven from another: what it reports about its own lease.
    warnings.push(`${summary.driver.clientName} has control`);
  }
  if (connection?.status === "connected" && connection.buildMismatch) {
    // The short form; the full one names the build in the tooltip.
    warnings.push(
      capitalize(describeBuildMismatch(connection.buildMismatch).replace(/ \(.*\)$/, ""))
    );
  }
  const facts: string[] = [];
  if (summary) {
    if (summary.projectCount !== null) facts.push(pluralize(summary.projectCount, "project"));
    if (summary.worktreeCount !== null) facts.push(pluralize(summary.worktreeCount, "worktree"));
  } else if (warnings.length === 0) {
    const { note } = describeHostMenuState(row, now);
    if (note) return note;
    if (row.lastSeenAt !== null) return `Last seen ${formatRelativeTime(row.lastSeenAt, now)}`;
    return null;
  }
  if (warnings.length === 0) return facts.join(" · ") || null;
  return (
    <>
      {/* Machine names keep their own case, so only the build phrase is capitalised. */}
      <span className="text-status-warning">{warnings.join(" · ")}</span>
      {facts.length > 0 && ` · ${facts.join(" · ")}`}
    </>
  );
}

function metaTitle(row: HostMenuRow): string | undefined {
  const connection = row.connection;
  return connection?.status === "connected" && connection.buildMismatch
    ? capitalize(describeBuildMismatch(connection.buildMismatch))
    : undefined;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The link state in the toolbar chip's words, where the numbers would otherwise stand. */
function linkStateText(row: HostMenuRow): string {
  const text = hostChipStatusText(hostChipStatus(false, row.connection, null));
  if (!text) return "Not connected";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface HostSwitcherRowProps {
  row: HostMenuRow;
  /** The metrics this row may show: null unless the link is up. */
  summary: HostMetricsSummary | null;
  /** Newest first. */
  history: readonly HostMetricsSummary[];
  index: number;
  isSelected: boolean;
  onHover: (index: number) => void;
  onPick: (index: number, newWindow: boolean) => void;
  now: number;
}

export function HostSwitcherRow({
  row,
  summary,
  history,
  index,
  isSelected,
  onHover,
  onPick,
  now,
}: HostSwitcherRowProps) {
  const tone = hostLinkTone(row);
  // The layout follows the link; a live host that hasn't reported yet shows unknowns.
  const live = tone === "live";
  const meta = metaLine(row, summary, now);
  const fullMeta = metaTitle(row);
  return (
    <button
      id={`host-switcher-${row.hostId}`}
      type="button"
      tabIndex={-1}
      role="option"
      aria-selected={isSelected}
      aria-current={row.isCurrent ? "true" : undefined}
      data-host-id={row.hostId}
      data-link-tone={tone}
      onPointerDown={(event) => event.preventDefault()}
      onPointerMove={() => onHover(index)}
      onClick={(event) => onPick(index, isNewWindowClick(event))}
      className={cn(
        PALETTE_ROW_CLASS,
        HOST_SWITCHER_GRID,
        "group",
        "w-full rounded-[var(--radius-md)] px-3 py-2 text-left"
      )}
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <LinkMark tone={tone} />
        <span className="flex h-5 w-3 shrink-0 items-center text-text-secondary" aria-hidden="true">
          <PlatformGlyph platform={row.platform} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <HostName name={row.name} dim={tone === "offline"} />
            {row.isCurrent && (
              <span className="shrink-0 rounded-sm border border-border-default px-1 text-2xs leading-4 text-text-secondary">
                this window
              </span>
            )}
          </span>
          {meta && (
            // A build warning shows its short form, so its full text is always on offer.
            <TruncatedTooltip
              content={fullMeta ?? meta}
              isTruncated={fullMeta ? true : undefined}
              focusable={false}
            >
              <span className="truncate text-xs text-text-secondary">{meta}</span>
            </TruncatedTooltip>
          )}
        </span>
      </span>
      {live ? (
        <>
          {summary ? (
            <AgentCounts summary={summary} />
          ) : (
            <MetricDash label="Agent activity unknown" />
          )}
          {summary ? (
            <CpuCell summary={summary} history={history} />
          ) : (
            <MetricDash label="CPU not reported yet" />
          )}
          {summary ? (
            <MemoryCell summary={summary} />
          ) : (
            <MetricDash label="Memory not reported yet" />
          )}
          <LinkCell row={row} />
        </>
      ) : (
        <span
          className={cn(
            "col-span-4 text-right text-xs",
            tone === "attention"
              ? "text-status-warning"
              : tone === "connecting"
                ? "text-text-primary"
                : "text-text-secondary"
          )}
        >
          {linkStateText(row)}
        </span>
      )}
    </button>
  );
}
