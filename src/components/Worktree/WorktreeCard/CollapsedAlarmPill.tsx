import { ArrowDown, CircleX, KeyRound } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AlarmDescriptor, AlarmKind } from "@/lib/worktreeAlarmTier";

/**
 * One silhouette per alarm kind.
 *
 * All three kinds used to be a single `CircleAlert` separated by the badge's
 * warning/error wash, which put the whole distinction on hue — and under
 * `forced-colors`, where the wash is gone and the glyph is one system colour,
 * on nothing at all. Arrow, key and circled cross are three shapes, so they
 * still separate once the colour has been taken away.
 */
const ALARM_ICONS: Record<Exclude<AlarmKind, "none">, typeof ArrowDown> = {
  behind: ArrowDown,
  "auth-failed": KeyRound,
  "ci-failed": CircleX,
};

interface CollapsedAlarmPillProps {
  alarm: AlarmDescriptor;
  /** The line under the label in the tooltip — the counts, or what to do about it. */
  detail?: string;
}

/**
 * The alarm mark on a collapsed row: a glyph in a toned chip, with the words in
 * a tooltip.
 *
 * It carried its label inline — `Behind`, `CI failed`, `Auth failed` — and on a
 * one-line row that made the alarm the loudest thing in it, ahead of the branch
 * name the row exists to show. The glyph in its wash is flag enough; what the
 * flag means is a hover away.
 *
 * Deliberately NOT `pointer-events-none`, which is what it used to be: Radix
 * opens a tooltip from pointer events on the trigger, so blocking them blocks
 * the hover this depends on. Losing the class costs nothing on the row, because
 * this stays a `<span>` with no `tabIndex`, no click handler and no button
 * role — a click lands on it and bubbles straight to the card, exactly as it
 * did through the pass-through. Same shape as `CollapsedSessionIndicators`
 * beside it, and as the status tick on the card's corner.
 *
 * The accessible name carries the detail as well as the label, and that is a
 * requirement rather than a nicety: a non-focusable trigger cannot be reached
 * by keyboard, so the tooltip is a pointer-only surface and the name is the
 * only place the rest of it is spoken.
 */
export function CollapsedAlarmPill({ alarm, detail }: CollapsedAlarmPillProps) {
  // Tier 0 is the no-alarm case; `kind` is tested alongside it so the icon
  // lookup below is total rather than needing a glyph for "none".
  if (alarm.tier === 0 || alarm.kind === "none") return null;

  const Icon = ALARM_ICONS[alarm.kind];
  const accessibleName = detail ? `${alarm.label} — ${detail}` : alarm.label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          size="xs"
          tone={alarm.tone === "error" ? "error" : "warning"}
          data-testid="collapsed-alarm-pill"
          data-alarm-kind={alarm.kind}
          role="img"
          aria-label={accessibleName}
          // Even padding, against the variant's `px-1.5`: with the label gone
          // the chip is one glyph, and a chip wider than it is tall reads as a
          // word that failed to render rather than as a mark.
          className="px-1"
        >
          <Icon aria-hidden="true" />
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <span className="block">{alarm.label}</span>
        {detail !== undefined && <span className="mt-0.5 block text-text-secondary">{detail}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
