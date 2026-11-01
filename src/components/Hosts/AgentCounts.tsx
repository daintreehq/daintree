import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { cn } from "@/lib/utils";
import { BlockedCircle, HollowCircle, SpinnerCircle } from "@/components/icons";

/** A reading the host didn't give: a dash, said in full to a screen reader. */
export function MetricDash({ label, align }: { label: string; align?: "right" }) {
  return (
    <span className={cn("text-xs text-text-secondary", align === "right" && "text-right")}>
      –<span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * A host's waiting and working agents, waiting first. Waiting is the host's
 * fleet band, so it is only what a Canopy reading found asking; working is what
 * its output heuristics saw. Unknown is a dash, never zero, and a host too old
 * to band its runs says nothing about waiting rather than guess. `quietZero` is
 * for a list that only needs to point at the hosts with something going on: an
 * idle host then draws nothing and still says so to a screen reader.
 */
export function AgentCounts({
  summary,
  quietZero = false,
}: {
  summary: HostMetricsSummary;
  quietZero?: boolean;
}) {
  const observed = summary.agentsObserved;
  if (!observed) return <MetricDash label="Agent activity unknown" />;
  const { working } = observed;
  const waiting = summary.agentAttention?.waiting ?? 0;
  const blocked = summary.agentAttention?.blocked ?? 0;
  const quiet = working === 0 && waiting === 0 && blocked === 0;
  const spoken = quiet
    ? "No agents waiting or working"
    : `Agents: ${[
        blocked > 0 && `${blocked} blocked`,
        waiting > 0 && `${waiting} waiting`,
        working > 0 && `${working} working`,
      ]
        .filter(Boolean)
        .join(", ")}`;
  return (
    <span className="flex items-center gap-2 text-xs tabular-nums text-text-primary">
      <span className="sr-only">{spoken} (observed)</span>
      {quiet ? (
        !quietZero && (
          <span aria-hidden="true" className="text-text-secondary">
            0
          </span>
        )
      ) : (
        <>
          {/* Rare, and the louder fact, so it takes room only when there is one. */}
          {blocked > 0 && (
            <span aria-hidden="true" className="flex w-7 items-center gap-1">
              <BlockedCircle className="h-3 w-3 shrink-0 text-status-danger" />
              {blocked}
            </span>
          )}
          {/* Waiting leads: it's the one asking for something. */}
          <span aria-hidden="true" className="flex w-7 items-center gap-1">
            {waiting > 0 && (
              <>
                <HollowCircle className="h-3 w-3 shrink-0 text-state-waiting" />
                {waiting}
              </>
            )}
          </span>
          <span aria-hidden="true" className="flex w-7 items-center gap-1">
            {working > 0 && (
              <>
                <SpinnerCircle className="h-3 w-3 shrink-0 animate-spin-slow text-state-working motion-reduce:animate-none" />
                {working}
              </>
            )}
          </span>
        </>
      )}
    </span>
  );
}
