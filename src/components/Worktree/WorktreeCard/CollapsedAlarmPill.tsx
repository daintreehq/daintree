import { useState } from "react";
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

/**
 * The id of the collapsed row's alarm description, for the card's select button
 * to point `aria-describedby` at. Worktree ids are paths, and a path can hold a
 * space, which would split one IDREF into two.
 */
export function collapsedAlarmDescriptionId(worktreeId: string): string {
  return `worktree-alarm-${encodeURIComponent(worktreeId)}`;
}

interface CollapsedAlarmPillProps {
  alarm: AlarmDescriptor;
  /** The line under the label in the tooltip — the counts, or what to do about it. */
  detail?: string;
  /**
   * Renders the alarm's words as a hidden node under this id, for the row's
   * keyboard target to describe itself with. Rendered even when there is no
   * alarm, empty, so the reference always resolves.
   */
  descriptionId?: string;
  /**
   * The row's keyboard target has `:focus-visible`. Opens the tooltip as a
   * hover would, since a keyboard user cannot hover the mark itself.
   */
  revealed?: boolean;
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
 * by keyboard, so on its own the tooltip is a pointer-only surface.
 *
 * The row's keyboard target is the card's select button, which is where a Tab
 * user actually lands, so the mark is carried there twice over: the button is
 * described by `descriptionId`, which is what a screen reader speaks on focus,
 * and `revealed` opens this tooltip while that button shows `:focus-visible`,
 * which is what a sighted keyboard user sees. Neither adds a Tab stop.
 */
export function CollapsedAlarmPill({
  alarm,
  detail,
  descriptionId,
  revealed = false,
}: CollapsedAlarmPillProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  // A reveal ends the way any tooltip here does — Escape, or the shared
  // auto-dismiss — and stays ended until focus leaves and comes back.
  // Without this latch `revealed` would re-assert `open` straight after
  // every close, and the tooltip could never be dismissed.
  const [revealDismissed, setRevealDismissed] = useState(false);
  const [wasRevealed, setWasRevealed] = useState(revealed);
  if (wasRevealed !== revealed) {
    setWasRevealed(revealed);
    if (!revealed) setRevealDismissed(false);
  }

  // Tier 0 is the no-alarm case; `kind` is tested alongside it so the icon
  // lookup below is total rather than needing a glyph for "none".
  if (alarm.tier === 0 || alarm.kind === "none") {
    return descriptionId ? <span id={descriptionId} hidden /> : null;
  }

  const Icon = ALARM_ICONS[alarm.kind];
  const accessibleName = detail ? `${alarm.label} — ${detail}` : alarm.label;

  return (
    <>
      <Tooltip
        open={hoverOpen || (revealed && !revealDismissed)}
        onOpenChange={(next) => {
          setHoverOpen(next);
          if (!next && revealed) setRevealDismissed(true);
        }}
      >
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
          {detail !== undefined && (
            <span className="mt-0.5 block text-text-secondary">{detail}</span>
          )}
        </TooltipContent>
      </Tooltip>
      {/* `hidden` keeps it out of the reading order, where the badge's own name
        already speaks it; a node `aria-describedby` points at is still read
        when hidden. Outside the badge, which must carry no text of its own. */}
      {descriptionId && (
        <span id={descriptionId} hidden>
          {accessibleName}
        </span>
      )}
    </>
  );
}
