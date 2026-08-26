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

function ScrollShadowOverlay({ edge, visible }: { edge: "top" | "bottom"; visible: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-visible={visible}
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-8 transition-opacity duration-150 ease-out",
        edge === "top"
          ? "top-0 bg-gradient-to-b from-[var(--scroll-shadow-color)] to-transparent"
          : "bottom-0 bg-gradient-to-t from-[var(--scroll-shadow-color)] to-transparent",
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
