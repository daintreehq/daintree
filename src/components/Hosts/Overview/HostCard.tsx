import type { ReactNode } from "react";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { cn } from "@/lib/utils";
import { PlatformGlyph } from "../PlatformGlyph";
import { describeHostForges } from "../hostForges";
import { describeHostAgentClis, describeHostRowStatus, type HostMenuRow } from "../hostModel";
import { isNewWindowClick } from "../hostSwitching";
import type { HostProjectRef } from "../hostProjects";
import { HostSparkline } from "./HostSparkline";
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

interface HostCardProps {
  row: HostMenuRow;
  /** Newest first, as this Shell received them. */
  history: readonly HostMetricsSummary[];
  /** Switch this window (or a new one) to the host. */
  onSwitch: (newWindow: boolean) => void;
  /** The host's projects, once listed; undefined while it can't be (not connected) or hasn't answered. */
  projects?: readonly HostProjectRef[];
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
  onOpenProject,
}: {
  hostName: string;
  projects: readonly HostProjectRef[];
  onOpenProject?: (projectId: string, newWindow: boolean) => void;
}) {
  const shown = [...projects]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, HOST_CARD_PROJECT_LIMIT);
  const more = projects.length - shown.length;
  return (
    <section aria-label={`Projects on ${hostName}`} data-testid="host-overview-projects">
      {projects.length === 0 ? (
        <p className="text-xs text-text-secondary">No projects on {hostName} yet.</p>
      ) : (
        <ul className="flex flex-col">
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
      {more > 0 && <p className="px-1.5 pt-0.5 text-2xs text-text-secondary">and {more} more</p>}
    </section>
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
    <div className="flex min-w-0 gap-2 text-xs">
      <dt className="shrink-0 text-text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-text-primary" title={detail}>
        {value}
      </dd>
    </div>
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
  const status = describeHostRowStatus(row);
  const version = row.connection?.status === "connected" ? row.connection.handshake.version : null;
  const clis = describeHostAgentClis({ ...row, summary });
  const forges = describeHostForges(summary, row.name);
  const cpuNow = summary?.cpuPercent ?? null;
  const pressureNow = summary?.memoryPressure ?? null;

  return (
    <article
      className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-lg)] border border-border-default bg-surface-panel p-4"
      data-testid="host-overview-card"
      data-host-id={row.hostId}
      data-live={live ? "true" : "false"}
      aria-label={row.name}
    >
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
        {row.isCurrent && (
          <span className="shrink-0 text-2xs text-text-secondary">This window</span>
        )}
      </button>

      {status && (
        <p className="text-xs text-text-secondary" data-testid="host-overview-status">
          {status}
        </p>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-3 text-text-secondary">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-2xs">
              CPU {cpuNow === null ? "not measured" : `${Math.round(cpuNow)}%`}
            </span>
            <HostSparkline
              values={cpuSeries(history)}
              label={`CPU over the last 15 minutes on ${row.name}`}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-2xs">Memory {pressureNow ?? "not measured"}</span>
            <HostSparkline
              values={pressureSeries(history)}
              label={`Memory pressure over the last 15 minutes on ${row.name}`}
            />
          </div>
        </div>
      )}

      <dl className="flex flex-col gap-1">
        {summary && <Fact label="Agents" value={describeObservedAgents(summary)} />}
        {summary && <Fact label="Projects" value={describeProjects(summary)} />}
        {summary && <Fact label="Memory" value={describeMemory(summary)} />}
        {summary && <Fact label="Swap" value={describeSwap(summary)} />}
        {summary && <Fact label="Thermal" value={describeThermal(summary)} />}
        {summary && <Fact label="Driving" value={describeDriver(summary)} />}
        <Fact label="Platform" value={row.platform ? PLATFORM_LABEL[row.platform] : null} />
        <Fact label="Version" value={version} />
        <Fact label="Link" value={describeRtt(row)} />
        <Fact label="Agent CLIs" value={clis} />
        <Fact label="Forges" value={forges?.short ?? null} detail={forges?.full} />
      </dl>

      {projects && (
        <ProjectList hostName={row.name} projects={projects} onOpenProject={onOpenProject} />
      )}

      {children}
    </article>
  );
}
