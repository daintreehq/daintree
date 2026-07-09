import * as React from "react";
import type * as TooltipPrimitiveType from "@radix-ui/react-tooltip";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";
import { FixedDropdownVisibleContext } from "./fixed-dropdown";
import { useIsDockPopoverChild } from "./DockPopoverChildContext";
import {
  isTooltipFocusOpenSuppressed,
  notifyTooltipPointerActivity,
  registerTooltipDismiss,
} from "@/lib/tooltipDismissRegistry";

type TooltipProviderProps = React.ComponentProps<typeof TooltipPrimitiveType.Provider>;

const TooltipProvider = ({ children, ...props }: TooltipProviderProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return <>{children}</>;
  const Provider = radix.TooltipPrimitive.Provider;
  return <Provider {...props}>{children}</Provider>;
};
TooltipProvider.displayName = "TooltipProvider";

type TooltipRootProps = React.ComponentProps<typeof TooltipPrimitiveType.Root>;

// How long any tooltip stays up before auto-hiding. Tooltips here are
// transient hints — once read, they've done their job — so every open gets
// a fixed display window instead of persisting while hovered/focused. The
// motivating bug: Radix opens tooltips on focus as well as hover, and focus
// routinely lands on a trigger without the user asking for a tooltip (focus
// restoration after a popover/dialog closes, webContents.focus() on a
// project-view swap, window re-activation). Those opens have no natural
// close, so without a deadline the tooltip pins until the next click.
// Controlled consumers are closed through their onOpenChange; a pinned
// `open` with no handler (validation/drag hints) deliberately ignores the
// dismiss. Tooltips whose body IS the content (rich hover cards, full-text
// reveals) opt out via `autoDismiss={false}`.
const TOOLTIP_AUTO_DISMISS_MS = 2500;

type TooltipProps = TooltipRootProps & {
  autoDismiss?: boolean;
  /**
   * When true (default), this tooltip closes on every dialog open/close
   * transition (issue #11030) and honors the brief focus-open suppression
   * window that follows. Rich hover cards whose body IS the content
   * (IssueBadge, PRBadge) opt out with `false` — they are fully exempt
   * from both the forced close and the suppression.
   */
  dismissOnDialogTransition?: boolean;
};

const Tooltip = ({
  children,
  open,
  defaultOpen,
  onOpenChange,
  autoDismiss = true,
  dismissOnDialogTransition = true,
  ...props
}: TooltipProps) => {
  const radix = useRadixPrimitives();
  // When the surrounding keepMounted FixedDropdown has transitioned to the
  // Activity-hidden state, force `open={false}` on the Radix Root so any
  // tooltip whose dismiss path was skipped by the synchronous `display:none`
  // gets explicitly closed before its portaled content can strand at (0,0)
  // on document.body (issue #8001). Outside that subtree the context default
  // (`true`) preserves the caller's `open` value, so uncontrolled tooltips
  // and any explicit `open={true}` callers keep working unchanged.
  const dropdownVisible = React.useContext(FixedDropdownVisibleContext);
  // Shadow of the open state so the Root is always controlled. For
  // uncontrolled consumers this replaces Radix's internal state; for
  // controlled consumers it tracks their value so flipping between modes
  // (`open={cond || undefined}`) can't strand a stale open.
  const [managedOpen, setManagedOpen] = React.useState(defaultOpen ?? false);
  const isControlled = open !== undefined;
  const resolvedOpen = isControlled ? open : managedOpen;
  const effectiveOpen = dropdownVisible ? resolvedOpen : false;

  // Synced in an effect (not during render) so the React Compiler can
  // memoize this component; events and timers only fire post-commit, so the
  // ref is always current when read.
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      // Focus restoration after a dialog transition re-opens tooltips
      // through Radix's focus path with nothing hovered. Ignore opens
      // during the post-dismiss suppression window; genuine hovers are
      // unaffected because pointerenter on any trigger clears it first.
      if (next && dismissOnDialogTransition && isTooltipFocusOpenSuppressed()) return;
      setManagedOpen(next);
      onOpenChangeRef.current?.(next);
    },
    [dismissOnDialogTransition]
  );

  // Mirror of the rendered open state for the dismiss callback, which must
  // read it post-commit without re-registering on every open/close.
  const effectiveOpenRef = React.useRef(false);
  React.useEffect(() => {
    effectiveOpenRef.current = effectiveOpen;
  });

  // Register with the global dismiss registry so dialog transitions can
  // force-close this tooltip (issue #11030). The callback is a stable
  // closure over refs, so StrictMode's mount→unmount→mount cycle
  // registers and unregisters cleanly without stale state.
  React.useEffect(() => {
    if (!dismissOnDialogTransition) return;
    return registerTooltipDismiss(() => {
      if (!effectiveOpenRef.current) return;
      setManagedOpen(false);
      onOpenChangeRef.current?.(false);
    });
  }, [dismissOnDialogTransition]);

  // Fixed display window: each open transition arms the dismiss timer; a
  // close (pointer leave, Escape, click) clears it via the effect cleanup.
  // Re-hovering after a dismissal re-opens through Radix's normal
  // pointer-move path and gets a fresh window. Known papercut: a timed close
  // bypasses Radix's provider onClose bookkeeping, so the skip-delay window
  // can stay "warm" (next hover opens with no delay) until any tooltip
  // closes through Radix's own path — harmless, and self-heals on the next
  // pointer-leave close anywhere.
  React.useEffect(() => {
    if (!autoDismiss || !effectiveOpen) return;
    const timer = setTimeout(() => {
      setManagedOpen(false);
      onOpenChangeRef.current?.(false);
    }, TOOLTIP_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [autoDismiss, effectiveOpen]);

  // The prop-forced close while hidden never fires onOpenChange, so the
  // shadow state must be reset explicitly or the tooltip would re-open
  // hover-less when the dropdown becomes visible again.
  React.useEffect(() => {
    if (!dropdownVisible) setManagedOpen(false);
  }, [dropdownVisible]);

  if (!radix) return <>{children}</>;
  const Root = radix.TooltipPrimitive.Root;
  // Key on visibility so the Radix Root remounts on each hidden/visible
  // transition, clearing any internal state the prop-forced close skipped
  // (issue #8001). The hidden tree has no user-visible state worth
  // preserving since the forced close already invalidated it.
  return (
    <Root
      key={dropdownVisible ? "visible" : "hidden"}
      {...props}
      open={effectiveOpen}
      onOpenChange={handleOpenChange}
    >
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
      // A real hover ends the post-dialog-transition focus-open
      // suppression — the user is pointing, so tooltips are wanted again.
      notifyTooltipPointerActivity();
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
            "animate-in fade-in-0 duration-150 data-[state=closed]:animate-out data-[state=closed]:duration-100 data-[state=closed]:fade-out-0 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
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
