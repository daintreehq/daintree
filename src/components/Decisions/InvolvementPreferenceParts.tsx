import { FactRun } from "@/components/ui/FactSeparator";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { TimeAgo } from "@/components/ui/TimeAgo";
import type { DecisionsInvolvementMode } from "@shared/types/decisionsInvolvement";
import {
  MODE_LABEL,
  formatUntil,
  inForce,
  modeDetail,
  setOnText,
  thenText,
  unavailableLabel,
  unavailableText,
} from "./decisionsInvolvementModel";
import type { InvolvementRead } from "./useInvolvementPreference";

export const MODE_OPTIONS: { value: DecisionsInvolvementMode; label: string }[] = [
  { value: "involve-early", label: MODE_LABEL["involve-early"] },
  { value: "recommend", label: MODE_LABEL.recommend },
];

/**
 * What agents are told now: the mode, and when a temporary one ends. `full`
 * adds what follows a temporary mode and says in a sentence why none is in
 * force; without it the value fits on one line.
 */
export function InvolvementValue({
  read,
  now,
  full,
  count = true,
}: {
  read: InvolvementRead;
  now: number;
  full: boolean;
  /** Says how many other agents a recommendation in force consults; off where a detail line says it. */
  count?: boolean;
}) {
  const { preference } = read;
  if (preference.status === "unavailable") {
    return (
      <span className="text-text-secondary" data-testid="decisions-involvement-unavailable">
        {full ? unavailableText(preference.reason) : unavailableLabel(preference.reason)}
      </span>
    );
  }
  const force = inForce(preference, now);
  return (
    <span
      // Unconfirmed, agents fall back to their usual behaviour: the mode steps down rather than reads as in force.
      className={cn("font-medium", preference.stale ? "text-text-secondary" : "text-text-primary")}
      data-testid="decisions-involvement-mode"
    >
      {preference.stale && <span className="font-normal">Last known: </span>}
      {MODE_LABEL[force.mode]}
      {force.until !== null && (
        <span className="font-normal text-text-secondary">
          {" "}
          until <time dateTime={force.until}>{formatUntil(force.until, now)}</time>
        </span>
      )}
      {/* After the end, so "until" reads as the mode's, not the count's. */}
      {count && force.mode === "recommend" && (
        <span className="font-normal text-text-secondary">
          , consulting {pluralize(preference.consultCount, "other agent")}
        </span>
      )}
      {force.until !== null && full && (
        <span className="font-normal text-text-secondary">, {thenText(preference)}</span>
      )}
    </span>
  );
}

/** What agents are asked to do in the mode in force, or nothing when none is. */
export function InvolvementDetail({ read, now }: { read: InvolvementRead; now: number }) {
  const { preference } = read;
  if (preference.status !== "available") return null;
  return (
    <p data-testid="decisions-involvement-detail">
      {modeDetail(inForce(preference, now).mode, preference.consultCount)}
    </p>
  );
}

/** Where it was set, and when this computer last confirmed it. */
export function InvolvementFacts({ read, now }: { read: InvolvementRead; now: number }) {
  const { preference, role } = read;
  // Given the read's clock: a static label would otherwise stay as first drawn.
  const confirmed =
    preference.lastSyncedAt === null ? (
      "Never confirmed by this computer"
    ) : (
      <TimeAgo
        key="confirmed"
        timestamp={preference.lastSyncedAt}
        now={now}
        prefix={
          preference.stale ? "Last confirmed by this computer " : "Confirmed by this computer "
        }
        verbose
      />
    );
  const facts =
    preference.status === "available"
      ? [
          <TimeAgo
            key="set"
            timestamp={preference.setAt}
            now={now}
            prefix={setOnText(preference.setOn, role)}
            verbose
          />,
          confirmed,
        ]
      : [confirmed];
  return (
    <p data-testid="decisions-involvement-facts">
      <FactRun facts={facts} />
    </p>
  );
}
