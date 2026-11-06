import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";

/**
 * The empty stand-in for `StatusDot` on a row that has no status to report.
 *
 * Every row in this palette puts its tile on one column, and on a workspace row
 * that column is reached across an 8px status mark. A create/command row has no
 * mark, so without this its tile climbed 16px left and the palette grew a
 * second icon column for its actions (#11947).
 */
export function StatusSlotSpacer() {
  return <div className="w-2 h-2 shrink-0" aria-hidden="true" />;
}

/**
 * The tile column every row family shares: 32px wide so the label lands on the
 * palette's one grid (69px from the surface edge), 28px tall so a quiet
 * single-line row is 38px rather than 46px. The tile itself is 28px square,
 * centred in the column — shrinking the column instead would pull every label
 * 4px left of the header and footer text it lines up with.
 */
const TILE_SLOT_CLASS = "flex h-7 w-8 shrink-0 items-center justify-center";
const TILE_CLASS = "flex h-7 w-7 items-center justify-center rounded-[var(--radius-lg)]";

/**
 * The 28x28 icon tile every non-workspace row wears.
 *
 * Two treatments, and the split is semantic rather than decorative: `manage`
 * acts on something that already exists, `create` brings something new in and
 * wears the dashed outline that has always marked an add affordance here. Both
 * ride the audited overlay ladder rather than a raw tint/muted alpha, so they
 * hold their separation from the row underneath in every theme.
 *
 * `children` stands in for the icon where the mark isn't a Lucide glyph — a
 * host's platform mark, which is its identity rather than an action.
 */
export function CommandTile({
  icon: Icon,
  tone,
  children,
}: {
  icon?: LucideIcon;
  tone: "manage" | "create";
  children?: ReactNode;
}) {
  return (
    <div aria-hidden="true" className={TILE_SLOT_CLASS}>
      <div
        className={cn(
          TILE_CLASS,
          "text-text-secondary",
          tone === "create"
            ? "border border-dashed border-border-strong bg-overlay-soft"
            : "bg-overlay-medium"
        )}
      >
        {children ?? (Icon && <Icon className="h-4 w-4" aria-hidden="true" />)}
      </div>
    </div>
  );
}

/**
 * A project's 28x28 identity tile: its emoji on its colour. A project that
 * never picked an emoji gets the switcher's own stand-in.
 *
 * `neutral` is for a project whose colour isn't known here — another host's,
 * which lists name and emoji only — and a project with no colour of its own
 * takes the same tile. Both sit on the command tiles' overlay step with a
 * hairline: the sidebar surface they used to fall back to read as a hole in
 * the palette in dark themes, and in light ones it was the highlight's own
 * beige, so the tile vanished into the row the cursor was on.
 *
 * Decoration, so hidden: left in the name, a reader hears "deciduous tree,
 * daintree" before the name it qualifies.
 */
export function ProjectTile({
  emoji,
  color,
  neutral = false,
}: {
  emoji?: string;
  color?: string;
  neutral?: boolean;
}) {
  const plain = neutral || !color;
  return (
    <div aria-hidden="true" className={TILE_SLOT_CLASS}>
      <div
        className={cn(
          TILE_CLASS,
          "text-base",
          plain
            ? "border border-border-default bg-overlay-medium"
            : // Wash/shadow var fallbacks keep themes without the overrides byte-identical.
              "shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))]"
        )}
        style={
          color && !neutral
            ? {
                background: `var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), ${getProjectGradient(color)}`,
              }
            : undefined
        }
      >
        <span className="leading-none select-none filter drop-shadow-sm">{emoji || "🌲"}</span>
      </div>
    </div>
  );
}

/**
 * How much a folded band is holding. Only while folded: expanded, the rows are
 * the count, and printing it as well would be chrome naming what is already on
 * screen.
 */
export function BandCollapsedCount({ count }: { count: number }) {
  // Hidden: the header's own text already says the count in words.
  return (
    <span aria-hidden="true" className="shrink-0 text-3xs tabular-nums">
      {count}
    </span>
  );
}
