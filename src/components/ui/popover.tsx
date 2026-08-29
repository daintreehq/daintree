import * as React from "react";
import type * as PopoverPrimitiveType from "@radix-ui/react-popover";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import { BrandSurfaceReset } from "@/components/icons/BrandSurface";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";
import {
  OverlayFocusRestoreContext,
  useOverlayFocusRestore,
  useOverlayFocusRestoreValue,
} from "./overlay-focus-restore";

let portalBoundary: HTMLDivElement | null = null;

function getPortalBoundary() {
  if (typeof document === "undefined") return null;
  if (portalBoundary) return portalBoundary;

  // Collision boundary that excludes the native portal region on the right.
  const boundary = document.createElement("div");
  boundary.dataset.portalBoundary = "true";
  Object.assign(boundary.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "calc(100vw - var(--right-obstruction-offset, 0px))",
    height: "100vh",
    pointerEvents: "none",
    visibility: "hidden",
  });
  document.body.appendChild(boundary);
  portalBoundary = boundary;
  return boundary;
}

const PopoverIntentContext = React.createContext<((next: boolean) => void) | null>(null);

type PopoverRootProps = React.ComponentProps<typeof PopoverPrimitiveType.Root>;

const Popover = ({ children, open, defaultOpen, onOpenChange, ...rest }: PopoverRootProps) => {
  const radix = useRadixPrimitives();
  const [pendingOpen, setPendingOpen] = React.useState<boolean | undefined>(undefined);
  const isControlled = open !== undefined;
  const focusRestore = useOverlayFocusRestoreValue();

  // Radix only calls `onOpenChange` for opens it initiates, so a CONTROLLED
  // consumer flipping `open` back to true never reaches the reset below.
  // That matters when a pointer dismissal is reversed mid-exit: the close
  // never reaches `onCloseAutoFocus`, and its flags would decide the next one.
  React.useEffect(() => {
    if (open) focusRestore.resetForOpen();
  }, [open, focusRestore]);

  const requestOpen = React.useCallback(
    (next: boolean) => {
      primeOnEvent();
      if (isControlled) {
        onOpenChange?.(next);
        return;
      }
      setPendingOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
  );

  if (!radix) {
    return (
      <PopoverIntentContext.Provider value={requestOpen}>{children}</PopoverIntentContext.Provider>
    );
  }

  const Root = radix.PopoverPrimitive.Root;
  const effectiveDefaultOpen = isControlled ? defaultOpen : (pendingOpen ?? defaultOpen);
  return (
    <OverlayFocusRestoreContext.Provider value={focusRestore}>
      <Root
        open={open}
        defaultOpen={effectiveDefaultOpen}
        onOpenChange={(next) => {
          // Cleared per opening — the content wrapper outlives each close, so
          // a dismissal that skips close-autofocus must not leak its flags.
          if (next) focusRestore.resetForOpen();
          if (!isControlled) setPendingOpen(undefined);
          onOpenChange?.(next);
        }}
        {...rest}
      >
        {children}
      </Root>
    </OverlayFocusRestoreContext.Provider>
  );
};
Popover.displayName = "Popover";

type PopoverTriggerProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitiveType.Trigger>;

function assignForwardedRef<T>(forwardedRef: React.ForwardedRef<T>, value: T | null) {
  if (typeof forwardedRef === "function") {
    forwardedRef(value);
  } else if (forwardedRef) {
    forwardedRef.current = value;
  }
}

const PopoverTrigger = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitiveType.Trigger>,
  PopoverTriggerProps
>(
  (
    { asChild, children, onPointerEnter, onPointerDown, onFocusCapture, onClick, ...props },
    ref
  ) => {
    const radix = useRadixPrimitives();
    const requestOpen = React.useContext(PopoverIntentContext);
    const focusRestore = useOverlayFocusRestore();
    const triggerNodeRef = React.useRef<HTMLElement | null>(null);
    const setTriggerRef = React.useCallback(
      (node: React.ElementRef<typeof PopoverPrimitiveType.Trigger> | null) => {
        triggerNodeRef.current = node as HTMLElement | null;
        // Where focus goes back to after a pointer selection closes the popover.
        focusRestore?.setRestoreTarget(node as HTMLElement | null);
        assignForwardedRef(ref, node);
      },
      [focusRestore, ref]
    );

    React.useLayoutEffect(() => {
      const node = triggerNodeRef.current;
      if (node && node.getAttribute("data-state") !== "open") {
        node.removeAttribute("aria-controls");
      }
    });

    const handlePointerEnter: React.PointerEventHandler<HTMLButtonElement> = (event) => {
      primeOnEvent();
      onPointerEnter?.(event);
    };
    const handlePointerDown: React.PointerEventHandler<HTMLButtonElement> = (event) => {
      primeOnEvent();
      onPointerDown?.(event);
    };
    const handleFocusCapture: React.FocusEventHandler<HTMLButtonElement> = (event) => {
      primeOnEvent();
      onFocusCapture?.(event);
    };

    if (!radix) {
      const intentClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
        primeOnEvent();
        requestOpen?.(true);
        onClick?.(event);
      };
      if (asChild) {
        return (
          <Slot
            ref={ref}
            onPointerEnter={handlePointerEnter}
            onPointerDown={handlePointerDown}
            onFocusCapture={handleFocusCapture}
            onClick={intentClick}
            {...props}
          >
            {children}
          </Slot>
        );
      }
      return (
        <button
          type="button"
          ref={ref as React.Ref<HTMLButtonElement>}
          onPointerEnter={handlePointerEnter}
          onPointerDown={handlePointerDown}
          onFocusCapture={handleFocusCapture}
          onClick={intentClick}
          {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        >
          {children}
        </button>
      );
    }

    const Trigger = radix.PopoverPrimitive.Trigger;
    return (
      <Trigger
        ref={setTriggerRef}
        asChild={asChild}
        onPointerEnter={handlePointerEnter}
        onPointerDown={handlePointerDown}
        onFocusCapture={handleFocusCapture}
        onClick={onClick}
        {...props}
      >
        {children}
      </Trigger>
    );
  }
);
PopoverTrigger.displayName = "PopoverTrigger";

type PopoverAnchorProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitiveType.Anchor>;

const PopoverAnchor = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitiveType.Anchor>,
  PopoverAnchorProps
>((props, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) {
    if (props.asChild && React.isValidElement(props.children)) {
      return props.children as React.ReactElement;
    }
    return null;
  }
  const Anchor = radix.PopoverPrimitive.Anchor;
  return <Anchor ref={ref} {...props} />;
});
PopoverAnchor.displayName = "PopoverAnchor";

type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitiveType.Content>;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitiveType.Content>,
  PopoverContentProps
>(
  (
    {
      className,
      align = "center",
      sideOffset = 4,
      collisionBoundary,
      style,
      onPointerDown,
      onPointerDownOutside,
      onInteractOutside,
      onKeyDown,
      onClick,
      onCloseAutoFocus,
      ...props
    },
    ref
  ) => {
    const radix = useRadixPrimitives();
    const [boundary, setBoundary] = React.useState<HTMLElement | null>(null);
    // Floating UI's autoUpdate observes the reference/floating elements but not the
    // collision boundary. The portal boundary's width tracks --right-obstruction-offset,
    // which changes when the right native panel toggles — so an open popover would keep a
    // stale position. Observe the boundary and bump a tick to re-run Radix's positioning.
    const [repositionTick, setRepositionTick] = React.useState(0);
    const focusRestore = useOverlayFocusRestore();

    React.useEffect(() => {
      const element = getPortalBoundary();
      setBoundary(element);

      // When a caller supplies their own boundary the portal boundary is unused, so there
      // is nothing to observe.
      if (collisionBoundary || !element || typeof ResizeObserver === "undefined") return;

      const observer = new ResizeObserver(() => setRepositionTick((tick) => tick + 1));
      observer.observe(element);
      return () => observer.disconnect();
    }, [collisionBoundary]);

    // Shared close-time focus policy (see `overlay-focus-restore.ts`). Consumer
    // handlers run first throughout, so an anchored palette that already owns
    // its own restoration policy still wins by preventing the default.
    const handlePointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
      onPointerDown?.(event);
      focusRestore?.onContentPointerDown();
    };
    const handlePointerDownOutside: NonNullable<PopoverContentProps["onPointerDownOutside"]> = (
      event
    ) => {
      onPointerDownOutside?.(event);
      focusRestore?.onContentPointerDownOutside();
    };
    const handleInteractOutside: NonNullable<PopoverContentProps["onInteractOutside"]> = (
      event
    ) => {
      onInteractOutside?.(event);
      focusRestore?.onContentInteractOutside(event);
    };
    const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
      onKeyDown?.(event);
      focusRestore?.onContentKeyDown();
    };
    const handleClick: React.MouseEventHandler<HTMLDivElement> = (event) => {
      onClick?.(event);
      focusRestore?.onContentClick(event);
    };
    const handleCloseAutoFocus: NonNullable<PopoverContentProps["onCloseAutoFocus"]> = (event) => {
      onCloseAutoFocus?.(event);
      focusRestore?.onContentCloseAutoFocus(event);
    };

    if (!radix) return null;
    const Portal = radix.PopoverPrimitive.Portal;
    const Content = radix.PopoverPrimitive.Content;
    return (
      <Portal>
        {/* Context reaches through a portal even though the DOM does not, so a
            popover opened from the toolbar would otherwise measure its brand
            marks against the toolbar's surface instead of this floating one. */}
        <BrandSurfaceReset>
          <Content
            ref={ref}
            align={align}
            sideOffset={sideOffset}
            collisionBoundary={collisionBoundary ?? boundary ?? undefined}
            style={{ transformOrigin: "var(--radix-popover-content-transform-origin)", ...style }}
            className={cn(
              "z-[var(--z-popover)] overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay text-text-primary",
              "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-120 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-97 data-[state=open]:zoom-in-97 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
              className
            )}
            {...props}
            onPointerDown={handlePointerDown}
            onPointerDownOutside={handlePointerDownOutside}
            onInteractOutside={handleInteractOutside}
            onKeyDown={handleKeyDown}
            onClick={handleClick}
            onCloseAutoFocus={handleCloseAutoFocus}
            // Internal reposition trigger must win over any caller-supplied value.
            data-reposition-tick={repositionTick}
          />
        </BrandSurfaceReset>
      </Portal>
    );
  }
);
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
