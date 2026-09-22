import * as React from "react";
import type * as SelectPrimitiveType from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { OVERLAY_MOTION_CLASS } from "./overlayMotion";
import { composeHandlers, primeOnEvent, useRadixPrimitives } from "./radix-loader";
import { useIsDockPopoverChild } from "./DockPopoverChildContext";
import { menuRowPointerMove } from "./menu-row-hover-focus";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";

const SelectIntentContext = React.createContext<((next: boolean) => void) | null>(null);
/**
 * The root's `disabled`, for the pre-Radix trigger. Radix reads it off the root,
 * but the stand-in trigger is a plain button that would otherwise stay clickable
 * and queue an open that fires, options and all, once Radix arrives.
 */
const SelectDisabledContext = React.createContext(false);

type SelectRootProps = React.ComponentProps<typeof SelectPrimitiveType.Root>;

const Select = ({ children, open, defaultOpen, onOpenChange, ...rest }: SelectRootProps) => {
  const radix = useRadixPrimitives();
  const [pendingOpen, setPendingOpen] = React.useState<boolean | undefined>(undefined);
  const isControlled = open !== undefined;
  const disabled = rest.disabled === true;

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
      <SelectDisabledContext.Provider value={disabled}>
        <SelectIntentContext.Provider value={requestOpen}>{children}</SelectIntentContext.Provider>
      </SelectDisabledContext.Provider>
    );
  }

  const Root = radix.SelectPrimitive.Root;
  // An open queued while the root was enabled is dropped if it has since been
  // disabled — Radix honours `defaultOpen` on a disabled root.
  const effectiveDefaultOpen =
    isControlled || disabled ? defaultOpen : (pendingOpen ?? defaultOpen);
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
Select.displayName = "Select";

type SelectGroupProps = React.ComponentPropsWithoutRef<typeof SelectPrimitiveType.Group>;

const SelectGroup = (props: SelectGroupProps) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Group = radix.SelectPrimitive.Group;
  return <Group {...props} />;
};
SelectGroup.displayName = "SelectGroup";

type SelectValueProps = React.ComponentPropsWithoutRef<typeof SelectPrimitiveType.Value>;

const SelectValue = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.Value>,
  SelectValueProps
>((props, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) {
    return <span>{props.placeholder as React.ReactNode}</span>;
  }
  const Value = radix.SelectPrimitive.Value;
  return <Value ref={ref} {...props} />;
});
SelectValue.displayName = "SelectValue";

type SelectTriggerProps = React.ComponentPropsWithoutRef<typeof SelectPrimitiveType.Trigger>;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.Trigger>,
  SelectTriggerProps
>(({ className, children, ...props }, ref) => {
  const radix = useRadixPrimitives();
  const requestOpen = React.useContext(SelectIntentContext);
  const rootDisabled = React.useContext(SelectDisabledContext);

  const primingHandlers = {
    onPointerEnter: composeHandlers(primeOnEvent, props.onPointerEnter),
    onPointerDown: composeHandlers(primeOnEvent, props.onPointerDown),
    onFocusCapture: composeHandlers(primeOnEvent, props.onFocusCapture),
  };

  if (!radix) {
    const intentClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      primeOnEvent();
      requestOpen?.(true);
      props.onClick?.(event);
    };
    return (
      <button
        type="button"
        ref={ref as React.Ref<HTMLButtonElement>}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas px-3 py-1.5 text-sm text-text-primary transition-colors",
          // Full accent, not /40: the recipe in docs/themes/interaction-state-recipes.md
          // is "border-shift, no ring", and at 40% alpha the focused border was 1.58:1
          // against the resting one — a focus indicator you cannot see is not one.
          "focus:outline-hidden focus:border-accent-primary",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          className
        )}
        {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        {...primingHandlers}
        disabled={props.disabled === true || rootDisabled}
        onClick={intentClick}
      >
        {children}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      </button>
    );
  }

  const Trigger = radix.SelectPrimitive.Trigger;
  const Icon = radix.SelectPrimitive.Icon;
  return (
    <Trigger
      ref={ref}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas px-3 py-1.5 text-sm text-text-primary transition-colors",
        "focus:outline-hidden focus:border-accent-primary",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        // `text-text-secondary`, not `text-muted`: a placeholder is the only
        // thing naming an unset control, and `text-muted` has no dark-theme
        // contrast floor (2.22:1 on namib, 2.50:1 on redwoods).
        "data-[placeholder]:text-text-secondary",
        "[&>span]:line-clamp-1 [&>span]:text-left",
        className
      )}
      {...props}
      {...primingHandlers}
    >
      {children}
      <Icon asChild>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform in-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </Icon>
    </Trigger>
  );
});
SelectTrigger.displayName = "SelectTrigger";

type SelectScrollUpButtonProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitiveType.ScrollUpButton
>;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.ScrollUpButton>,
  SelectScrollUpButtonProps
>(({ className, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const ScrollUpButton = radix.SelectPrimitive.ScrollUpButton;
  return (
    <ScrollUpButton
      ref={ref}
      className={cn("flex cursor-pointer items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronUp className="h-4 w-4" aria-hidden="true" />
    </ScrollUpButton>
  );
});
SelectScrollUpButton.displayName = "SelectScrollUpButton";

type SelectScrollDownButtonProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitiveType.ScrollDownButton
>;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.ScrollDownButton>,
  SelectScrollDownButtonProps
>(({ className, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const ScrollDownButton = radix.SelectPrimitive.ScrollDownButton;
  return (
    <ScrollDownButton
      ref={ref}
      className={cn("flex cursor-pointer items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronDown className="h-4 w-4" aria-hidden="true" />
    </ScrollDownButton>
  );
});
SelectScrollDownButton.displayName = "SelectScrollDownButton";

type SelectContentProps = React.ComponentPropsWithoutRef<typeof SelectPrimitiveType.Content>;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.Content>,
  SelectContentProps
>(
  (
    {
      className,
      children,
      position = "popper",
      sideOffset = 4,
      onEscapeKeyDown,
      onCloseAutoFocus,
      style,
      ...props
    },
    ref
  ) => {
    const radix = useRadixPrimitives();
    const isDockPopoverChild = useIsDockPopoverChild();
    if (!radix) return null;
    const Portal = radix.SelectPrimitive.Portal;
    const Content = radix.SelectPrimitive.Content;
    const Viewport = radix.SelectPrimitive.Viewport;
    return (
      <Portal>
        <Content
          ref={ref}
          position={position}
          sideOffset={sideOffset}
          onEscapeKeyDown={(event) => {
            event.stopPropagation();
            onEscapeKeyDown?.(event);
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            // Radix returns focus to the trigger here with a bare `.focus()`,
            // which opens any tooltip that trigger carries. A select's focus
            // policy is otherwise left alone — returning to the trigger is what
            // a combobox is supposed to do — so only the tooltip is suppressed.
            armTooltipFocusSuppression();
          }}
          style={{ transformOrigin: "var(--radix-select-content-transform-origin)", ...style }}
          className={cn(
            // Escapes the toolbar's drag region via the portal — see `.app-no-drag` (#12347).
            "app-no-drag",
            "relative z-[var(--z-popover)] overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay text-text-primary",
            OVERLAY_MOTION_CLASS,
            position === "popper" &&
              "min-w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)]",
            className
          )}
          {...props}
          data-dock-popover-child={isDockPopoverChild ? "" : undefined}
        >
          <SelectScrollUpButton />
          <Viewport
            className={cn(
              "p-1",
              position === "popper" && "h-[var(--radix-select-trigger-height)] w-full"
            )}
          >
            {children}
          </Viewport>
          <SelectScrollDownButton />
        </Content>
      </Portal>
    );
  }
);
SelectContent.displayName = "SelectContent";

type SelectLabelProps = React.ComponentPropsWithoutRef<typeof SelectPrimitiveType.Label>;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.Label>,
  SelectLabelProps
>(({ className, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Label = radix.SelectPrimitive.Label;
  return (
    <Label
      ref={ref}
      className={cn(
        "px-2.5 py-1.5 text-2xs font-bold tracking-wider uppercase text-text-secondary",
        className
      )}
      {...props}
    />
  );
});
SelectLabel.displayName = "SelectLabel";

interface SelectItemProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitiveType.Item> {
  description?: React.ReactNode;
}

/* Same highlighted-row focus ring as the dropdown-menu primitives: Radix's
 * `data-[highlighted]` fill is too low-contrast to be the indicator, so keyboard
 * focus draws an inset `selection-outline` ring. `outline-solid` is load-bearing —
 * `outline-hidden` sets `--tw-outline-style: none` and `outline-2` reads it back.
 */
const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.Item>,
  SelectItemProps
>(({ className, children, description, onPointerMove, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Item = radix.SelectPrimitive.Item;
  const ItemIndicator = radix.SelectPrimitive.ItemIndicator;
  const ItemText = radix.SelectPrimitive.ItemText;
  return (
    <Item
      ref={ref}
      className={cn(
        "relative flex w-full cursor-pointer select-none items-start rounded-[var(--radius-sm)] py-1.5 pl-8 pr-2.5 text-xs outline-hidden transition-colors",
        "data-[highlighted]:bg-overlay-raised focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-[-2px]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
      onPointerMove={(event) => menuRowPointerMove(event, onPointerMove)}
    >
      <span className="absolute left-2 top-1.5 flex h-3.5 w-3.5 items-center justify-center">
        <ItemIndicator>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </ItemIndicator>
      </span>
      {/* `min-w-0` on the text column: as a flex child it otherwise takes its
          content width as a floor (`min-width: auto`), so a long label runs out
          past the popup's padding and is cut by the edge with no ellipsis, and
          a descendant's `truncate` never gets the chance to fire.

          It lifts that floor unconditionally — not only where something asks to
          truncate — so under enough constraint non-truncating content can wrap
          where it previously overflowed. That is the better failure of the two,
          and no current consumer is constrained enough to meet it.

          No `flex-1`: the default `flex-shrink: 1` is what does the work here,
          and filling surplus width buys nothing. No `truncate` on the
          description either — those are full sentences across the settings tabs
          and are meant to wrap. */}
      {description ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <ItemText>{children}</ItemText>
          <span className="text-2xs text-text-secondary">{description}</span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-col">
          <ItemText>{children}</ItemText>
        </span>
      )}
    </Item>
  );
});
SelectItem.displayName = "SelectItem";

type SelectSeparatorProps = React.ComponentPropsWithoutRef<typeof SelectPrimitiveType.Separator>;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.Separator>,
  SelectSeparatorProps
>(({ className, ...props }, ref) => {
  const radix = useRadixPrimitives();
  if (!radix) return null;
  const Separator = radix.SelectPrimitive.Separator;
  return (
    <Separator
      ref={ref}
      className={cn("-mx-1 my-1 h-px bg-border-divider", className)}
      {...props}
    />
  );
});
SelectSeparator.displayName = "SelectSeparator";

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
