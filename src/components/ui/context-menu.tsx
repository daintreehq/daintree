import * as React from "react";
import type * as ContextMenuPrimitiveType from "@radix-ui/react-context-menu";
import { Slot } from "@radix-ui/react-slot";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";
import { useIsDockPopoverChild } from "./DockPopoverChildContext";
import { MenuActionSourceContext, useMenuActionSource } from "./menu-source";
import { actionService } from "@/services/ActionService";
import type { ActionId, ActionDispatchOptions } from "@shared/types/actions";

type ContextMenuRootProps = React.ComponentProps<typeof ContextMenuPrimitiveType.Root>;

const ContextMenu = ({ children, ...rest }: ContextMenuRootProps) => {
  const radix = useRadixPrimitives();
  if (!radix)
    return (
      <MenuActionSourceContext.Provider value="context-menu">
        {children}
      </MenuActionSourceContext.Provider>
    );
  const Root = radix.ContextMenuPrimitive.Root;
  return (
    <MenuActionSourceContext.Provider value="context-menu">
      <Root {...rest}>{children}</Root>
    </MenuActionSourceContext.Provider>
  );
};
ContextMenu.displayName = "ContextMenu";

type ContextMenuTriggerProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.Trigger
>;

// ContextMenu has no controlled `open` API — primes on pointer enter / pointer down / focus capture
// so the chunk loads before the user right-clicks. A cold right-click with no preceding pointer
// activity on the trigger may miss on the first attempt, but the second attempt always succeeds.
const ContextMenuTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Trigger>,
  ContextMenuTriggerProps
>(
  (
    { asChild, children, onPointerEnter, onPointerDown, onFocusCapture, onContextMenu, ...props },
    ref
  ) => {
    const radix = useRadixPrimitives();

    const handlePointerEnter: React.PointerEventHandler<HTMLSpanElement> = (event) => {
      primeOnEvent();
      onPointerEnter?.(event);
    };
    const handlePointerDown: React.PointerEventHandler<HTMLSpanElement> = (event) => {
      primeOnEvent();
      onPointerDown?.(event);
    };
    const handleFocusCapture: React.FocusEventHandler<HTMLSpanElement> = (event) => {
      primeOnEvent();
      onFocusCapture?.(event);
    };
    const handleContextMenu: React.MouseEventHandler<HTMLSpanElement> = (event) => {
      primeOnEvent();
      onContextMenu?.(event);
    };

    if (!radix) {
      if (asChild) {
        return (
          <Slot
            ref={ref}
            onPointerEnter={handlePointerEnter}
            onPointerDown={handlePointerDown}
            onFocusCapture={handleFocusCapture}
            onContextMenu={handleContextMenu}
            {...props}
          >
            {children}
          </Slot>
        );
      }
      return (
        <span
          ref={ref as React.Ref<HTMLSpanElement>}
          onPointerEnter={handlePointerEnter}
          onPointerDown={handlePointerDown}
          onFocusCapture={handleFocusCapture}
          onContextMenu={handleContextMenu}
          {...(props as React.HTMLAttributes<HTMLSpanElement>)}
        >
          {children}
        </span>
      );
    }

    const Trigger = radix.ContextMenuPrimitive.Trigger;
    return (
      <Trigger
        ref={ref}
        asChild={asChild}
        onPointerEnter={handlePointerEnter}
        onPointerDown={handlePointerDown}
        onFocusCapture={handleFocusCapture}
        onContextMenu={handleContextMenu}
        {...props}
      >
        {children}
      </Trigger>
    );
  }
);
ContextMenuTrigger.displayName = "ContextMenuTrigger";

type ContextMenuGroupProps = React.ComponentPropsWithoutRef<typeof ContextMenuPrimitiveType.Group>;

const ContextMenuGroup = (props: ContextMenuGroupProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return <>{props.children}</>;
  const Group = radix.ContextMenuPrimitive.Group;
  return <Group {...props} />;
};
ContextMenuGroup.displayName = "ContextMenuGroup";

type ContextMenuPortalProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.Portal
>;

const ContextMenuPortal = (props: ContextMenuPortalProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Portal = radix.ContextMenuPrimitive.Portal;
  return <Portal {...props} />;
};
ContextMenuPortal.displayName = "ContextMenuPortal";

type ContextMenuSubProps = React.ComponentPropsWithoutRef<typeof ContextMenuPrimitiveType.Sub>;

const ContextMenuSub = (props: ContextMenuSubProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return <>{props.children}</>;
  const Sub = radix.ContextMenuPrimitive.Sub;
  return <Sub {...props} />;
};
ContextMenuSub.displayName = "ContextMenuSub";

type ContextMenuSubTriggerProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.SubTrigger
> & {
  inset?: boolean;
};

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.SubTrigger>,
  ContextMenuSubTriggerProps
>(({ className, inset, children, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const SubTrigger = radix.ContextMenuPrimitive.SubTrigger;
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
ContextMenuSubTrigger.displayName = "ContextMenuSubTrigger";

type ContextMenuSubContentProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.SubContent
>;

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.SubContent>,
  ContextMenuSubContentProps
>(({ className, sideOffset = 4, collisionPadding = 8, children, style, ...props }, ref) => {
  const radix = useRadixPrimitives();
  const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays(ref);
  const isDockPopoverChild = useIsDockPopoverChild();
  if (!radix) return null;
  const Portal = radix.ContextMenuPrimitive.Portal;
  const SubContent = radix.ContextMenuPrimitive.SubContent;
  return (
    <Portal>
      <SubContent
        ref={shadowRef}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        style={{ transformOrigin: "var(--radix-context-menu-content-transform-origin)", ...style }}
        className={cn(
          "relative z-[var(--z-popover)] min-w-[10rem] max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay p-1 text-daintree-text",
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
ContextMenuSubContent.displayName = "ContextMenuSubContent";

type ContextMenuContentProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.Content
>;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Content>,
  ContextMenuContentProps
>(({ className, collisionPadding = 8, children, style, ...props }, ref) => {
  const radix = useRadixPrimitives();
  const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays(ref);
  const isDockPopoverChild = useIsDockPopoverChild();
  if (!radix) return null;
  const Portal = radix.ContextMenuPrimitive.Portal;
  const Content = radix.ContextMenuPrimitive.Content;
  return (
    <Portal>
      <Content
        ref={shadowRef}
        collisionPadding={collisionPadding}
        style={{ transformOrigin: "var(--radix-context-menu-content-transform-origin)", ...style }}
        className={cn(
          "relative z-[var(--z-popover)] min-w-[10rem] max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay p-1 text-daintree-text",
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
ContextMenuContent.displayName = "ContextMenuContent";

type ContextMenuItemProps = React.ComponentPropsWithoutRef<typeof ContextMenuPrimitiveType.Item> & {
  inset?: boolean;
  destructive?: boolean;
};

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Item>,
  ContextMenuItemProps
>(({ className, inset, destructive, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Item = radix.ContextMenuPrimitive.Item;
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
ContextMenuItem.displayName = "ContextMenuItem";

type ContextMenuActionItemProps = ContextMenuItemProps & {
  actionId: ActionId;
  args?: unknown;
  dispatchOptions?: Omit<ActionDispatchOptions, "source">;
};

const ContextMenuActionItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Item>,
  ContextMenuActionItemProps
>(({ actionId, args, dispatchOptions, onSelect, disabled, ...props }, ref) => {
  const source = useMenuActionSource();

  const handleSelect: React.ComponentPropsWithoutRef<
    typeof ContextMenuPrimitiveType.Item
  >["onSelect"] = (event) => {
    onSelect?.(event);
    if (event.defaultPrevented) return;
    void actionService.dispatch(actionId, args, { ...dispatchOptions, source });
  };

  return <ContextMenuItem ref={ref} onSelect={handleSelect} disabled={disabled} {...props} />;
});
ContextMenuActionItem.displayName = "ContextMenuActionItem";

type ContextMenuSeparatorProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.Separator
>;

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Separator>,
  ContextMenuSeparatorProps
>(({ className, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Separator = radix.ContextMenuPrimitive.Separator;
  return (
    <Separator
      ref={ref}
      className={cn("-mx-1 my-1 h-px bg-border-divider", className)}
      {...props}
    />
  );
});
ContextMenuSeparator.displayName = "ContextMenuSeparator";

type ContextMenuLabelProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.Label
> & {
  inset?: boolean;
};

const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Label>,
  ContextMenuLabelProps
>(({ className, inset, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Label = radix.ContextMenuPrimitive.Label;
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
ContextMenuLabel.displayName = "ContextMenuLabel";

const ContextMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      className={cn("ml-auto text-[11px] font-mono text-daintree-text/50", className)}
      {...props}
    />
  );
};
ContextMenuShortcut.displayName = "ContextMenuShortcut";

type ContextMenuCheckboxItemProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.CheckboxItem
>;

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.CheckboxItem>,
  ContextMenuCheckboxItemProps
>(({ className, children, checked, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const CheckboxItem = radix.ContextMenuPrimitive.CheckboxItem;
  const ItemIndicator = radix.ContextMenuPrimitive.ItemIndicator;
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
ContextMenuCheckboxItem.displayName = "ContextMenuCheckboxItem";

type ContextMenuRadioGroupProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.RadioGroup
>;

const ContextMenuRadioGroup = (props: ContextMenuRadioGroupProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const RadioGroup = radix.ContextMenuPrimitive.RadioGroup;
  return <RadioGroup {...props} />;
};
ContextMenuRadioGroup.displayName = "ContextMenuRadioGroup";

type ContextMenuRadioItemProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.RadioItem
>;

const ContextMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.RadioItem>,
  ContextMenuRadioItemProps
>(({ className, children, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const RadioItem = radix.ContextMenuPrimitive.RadioItem;
  const ItemIndicator = radix.ContextMenuPrimitive.ItemIndicator;
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
ContextMenuRadioItem.displayName = "ContextMenuRadioItem";

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuActionItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuLabel,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
};
