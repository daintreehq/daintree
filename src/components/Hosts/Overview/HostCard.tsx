import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/lib/pluralize";
import { TimeAgo } from "@/components/ui/TimeAgo";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { cn } from "@/lib/utils";
import { PlatformGlyph } from "../PlatformGlyph";
import { describeHostMenuState, type HostMenuRow } from "../hostModel";
import { isNewWindowClick } from "../hostSwitching";
import type { HostProjectRef } from "../hostProjects";
import { HostSparkline } from "./HostSparkline";
import { HOST_METRICS_HISTORY_SIZE } from "@/store/hostMetricsStore";
import {
  cpuSeries,
  describeDriver,
  describeMemory,
  describeObservedAgents,
  describeProjects,
  describeRtt,
  describeSwap,
  describeThermal,
  isLive,
  pressureSeries,
} from "./overviewModel";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

interface HostCardProps {
  row: HostMenuRow;
  /** Newest first, as this Shell received them. */
  history: readonly HostMetricsSummary[];
  /** Switch this window (or a new one) to the host. */
  onSwitch: (newWindow: boolean) => void;
  /**
   * The host's projects, once listed; null when the list couldn't be read;
   * undefined while it can't be (not connected) or hasn't answered.
   */
  projects?: readonly HostProjectRef[] | null;
  /** Open one of the host's projects on the host (Cmd/Ctrl-click: a new window). */
  onOpenProject?: (projectId: string, newWindow: boolean) => void;
  /** Extra per-host content: fleet targets, Add project…. */
  children?: ReactNode;
}

/** A card lists this many projects; the rest are counted. */
export const HOST_CARD_PROJECT_LIMIT = 6;

function ProjectList({
  hostName,
  projects,
  counts,
  onOpenProject,
}: {
  hostName: string;
  projects: readonly HostProjectRef[];
  /** "1 open · 2 worktrees", as the host last reported. */
  counts: string | null;
  onOpenProject?: (projectId: string, newWindow: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...projects].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const shown = showAll ? sorted : sorted.slice(0, HOST_CARD_PROJECT_LIMIT);
  const more = projects.length - shown.length;
  return (
    <section aria-label={`Projects on ${hostName}`} data-testid="host-overview-projects">
      <h4 className="mb-1 text-2xs font-medium text-text-secondary">
        Projects{counts ? ` · ${counts}` : ""}
      </h4>
      {projects.length === 0 ? (
        <p className="text-xs text-text-secondary">No projects on {hostName} yet</p>
      ) : (
        <ul className="-mx-1.5 flex flex-col">
          {shown.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-xs",
                  "text-text-primary transition-colors hover:bg-overlay-subtle",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline"
                )}
                aria-label={`Open ${project.name} on ${hostName}`}
                title={project.path}
                onClick={(event) => onOpenProject?.(project.id, isNewWindowClick(event))}
              >
                {project.emoji && (
                  <span className="shrink-0 leading-none" aria-hidden="true">
                    {project.emoji}
                  </span>
                )}
                <span className="min-w-0 truncate">{project.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <Button variant="ghost" size="xs" className="mt-0.5" onClick={() => setShowAll(true)}>
          Show {pluralize(more, "more project")}
        </Button>
      )}
    </section>
  );
}

/** A sparkline needs a few samples before its shape says anything. */
const MIN_HISTORY_SAMPLES = 3;
/** Samples per minute at the host's 5 s reporting cadence. */
const SAMPLES_PER_MINUTE = 12;

/**
 * The window the charts span: the history so far, rounded up to whole minutes
 * and growing to the full ~15 minutes, so a fresh connection fills the chart
 * and its caption says how far back it reaches.
 */
function chartWindow(sampleCount: number): { size: number; minutes: number } {
  const minutes = Math.min(
    Math.ceil(HOST_METRICS_HISTORY_SIZE / SAMPLES_PER_MINUTE),
    Math.max(1, Math.ceil(sampleCount / SAMPLES_PER_MINUTE))
  );
  return { size: Math.min(HOST_METRICS_HISTORY_SIZE, minutes * SAMPLES_PER_MINUTE), minutes };
}

function LoadMeter({
  label,
  values,
  chartLabel,
  windowSize,
}: {
  label: string;
  values: ReadonlyArray<number | null>;
  chartLabel: string;
  windowSize: number;
}) {
  const measured = values.filter((value) => value !== null).length;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-text-primary">{label}</span>
      {measured < MIN_HISTORY_SAMPLES ? (
        <span className="flex h-6 items-center text-2xs text-text-secondary">
          Collecting history…
        </span>
      ) : (
        <HostSparkline
          values={values}
          label={chartLabel}
          windowSize={windowSize}
          className="text-text-secondary"
        />
      )}
    </div>
  );
}

function Fact({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | null;
  /** The full wording behind a shortened value. */
  detail?: string;
}) {
  if (value === null) return null;
  return (
    <>
      <dt className="text-text-secondary">{label}</dt>
      <TruncatedTooltip content={detail ?? value} isTruncated={detail ? true : undefined}>
        <dd className="min-w-0 truncate text-text-primary">{value}</dd>
      </TruncatedTooltip>
    </>
  );
}

const PLATFORM_LABEL = { darwin: "macOS", linux: "Linux" } as const;

/**
 * One machine at a glance. Numbers show only while they are current (this
 * machine, or a host whose link is up); otherwise the card says what the link
 * last saw, never a guess at why.
 */
export function HostCard({
  row,
  history,
  onSwitch,
  projects,
  onOpenProject,
  children,
}: HostCardProps) {
  const live = isLive(row);
  const summary = live ? (history[0] ?? row.summary) : null;
  const { state, note } = describeHostMenuState(row);
  const cpuNow = summary?.cpuPercent ?? null;
  const pressureNow = summary?.memoryPressure ?? null;
  const placeState = [row.isCurrent ? "This window" : null, state].filter(Boolean).join(" · ");
  const chart = chartWindow(history.length);
  const span = chart.minutes === 1 ? "minute" : `${chart.minutes} minutes`;

  return (
    <article
      className="flex min-w-0 flex-col gap-4 rounded-[var(--radius-lg)] border border-border-default bg-surface-panel p-4"
      data-testid="host-overview-card"
      data-host-id={row.hostId}
      data-live={live ? "true" : "false"}
      aria-label={row.name}
    >
      <div className="flex flex-col gap-1">
        <button
          type="button"
          className={cn(
            "-m-1 flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] p-1 text-left",
            "transition-colors hover:bg-overlay-subtle",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2"
          )}
          aria-current={row.isCurrent ? "true" : undefined}
          aria-label={row.isCurrent ? `${row.name}, this window's host` : `Switch to ${row.name}`}
          onClick={(event) => onSwitch(isNewWindowClick(event))}
        >
          <PlatformGlyph platform={row.platform} className="shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
            {row.name}
          </span>
          {placeState && (
            <span
              className="shrink-0 text-2xs text-text-secondary"
              data-testid="host-overview-status"
            >
              {placeState}
            </span>
          )}
        </button>
        {note && <p className="text-xs text-text-secondary">{note}</p>}
      </div>

      {summary && (
        <p className="text-sm text-text-primary" data-testid="host-overview-agents">
          {describeObservedAgents(summary)}
        </p>
      )}

      {summary && (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-2 gap-3">
            <LoadMeter
              label={`CPU ${cpuNow === null ? "not measured" : `${Math.round(cpuNow)}%`}`}
              values={cpuSeries(history)}
              windowSize={chart.size}
              chartLabel={`CPU over the last ${span} on ${row.name}`}
            />
            <LoadMeter
              label={`Memory pressure ${pressureNow ?? "not measured"}`}
              values={pressureSeries(history)}
              windowSize={chart.size}
              chartLabel={`Memory pressure over the last ${span} on ${row.name}`}
            />
          </div>
          <span className="text-2xs text-text-secondary">
            Last {span} · updated <TimeAgo timestamp={summary.sampledAt} verbose />
          </span>
        </div>
      )}

      {!projects && live && (
        <section aria-label={`Projects on ${row.name}`}>
          <h4 className="mb-1 text-2xs font-medium text-text-secondary">Projects</h4>
          <p className="text-xs text-text-secondary">
            {projects === null
              ? `Couldn't load projects on ${row.name}. Reopen the overview to try again`
              : `Listing projects on ${row.name}…`}
          </p>
        </section>
      )}
      {projects && (
        <ProjectList
          hostName={row.name}
          projects={projects}
          counts={summary ? describeProjects(summary) : null}
          onOpenProject={onOpenProject}
        />
      )}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {summary && <Fact label="Memory" value={describeMemory(summary)} />}
        {summary && <Fact label="Swap" value={describeSwap(summary)} />}
        {summary && <Fact label="Thermal" value={describeThermal(summary)} />}
        {summary && <Fact label="Driving" value={describeDriver(summary)} />}
        <Fact label="Platform" value={row.platform ? PLATFORM_LABEL[row.platform] : null} />
        <Fact label="Link" value={describeRtt(row)} />
      </dl>

      {children}
    </article>
  );
}
