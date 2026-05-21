import * as React from "react";
import type * as TooltipPrimitiveType from "@radix-ui/react-tooltip";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";
import { FixedDropdownVisibleContext } from "./fixed-dropdown";
import { useIsDockPopoverChild } from "./DockPopoverChildContext";

type TooltipProviderProps = React.ComponentProps<typeof TooltipPrimitiveType.Provider>;

const TooltipProvider = ({ children, ...props }: TooltipProviderProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return <>{children}</>;
  const Provider = radix.TooltipPrimitive.Provider;
  return <Provider {...props}>{children}</Provider>;
};
TooltipProvider.displayName = "TooltipProvider";

type TooltipRootProps = React.ComponentProps<typeof TooltipPrimitiveType.Root>;

const Tooltip = ({ children, open, ...props }: TooltipRootProps) => {
  const radix = useRadixPrimitives();
  // When the surrounding keepMounted FixedDropdown has transitioned to the
  // Activity-hidden state, force `open={false}` on the Radix Root so any
  // tooltip whose dismiss path was skipped by the synchronous `display:none`
  // gets explicitly closed before its portaled content can strand at (0,0)
  // on document.body (issue #8001). Outside that subtree the context default
  // (`true`) preserves the caller's `open` value, so uncontrolled tooltips
  // and any explicit `open={true}` callers keep working unchanged.
  const dropdownVisible = React.useContext(FixedDropdownVisibleContext);
  const effectiveOpen = dropdownVisible ? open : false;
  if (!radix) return <>{children}</>;
  const Root = radix.TooltipPrimitive.Root;
  // Key on visibility so the Radix Root remounts on each hidden/visible
  // transition. Without this, a tooltip that was uncontrolled-open when
  // the dropdown hid would leave Radix's internal `uncontrolledProp` stuck
  // at `true` — the controlled-close path only fires `onOpenChange` and
  // never resets the uncontrolled state. On reopen, releasing back to
  // `open={undefined}` would then read that stale `true` and re-open the
  // tooltip with no user hover. Remounting clears it; the hidden tree has
  // no user-visible state worth preserving since the prop-forced close
  // already invalidated it.
  return (
    <Root key={dropdownVisible ? "visible" : "hidden"} {...props} open={effectiveOpen}>
      {children}
    </Root>
  );
};
Tooltip.displayName = "Tooltip";

type TooltipTriggerProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitiveType.Trigger>;

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitiveType.Trigger>,
  TooltipTriggerProps
>(
  (
    { asChild, children, onPointerEnter, onPointerDown, onPointerUp, onFocusCapture, ...props },
    ref
  ) => {
    const radix = useRadixPrimitives();
    // Track whether the most recent focus arrived via a pointer interaction so
    // the focus-capture handler can distinguish keyboard focus from
    // click-induced focus. `pointerdown` sets the ref; `pointerup` schedules a
    // next-tick clear so the same task that fires `focus` between them still
    // sees `true`. The drag-out case (pointerdown on trigger, pointerup
    // outside) leaves the ref `true` until the next `pointerdown` on this
    // element — harmless here since the only suppressed work is
    // `primeOnEvent` (already called on `pointerdown`) and the consumer's
    // `onFocusCapture` (no current callers). See issue #8008.
    const pointerActiveRef = React.useRef(false);

    const handlePointerEnter: React.PointerEventHandler<HTMLButtonElement> = (event) => {
      primeOnEvent();
      onPointerEnter?.(event);
    };
    const handlePointerDown: React.PointerEventHandler<HTMLButtonElement> = (event) => {
      pointerActiveRef.current = true;
      primeOnEvent();
      onPointerDown?.(event);
    };
    const handlePointerUp: React.PointerEventHandler<HTMLButtonElement> = (event) => {
      onPointerUp?.(event);
      setTimeout(() => {
        pointerActiveRef.current = false;
      }, 0);
    };
    const handleFocusCapture: React.FocusEventHandler<HTMLButtonElement> = (event) => {
      // Early return is the actual suppression — skipping `primeOnEvent` and
      // the consumer's `onFocusCapture`. The Radix Trigger's own
      // `isPointerDownRef` blocks Radix's internal open path independently.
      if (pointerActiveRef.current) return;
      primeOnEvent();
      onFocusCapture?.(event);
    };

    if (!radix) {
      if (asChild) {
        return (
          <Slot
            ref={ref}
            onPointerEnter={handlePointerEnter}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onFocusCapture={handleFocusCapture}
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
          onPointerUp={handlePointerUp}
          onFocusCapture={handleFocusCapture}
          {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        >
          {children}
        </button>
      );
    }

    const Trigger = radix.TooltipPrimitive.Trigger;
    return (
      <Trigger
        ref={ref}
        asChild={asChild}
        onPointerEnter={handlePointerEnter}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onFocusCapture={handleFocusCapture}
        {...props}
      >
        {children}
      </Trigger>
    );
  }
);
TooltipTrigger.displayName = "TooltipTrigger";

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitiveType.Content>;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitiveType.Content>,
  TooltipContentProps
>(
  (
    {
      className,
      sideOffset = 4,
      collisionPadding = 8,
      sticky = "partial",
      hideWhenDetached = true,
      style,
      ...props
    },
    ref
  ) => {
    const radix = useRadixPrimitives();
    const isDockPopoverChild = useIsDockPopoverChild();
    if (!radix) return null;
    const Portal = radix.TooltipPrimitive.Portal;
    const Content = radix.TooltipPrimitive.Content;
    return (
      <Portal>
        <Content
          ref={ref}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          sticky={sticky}
          hideWhenDetached={hideWhenDetached}
          style={{ transformOrigin: "var(--radix-tooltip-content-transform-origin)", ...style }}
          className={cn(
            "z-[var(--z-popover)] max-w-xs overflow-hidden rounded-[var(--radius-md)] surface-overlay shadow-overlay px-3 py-1.5 text-xs text-daintree-text",
            "animate-in fade-in-0 zoom-in-95 duration-150 data-[state=closed]:animate-out data-[state=closed]:duration-[100ms] data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
            className
          )}
          {...props}
          data-dock-popover-child={isDockPopoverChild ? "" : undefined}
        />
      </Portal>
    );
  }
);
TooltipContent.displayName = "TooltipContent";

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
