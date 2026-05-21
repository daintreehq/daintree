import * as React from "react";
import type * as PopoverPrimitiveType from "@radix-ui/react-popover";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";

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
    <Root
      open={open}
      defaultOpen={effectiveDefaultOpen}
      onOpenChange={(next) => {
        if (!isControlled) setPendingOpen(undefined);
        onOpenChange?.(next);
      }}
      {...rest}
    >
      {children}
    </Root>
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
    const triggerNodeRef = React.useRef<HTMLElement | null>(null);
    const setTriggerRef = React.useCallback(
      (node: React.ElementRef<typeof PopoverPrimitiveType.Trigger> | null) => {
        triggerNodeRef.current = node as HTMLElement | null;
        assignForwardedRef(ref, node);
      },
      [ref]
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
>(({ className, align = "center", sideOffset = 4, collisionBoundary, style, ...props }, ref) => {
  const radix = useRadixPrimitives();
  const [boundary, setBoundary] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    setBoundary(getPortalBoundary());
  }, []);

  if (!radix) return null;
  const Portal = radix.PopoverPrimitive.Portal;
  const Content = radix.PopoverPrimitive.Content;
  return (
    <Portal>
      <Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        collisionBoundary={collisionBoundary ?? boundary ?? undefined}
        style={{ transformOrigin: "var(--radix-popover-content-transform-origin)", ...style }}
        className={cn(
          "z-[var(--z-popover)] overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay text-daintree-text",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      />
    </Portal>
  );
});
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
