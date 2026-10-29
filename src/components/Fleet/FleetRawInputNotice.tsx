import type { ReactElement } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { FLOATING_CARD_SURFACE_CLASS } from "@/components/ui/floatingSurface";
import type { HostId } from "@shared/types/remoteHosts";
import { useArmedCrossHostTargets, type CrossHostFleetTarget } from "./crossHostFleet";

/**
 * Who keystrokes typed straight into a pane leave out: every armed agent on
 * another host. Raw input fans out over this view's PTYs only; another host's
 * agents take whole prompts over its link, never single keys. Null when the
 * fleet has none.
 */
export function describeRawInputSkippedTargets(
  targets: readonly CrossHostFleetTarget[]
): string | null {
  if (targets.length === 0) return null;
  const hostNames = new Map<HostId, string>();
  for (const target of targets) hostNames.set(target.hostId, target.hostName);
  const where =
    hostNames.size === 1 ? [...hostNames.values()][0]! : pluralize(hostNames.size, "host");
  return `Typing here skips ${pluralize(targets.length, "agent")} on ${where}`;
}

export interface FleetRawInputNoticeProps {
  /** The pane's composer can take a draft, and its Enter sends to the whole fleet. */
  composerReachesFleet: boolean;
}

/**
 * Says, on the armed pane being typed into, that its keystrokes stop at this
 * view's panes while agents on other hosts are in the fleet. Passive: clicks
 * go through to the terminal under it.
 */
export function FleetRawInputNotice({
  composerReachesFleet,
}: FleetRawInputNoticeProps): ReactElement | null {
  const targets = useArmedCrossHostTargets();
  const skipped = describeRawInputSkippedTargets(targets);
  if (skipped === null) return null;

  return (
    <div
      role="note"
      data-testid="fleet-raw-input-notice"
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-0.5",
        FLOATING_CARD_SURFACE_CLASS,
        "text-xs font-medium text-text-secondary"
      )}
    >
      <Info className="h-3 w-3 shrink-0" aria-hidden="true" />
      {/* One line: the end gives way first on a narrow pane, so the hint goes
          before who is skipped. */}
      <span className="min-w-0 truncate">
        {composerReachesFleet ? `${skipped} · send from the composer to reach them` : skipped}
      </span>
    </div>
  );
}
