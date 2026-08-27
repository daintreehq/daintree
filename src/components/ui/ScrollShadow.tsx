import {
  forwardRef,
  useRef,
  useMemo,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
  type ComponentPropsWithoutRef,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";
import { useVerticalScrollShadows } from "@/hooks/useVerticalScrollShadows";

/**
 * The "there is more this way" cue.
 *
 * Normally a fade. Under `forced-colors: active` the UA drops the gradient, so
 * the only signal that a bounded list continues would disappear — and a list
 * that is cut off but looks finished is worse than one with no cue at all. A
 * capped conflict preview showing four of five keys reads as complete
 * (#11973).
 *
 * So in that mode only, the strip collapses to a rule on the scrollable edge.
 * `border-color` resolves to `currentColor` and the UA repaints it to a system
 * colour, which is the one thing guaranteed to be visible there. `opacity`
 * survives forced-colors, so the rule still appears and disappears with the
 * scroll position rather than sitting there permanently.
 *
 * `prefers-contrast: more` gets its own, separate treatment. Author colours
 * survive there, so the gradient would still render — but a fade-to-transparent
 * wash lowers the contrast of real content at the scrolling edge, in the one
 * mode that exists to raise it. So the strip collapses to a solid hairline
 * instead of a border: same "there is more" cue, none of the wash. The two
 * media queries stay separate on purpose — macOS fires only the former and
 * Windows swaps in system colours; see the block comments in `index.css`.
 */
function ScrollShadowOverlay({ edge, visible }: { edge: "top" | "bottom"; visible: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-visible={visible}
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-8 transition-opacity duration-150 ease-out",
        "forced-colors:h-0",
        // Under increased contrast the gradient is swapped for a solid
        // hairline rather than removed. The wash itself is the problem — it
        // lowers the contrast of real content at the scrolling edge, in the
        // one mode that exists to raise it — but the cue is NOT decorative:
        // `WebviewDialog` relies on it to stop page-controlled text concealing
        // the request below the fold, `GitPushConfirmDialog` names it as what
        // communicates "there is more", and `NotificationCenter` tests it as
        // such. On macOS the scrollbar auto-hides, so deleting this outright
        // would leave no at-rest signal at all. A solid rule says the same
        // thing and reads better at high contrast.
        // `forced-colors` is deliberately left to its own block above.
        "contrast-more:bg-none contrast-more:h-px contrast-more:bg-border-strong",
        edge === "top"
          ? "top-0 bg-gradient-to-b from-[var(--scroll-shadow-color)] to-transparent forced-colors:border-t-2"
          : "bottom-0 bg-gradient-to-t from-[var(--scroll-shadow-color)] to-transparent forced-colors:border-b-2",
        visible ? "opacity-100" : "opacity-0"
      )}
    />
  );
}

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (el: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") {
        ref(el);
      } else if (ref) {
        (ref as React.MutableRefObject<T | null>).current = el;
      }
    }
  };
}

interface ScrollShadowProps extends Omit<ComponentPropsWithoutRef<"div">, "className"> {
  className?: string;
  scrollClassName?: string;
  children: ReactNode;
}

export const ScrollShadow = forwardRef<HTMLDivElement, ScrollShadowProps>(
  ({ className, scrollClassName, children, ...rest }, forwardedRef) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const { canScrollUp, canScrollDown } = useVerticalScrollShadows(internalRef);

    return (
      <div className={cn("relative overflow-hidden min-h-0 flex flex-col", className)}>
        <ScrollShadowOverlay edge="top" visible={canScrollUp} />
        <div
          ref={mergeRefs(internalRef, forwardedRef)}
          className={cn("flex-1 overflow-y-auto", scrollClassName)}
          {...rest}
        >
          {children}
        </div>
        <ScrollShadowOverlay edge="bottom" visible={canScrollDown} />
      </div>
    );
  }
);

ScrollShadow.displayName = "ScrollShadow";

export function useScrollShadowOverlays(externalRef?: Ref<HTMLElement>) {
  // State, not a plain ref: `useVerticalScrollShadows` keys its observer effect
  // on the ref OBJECT, so a node that arrives later — or is swapped for a new
  // one — never gets observed if the object identity never changes. Callers
  // that mount their scroller behind a loading or empty branch (the forge
  // dropdown's virtualized list) hit exactly that.
  const [node, setNode] = useState<HTMLElement | null>(null);
  const nodeRef = useMemo(() => ({ current: node }), [node]);
  const { canScrollUp, canScrollDown } = useVerticalScrollShadows(nodeRef);

  // Indirect the externalRef via a ref so the callback below doesn't mutate a
  // hook argument directly — the React Compiler rejects that pattern.
  const externalRefHolder = useRef<Ref<HTMLElement> | undefined>(externalRef);
  useEffect(() => {
    externalRefHolder.current = externalRef;
  }, [externalRef]);

  const ref = useCallback((el: HTMLElement | null) => {
    setNode(el);
    const ext = externalRefHolder.current;
    if (typeof ext === "function") {
      ext(el);
    } else if (ext) {
      (ext as React.MutableRefObject<HTMLElement | null>).current = el;
    }
  }, []);

  // Conditional rendering here is load-bearing: `useVerticalScrollShadows`
  // observes `el.firstElementChild` to detect content-size changes. If the
  // top overlay were always mounted as the first child, the ResizeObserver
  // would track a fixed-height overlay instead of the actual content.
  return {
    ref,
    topShadow: canScrollUp ? <ScrollShadowOverlay edge="top" visible /> : null,
    bottomShadow: canScrollDown ? <ScrollShadowOverlay edge="bottom" visible /> : null,
  };
}
