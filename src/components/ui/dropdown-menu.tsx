import * as React from "react";
import type * as DropdownMenuPrimitiveType from "@radix-ui/react-dropdown-menu";
import { Slot } from "@radix-ui/react-slot";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";
import { useIsDockPopoverChild } from "./DockPopoverChildContext";
import { MenuActionSourceContext, useMenuActionSource } from "./menu-source";
import { actionService } from "@/services/ActionService";
import type { ActionId, ActionDispatchOptions } from "@shared/types/actions";

const DropdownMenuIntentContext = React.createContext<((next: boolean) => void) | null>(null);

type DropdownMenuRootProps = React.ComponentProps<typeof DropdownMenuPrimitiveType.Root>;

const DropdownMenu = ({
  children,
  open,
  defaultOpen,
  onOpenChange,
  ...rest
}: DropdownMenuRootProps) => {
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
      <DropdownMenuIntentContext.Provider value={requestOpen}>
        <MenuActionSourceContext.Provider value="menu">{children}</MenuActionSourceContext.Provider>
      </DropdownMenuIntentContext.Provider>
    );
  }

  const Root = radix.DropdownMenuPrimitive.Root;
  const effectiveDefaultOpen = isControlled ? defaultOpen : (pendingOpen ?? defaultOpen);
  return (
    <MenuActionSourceContext.Provider value="menu">
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
    </MenuActionSourceContext.Provider>
  );
};
DropdownMenu.displayName = "DropdownMenu";

type DropdownMenuTriggerProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.Trigger
>;

const DropdownMenuTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.Trigger>,
  DropdownMenuTriggerProps
>(
  (
    { asChild, children, onPointerEnter, onPointerDown, onFocusCapture, onClick, ...props },
    ref
  ) => {
    const radix = useRadixPrimitives();
    const requestOpen = React.useContext(DropdownMenuIntentContext);

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

    const Trigger = radix.DropdownMenuPrimitive.Trigger;
    return (
      <Trigger
        ref={ref}
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
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

type DropdownMenuGroupProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.Group
>;

const DropdownMenuGroup = (props: DropdownMenuGroupProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return <>{props.children}</>;
  const Group = radix.DropdownMenuPrimitive.Group;
  return <Group {...props} />;
};
DropdownMenuGroup.displayName = "DropdownMenuGroup";

type DropdownMenuPortalProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.Portal
>;

const DropdownMenuPortal = (props: DropdownMenuPortalProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Portal = radix.DropdownMenuPrimitive.Portal;
  return <Portal {...props} />;
};
DropdownMenuPortal.displayName = "DropdownMenuPortal";

type DropdownMenuSubProps = React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitiveType.Sub>;

const DropdownMenuSub = (props: DropdownMenuSubProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return <>{props.children}</>;
  const Sub = radix.DropdownMenuPrimitive.Sub;
  return <Sub {...props} />;
};
DropdownMenuSub.displayName = "DropdownMenuSub";

type DropdownMenuSubTriggerProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.SubTrigger
> & {
  inset?: boolean;
};

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.SubTrigger>,
  DropdownMenuSubTriggerProps
>(({ className, inset, children, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const SubTrigger = radix.DropdownMenuPrimitive.SubTrigger;
  return (
    <SubTrigger
      ref={ref}
      className={cn(
        "flex cursor-default select-none items-center rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-hidden focus:bg-overlay-emphasis data-[state=open]:bg-overlay-emphasis",
        inset && "pl-8",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto h-3.5 w-3.5" aria-hidden="true" />
    </SubTrigger>
  );
});
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

type DropdownMenuSubContentProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.SubContent
>;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.SubContent>,
  DropdownMenuSubContentProps
>(({ className, sideOffset = 4, collisionPadding = 8, children, style, ...props }, ref) => {
  const radix = useRadixPrimitives();
  const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays(ref);
  const isDockPopoverChild = useIsDockPopoverChild();
  if (!radix) return null;
  const Portal = radix.DropdownMenuPrimitive.Portal;
  const SubContent = radix.DropdownMenuPrimitive.SubContent;
  return (
    <Portal>
      <SubContent
        ref={shadowRef}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        style={{ transformOrigin: "var(--radix-dropdown-menu-content-transform-origin)", ...style }}
        className={cn(
          "relative z-[var(--z-popover)] min-w-[10rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay p-1 text-daintree-text",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
        data-dock-popover-child={isDockPopoverChild ? "" : undefined}
      >
        {topShadow}
        {children}
        {bottomShadow}
      </SubContent>
    </Portal>
  );
});
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

type DropdownMenuContentProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.Content
>;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.Content>,
  DropdownMenuContentProps
>(({ className, sideOffset = 4, children, style, ...props }, ref) => {
  const radix = useRadixPrimitives();
  const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays(ref);
  const isDockPopoverChild = useIsDockPopoverChild();
  if (!radix) return null;
  const Portal = radix.DropdownMenuPrimitive.Portal;
  const Content = radix.DropdownMenuPrimitive.Content;
  return (
    <Portal>
      <Content
        ref={shadowRef}
        sideOffset={sideOffset}
        style={{ transformOrigin: "var(--radix-dropdown-menu-content-transform-origin)", ...style }}
        className={cn(
          "relative z-[var(--z-popover)] min-w-[10rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay p-1 text-daintree-text",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
        data-dock-popover-child={isDockPopoverChild ? "" : undefined}
      >
        {topShadow}
        {children}
        {bottomShadow}
      </Content>
    </Portal>
  );
});
DropdownMenuContent.displayName = "DropdownMenuContent";

type DropdownMenuItemProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.Item
> & {
  inset?: boolean;
  destructive?: boolean;
};

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.Item>,
  DropdownMenuItemProps
>(({ className, inset, destructive, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Item = radix.DropdownMenuPrimitive.Item;
  return (
    <Item
      ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-hidden transition-colors focus:bg-overlay-emphasis data-[highlighted]:bg-overlay-emphasis data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        destructive &&
          "text-status-danger data-[highlighted]:text-status-danger data-[highlighted]:bg-status-danger/10",
        className
      )}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = "DropdownMenuItem";

type DropdownMenuActionItemProps = DropdownMenuItemProps & {
  actionId: ActionId;
  args?: unknown;
  dispatchOptions?: Omit<ActionDispatchOptions, "source">;
};

const DropdownMenuActionItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.Item>,
  DropdownMenuActionItemProps
>(({ actionId, args, dispatchOptions, onSelect, disabled, ...props }, ref) => {
  const source = useMenuActionSource();

  const handleSelect: React.ComponentPropsWithoutRef<
    typeof DropdownMenuPrimitiveType.Item
  >["onSelect"] = (event) => {
    onSelect?.(event);
    if (event.defaultPrevented) return;
    void actionService.dispatch(actionId, args, { ...dispatchOptions, source });
  };

  return <DropdownMenuItem ref={ref} onSelect={handleSelect} disabled={disabled} {...props} />;
});
DropdownMenuActionItem.displayName = "DropdownMenuActionItem";

type DropdownMenuSeparatorProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.Separator
>;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.Separator>,
  DropdownMenuSeparatorProps
>(({ className, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Separator = radix.DropdownMenuPrimitive.Separator;
  return (
    <Separator
      ref={ref}
      className={cn("-mx-1 my-1 h-px bg-border-divider", className)}
      {...props}
    />
  );
});
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

type DropdownMenuLabelProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.Label
> & {
  inset?: boolean;
};

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.Label>,
  DropdownMenuLabelProps
>(({ className, inset, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Label = radix.DropdownMenuPrimitive.Label;
  return (
    <Label
      ref={ref}
      className={cn(
        "px-2 py-1.5 text-[11px] font-bold tracking-wider uppercase text-daintree-text/50",
        inset && "pl-8",
        className
      )}
      {...props}
    />
  );
});
DropdownMenuLabel.displayName = "DropdownMenuLabel";

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn("ml-auto text-[11px] font-mono text-daintree-text/50", className)}
      {...props}
    />
  );
};
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";

type DropdownMenuRadioGroupProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.RadioGroup
>;

const DropdownMenuRadioGroup = (props: DropdownMenuRadioGroupProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const RadioGroup = radix.DropdownMenuPrimitive.RadioGroup;
  return <RadioGroup {...props} />;
};
DropdownMenuRadioGroup.displayName = "DropdownMenuRadioGroup";

type DropdownMenuRadioItemProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.RadioItem
>;

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.RadioItem>,
  DropdownMenuRadioItemProps
>(({ className, children, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const RadioItem = radix.DropdownMenuPrimitive.RadioItem;
  const ItemIndicator = radix.DropdownMenuPrimitive.ItemIndicator;
  return (
    <RadioItem
      ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2.5 text-xs outline-hidden transition-colors focus:bg-overlay-emphasis data-[highlighted]:bg-overlay-emphasis data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <ItemIndicator>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </ItemIndicator>
      </span>
      {children}
    </RadioItem>
  );
});
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

type DropdownMenuCheckboxItemProps = React.ComponentPropsWithoutRef<
  typeof DropdownMenuPrimitiveType.CheckboxItem
>;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitiveType.CheckboxItem>,
  DropdownMenuCheckboxItemProps
>(({ className, children, checked, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const CheckboxItem = radix.DropdownMenuPrimitive.CheckboxItem;
  const ItemIndicator = radix.DropdownMenuPrimitive.ItemIndicator;
  return (
    <CheckboxItem
      ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2.5 text-xs outline-hidden transition-colors focus:bg-overlay-emphasis data-[highlighted]:bg-overlay-emphasis data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <ItemIndicator>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </ItemIndicator>
      </span>
      {children}
    </CheckboxItem>
  );
});
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuActionItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
};
