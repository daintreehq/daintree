import { expect } from "vitest";

import { cn } from "@/lib/utils";

/**
 * Utilities a cva base and its variants can each contribute, grouped by the CSS
 * property they set. Asserting one winner per group is what catches the failure
 * mode these tables actually have: two variants both emitting a padding, or a
 * consumer override landing alongside the class it meant to replace instead of
 * on top of it.
 */
const GROUP_PATTERNS: Record<string, RegExp> = {
  paddingX: /^p[xs]?-/,
  paddingY: /^p[ys]?-/,
  fontSize: /^text-(xs|sm|base|lg|xl|\[.+\])$/,
  radius: /^rounded(-|$)/,
  resize: /^resize(-|$)/,
  width: /^w-/,
  height: /^h-/,
  transition: /^transition(-|$)/,
};

/** Bare utilities only — a variant-prefixed class sets a different state. */
export function baseUtilities(classes: string): string[] {
  return classes.split(/\s+/).filter((token) => token.length > 0 && !token.includes(":"));
}

export function utilitiesInGroup(classes: string, group: keyof typeof GROUP_PATTERNS): string[] {
  const pattern = GROUP_PATTERNS[group]!;
  return baseUtilities(classes).filter((token) => pattern.test(token));
}

/** The merged output must never leave two utilities fighting over one property. */
export function expectSingleWinner(
  classes: string,
  groups: Array<keyof typeof GROUP_PATTERNS>
): void {
  for (const group of groups) {
    const matches = utilitiesInGroup(cn(classes), group);
    expect(matches.length, `${group}: ${matches.join(" ")}`).toBeLessThanOrEqual(1);
  }
}

/** Accent is reserved for focus indicators; anywhere else it is a violation. */
export function expectNoUnfocusedAccent(classes: string): void {
  const offenders = classes
    .split(/\s+/)
    .filter((token) => /accent/.test(token) && !/(^|:)focus(-visible|-within)?:/.test(token));
  expect(offenders, offenders.join(" ")).toHaveLength(0);
}
