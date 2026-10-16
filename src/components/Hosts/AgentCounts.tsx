import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { cn } from "@/lib/utils";
import { HollowCircle, SpinnerCircle } from "@/components/icons";

/** A reading the host didn't give: a dash, said in full to a screen reader. */
export function MetricDash({ label, align }: { label: string; align?: "right" }) {
  return (
    <span className={cn("text-xs text-text-secondary", align === "right" && "text-right")}>
      –<span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * A host's waiting and working agents as its own output heuristics saw them,
 * waiting first. Unknown is a dash, never zero.
 */
export function AgentCounts({ summary }: { summary: HostMetricsSummary }) {
  const observed = summary.agentsObserved;
  if (!observed) return <MetricDash label="Agent activity unknown" />;
  const { working, waiting } = observed;
  const spoken =
    working === 0 && waiting === 0
      ? "No agents waiting or working"
      : `Agents: ${[waiting > 0 && `${waiting} waiting`, working > 0 && `${working} working`]
          .filter(Boolean)
          .join(", ")}`;
  return (
    <span className="flex items-center gap-2 text-xs tabular-nums text-text-primary">
      <span className="sr-only">{spoken} (observed)</span>
      {working === 0 && waiting === 0 ? (
        <span aria-hidden="true" className="text-text-secondary">
          0
        </span>
      ) : (
        <>
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
