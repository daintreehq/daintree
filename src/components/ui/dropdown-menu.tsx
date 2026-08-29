import * as React from "react";
import type * as DropdownMenuPrimitiveType from "@radix-ui/react-dropdown-menu";
import { Slot } from "@radix-ui/react-slot";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandSurfaceReset } from "@/components/icons/BrandSurface";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";
import { useIsDockPopoverChild } from "./DockPopoverChildContext";
import { MenuActionSourceContext, useMenuActionSource } from "./menu-source";
import { actionService } from "@/services/ActionService";
import { useAriaKeyshortcuts } from "@/hooks";
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

/* Highlighted-row focus ring, shared by every item-shaped primitive below.
 *
 * `data-[highlighted]` is Radix's own highlight and fires for pointer and keyboard
 * alike, so it stays the fill. It cannot be the WCAG 1.4.11 indicator on its own:
 * `overlay-raised` clears about 1.1:1 against the surface these menus float on
 * (`shared/theme/contrast.ts`), which is why the palette row grew a separate rail
 * rather than a heavier fill. Keyboard focus gets the indicator instead.
 *
 * `selection-outline` rather than the accent the generic inset-ring recipe names:
 * `getPaletteSelectionWarnings` holds that token to 3:1 against all three colours an
 * inset ring on one of these rows can touch — the raised fill, the `status-danger`
 * wash a destructive row swaps in for it, and the `.surface-overlay` behind both.
 * Accent is only scored against the display surfaces, so it has no guarantee against
 * any of them.
 *
 * `outline-solid` is load-bearing, not decorative: `outline-hidden` sets
 * `--tw-outline-style: none` on this element and `outline-2` reads that same
 * variable back, so the ring resolves to `outline-style: none` without it. The
 * suppression is kept so `forced-colors` can still recolour the outline (#6185).
 */
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
        "flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-hidden transition-colors data-[highlighted]:bg-overlay-raised focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px] data-[state=open]:bg-overlay-raised",
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
          "relative z-[var(--z-popover)] min-w-[10rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay p-1 text-text-primary",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-120 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-97 data-[state=open]:zoom-in-97 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
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
      {/* Context reaches through a portal even though the DOM does not, so a
          menu opened from the toolbar would otherwise measure its brand marks
          against the toolbar's surface instead of this floating one. */}
      <BrandSurfaceReset>
        <Content
          ref={shadowRef}
          sideOffset={sideOffset}
          style={{
            transformOrigin: "var(--radix-dropdown-menu-content-transform-origin)",
            ...style,
          }}
          className={cn(
            "relative z-[var(--z-popover)] min-w-[10rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay p-1 text-text-primary",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-120 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-97 data-[state=open]:zoom-in-97 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
            className
          )}
          {...props}
          data-dock-popover-child={isDockPopoverChild ? "" : undefined}
        >
          {topShadow}
          {children}
          {bottomShadow}
        </Content>
      </BrandSurfaceReset>
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

/* Leading icons: mark the icon `data-menu-icon` and the text-only items in the
 * same menu pick up a matching gutter from the `[role="menu"]:has(...)` rule in
 * index.css — and lose it again when the icon-bearing items are filtered out.
 * `inset` is the static alternative for a menu whose shape never changes. */
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
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-hidden transition-colors data-[highlighted]:bg-overlay-raised focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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
  const ariaKeyshortcuts = useAriaKeyshortcuts(actionId);

  const handleSelect: React.ComponentPropsWithoutRef<
    typeof DropdownMenuPrimitiveType.Item
  >["onSelect"] = (event) => {
    onSelect?.(event);
    if (event.defaultPrevented) return;
    void actionService.dispatch(actionId, args, { ...dispatchOptions, source });
  };

  return (
    <DropdownMenuItem
      ref={ref}
      onSelect={handleSelect}
      disabled={disabled}
      {...props}
      aria-keyshortcuts={ariaKeyshortcuts}
    />
  );
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
        "px-2.5 py-1.5 text-2xs font-bold tracking-wider uppercase text-text-secondary",
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
      className={cn("ml-auto pl-2 text-2xs font-mono text-text-secondary", className)}
      {...props}
    />
  );
};
DropdownMenuShortcut.displayName = "DropdownMenuShortcut";

/* Trailing muted slot for item METADATA — a count, a state, a reason an item is
 * disabled. Deliberately not `DropdownMenuShortcut`: a count is not a keybinding,
 * and rendering it in the shortcut's mono face reads as one. Non-mono, and
 * `aria-hidden` by default because the number belongs in the item's accessible
 * name (callers pass one), not as a second stray string after it. */
const DropdownMenuMeta = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      aria-hidden="true"
      className={cn("ml-auto pl-2 text-2xs text-text-secondary tabular-nums", className)}
      {...props}
    />
  );
};
DropdownMenuMeta.displayName = "DropdownMenuMeta";

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
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2.5 text-xs outline-hidden transition-colors data-[highlighted]:bg-overlay-raised focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2.5 text-xs outline-hidden transition-colors data-[highlighted]:bg-overlay-raised focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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
  DropdownMenuMeta,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
};
