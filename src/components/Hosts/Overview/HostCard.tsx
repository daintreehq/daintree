import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { pluralize } from "@/lib/pluralize";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { FactSeparator } from "@/components/ui/FactSeparator";
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
  describeCoreClusters,
  describeCpu,
  describeCpuPressure,
  describeDriver,
  describeDriverDetail,
  describeLoad,
  describeMemory,
  describeMemoryCapacity,
  describeMemoryPressure,
  describeObservedAgents,
  describeProjects,
  describeRtt,
  describeSwap,
  describeSwapActivity,
  describeThermal,
  isLive,
  memoryUsedSeries,
  pressureSeries,
  reportsMemoryCapacity,
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
  /** Ask the host for its projects again, after a list that couldn't be read. */
  onRetryProjects?: () => void;
  /** Extra per-host content: fleet targets, Add project…. */
  children?: ReactNode;
}

/** A card lists this many projects; the rest are counted. */
export const HOST_CARD_PROJECT_LIMIT = 6;

function ProjectList({
  hostName,
  projects,
  onOpenProject,
}: {
  hostName: string;
  projects: readonly HostProjectRef[];
  onOpenProject?: (projectId: string, newWindow: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...projects].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const shown = showAll ? sorted : sorted.slice(0, HOST_CARD_PROJECT_LIMIT);
  const more = projects.length - shown.length;
  const anyEmoji = shown.some((project) => project.emoji);
  return (
    <>
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
                {anyEmoji && (
                  <span className="w-4 shrink-0 text-center leading-none" aria-hidden="true">
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
    </>
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
  onRetryProjects,
  children,
}: HostCardProps) {
  const live = isLive(row);
  const summary = live ? (history[0] ?? row.summary) : null;
  const { state, note } = describeHostMenuState(row);
  const cpuNow = summary ? describeCpu(summary) : null;
  const pressureNow = summary?.memoryPressure ?? null;
  // Capacity charts only from a host that counts used memory without the file cache; others
  // keep the band. Decided by the host, not the sample, so a missed read is a gap, not a new chart.
  const capacityChart = summary ? reportsMemoryCapacity(summary) : false;
  const clusters = summary ? describeCoreClusters(summary) : null;
  const placeState = [row.isCurrent ? "Current" : null, state].filter(Boolean).join(" · ");
  const chart = chartWindow(history.length);
  const span = chart.minutes === 1 ? "minute" : `${chart.minutes} minutes`;
  const listing = live && projects === undefined;
  const counts = projects && summary ? describeProjects(summary) : null;

  // The Projects section is one node through failed, listing and listed, so a
  // pressed Retry hands focus to it rather than to the page as the listing
  // state replaces it, and the answer finds it there.
  const projectsRef = useRef<HTMLElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  const holdFocus = useRef(false);
  // Focus held on the section says nothing of what replaced its contents, so
  // once Retry is pressed the card announces how its listing went. An answer
  // nobody asked for here stays quiet, as several hosts may fail at once.
  const [retried, setRetried] = useState(false);
  const announcement =
    !retried || !live
      ? ""
      : projects === undefined
        ? `Listing projects on ${row.name}`
        : projects === null
          ? `Couldn't load projects on ${row.name}`
          : projects.length === 0
            ? `No projects on ${row.name} yet`
            : `${pluralize(projects.length, "project")} on ${row.name}`;

  useLayoutEffect(() => {
    if (!holdFocus.current || listing) return;
    holdFocus.current = false;
    // Focus the person moved elsewhere while waiting stays where they put it.
    const active = document.activeElement;
    if (active && active !== document.body && active !== projectsRef.current) return;
    // Another failure: its Retry. A list: the section stays. Gone offline: the card.
    (retryRef.current ?? projectsRef.current ?? switchRef.current)?.focus({ preventScroll: true });
  }, [listing, projects]);

  const retryProjects = () => {
    const section = projectsRef.current;
    if (section?.contains(document.activeElement)) {
      holdFocus.current = true;
      section.focus({ preventScroll: true });
    }
    setRetried(true);
    onRetryProjects?.();
  };

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
          ref={switchRef}
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
              label={`CPU ${cpuNow ?? "not measured"}`}
              values={cpuSeries(history)}
              windowSize={chart.size}
              chartLabel={`CPU over the last ${span} on ${row.name}`}
            />
            {summary && capacityChart ? (
              <LoadMeter
                label={`Memory ${describeMemoryCapacity(summary) ?? "not measured"}`}
                values={memoryUsedSeries(history)}
                windowSize={chart.size}
                chartLabel={`Memory in use over the last ${span} on ${row.name}`}
              />
            ) : (
              <LoadMeter
                label={`Memory pressure ${pressureNow ?? "not measured"}`}
                values={pressureSeries(history)}
                windowSize={chart.size}
                chartLabel={`Memory pressure over the last ${span} on ${row.name}`}
              />
            )}
          </div>
          <span className="text-2xs text-text-secondary">
            Last {span} <FactSeparator /> updated <TimeAgo timestamp={summary.sampledAt} verbose />
          </span>
        </div>
      )}

      {(projects || live) && (
        <section
          ref={projectsRef}
          tabIndex={-1}
          aria-label={`Projects on ${row.name}`}
          data-testid={projects ? "host-overview-projects" : undefined}
          className={cn(
            "-m-1 rounded-[var(--radius-md)] p-1",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline"
          )}
        >
          <h4 className="mb-1 text-2xs font-medium text-text-secondary">
            Projects
            {counts?.map((part) => (
              <Fragment key={part}>
                {" "}
                <FactSeparator /> {part}
              </Fragment>
            ))}
          </h4>
          {projects ? (
            <ProjectList hostName={row.name} projects={projects} onOpenProject={onOpenProject} />
          ) : projects === null ? (
            <InlineError
              action={
                onRetryProjects && (
                  <Button
                    ref={retryRef}
                    variant="outline"
                    size="xs"
                    className="-my-0.5"
                    aria-label={`Retry listing projects on ${row.name}`}
                    onClick={retryProjects}
                  >
                    <RefreshCw aria-hidden="true" />
                    Retry
                  </Button>
                )
              }
            >
              Couldn&apos;t load projects on {row.name}
            </InlineError>
          ) : (
            <p className="text-xs text-text-secondary">Listing projects on {row.name}…</p>
          )}
        </section>
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {summary &&
          (capacityChart ? (
            <Fact label="Memory pressure" value={describeMemoryPressure(summary)} />
          ) : (
            <Fact label="Memory" value={describeMemory(summary)} />
          ))}
        {summary && <Fact label="Load (1 min)" value={describeLoad(summary)} />}
        {clusters && <Fact label="Core clusters" value={clusters.value} detail={clusters.detail} />}
        {summary && <Fact label="CPU pressure" value={describeCpuPressure(summary)} />}
        {summary && <Fact label="Swap" value={describeSwap(summary)} />}
        {summary && <Fact label="Swap activity" value={describeSwapActivity(summary)} />}
        {summary && <Fact label="Thermal" value={describeThermal(summary)} />}
        {summary && (
          <Fact
            label="Control"
            value={describeDriver(summary)}
            detail={describeDriverDetail(summary)}
          />
        )}
        <Fact label="Platform" value={row.platform ? PLATFORM_LABEL[row.platform] : null} />
        <Fact label="Link" value={describeRtt(row)} />
      </dl>

      {children}
    </article>
  );
}
