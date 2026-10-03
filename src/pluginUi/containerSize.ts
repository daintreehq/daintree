import { useEffect, useRef, useState } from "react";
import type { PluginContainerSize, PluginContainerTarget } from "@shared/types/plugin-sdk-react";

const UNMEASURED: PluginContainerSize = { width: 0, height: 0 };

/** The default steps of `useBreakpoint`, in CSS px of the container's width. */
export const DEFAULT_BREAKPOINTS = { sm: 360, md: 640, lg: 960 } as const;

function resolveTarget(target: PluginContainerTarget): Element | null {
  if (target === null || target === undefined) return null;
  if (typeof Element !== "undefined" && target instanceof Element) return target;
  if (typeof target === "object" && "current" in target) {
    const current: unknown = target.current;
    return typeof Element !== "undefined" && current instanceof Element ? current : null;
  }
  return null;
}

type SizeListener = (size: PluginContainerSize) => void;

/**
 * Watches one element's border box, reporting at most once a frame. The first
 * read is scheduled too, so subscribing never forces a layout mid-commit.
 * Returns the unsubscribe.
 */
function observeSize(element: Element, listener: SizeListener): () => void {
  if (typeof ResizeObserver === "undefined" || typeof requestAnimationFrame === "undefined") {
    return () => {};
  }
  let frame = 0;
  let pending = false;
  const measure = () => {
    pending = false;
    const rect = element.getBoundingClientRect();
    listener({ width: Math.round(rect.width), height: Math.round(rect.height) });
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    frame = requestAnimationFrame(measure);
  };
  schedule();
  const observer = new ResizeObserver(schedule);
  // The border box, the same box the measurement reads: padding or a border
  // changing around a fixed content box still reports.
  observer.observe(element, { box: "border-box" });
  return () => {
    if (pending) cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

/**
 * The size of an element's border box, re-read at most once a frame while
 * it changes. A ref is re-read on every render of the component calling the
 * hook, so an element that component mounts late (behind a loading branch)
 * or swaps is picked up. An element a child mounts on its own schedule is
 * not: hand over the element itself, from a callback ref kept in state.
 */
export function useContainerSize(target: PluginContainerTarget): PluginContainerSize {
  const [size, setSize] = useState<PluginContainerSize>(UNMEASURED);
  const watching = useRef<{ element: Element | null; stop: () => void }>({
    element: null,
    stop: () => {},
  });

  // Every commit, because a ref changes without a render of its own: the
  // effect is the first moment the element it names is known.
  useEffect(() => {
    const next = resolveTarget(target);
    const current = watching.current;
    if (next === current.element) return;
    current.stop();
    const report: SizeListener = (measured) =>
      setSize((previous) =>
        previous.width === measured.width && previous.height === measured.height
          ? previous
          : measured
      );
    watching.current = next
      ? { element: next, stop: observeSize(next, report) }
      : { element: null, stop: () => {} };
    if (!next) report(UNMEASURED);
  });

  useEffect(() => {
    const current = watching;
    return () => {
      current.current.stop();
      current.current = { element: null, stop: () => {} };
    };
  }, []);

  return size;
}

/** Valid breakpoint steps from untyped input: finite, non-negative widths. */
function readBreakpoints(value: unknown): [string, number][] {
  const source =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : DEFAULT_BREAKPOINTS;
  return Object.entries(source)
    .filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0
    )
    .sort((a, b) => a[1] - b[1]);
}

/** The widest step `width` reaches, or null below the narrowest. Exported for tests. */
export function breakpointFor(width: number, breakpoints: unknown): string | null {
  let current: string | null = null;
  for (const [name, min] of readBreakpoints(breakpoints)) {
    if (width >= min) current = name;
  }
  return current;
}

/**
 * The named step of an element's width: the widest breakpoint whose minimum
 * the container reaches, or null while it is narrower than every step (and
 * before it is measured). Answers to the container, never the window.
 */
export function useBreakpoint(target: PluginContainerTarget): "sm" | "md" | "lg" | null;
export function useBreakpoint<K extends string>(
  target: PluginContainerTarget,
  breakpoints: Readonly<Record<K, number>>
): K | null;
export function useBreakpoint(
  target: PluginContainerTarget,
  breakpoints?: Readonly<Record<string, number>>
): string | null {
  const { width } = useContainerSize(target);
  return width > 0 ? breakpointFor(width, breakpoints ?? DEFAULT_BREAKPOINTS) : null;
}
