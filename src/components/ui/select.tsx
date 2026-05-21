import * as React from "react";
import type * as SelectPrimitiveType from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { composeHandlers, primeOnEvent, useRadixPrimitives } from "./radix-loader";
import { useIsDockPopoverChild } from "./DockPopoverChildContext";

const SelectIntentContext = React.createContext<((next: boolean) => void) | null>(null);

type SelectRootProps = React.ComponentProps<typeof SelectPrimitiveType.Root>;

const Select = ({ children, open, defaultOpen, onOpenChange, ...rest }: SelectRootProps) => {
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
      <SelectIntentContext.Provider value={requestOpen}>{children}</SelectIntentContext.Provider>
    );
  }

  const Root = radix.SelectPrimitive.Root;
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
          "flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-1.5 text-sm text-daintree-text transition-colors",
          "focus:outline-hidden focus:border-daintree-accent",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          className
        )}
        {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        {...primingHandlers}
        onClick={intentClick}
      >
        {children}
        <ChevronDown className="h-4 w-4 shrink-0 text-daintree-text/50" aria-hidden="true" />
      </button>
    );
  }

  const Trigger = radix.SelectPrimitive.Trigger;
  const Icon = radix.SelectPrimitive.Icon;
  return (
    <Trigger
      ref={ref}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-1.5 text-sm text-daintree-text transition-colors",
        "focus:outline-hidden focus:border-daintree-accent",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "data-[placeholder]:text-text-muted",
        "[&>span]:line-clamp-1 [&>span]:text-left",
        className
      )}
      {...props}
      {...primingHandlers}
    >
      {children}
      <Icon asChild>
        <ChevronDown className="h-4 w-4 shrink-0 text-daintree-text/50" aria-hidden="true" />
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
    { className, children, position = "popper", sideOffset = 4, onEscapeKeyDown, style, ...props },
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
          style={{ transformOrigin: "var(--radix-select-content-transform-origin)", ...style }}
          className={cn(
            "relative z-[var(--z-popover)] overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay text-daintree-text",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-[120ms] data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
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
        "px-2 py-1.5 text-[11px] font-bold tracking-wider uppercase text-daintree-text/50",
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

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitiveType.Item>,
  SelectItemProps
>(({ className, children, description, ...props }, ref) => {
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
        "focus:bg-overlay-emphasis data-[highlighted]:bg-overlay-emphasis",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <span className="absolute left-2 top-1.5 flex h-3.5 w-3.5 items-center justify-center">
        <ItemIndicator>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </ItemIndicator>
      </span>
      {description ? (
        <span className="flex flex-col gap-0.5">
          <ItemText>{children}</ItemText>
          <span className="text-[11px] text-daintree-text/40">{description}</span>
        </span>
      ) : (
        <ItemText>{children}</ItemText>
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
