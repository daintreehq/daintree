import { cloneElement, type CSSProperties, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { resolveBrandMarkInk } from "@/lib/brandIcon";
import { useActiveAppScheme } from "@/hooks/useActiveAppScheme";

interface BrandMarkProps {
  brandColor?: string;
  className?: string;
  children: ReactElement<{ className?: string; style?: CSSProperties }>;
}

/**
 * Owns the colour of a third-party brand mark. The glyph itself stays on
 * `currentColor` — nothing hands a colour to an SVG — so this is the one place
 * that decides what a logo is allowed to look like on the active theme.
 *
 * Publishes the resting and hover inks as custom properties and tags the glyph
 * with `.brand-mark`; `src/index.css` reads both and owns the swap, which is
 * what gets keyboard focus the same treatment as the mouse without every call
 * site wiring up hover state. Deliberately no inline `color`: an inline
 * declaration outranks the `:hover` rule and would strand the mark at rest.
 */
export function BrandMark({ brandColor, className, children }: BrandMarkProps) {
  const scheme = useActiveAppScheme();
  const ink = resolveBrandMarkInk(brandColor, scheme);
  // `cn` collapses to "" when nothing is supplied; pass className only when it
  // has content so the untouched path leaves the child's props exactly as they were.
  const merged = cn(children.props.className, ink && "brand-mark", className);

  if (!ink) {
    // No colour to resolve (no brand hex, or a theme missing the tokens the
    // resolver reads) — the glyph inherits whatever ink its context provides.
    return merged ? cloneElement(children, { className: merged }) : children;
  }

  return cloneElement(children, {
    ...(merged ? { className: merged } : null),
    style: {
      ...children.props.style,
      "--brand-mark-rest": ink.rest,
      "--brand-mark-hover": ink.hover,
    } as CSSProperties,
  });
}
