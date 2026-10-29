import type { ReactElement } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { FLOATING_CARD_CLASS } from "@/components/ui/floatingSurface";
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
  isArmed: boolean;
  /** The pane holds the selection, so it is the one being typed into. */
  isFocused: boolean;
  isInputLocked: boolean;
  hasComposer: boolean;
  isComposerDisabled: boolean;
}

/**
 * Says, on the armed pane being typed into, that its keystrokes stop at this
 * view's panes while agents on other hosts are in the fleet. Followers and
 * locked panes say nothing: nobody types into them.
 */
export function FleetRawInputNotice({
  isArmed,
  isFocused,
  isInputLocked,
  hasComposer,
  isComposerDisabled,
}: FleetRawInputNoticeProps): ReactElement | null {
  if (!isArmed || !isFocused || isInputLocked) return null;
  // The composer's Enter goes to every member, other hosts included.
  return <SkippedTargetsNotice composerReachesFleet={hasComposer && !isComposerDisabled} />;
}

function SkippedTargetsNotice({
  composerReachesFleet,
}: {
  composerReachesFleet: boolean;
}): ReactElement | null {
  const targets = useArmedCrossHostTargets();
  const skipped = describeRawInputSkippedTargets(targets);
  if (skipped === null) return null;

  // Wraps rather than truncates: it takes no pointer events, so text cut off
  // here could never be read.
  return (
    <div
      role="note"
      data-testid="fleet-raw-input-notice"
      className={cn(
        "inline-flex min-w-0 max-w-full items-start gap-1 px-2 py-0.5",
        FLOATING_CARD_CLASS,
        "text-xs font-medium text-text-secondary"
      )}
    >
      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 wrap-anywhere">
        {composerReachesFleet ? `${skipped} · send from the composer to reach them` : skipped}
      </span>
    </div>
  );
}
