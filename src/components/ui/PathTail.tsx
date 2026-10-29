import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const CUT_ATTR = "data-cut";

let observer: ResizeObserver | null = null;
let watched = 0;

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
      path.getBoundingClientRect().width - target.getBoundingClientRect().width > 0.01
    );
  });
  entries.forEach(({ target }, i) => target.toggleAttribute(CUT_ATTR, cuts[i]));
}

function watch(el: HTMLElement) {
  if (typeof ResizeObserver === "undefined") return undefined;
  observer ??= new ResizeObserver(markCut);
  observer.observe(el);
  watched++;
  return () => {
    observer?.unobserve(el);
    if (--watched === 0) {
      observer?.disconnect();
      observer = null;
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
  ...rest
}: { children: string; ref?: React.Ref<HTMLSpanElement> } & Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "children"
>) {
  const tailRef = useRef<HTMLSpanElement | null>(null);

  // Re-observed when the path changes: a new path in a box that keeps its
  // width can cross the cut without the box resizing, and a fresh observation
  // reports at once.
  useLayoutEffect(() => {
    const el = tailRef.current;
    return el ? watch(el) : undefined;
  }, [children]);

  return (
    <span
      {...rest}
      ref={(el) => {
        tailRef.current = el;
        return assignRef(ref, el);
      }}
      className={cn("path-tail truncate text-left [direction:rtl]", className)}
    >
      <bdi dir="ltr">{children}</bdi>
    </span>
  );
}
