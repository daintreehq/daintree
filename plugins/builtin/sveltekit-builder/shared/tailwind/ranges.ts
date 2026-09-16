import { SCOPE_PROBES, composeCandidate } from "./candidates.js";
import type { TailwindDesignSystem } from "./designSystem.js";

/**
 * Responsive scope, resolved from the project's own `--breakpoint-*` theme
 * variables. The preview viewport is a measured width; a breakpoint is a CSS
 * condition the project defines — and a project may rename, reorder, add or
 * (`--breakpoint-*: initial`) delete every one of them. Nothing here assumes
 * `md` exists or that it means 768px.
 */

export interface Breakpoint {
  name: string;
  /** As authored, e.g. `48rem`. Shown to the user in preference to pixels. */
  value: string;
  /** Resolved against a 16px root — the initial size media queries resolve at. */
  px: number;
}

export interface ResponsiveRange {
  /** `base`, or the variant chain that expresses this interval. */
  variant: string;
  label: string;
  minWidth?: number;
  maxWidthExclusive?: number;
}

export const BASE_RANGE_VARIANT = "base";

const ROOT_FONT_SIZE_PX = 16;
const LENGTH = /^(-?\d*\.?\d+)(px|rem|em)$/;

export function readBreakpoints(system: TailwindDesignSystem): Breakpoint[] {
  const breakpoints: Breakpoint[] = [];
  for (const entry of system.themeNamespace("--breakpoint-")) {
    const px = toPixels(entry.value);
    // A breakpoint set to a non-length (or removed) has no bounds we could
    // honestly display, and one at or below zero bounds nothing. `base` would
    // collide with the name this model gives the unprefixed range, so a project
    // using it gets a reported gap rather than two ranges called `base`.
    if (px === null || px <= 0 || entry.name === BASE_RANGE_VARIANT) continue;
    breakpoints.push({ name: entry.name, value: entry.value, px });
  }
  breakpoints.sort((a, b) => a.px - b.px || a.name.localeCompare(b.name));

  // Two names for one width cannot produce an interval between them, and the
  // aliases are interchangeable anyway — keep the first.
  return breakpoints.filter(
    (breakpoint, index) => index === 0 || breakpoint.px !== breakpoints[index - 1]?.px
  );
}

export function toPixels(value: string): number | null {
  const match = LENGTH.exec(value.trim());
  if (!match) return null;
  const amount = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(amount)) return null;
  return match[2] === "px" ? amount : amount * ROOT_FONT_SIZE_PX;
}

/**
 * Base, then every breakpoint as a minimum, then every breakpoint as a maximum,
 * then each adjacent bounded interval.
 *
 * Every chain is compiled *and* checked for a width condition carrying that
 * breakpoint's own value before it is offered. Compiling alone proves nothing:
 * `@custom-variant md (&:hover)` shadows the breakpoint, generates perfectly
 * valid CSS, and has no width in it at all.
 */
export function resolveResponsiveRanges(system: TailwindDesignSystem): ResponsiveRange[] {
  const breakpoints = readBreakpoints(system);
  const probe = SCOPE_PROBES.find(
    (utility) => system.cssFor(composeCandidate(system, null, utility)) !== null
  );

  const boundsWidth = (variant: string, value: string): boolean => {
    if (probe === undefined) return false;
    const candidate = composeCandidate(system, variant, probe);
    const compiled = system.compile(candidate);
    if (!compiled || compiled.declarations.length === 0) return false;
    return compiled.declarations.some((declaration) =>
      declaration.scope.conditions.some(
        (condition) => condition.includes("width") && condition.includes(value)
      )
    );
  };

  const usable = breakpoints.filter(
    (breakpoint) =>
      boundsWidth(breakpoint.name, breakpoint.value) &&
      boundsWidth(`max-${breakpoint.name}`, breakpoint.value)
  );

  const ranges: ResponsiveRange[] = [{ variant: BASE_RANGE_VARIANT, label: "Base (all widths)" }];

  for (const breakpoint of usable) {
    ranges.push({
      variant: breakpoint.name,
      label: `${breakpoint.name} and up (≥ ${breakpoint.value})`,
      minWidth: Math.round(breakpoint.px),
    });
  }

  for (const breakpoint of usable) {
    ranges.push({
      variant: `max-${breakpoint.name}`,
      label: `Below ${breakpoint.name} (< ${breakpoint.value})`,
      maxWidthExclusive: Math.max(1, Math.round(breakpoint.px)),
    });
  }

  for (let index = 0; index < usable.length - 1; index++) {
    const lower = usable[index] as Breakpoint;
    const upper = usable[index + 1] as Breakpoint;
    const variant = `${lower.name}:max-${upper.name}`;
    if (!boundsWidth(variant, lower.value) || !boundsWidth(variant, upper.value)) continue;
    ranges.push({
      variant,
      label: `${lower.name} to below ${upper.name} (≥ ${lower.value}, < ${upper.value})`,
      minWidth: Math.round(lower.px),
      maxWidthExclusive: Math.max(1, Math.round(upper.px)),
    });
  }

  return ranges;
}

/** The variant chain a range authors under; `null` for base, prefix excluded. */
export function variantChainOf(range: ResponsiveRange): string | null {
  return range.variant === BASE_RANGE_VARIANT ? null : range.variant;
}

/**
 * The range a measured viewport width falls inside — a report of where the
 * preview currently sits, never the scope an edit is written at.
 */
export function rangeContaining(ranges: ResponsiveRange[], width: number): ResponsiveRange | null {
  const base = ranges.find((range) => range.variant === BASE_RANGE_VARIANT) ?? null;
  if (!Number.isFinite(width)) return base;

  const bounded = ranges.filter(
    (range) => range.minWidth !== undefined && range.maxWidthExclusive !== undefined
  );
  const match = bounded.find(
    (range) => width >= (range.minWidth ?? 0) && width < (range.maxWidthExclusive ?? Infinity)
  );
  if (match) return match;

  // Below the first breakpoint, and above the last, no bounded interval exists.
  const maxOnly = ranges
    .filter((range) => range.minWidth === undefined && range.maxWidthExclusive !== undefined)
    .sort((a, b) => (a.maxWidthExclusive ?? 0) - (b.maxWidthExclusive ?? 0));
  const belowFirst = maxOnly[0];
  if (belowFirst && width < (belowFirst.maxWidthExclusive ?? 0)) return belowFirst;

  const minOnly = ranges
    .filter((range) => range.maxWidthExclusive === undefined && range.minWidth !== undefined)
    .sort((a, b) => (b.minWidth ?? 0) - (a.minWidth ?? 0));
  const aboveLast = minOnly.find((range) => width >= (range.minWidth ?? 0));
  if (aboveLast) return aboveLast;

  return base;
}
