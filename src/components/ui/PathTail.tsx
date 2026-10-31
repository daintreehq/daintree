import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { HighlightedText } from "./HighlightedText";

const CUT_ATTR = "data-cut";

// Blink still fits a line one layout unit (1/64px) past its box, which reads as
// 1/16px through getBoundingClientRect at the 25% zoom floor. A false cut would
// draw an ellipsis over the first glyph of a path that fits, so the line sits
// above that; a near miss only keeps the native ellipsis.
const CUT_TOLERANCE_PX = 0.1;

let observer: ResizeObserver | null = null;
const watched = new Set<HTMLElement>();

// Every read before any write: a write adds the box's `::before`, which dirties
// layout, and the next read would then force it once per row of a resized list.
// Read here, in the observer's callback, layout is clean and paint has not
// happened, so a pane dragged across a cut never paints the other ellipsis.
// The marker is out of flow, so a write never resizes the box it is observing.
function markCut(entries: ResizeObserverEntry[]) {
  const cuts = entries.map(({ target }) => {
    const path = target.firstElementChild;
    // Fractional widths: scrollWidth and clientWidth are whole pixels, and a
    // directory over by less than one is still cut.
    return (
      path !== null &&
      path.getBoundingClientRect().width - target.getBoundingClientRect().width > CUT_TOLERANCE_PX
    );
  });
  entries.forEach(({ target }, i) => target.toggleAttribute(CUT_ATTR, cuts[i]));
}

// A late font changes every path's width, but not the width of a box the row
// sizes rather than its text. A fresh observation reports in the next frame
// whatever the box's size, so each is measured again.
function reobserveAll() {
  for (const el of watched) {
    observer?.unobserve(el);
    observer?.observe(el);
  }
}

function watch(el: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return undefined;
  if (!observer) {
    observer = new ResizeObserver(markCut);
    // jsdom has no FontFaceSet.
    document.fonts?.addEventListener("loadingdone", reobserveAll);
  }
  observer.observe(el);
  watched.add(el);
  return () => {
    observer?.unobserve(el);
    watched.delete(el);
    if (watched.size === 0) {
      observer?.disconnect();
      observer = null;
      document.fonts?.removeEventListener("loadingdone", reobserveAll);
    }
  };
}

function assignRef<T>(ref: React.Ref<T> | undefined, el: T | null) {
  if (typeof ref === "function") return ref(el);
  if (ref) ref.current = el;
}

/**
 * A directory that gives way from its start when the row runs out of room.
 *
 * Beside a file's name, the directory is there to tell two same-named files
 * apart, and the part that does that is the end — `…/Settings/AgentSettings`,
 * not `src/components/Sett…`. The span runs right-to-left so the ellipsis lands
 * at the start. The `<bdi dir="ltr">` keeps the path itself left-to-right so its
 * slashes don't migrate: a bare `<bdi>` takes its direction from the first
 * strong character and would flip a Hebrew- or Arabic-leading directory.
 * `text-left` holds an untruncated path on the same edge as the rest of the row,
 * and `data-cut` does the same for a cut one (see path-tail.css).
 */
export function PathTail({
  children,
  className,
  ref,
  indices,
  ...rest
}: {
  children: string;
  ref?: React.Ref<HTMLSpanElement>;
  /** Match ranges on the path, for search results that show why they matched. */
  indices?: readonly (readonly [number, number])[];
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children">) {
  const tailRef = useRef<HTMLSpanElement | null>(null);

  // Observed afresh when the path or its classes change: either can carry the
  // path across the cut in a box that keeps its width. Not on `indices`: a match
  // band or underline changes no metrics.
  useLayoutEffect(() => {
    const el = tailRef.current;
    return el ? watch(el) : undefined;
  }, [children, className]);

  return (
    <span
      {...rest}
      ref={(el) => {
        tailRef.current = el;
        return assignRef(ref, el);
      }}
      className={cn("path-tail truncate text-left [direction:rtl]", className)}
    >
      <bdi dir="ltr">
        <HighlightedText text={children} indices={indices} />
      </bdi>
    </span>
  );
}
