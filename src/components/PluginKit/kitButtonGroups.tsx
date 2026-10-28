import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type {
  PluginSplitButtonProps,
  PluginToggleGroupProps,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuMeta,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu-base";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { renderMenuEntries, type KitMenuParts } from "./kitMenu";
import {
  ALIGNS,
  SIDES,
  content,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  PluginStyleScope,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { renderIconSource } from "./PluginKitIcons";
import { focusLeft, useKitFocusScope } from "./kitField";

interface ToggleEntry {
  value: string;
  label: string | undefined;
  icon: unknown;
  ariaLabel: string | undefined;
  tooltip: ReactNode;
  disabled: boolean;
}

function readToggleItems(items: unknown): ToggleEntry[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: ToggleEntry[] = [];
  for (const entry of items as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = nonEmpty(field(entry, "value"));
    const label = nonEmpty(field(entry, "label"));
    const icon = field(entry, "icon");
    const ariaLabel = nonEmpty(field(entry, "aria-label"));
    // Something has to say what the button is.
    if (
      value === undefined ||
      seen.has(value) ||
      (label === undefined && ariaLabel === undefined)
    ) {
      continue;
    }
    seen.add(value);
    out.push({
      value,
      label,
      icon,
      ariaLabel,
      tooltip: content(field(entry, "tooltip")),
      disabled: field(entry, "disabled") === true,
    });
  }
  return out;
}

function readValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

// Drawn as Daintree's own weekday picker (Notification settings) draws its
// days: subtle buttons, so every choice has an edge whether on or off, with
// the kit Button's one pressed look (`pressed`) on the ones that are on. Its
// secondary-ink edge clears 3:1 in either polarity, so "on" never leans on
// the fill alone.
const TOGGLE_SIZE = {
  default: { text: "sm", icon: "icon-sm" },
  compact: { text: "xs", icon: "icon-xs" },
} as const;

function inToolbar(group: Element): boolean {
  return group.parentElement?.closest('[role="toolbar"]') != null;
}

export function KitToggleGroup(props: PluginToggleGroupProps) {
  const { items, type, value, defaultValue, onValueChange, disabled, invalid, density, className } =
    props;
  const onBlur = fn(props.onBlur);
  const entries = readToggleItems(items);
  const single = type === "single";
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState<string[]>(() => readValues(defaultValue));
  const known = new Set(entries.map((entry) => entry.value));
  const knownOn = (controlled ? readValues(value) : own).filter((entry) => known.has(entry));
  // At most one is on in single mode, whatever was handed in.
  const on = single ? knownOn.slice(0, 1) : knownOn;
  const onChange = fn(onValueChange);
  const inert = disabled === true;
  const sizes = TOGGLE_SIZE[density === "compact" ? "compact" : "default"];
  const groupRef = useRef<HTMLDivElement>(null);
  const focusScope = useKitFocusScope();
  const overlayZ = useKitOverlayZClass();
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);

  const enabled = entries.flatMap((entry, index) => (entry.disabled || inert ? [] : [index]));
  const firstOn = entries.findIndex((entry) => on.includes(entry.value) && !entry.disabled);
  const stop =
    cursor !== null && enabled.includes(cursor) ? cursor : firstOn >= 0 ? firstOn : enabled[0];
  // The one tab stop, set on the buttons directly rather than rendered: inside
  // a Toolbar the toolbar's own roving owns the stops, and a rendered tabIndex
  // would take back the ones it set.
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group || inToolbar(group)) return;
    buttonRefs.current.forEach((button, index) => {
      if (button) button.tabIndex = index === stop ? 0 : -1;
    });
  });

  const toggle = (entry: ToggleEntry) => {
    const pressed = on.includes(entry.value);
    const next = single
      ? pressed
        ? []
        : [entry.value]
      : entries
          .map((item) => item.value)
          .filter((item) => (item === entry.value ? !pressed : on.includes(item)));
    if (!controlled) setOwn(next);
    onChange?.(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (inToolbar(event.currentTarget) || enabled.length === 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const from = buttonRefs.current.findIndex((el) => el === document.activeElement);
    const at = enabled.indexOf(from);
    let target: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      target = enabled[(at + 1) % enabled.length];
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      target = enabled[(at - 1 + enabled.length) % enabled.length];
    } else if (event.key === "Home") {
      target = enabled[0];
    } else if (event.key === "End") {
      target = enabled[enabled.length - 1];
    }
    if (target === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    setCursor(target);
    buttonRefs.current[target]?.focus();
  };

  return (
    <div
      {...pickRootProps(props, { aria: true })}
      ref={groupRef}
      role="group"
      aria-label={str(props["aria-label"]) ?? ""}
      aria-disabled={inert || undefined}
      aria-invalid={invalid === true || undefined}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (focusLeft(event, focusScope.id)) onBlur?.();
      }}
      data-slot="toggle-group"
      className={cn("inline-flex shrink-0 flex-wrap items-center gap-2", str(className))}
    >
      {entries.map((entry, index) => {
        const pressed = on.includes(entry.value);
        const glyph = renderIconSource(entry.icon);
        const iconOnly = entry.label === undefined;
        const button = (
          <Button
            key={entry.value}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            variant="subtle"
            size={iconOnly ? sizes.icon : sizes.text}
            pressed={pressed}
            aria-label={entry.ariaLabel}
            disabled={inert || entry.disabled}
            onFocus={() => setCursor(index)}
            onClick={() => toggle(entry)}
            className="[&_svg]:size-3.5"
          >
            {glyph}
            {entry.label}
          </Button>
        );
        const tip = hasContent(entry.tooltip) ? entry.tooltip : iconOnly ? entry.ariaLabel : null;
        if (!hasContent(tip)) return button;
        return (
          <Tooltip key={entry.value}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="bottom" className={overlayZ}>
              <PluginStyleScope>{node(tip)}</PluginStyleScope>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

const SPLIT_MENU_PARTS: KitMenuParts = {
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Item: DropdownMenuItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Meta: DropdownMenuMeta,
};

const SPLIT_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "subtle",
  "contrast",
  "destructive",
  "ghost-danger",
] as const;

type SplitVariant = (typeof SPLIT_VARIANTS)[number];

// The seam between the halves. A filled button draws it in its own label ink
// at half strength, which keeps it near 3:1 against the fill in either
// polarity, so the two halves read as two targets; a ringed one lets the two
// rings meet as one hairline; a ghost one, with no edge of its own, takes the
// subtle border.
const SPLIT_SEAM: Record<SplitVariant, string> = {
  default: "border-l border-l-[color-mix(in_oklab,currentColor_50%,transparent)]",
  destructive: "border-l border-l-[color-mix(in_oklab,currentColor_50%,transparent)]",
  contrast: "border-l border-l-[color-mix(in_oklab,currentColor_50%,transparent)]",
  secondary: "border-l border-l-[color-mix(in_oklab,currentColor_40%,transparent)]",
  outline: "-ml-px",
  subtle: "-ml-px",
  ghost: "border-l border-l-border-subtle",
  "ghost-danger": "border-l border-l-border-subtle",
};

const SPLIT_CHEVRON_WIDTH = { default: "w-7", lg: "w-8", sm: "w-6", xs: "w-5" } as const;

export function KitSplitButton({
  children,
  onClick,
  items,
  variant,
  size,
  icon,
  loading,
  disabled,
  menuDisabled,
  type,
  menuLabel,
  side,
  align,
  className,
  ...rest
}: PluginSplitButtonProps) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const tone = oneOf(variant, SPLIT_VARIANTS) ?? "default";
  const sizeKey = oneOf(size, ["default", "sm", "xs", "lg"] as const) ?? "default";
  const busy = loading === true;
  const inert = disabled === true;
  const handleClick = fn(onClick);
  const moreLabel = nonEmpty(menuLabel) ?? "More options";
  const entries = Array.isArray(items) ? items : [];
  return (
    <div
      {...pickRootProps(rest)}
      role="group"
      data-slot="split-button"
      className={cn("isolate inline-flex shrink-0 items-stretch", str(className))}
    >
      <Button
        variant={tone}
        size={sizeKey}
        loading={busy}
        disabled={inert}
        type={type === "submit" ? "submit" : "button"}
        onClick={() => handleClick?.()}
        className="rounded-r-none focus-visible:z-10"
      >
        {renderIconSource(icon)}
        {node(children)}
      </Button>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant={tone}
                size={sizeKey}
                disabled={inert || busy || menuDisabled === true || entries.length === 0}
                aria-label={moreLabel}
                className={cn(
                  "rounded-l-none px-0 focus-visible:z-10 data-[state=open]:z-10",
                  SPLIT_CHEVRON_WIDTH[sizeKey],
                  SPLIT_SEAM[tone]
                )}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className={overlayZ}>
            {moreLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          {...owner}
          className={overlayZ}
          side={oneOf(side, SIDES)}
          align={oneOf(align, ALIGNS) ?? "end"}
          aria-label={moreLabel}
        >
          {renderMenuEntries(SPLIT_MENU_PARTS, entries)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
