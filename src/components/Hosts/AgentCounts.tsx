import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { cn } from "@/lib/utils";
import { SpinnerCircle } from "@/components/icons";
import { BAND_GLYPH, BAND_GLYPH_TONE } from "@/components/Pilot/PilotRunState";

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
 * fleet band, so it is only what a Canopy reading found asking, plus the runs
 * blocked on an error; working is what its output heuristics saw. Unknown is a
 * dash, never zero, and a host too old to band its runs says nothing about
 * waiting rather than guess. `quietZero` is for a list that only needs to point
 * at the hosts with something going on: an idle host then draws nothing and
 * still says so to a screen reader.
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
  const attention = summary.agentAttention;
  const waiting = attention?.waiting ?? 0;
  const blocked = attention?.blocked ?? 0;
  // Every agent asking, in one cell: the column is sized for two counts, and a
  // block is a wait that needs more, so it takes the glyph as the switcher's
  // mark does.
  const asking = waiting + blocked;
  const quiet = working === 0 && asking === 0;
  const spoken = quiet
    ? attention
      ? "No agents waiting or working"
      : "No agents working"
    : `Agents: ${[
        blocked > 0 && `${blocked} blocked`,
        waiting > 0 && `${waiting} waiting`,
        working > 0 && `${working} working`,
      ]
        .filter(Boolean)
        .join(", ")}`;
  const askingBand = blocked > 0 ? "blocked" : "needs-you";
  const AskingGlyph = BAND_GLYPH[askingBand];
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
          {/* Waiting leads: it's the one asking for something. */}
          <span aria-hidden="true" className="flex w-7 items-center gap-1">
            {asking > 0 && (
              <>
                <AskingGlyph className={cn("h-3 w-3 shrink-0", BAND_GLYPH_TONE[askingBand])} />
                {asking}
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
