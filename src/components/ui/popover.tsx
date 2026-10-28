import * as React from "react";
import type * as PopoverPrimitiveType from "@radix-ui/react-popover";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import {
  OVERLAY_DROP_MOTION_CLASS,
  OVERLAY_MOTION_CLASS,
  OVERLAY_SIDE_OFFSET,
} from "./overlayMotion";
import { BrandSurfaceReset } from "@/components/icons/BrandSurface";
import { useDialogOverlayZClass } from "./dialogLayer";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";
import {
  OverlayFocusRestoreContext,
  useOverlayFocusRestore,
  useOverlayFocusRestoreValue,
} from "./overlay-focus-restore";
import { useLayerPressFocusGuard } from "./layer-press-focus-guard";

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

// PopoverContent's default collisionPadding; the menu-family contract reads that literal.
const DEFAULT_COLLISION_PADDING = 8;

/**
 * The width a `PopoverContent` on the default collision boundary can take:
 * the window less the native panel on the right and the collision padding.
 * Radix shifts the content along the anchor's axis to stay inside that
 * boundary, so this is its `--radix-popover-content-available-width` once it
 * is placed, known before it is. The window, without layout to measure.
 *
 * Reads layout and mounts the boundary on first use, so call it from a layout
 * effect or an event handler, never during render.
 */
function getPopoverAvailableWidth(collisionPadding = DEFAULT_COLLISION_PADDING): number {
  if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
  const measured = getPortalBoundary()?.getBoundingClientRect().width ?? 0;
  const width = measured > 0 ? measured : window.innerWidth;
  return Math.max(0, width - 2 * collisionPadding);
}

const PopoverIntentContext = React.createContext<((next: boolean) => void) | null>(null);

/**
 * Where this popover hands focus back, kept on its own root. A trigger records
 * itself as the shared policy's restore target; an anchor that opts in through
 * `restoreFocus` does the same, and also takes the keyboard close, which the
 * shared policy leaves to Radix — and Radix restores to a trigger an anchored
 * popover doesn't have, so focus would land on `document.body`.
 *
 * Its own context rather than `OverlayFocusRestoreContext`: a trigger or an
 * anchor often sits on another overlay's trigger (a context menu around a
 * toolbar button, a menu button whose item opens this popover), where the
 * nearest focus-restore provider is that overlay's, not this popover's.
 */
interface PopoverFocusTargets {
  setRestoreTarget: (node: HTMLElement | null) => void;
  setAnchor: (node: HTMLElement | null) => void;
  getAnchor: () => HTMLElement | null;
  /**
   * Radix restores nothing once an outside interaction it didn't veto has
   * closed the popover — focus already went where the user sent it — and
   * neither may the anchor. Per opening, like the shared policy's flags.
   */
  markInteractedOutside: () => void;
  takeInteractedOutside: () => boolean;
  resetForOpen: () => void;
}

const PopoverFocusTargetsContext = React.createContext<PopoverFocusTargets | null>(null);

type PopoverRootProps = React.ComponentProps<typeof PopoverPrimitiveType.Root>;

const Popover = ({ children, open, defaultOpen, onOpenChange, ...rest }: PopoverRootProps) => {
  const radix = useRadixPrimitives();
  const [pendingOpen, setPendingOpen] = React.useState<boolean | undefined>(undefined);
  const isControlled = open !== undefined;
  const focusRestore = useOverlayFocusRestoreValue();
  const anchorRef = React.useRef<HTMLElement | null>(null);
  const interactedOutsideRef = React.useRef(false);
  const focusTargets = React.useMemo<PopoverFocusTargets>(
    () => ({
      setRestoreTarget: (node) => focusRestore.setRestoreTarget(node),
      setAnchor: (node) => {
        anchorRef.current = node;
        focusRestore.setRestoreTarget(node);
      },
      getAnchor: () => anchorRef.current,
      markInteractedOutside: () => {
        interactedOutsideRef.current = true;
      },
      takeInteractedOutside: () => {
        const interacted = interactedOutsideRef.current;
        interactedOutsideRef.current = false;
        return interacted;
      },
      resetForOpen: () => {
        interactedOutsideRef.current = false;
      },
    }),
    [focusRestore]
  );

  // Radix only calls `onOpenChange` for opens it initiates, so a CONTROLLED
  // consumer flipping `open` back to true never reaches the reset below.
  // That matters when a pointer dismissal is reversed mid-exit: the close
  // never reaches `onCloseAutoFocus`, and its flags would decide the next one.
  React.useEffect(() => {
    if (!open) return;
    focusRestore.resetForOpen();
    focusTargets.resetForOpen();
  }, [open, focusRestore, focusTargets]);

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
      <PopoverFocusTargetsContext.Provider value={focusTargets}>
        <PopoverIntentContext.Provider value={requestOpen}>
          {children}
        </PopoverIntentContext.Provider>
      </PopoverFocusTargetsContext.Provider>
    );
  }

  const Root = radix.PopoverPrimitive.Root;
  const effectiveDefaultOpen = isControlled ? defaultOpen : (pendingOpen ?? defaultOpen);
  return (
    <OverlayFocusRestoreContext.Provider value={focusRestore}>
      <PopoverFocusTargetsContext.Provider value={focusTargets}>
        <Root
          open={open}
          defaultOpen={effectiveDefaultOpen}
          onOpenChange={(next) => {
            // Cleared per opening — the content wrapper outlives each close, so
            // a dismissal that skips close-autofocus must not leak its flags.
            if (next) {
              focusRestore.resetForOpen();
              focusTargets.resetForOpen();
            }
            if (!isControlled) setPendingOpen(undefined);
            onOpenChange?.(next);
          }}
          {...rest}
        >
          {children}
        </Root>
      </PopoverFocusTargetsContext.Provider>
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
    const focusTargets = React.useContext(PopoverFocusTargetsContext);
    const triggerNodeRef = React.useRef<HTMLElement | null>(null);
    const setTriggerRef = React.useCallback(
      (node: React.ElementRef<typeof PopoverPrimitiveType.Trigger> | null) => {
        triggerNodeRef.current = node as HTMLElement | null;
        // Where focus goes back to after a pointer selection closes the popover.
        focusTargets?.setRestoreTarget(node as HTMLElement | null);
        assignForwardedRef(ref, node);
      },
      [focusTargets, ref]
    );

    React.useLayoutEffect(() => {
      const node = triggerNodeRef.current;
      // `aria-expanded`, not `data-state`: a Tooltip sharing this trigger writes its
      // own `data-state` over the popover's, which read as closed while the popover
      // was open and stripped the attribute that names it.
      if (node && node.getAttribute("aria-expanded") !== "true") {
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
      // Consumer first, then the queued open only if nobody prevented it, as
      // Radix's own trigger composes its toggle. An `asChild` child's handler
      // has already run by now: Slot calls the child's before its own.
      const intentClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
        primeOnEvent();
        onClick?.(event);
        if (event.defaultPrevented) return;
        requestOpen?.(true);
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

type PopoverAnchorProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitiveType.Anchor> & {
  /**
   * Hand focus back to this element when the popover closes. For a popover
   * with no `PopoverTrigger` — one opened from another control's menu, say —
   * whose anchor is itself focusable. The shared close policy then treats it
   * as the trigger: ringless after a pointer close, ringed after the keyboard.
   */
  restoreFocus?: boolean;
};

const PopoverAnchor = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitiveType.Anchor>,
  PopoverAnchorProps
>(({ restoreFocus = false, ...props }, ref) => {
  const radix = useRadixPrimitives();
  const focusTargets = React.useContext(PopoverFocusTargetsContext);
  const setAnchorRef = React.useCallback(
    (node: React.ElementRef<typeof PopoverPrimitiveType.Anchor> | null) => {
      if (restoreFocus) focusTargets?.setAnchor(node as HTMLElement | null);
      assignForwardedRef(ref, node);
    },
    [restoreFocus, focusTargets, ref]
  );
  if (!radix) {
    // Through a Slot rather than returning the child bare: an anchor composed
    // inside another trigger's `asChild` chain receives that trigger's
    // handlers and ref as props, and dropping them would leave the shared
    // element inert until the Radix chunk lands.
    if (props.asChild && React.isValidElement(props.children)) {
      const { asChild: _asChild, ...slotProps } = props;
      return <Slot ref={setAnchorRef} {...slotProps} />;
    }
    return null;
  }
  const Anchor = radix.PopoverPrimitive.Anchor;
  return <Anchor ref={setAnchorRef} {...props} />;
});
PopoverAnchor.displayName = "PopoverAnchor";

type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitiveType.Content> & {
  /**
   * `drop` for a list that hangs off a trigger about as wide as itself: it
   * unrolls downward instead of zooming from the anchor's corner, which on a
   * wide panel reads as sideways growth. See `overlayMotion.ts`.
   */
  motion?: "overlay" | "drop";
};

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitiveType.Content>,
  PopoverContentProps
>(
  (
    {
      className,
      align = "center",
      sideOffset = OVERLAY_SIDE_OFFSET,
      collisionPadding = 8,
      collisionBoundary,
      style,
      onPointerDown,
      onPointerDownCapture,
      onPointerDownOutside,
      onInteractOutside,
      onFocusOutside,
      onKeyDown,
      onClick,
      onCloseAutoFocus,
      motion = "overlay",
      ...props
    },
    ref
  ) => {
    const radix = useRadixPrimitives();
    const dialogOverlayZ = useDialogOverlayZClass();
    const focusTargets = React.useContext(PopoverFocusTargetsContext);
    const [boundary, setBoundary] = React.useState<HTMLElement | null>(null);
    // Floating UI's autoUpdate observes the reference/floating elements but not the
    // collision boundary. The portal boundary's width tracks --right-obstruction-offset,
    // which changes when the right native panel toggles — so an open popover would keep a
    // stale position. Observe the boundary and bump a tick to re-run Radix's positioning.
    const [repositionTick, setRepositionTick] = React.useState(0);
    const focusRestore = useOverlayFocusRestore();
    const {
      ref: guardedRef,
      onPointerDownCapture: claimPress,
      onFocusOutside: guardFocusOutside,
    } = useLayerPressFocusGuard(ref);

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
      if (!event.defaultPrevented) focusTargets?.markInteractedOutside();
    };
    // A press inside the popover must not lose it to an ancestor that pulls
    // focus on pointerdown (see `layer-press-focus-guard.ts`).
    const handlePointerDownCapture: React.PointerEventHandler<HTMLDivElement> = (event) => {
      onPointerDownCapture?.(event);
      claimPress();
    };
    const handleFocusOutside: NonNullable<PopoverContentProps["onFocusOutside"]> = (event) => {
      onFocusOutside?.(event);
      guardFocusOutside(event);
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
      // A close nobody claimed, with focus not sent elsewhere, is the
      // keyboard's (or the content's own), and Radix would restore it to a
      // trigger. An anchor that opted into `restoreFocus` stands in for the
      // missing one, ringed, because the keyboard user has to see where they
      // landed.
      const interactedOutside = focusTargets?.takeInteractedOutside() ?? false;
      if (event.defaultPrevented || interactedOutside) return;
      const anchor = focusTargets?.getAnchor();
      if (!anchor?.isConnected) return;
      event.preventDefault();
      anchor.focus({ preventScroll: true });
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
            ref={guardedRef}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={collisionPadding}
            collisionBoundary={collisionBoundary ?? boundary ?? undefined}
            style={{ transformOrigin: "var(--radix-popover-content-transform-origin)", ...style }}
            className={cn(
              // Escapes the toolbar's drag region via the portal — see `.app-no-drag` (#12347).
              "app-no-drag",
              "z-[var(--z-popover)] overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay text-text-primary",
              dialogOverlayZ,
              motion === "drop" ? OVERLAY_DROP_MOTION_CLASS : OVERLAY_MOTION_CLASS,
              className
            )}
            {...props}
            onPointerDown={handlePointerDown}
            onPointerDownCapture={handlePointerDownCapture}
            onPointerDownOutside={handlePointerDownOutside}
            onInteractOutside={handleInteractOutside}
            onFocusOutside={handleFocusOutside}
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

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, getPopoverAvailableWidth };
