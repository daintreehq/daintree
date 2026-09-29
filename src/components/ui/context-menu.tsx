import * as React from "react";
import type * as ContextMenuPrimitiveType from "@radix-ui/react-context-menu";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { OVERLAY_MOTION_CLASS } from "./overlayMotion";
import { BrandSurfaceReset } from "@/components/icons/BrandSurface";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { primeOnEvent, useRadixPrimitives } from "./radix-loader";
import { useIsDockPopoverChild } from "./DockPopoverChildContext";
import { MenuActionSourceContext, useMenuActionSource } from "./menu-source";
import { menuRowPointerMove } from "./menu-row-hover-focus";
import {
  OverlayFocusRestoreContext,
  useOverlayFocusRestore,
  useOverlayFocusRestoreValue,
} from "./overlay-focus-restore";
import { actionService } from "@/services/ActionService";
import { useAriaKeyshortcuts, useEffectiveCombo } from "@/hooks";
import { KbdChord } from "./Kbd";
import type { ActionId, ActionDispatchOptions } from "@shared/types/actions";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";

type ContextMenuRootProps = React.ComponentProps<typeof ContextMenuPrimitiveType.Root>;

const ContextMenu = ({ children, onOpenChange, ...rest }: ContextMenuRootProps) => {
  const radix = useRadixPrimitives();
  const focusRestore = useOverlayFocusRestoreValue({ restoreFocusOnPointerClose: true });
  if (!radix)
    return (
      <MenuActionSourceContext.Provider value="context-menu">
        {children}
      </MenuActionSourceContext.Provider>
    );
  const Root = radix.ContextMenuPrimitive.Root;
  return (
    <MenuActionSourceContext.Provider value="context-menu">
      <OverlayFocusRestoreContext.Provider value={focusRestore}>
        <Root
          onOpenChange={(next) => {
            if (next) {
              focusRestore.resetForOpen();
              // A context menu has no focusable trigger of its own — Radix's
              // focus scope restores whatever was focused before it opened, so
              // that element is the one a pointer selection has to hand focus
              // back to. Chromium focuses a button on right-press, so this is
              // usually the control that was right-clicked.
              focusRestore.setRestoreTarget(
                document.activeElement instanceof HTMLElement ? document.activeElement : null
              );
            }
            onOpenChange?.(next);
          }}
          {...rest}
        >
          {children}
        </Root>
      </OverlayFocusRestoreContext.Provider>
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

/* Same highlighted-row focus ring as the dropdown-menu primitives: Radix's
 * `data-[highlighted]` fill is too low-contrast to be the indicator, so keyboard
 * focus draws an inset `selection-outline` ring. `outline-solid` is load-bearing —
 * `outline-hidden` sets `--tw-outline-style: none` and `outline-2` reads it back.
 */
const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.SubTrigger>,
  ContextMenuSubTriggerProps
>(({ className, inset, children, onPointerMove, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const SubTrigger = radix.ContextMenuPrimitive.SubTrigger;
  return (
    <SubTrigger
      ref={ref}
      className={cn(
        "flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-hidden transition-colors duration-150 ease-out data-[highlighted]:bg-overlay-highlight focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px] data-[state=open]:bg-overlay-highlight",
        inset && "pl-8",
        className
      )}
      {...props}
      onPointerMove={(event) => menuRowPointerMove(event, onPointerMove)}
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
      <BrandSurfaceReset>
        <SubContent
          ref={shadowRef}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          style={{
            transformOrigin: "var(--radix-context-menu-content-transform-origin)",
            ...style,
          }}
          className={cn(
            // Escapes the toolbar's drag region via the portal — see `.app-no-drag` (#12347).
            "app-no-drag",
            "relative z-[var(--z-popover)] min-w-[10rem] max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay p-1 text-text-primary",
            OVERLAY_MOTION_CLASS,
            className
          )}
          {...props}
          data-dock-popover-child={isDockPopoverChild ? "" : undefined}
        >
          {topShadow}
          {children}
          {bottomShadow}
        </SubContent>
      </BrandSurfaceReset>
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
>(
  (
    {
      className,
      collisionPadding = 8,
      children,
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
    const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays(ref);
    const isDockPopoverChild = useIsDockPopoverChild();
    const focusRestore = useOverlayFocusRestore();

    // Shared close-time focus policy (see `overlay-focus-restore.ts`).
    const handlePointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
      onPointerDown?.(event);
      focusRestore?.onContentPointerDown();
    };
    const handlePointerDownOutside: NonNullable<ContextMenuContentProps["onPointerDownOutside"]> = (
      event
    ) => {
      onPointerDownOutside?.(event);
      focusRestore?.onContentPointerDownOutside();
    };
    const handleInteractOutside: NonNullable<ContextMenuContentProps["onInteractOutside"]> = (
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
    const handleCloseAutoFocus: NonNullable<ContextMenuContentProps["onCloseAutoFocus"]> = (
      event
    ) => {
      onCloseAutoFocus?.(event);
      focusRestore?.onContentCloseAutoFocus(event);
    };

    if (!radix) return null;
    const Portal = radix.ContextMenuPrimitive.Portal;
    const Content = radix.ContextMenuPrimitive.Content;
    return (
      <Portal>
        {/* Context reaches through a portal even though the DOM does not, so a
            menu opened from the toolbar would otherwise measure its brand marks
            against the toolbar's surface instead of this floating one. */}
        <BrandSurfaceReset>
          <Content
            ref={shadowRef}
            collisionPadding={collisionPadding}
            style={{
              transformOrigin: "var(--radix-context-menu-content-transform-origin)",
              ...style,
            }}
            className={cn(
              // Escapes the toolbar's drag region via the portal — see `.app-no-drag` (#12347).
              "app-no-drag",
              "relative z-[var(--z-popover)] min-w-[10rem] max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto rounded-[var(--radius-lg)] surface-overlay shadow-overlay p-1 text-text-primary",
              OVERLAY_MOTION_CLASS,
              className
            )}
            {...props}
            onPointerDown={handlePointerDown}
            onPointerDownOutside={handlePointerDownOutside}
            onInteractOutside={handleInteractOutside}
            onKeyDown={handleKeyDown}
            onClick={handleClick}
            onCloseAutoFocus={handleCloseAutoFocus}
            data-dock-popover-child={isDockPopoverChild ? "" : undefined}
          >
            {topShadow}
            {children}
            {bottomShadow}
          </Content>
        </BrandSurfaceReset>
      </Portal>
    );
  }
);
ContextMenuContent.displayName = "ContextMenuContent";

interface ContextMenuShortcutProps {
  /** The canonical combo (`"Cmd+Shift+P"`), never a pre-formatted display string. */
  shortcut: string | null | undefined;
  className?: string;
}

/* The trailing key column, drawn by `KbdChord` like every other shortcut in the
 * app, bare because every row of a menu can carry one. `aria-hidden`: the glyph
 * run is not part of the item's name (WCAG 2.5.3) — the item carries the keys
 * as `aria-keyshortcuts` instead. */
const ContextMenuShortcut = ({ shortcut, className }: ContextMenuShortcutProps) => {
  if (!shortcut || !shortcut.trim()) return null;
  return (
    <span aria-hidden="true" className={cn("ml-auto shrink-0 pl-4", className)}>
      <KbdChord shortcut={shortcut} density="bare" />
    </span>
  );
};
ContextMenuShortcut.displayName = "ContextMenuShortcut";

type ContextMenuItemProps = React.ComponentPropsWithoutRef<typeof ContextMenuPrimitiveType.Item> & {
  inset?: boolean;
  destructive?: boolean;
  /**
   * The action whose live binding this row shows. Draws it in the trailing key
   * column and sets `aria-keyshortcuts` from the same combo, so the visible
   * keys and the announced ones cannot drift apart. Draws nothing when the
   * action is unbound.
   */
  keybinding?: string;
};

const ContextMenuItemBase = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Item>,
  Omit<ContextMenuItemProps, "keybinding">
>(({ className, inset, destructive, onPointerMove, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Item = radix.ContextMenuPrimitive.Item;
  return (
    <Item
      ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-hidden transition-colors duration-150 ease-out data-[highlighted]:bg-overlay-highlight focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        destructive &&
          "text-status-danger data-[highlighted]:text-status-danger data-[highlighted]:bg-status-danger/10",
        className
      )}
      {...props}
      onPointerMove={(event) => menuRowPointerMove(event, onPointerMove)}
    />
  );
});
ContextMenuItemBase.displayName = "ContextMenuItemBase";

/* A row that shows an action's binding. Its own component so only rows that
 * carry one subscribe to keybinding changes. */
const ContextMenuKeyboundItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Item>,
  Omit<ContextMenuItemProps, "keybinding"> & { keybinding: string }
>(({ keybinding, children, ...props }, ref) => {
  const combo = useEffectiveCombo(keybinding);
  const ariaKeyshortcuts = useAriaKeyshortcuts(keybinding);
  return (
    <ContextMenuItemBase ref={ref} aria-keyshortcuts={ariaKeyshortcuts} {...props}>
      {/* Slottable: with `asChild` the child stays the slotted element and the
          key column is appended inside it, not beside it. */}
      <Slottable>{children}</Slottable>
      <ContextMenuShortcut shortcut={combo} />
    </ContextMenuItemBase>
  );
});
ContextMenuKeyboundItem.displayName = "ContextMenuKeyboundItem";

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.Item>,
  ContextMenuItemProps
>(({ keybinding, ...props }, ref) =>
  keybinding ? (
    <ContextMenuKeyboundItem ref={ref} keybinding={keybinding} {...props} />
  ) : (
    <ContextMenuItemBase ref={ref} {...props} />
  )
);
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
  const ariaKeyshortcuts = useAriaKeyshortcuts(actionId);

  const handleSelect: React.ComponentPropsWithoutRef<
    typeof ContextMenuPrimitiveType.Item
  >["onSelect"] = (event) => {
    onSelect?.(event);
    if (event.defaultPrevented) return;
    void actionService.dispatch(actionId, args, { ...dispatchOptions, source });
  };

  return (
    <ContextMenuItem
      ref={ref}
      onSelect={handleSelect}
      disabled={disabled}
      {...props}
      aria-keyshortcuts={ariaKeyshortcuts}
    />
  );
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
      className={cn(LIST_LABEL_CLASS, "px-2.5 py-1.5", inset && "pl-8", className)}
      {...props}
    />
  );
});
ContextMenuLabel.displayName = "ContextMenuLabel";

/* Trailing muted slot for item METADATA — a count, a state, a reason an item is
 * disabled. Deliberately not `ContextMenuShortcut`: a count is not a keybinding,
 * and rendering it in the shortcut's mono face reads as one. Non-mono, and
 * `aria-hidden` by default because the number belongs in the item's accessible
 * name (callers pass one), not as a second stray string after it. */
const ContextMenuMeta = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return (
    <span
      aria-hidden="true"
      className={cn("ml-auto pl-2 text-2xs text-text-secondary tabular-nums", className)}
      {...props}
    />
  );
};
ContextMenuMeta.displayName = "ContextMenuMeta";

type ContextMenuCheckboxItemProps = React.ComponentPropsWithoutRef<
  typeof ContextMenuPrimitiveType.CheckboxItem
>;

const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitiveType.CheckboxItem>,
  ContextMenuCheckboxItemProps
>(({ className, children, checked, onPointerMove, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const CheckboxItem = radix.ContextMenuPrimitive.CheckboxItem;
  const ItemIndicator = radix.ContextMenuPrimitive.ItemIndicator;
  return (
    <CheckboxItem
      ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2.5 text-xs outline-hidden transition-colors duration-150 ease-out data-[highlighted]:bg-overlay-highlight focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      checked={checked}
      {...props}
      onPointerMove={(event) => menuRowPointerMove(event, onPointerMove)}
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
>(({ className, children, onPointerMove, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const RadioItem = radix.ContextMenuPrimitive.RadioItem;
  const ItemIndicator = radix.ContextMenuPrimitive.ItemIndicator;
  return (
    <RadioItem
      ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2.5 text-xs outline-hidden transition-colors duration-150 ease-out data-[highlighted]:bg-overlay-highlight focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
      onPointerMove={(event) => menuRowPointerMove(event, onPointerMove)}
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

/**
 * Keeps a nested trigger's right-click from reaching an enclosing trigger.
 *
 * A right-click menu belongs to the object under the pointer. Radix's trigger
 * calls `preventDefault()` but never `stopPropagation()`, so a tab inside a
 * panel's trigger, or a row inside a card's, lets the event carry on to the
 * enclosing one. Pass this as the inner trigger's `onContextMenu`. It must not
 * call `preventDefault()`: Radix runs it ahead of its own handler and skips that
 * handler when the default is already prevented, so the inner menu would never
 * open.
 */
function stopContextMenuPropagation(event: React.MouseEvent): void {
  event.stopPropagation();
}

export {
  stopContextMenuPropagation,
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
  ContextMenuMeta,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
};
