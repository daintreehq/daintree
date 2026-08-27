import { expect } from "vitest";

import { cn } from "@/lib/utils";

/**
 * Utilities a cva base and its variants can each contribute, grouped by the CSS
 * property they set. Asserting one winner per group is what catches the failure
 * mode these tables actually have: two variants both emitting a padding, or a
 * consumer override landing alongside the class it meant to replace instead of
 * on top of it.
 */
const GROUP_PATTERNS = {
  // `p-` sets both axes; `ps-`/`pe-` are the logical inline pair, so they belong
  // to X alongside `pl-`/`pr-` and never to Y.
  paddingX: /^p([xselr])?-/,
  paddingY: /^p([ytb])?-/,
  fontSize: /^text-(xs|sm|base|lg|[2-9]?xl|\[[\d.]+(px|rem|em)\])$/,
  radius: /^rounded(-|$)/,
  resize: /^resize(-|$)/,
  width: /^w-/,
  height: /^h-/,
  transition: /^transition(-|$)/,
} satisfies Record<string, RegExp>;

type Group = keyof typeof GROUP_PATTERNS;

/** Bare utilities only — a variant-prefixed class sets a different state. */
export function baseUtilities(classes: string): string[] {
  return classes
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token) => {
      // A colon inside an arbitrary value (`bg-[url(data:…)]`) is data, not a
      // variant separator; only a colon outside brackets marks a variant. Strip
      // every bracketed run first, so `data-[state=checked]:p-2` still reads as
      // the variant-prefixed utility it is.
      const scan = token.replace(/\[[^\]]*\]/g, "");
      return !scan.includes(":");
    });
}

export function utilitiesInGroup(classes: string, group: Group): string[] {
  const pattern = GROUP_PATTERNS[group];
  return baseUtilities(classes).filter((token) => pattern.test(token));
}

/**
 * The merged output must resolve each named property to exactly one utility —
 * never two fighting over it, and never zero, which would mean the variant
 * silently stopped emitting anything at all.
 */
export function expectSingleWinner(classes: string, groups: Group[]): void {
  for (const group of groups) {
    const matches = utilitiesInGroup(cn(classes), group);
    expect(matches, `${group}: ${matches.join(" ") || "<none>"}`).toHaveLength(1);
  }
}

/** Same, for a property a variant may legitimately decline to set. */
export function expectAtMostOneWinner(classes: string, groups: Group[]): void {
  for (const group of groups) {
    const matches = utilitiesInGroup(cn(classes), group);
    expect(matches.length, `${group}: ${matches.join(" ")}`).toBeLessThanOrEqual(1);
  }
}

/**
 * Accent is reserved for structural focus indicators. This mirrors the repo-wide
 * guard in `src/config/__tests__/accentGuard.contract.test.ts`: only
 * border/ring/outline carry a focus ring, only the element's own focus
 * pseudo-class counts (never `group-focus`/`peer-focus`), and a fill or
 * foreground painted in accent is a violation even under a focus variant.
 */
export function expectNoUnfocusedAccent(classes: string): void {
  const offenders = classes
    .split(/\s+/)
    .filter((token) => token.includes("accent"))
    .filter((token) => {
      const separator = token.lastIndexOf(":");
      if (separator === -1) return true;
      const variants = token.slice(0, separator);
      const utility = token.slice(separator + 1);
      if (!/^(border|ring|outline)-/.test(utility)) return true;
      if (/\b(group|peer)-focus/.test(variants)) return true;
      return !/(^|:)focus(-visible|-within)?$/.test(variants);
    });
  expect(offenders, offenders.join(" ")).toHaveLength(0);
}

/**
 * A transition must name the properties it animates. `transition-all` repaints
 * everything, and bare `transition` sweeps in a default property list that
 * tailwind-merge will then let any consumer class replace wholesale.
 */
export function expectNarrowTransition(classes: string, expectedProperties: RegExp): void {
  const transitions = utilitiesInGroup(classes, "transition");
  expect(transitions, transitions.join(" ")).toHaveLength(1);
  expect(transitions[0]).not.toBe("transition");
  expect(transitions[0]).not.toBe("transition-all");
  expect(transitions[0]).toMatch(expectedProperties);
}

/** Tailwind duration utilities, in ms, for comparing two timings relationally. */
export function durationMs(classes: string): number {
  const match = /(?:^|\s)duration-(\d+)(?:\s|$)/.exec(classes);
  expect(match, `no duration utility in: ${classes}`).not.toBeNull();
  return Number(match![1]);
}
