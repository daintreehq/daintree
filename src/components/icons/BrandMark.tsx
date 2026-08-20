import { cloneElement, type CSSProperties, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { resolveBrandBadge } from "@/lib/brandIcon";

interface BrandMarkProps {
  brandColor?: string;
  size?: number;
  className?: string;
  children: ReactElement<{ className?: string; style?: CSSProperties }>;
}

const SIZE_CLASS_REGEX = /\b(?:size-|w-|h-)/;

/**
 * Renders an agent mark as a silhouette knocked out of a tile painted in the
 * brand color (#11895). The glyph inherits the tile's ink through
 * `currentColor`, so its contrast pair is the tile and never the surface the
 * mark lands on — the same mark reads on the grid, sidebar, toolbar, panel and
 * elevated planes without any of them being passed in.
 *
 * The color is painted exactly as given. There is no theme branch, no damping
 * and no user-choice exception: a preset color and a built-in color take the
 * same path, on both polarities.
 */
export function BrandMark({ brandColor, size, className, children }: BrandMarkProps) {
  const badge = resolveBrandBadge(brandColor);

  if (!badge) {
    // No usable color — the child keeps inheriting `currentColor`, which the
    // text tokens already hold above the contrast floor on every surface.
    if (!className) {
      return children;
    }
    // `cn` collapses to "" when nothing is supplied; pass className only when it
    // has content so the no-op path leaves the child's props exactly as they were.
    const merged = cn(children.props.className, className);
    return cloneElement(children, merged ? { className: merged } : {});
  }

  const inferSize = size === undefined && !(className && SIZE_CLASS_REGEX.test(className));
  const fallbackSize = inferSize ? 16 : size;

  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center rounded-[3px]", className)}
      style={{
        ...(fallbackSize !== undefined ? { width: fallbackSize, height: fallbackSize } : null),
        backgroundColor: badge.tile,
        color: badge.glyph,
        // Achromatic tiles (goose, interpreter, grok) sit within ~1.1:1 of a
        // same-polarity surface and would have no edge at all. The ring is the
        // ink at low alpha, so it is always the tile's opposite polarity and
        // needs no theme token to stay visible.
        boxShadow: `inset 0 0 0 1px ${badge.ring}`,
      }}
    >
      {/* Inset the glyph by sizing it against the tile rather than padding the
          tile: percentage padding resolves against the *containing block's*
          width, so a 16px badge in a wide row would inset by a slice of the row.
          A percentage on the child resolves against this span, which is the box
          we actually mean. It also beats both ways a caller sizes its icon — a
          `size` attribute or `w-*`/`h-*` classes — without being told which. */}
      {cloneElement(children, {
        style: {
          ...children.props.style,
          // Callers hand the same className to the wrapper and the glyph, and a
          // `text-*` class on the glyph would outrank the inherited ink and undo
          // the contrast the tile was chosen to guarantee.
          color: "inherit",
          width: "75%",
          height: "75%",
        },
      })}
    </span>
  );
}
