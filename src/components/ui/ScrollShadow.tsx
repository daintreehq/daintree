import {
  forwardRef,
  useRef,
  useCallback,
  type ReactNode,
  type ComponentPropsWithoutRef,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";
import { useVerticalScrollShadows } from "@/hooks/useVerticalScrollShadows";

const TOP_SHADOW = (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-black/15 to-transparent"
  />
);

const BOTTOM_SHADOW = (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-black/15 to-transparent"
  />
);

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
      <div className={cn("relative overflow-hidden min-h-0", className)}>
        {canScrollUp && TOP_SHADOW}
        <div
          ref={mergeRefs(internalRef, forwardedRef)}
          className={cn("h-full overflow-y-auto", scrollClassName)}
          {...rest}
        >
          {children}
        </div>
        {canScrollDown && BOTTOM_SHADOW}
      </div>
    );
  }
);

ScrollShadow.displayName = "ScrollShadow";

export function useScrollShadowOverlays(externalRef?: Ref<HTMLElement>) {
  const internalRef = useRef<HTMLElement>(null);
  const { canScrollUp, canScrollDown } = useVerticalScrollShadows(internalRef);

  const ref = useCallback(
    (el: HTMLElement | null) => {
      (internalRef as React.MutableRefObject<HTMLElement | null>).current = el;
      if (typeof externalRef === "function") {
        externalRef(el);
      } else if (externalRef) {
        (externalRef as React.MutableRefObject<HTMLElement | null>).current = el;
      }
    },
    [externalRef]
  );

  return {
    ref,
    topShadow: canScrollUp ? TOP_SHADOW : null,
    bottomShadow: canScrollDown ? BOTTOM_SHADOW : null,
  };
}
