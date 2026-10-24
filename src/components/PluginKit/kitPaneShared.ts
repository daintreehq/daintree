import { useLayoutEffect, useState } from "react";
import { pluralNoun } from "@/lib/pluralize";
import { field, nonEmpty } from "./kitProps";

export const LIMIT_PX = 100_000;

export const SIDES = ["left", "right", "top", "bottom"] as const;
export type Side = (typeof SIDES)[number];

/** Kit view-state keys the layout panes write, kept apart from a view's own. */
export function viewStateKey(kind: string, key: string | undefined): string {
  return `kit:${kind}:${key ?? ""}`;
}

/**
 * An element's border-box size, read before the first paint and then on
 * every resize, so a narrow pane never flashes its wide layout.
 */
export function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const read = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      );
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** A plugin's noun for `count`: a word to pluralise, or its own `{ one, other }`. */
export function nounFor(noun: unknown, count: number, fallback: string): string {
  if (typeof noun === "object" && noun !== null) {
    const one = nonEmpty(field(noun, "one"));
    const other = nonEmpty(field(noun, "other"));
    if (one && other) return pluralNoun(count, one, other);
  }
  return pluralNoun(count, nonEmpty(noun) ?? fallback);
}

export function wholeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

// A container the kit moves focus to (a pane, a drawer, a footer) rings
// inside its own edge, where its clip cannot cut the ring away.
export const PROGRAMMATIC_FOCUS_RING =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";

// Whether the user's last input was a pointer press rather than a key, read
// when a drawer moves focus: one listener pair for the whole document.
let pointerLast = false;
let tracking = false;
export function lastInputWasPointer(): boolean {
  return pointerLast;
}
export function trackLastInput(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("pointerdown", () => (pointerLast = true), true);
  document.addEventListener("keydown", () => (pointerLast = false), true);
}

export function readIds(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : undefined;
}
