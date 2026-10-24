import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Pipette } from "lucide-react";
import { HexColorPicker } from "react-colorful";
import type {
  PluginColorPickerProps,
  PluginColorSwatchProps,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { inputVariants } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { selectTriggerVariants } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useDaintreeTheme } from "@/pluginUi/theme";
import {
  CATEGORY_SWATCH_KEYS,
  categorySwatchName,
  hexToHsl,
  normalizeHex,
  parseColorText,
} from "./kitColor";
import {
  ALIGNS,
  SIDES,
  field,
  fn,
  nonEmpty,
  oneOf,
  pickDomProps,
  pickRootProps,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import "./kitColorArea.css";
import { invalidProp, useKitFieldControl, focusLeft, useKitFocusScope } from "./kitField";

const SWATCH_SIZE = { xs: "size-3", sm: "size-4", md: "size-5", lg: "size-6" } as const;

// The chip's edge is the strong border ink, so white on a light pane and
// near-black on a dark one both keep their outline. A chosen chip adds a
// primary-ink ring outside a gap in the pane's colour, the selection ring of
// the host's own colour pickers, never accent: accent is the focus ring's.
const SWATCH_CHIP =
  "relative inline-block shrink-0 border border-border-strong bg-clip-padding align-middle";
const SWATCH_SELECTED =
  "outline outline-2 outline-offset-2 outline-text-primary focus-visible:outline-accent-primary";
const SWATCH_BUTTON =
  "cursor-pointer transition-transform duration-150 ease-out hover:scale-110 motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary disabled:cursor-not-allowed disabled:opacity-50";

// An empty chip: a diagonal rule through the strong border, the "no colour" mark.
const EMPTY_SWATCH_STYLE: CSSProperties = {
  backgroundImage:
    "linear-gradient(to top right, transparent calc(50% - 0.5px), var(--color-border-strong) calc(50% - 0.5px), var(--color-border-strong) calc(50% + 0.5px), transparent calc(50% + 0.5px))",
};

export function KitColorSwatch({
  color,
  size,
  shape,
  selected,
  "aria-label": ariaLabel,
  disabled,
  className,
  ...rest
}: PluginColorSwatchProps) {
  const hex = normalizeHex(color);
  const sizeClass = SWATCH_SIZE[oneOf(size, ["xs", "sm", "md", "lg"] as const) ?? "sm"];
  const shapeClass = shape === "square" ? "rounded-[var(--radius-xs)]" : "rounded-full";
  const name = nonEmpty(ariaLabel) ?? (hex ? hex.toUpperCase() : "No colour");
  const style = hex ? { backgroundColor: hex } : EMPTY_SWATCH_STYLE;
  const dom = pickDomProps(rest);
  const chipClass = cn(
    SWATCH_CHIP,
    sizeClass,
    shapeClass,
    selected === true && SWATCH_SELECTED,
    str(className)
  );
  // A trigger (a Popover or DropdownMenu hands its child an onClick) is a button.
  if (typeof dom.onClick === "function") {
    return (
      <button
        type="button"
        {...dom}
        aria-label={name}
        aria-pressed={typeof selected === "boolean" ? selected : undefined}
        disabled={disabled === true}
        data-slot="color-swatch"
        className={cn(chipClass, SWATCH_BUTTON)}
        style={{ ...style, ...(typeof dom.style === "object" ? dom.style : null) }}
      />
    );
  }
  return (
    <span
      {...dom}
      role="img"
      aria-label={name}
      data-slot="color-swatch"
      className={cn(chipClass, disabled === true && "opacity-50")}
      style={{ ...style, ...(typeof dom.style === "object" ? dom.style : null) }}
    />
  );
}

interface SwatchEntry {
  value: string;
  label: string;
}

function readSwatches(value: unknown): SwatchEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: SwatchEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const raw = typeof entry === "object" && entry !== null ? field(entry, "value") : entry;
    const hex = normalizeHex(raw);
    if (hex === null || seen.has(hex)) continue;
    seen.add(hex);
    const label =
      typeof entry === "object" && entry !== null ? nonEmpty(field(entry, "label")) : undefined;
    out.push({ value: hex, label: label ?? hex.toUpperCase() });
  }
  return out;
}

/** The theme's category ramp as swatches, each named for its hue. */
function useCategorySwatches(): SwatchEntry[] {
  const { tokens } = useDaintreeTheme();
  const out: SwatchEntry[] = [];
  const seen = new Set<string>();
  for (const key of CATEGORY_SWATCH_KEYS) {
    const hex = normalizeHex(tokens[key]);
    if (hex === null || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ value: hex, label: categorySwatchName(key) });
  }
  return out;
}

const SWATCH_COLUMNS = 6;

/**
 * The palette: a radio group of chips in rows of six, one tab stop, arrows
 * moving the choice in two dimensions as a grid of radios does.
 */
function SwatchGrid({
  swatches,
  value,
  onPick,
}: {
  swatches: SwatchEntry[];
  value: string | null;
  /** `close` for a press on a chip; an arrow key only moves the choice. */
  onPick: (hex: string, close: boolean) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = swatches.findIndex((swatch) => swatch.value === value);
  const [cursor, setCursor] = useState(chosen >= 0 ? chosen : 0);
  const stop = chosen >= 0 ? chosen : Math.min(cursor, swatches.length - 1);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = refs.current.findIndex((el) => el === document.activeElement);
    if (from < 0) return;
    const last = swatches.length - 1;
    const steps: Record<string, number> = {
      ArrowRight: from + 1,
      ArrowLeft: from - 1,
      ArrowDown: from + SWATCH_COLUMNS,
      ArrowUp: from - SWATCH_COLUMNS,
      Home: 0,
      End: last,
    };
    const target = steps[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = (target + swatches.length) % swatches.length;
    setCursor(next);
    refs.current[next]?.focus();
    onPick(swatches[next]!.value, false);
  };
  return (
    <div role="radiogroup" aria-label="Colours" onKeyDown={move} className="grid grid-cols-6 gap-2">
      {swatches.map((swatch, index) => {
        const checked = swatch.value === value;
        return (
          <button
            key={swatch.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={swatch.label}
            tabIndex={index === stop ? 0 : -1}
            onClick={() => onPick(swatch.value, true)}
            data-slot="color-swatch"
            className={cn(
              SWATCH_CHIP,
              SWATCH_BUTTON,
              "size-6 rounded-full",
              checked && SWATCH_SELECTED
            )}
            style={{ backgroundColor: swatch.value }}
          >
            {checked ? (
              <Check
                aria-hidden="true"
                strokeWidth={3}
                className="absolute inset-0 m-auto size-3.5"
                style={{ color: inkOn(swatch.value) }}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Black or white, whichever reads better on `hex`, for a check drawn on the chip. */
function inkOn(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Contrast with white against contrast with black, without the division.
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? "white" : "black";
}

interface EyeDropperResult {
  sRGBHex: string;
}

type EyeDropperConstructor = new () => { open: () => Promise<EyeDropperResult> };

function isEyeDropper(value: unknown): value is EyeDropperConstructor {
  return typeof value === "function";
}

/** The platform eyedropper's constructor, where there is one (Chromium has it). */
function eyeDropperConstructor(): EyeDropperConstructor | null {
  if (typeof window === "undefined") return null;
  const ctor: unknown = Reflect.get(window, "EyeDropper");
  return isEyeDropper(ctor) ? ctor : null;
}

// react-colorful draws the area and hue strip; kitColorArea.css puts them on
// the kit's radius and gives the pointers the Slider's thumb.
const COLOR_AREA_CLASS = "kit-color-area";

function ColorPanel({
  value,
  swatches,
  allowCustom,
  onChange,
  onPickSwatch,
}: {
  value: string | null;
  swatches: SwatchEntry[];
  allowCustom: boolean;
  onChange: (hex: string) => void;
  onPickSwatch: (hex: string, close: boolean) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [typedInvalid, setTypedInvalid] = useState(false);
  const hexErrorId = useId();
  const Dropper = eyeDropperConstructor();
  const hsl = value ? hexToHsl(value) : null;
  const commitText = () => {
    if (text === null) return;
    const parsed = parseColorText(text);
    if (parsed === null) {
      setTypedInvalid(true);
      return;
    }
    setText(null);
    setTypedInvalid(false);
    onChange(parsed);
  };
  return (
    <div className="grid w-60 gap-3">
      {swatches.length > 0 ? (
        <SwatchGrid swatches={swatches} value={value} onPick={onPickSwatch} />
      ) : null}
      {allowCustom ? (
        <>
          {swatches.length > 0 ? (
            <div className="h-px bg-border-subtle" aria-hidden="true" />
          ) : null}
          <HexColorPicker
            color={value ?? "#808080"}
            onChange={(next) => {
              const hex = normalizeHex(next);
              if (hex) onChange(hex);
            }}
            className={COLOR_AREA_CLASS}
          />
          <div className="flex items-center gap-2">
            <input
              type="text"
              aria-label="Hex, RGB or HSL colour"
              aria-invalid={typedInvalid || undefined}
              aria-describedby={typedInvalid ? hexErrorId : undefined}
              spellCheck={false}
              autoComplete="off"
              value={text ?? (value ? value.toUpperCase() : "")}
              placeholder="#RRGGBB"
              onChange={(event) => {
                setText(event.target.value);
                setTypedInvalid(false);
              }}
              onBlur={commitText}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitText();
                } else if (event.key === "Escape" && text !== null) {
                  event.preventDefault();
                  event.stopPropagation();
                  setText(null);
                  setTypedInvalid(false);
                }
              }}
              className={cn(
                inputVariants({ density: "compact" }),
                "min-w-0 flex-1 font-mono uppercase",
                typedInvalid && "border-status-error"
              )}
            />
            {hsl ? (
              <span
                className="shrink-0 text-2xs tabular-nums text-text-secondary"
                aria-label={`Hue ${hsl.h} degrees, saturation ${hsl.s} percent, lightness ${hsl.l} percent`}
              >
                {`${hsl.h}° ${hsl.s}% ${hsl.l}%`}
              </span>
            ) : null}
            {Dropper ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-text-secondary"
                aria-label="Pick a colour from the screen"
                onClick={() => {
                  void new Dropper()
                    .open()
                    .then((result) => {
                      const hex = normalizeHex(result.sRGBHex);
                      if (hex) onChange(hex);
                    })
                    .catch(() => {});
                }}
              >
                <Pipette aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          {typedInvalid ? (
            <InlineError id={hexErrorId}>Enter a hex, rgb() or hsl() colour</InlineError>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function KitColorPicker(props: PluginColorPickerProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    swatches,
    allowCustom,
    variant,
    placeholder,
    disabled,
    invalid,
    name,
    open,
    defaultOpen,
    onOpenChange,
    side,
    align,
    density,
    className,
  } = props;
  const onBlur = fn(props.onBlur);
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const themeSwatches = useCategorySwatches();
  const palette = readSwatches(swatches) ?? themeSwatches;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState<string | null>(() => normalizeHex(defaultValue));
  const current = controlled ? normalizeHex(value) : own;
  const controlledOpen = typeof open === "boolean" ? open : undefined;
  const [ownOpen, setOwnOpen] = useState(defaultOpen === true);
  const inert = disabled === true;
  // A picker disabled while open (say, during a save) takes its panel with it.
  const isOpen = (controlledOpen ?? ownOpen) && !inert;
  const onChange = fn(onValueChange);
  const onOpen = fn(onOpenChange);
  const { controlProps } = useKitFieldControl(props, invalidProp(invalid));
  const shownInvalid = controlProps["aria-invalid"] === true;
  const focusScope = useKitFocusScope();

  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpen?.(next);
    // Closing the panel is the end of an edit, as leaving a field is.
    if (!next) onBlur?.();
  };
  const onTriggerBlur = (event: ReactFocusEvent<HTMLElement>) => {
    if (!isOpen && focusLeft(event, focusScope.id)) onBlur?.();
  };
  const change = (hex: string) => {
    if (hex === current) return;
    if (!controlled) setOwn(hex);
    onChange?.(hex);
  };
  const spoken = current
    ? (palette.find((swatch) => swatch.value === current)?.label ?? current.toUpperCase())
    : undefined;

  const swatchOnly = variant === "swatch";
  const trigger = swatchOnly ? (
    <button
      type="button"
      {...pickRootProps(props, { aria: true })}
      // Inside a FormField the field's label names it; alone it needs a name of its own.
      aria-label={
        str(props["aria-label"]) ?? (controlProps["aria-labelledby"] ? undefined : "Colour")
      }
      {...controlProps}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-description={spoken}
      disabled={inert}
      onBlur={onTriggerBlur}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border-input bg-surface-input focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary disabled:cursor-not-allowed disabled:opacity-50",
        shownInvalid && "border-status-error",
        str(className)
      )}
    >
      <KitColorSwatch color={current} size="sm" aria-label={spoken ?? "No colour"} />
    </button>
  ) : (
    <button
      type="button"
      {...pickRootProps(props, { aria: true })}
      id={str(props.id)}
      aria-label={str(props["aria-label"])}
      {...controlProps}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      disabled={inert}
      onBlur={onTriggerBlur}
      data-placeholder={current ? undefined : ""}
      className={cn(
        selectTriggerVariants({ density: oneOf(density, ["default", "compact"] as const) }),
        "group min-w-0 text-left data-[placeholder]:text-text-secondary",
        shownInvalid && "border-status-error",
        str(className)
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <KitColorSwatch color={current} size="sm" aria-hidden="true" />
        <span className={cn("truncate", current && "font-mono uppercase")}>
          {current ? current : (nonEmpty(placeholder) ?? "Choose a colour")}
        </span>
        {current && spoken && spoken !== current.toUpperCase() ? (
          <span className="truncate text-text-secondary">{spoken}</span>
        ) : null}
      </span>
      <ChevronDown
        data-animated-chevron
        className="h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out group-data-[state=open]:rotate-180"
        aria-hidden="true"
      />
    </button>
  );

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        {...owner}
        {...focusScope.attributes}
        side={oneOf(side, SIDES)}
        align={oneOf(align, ALIGNS) ?? "start"}
        aria-label="Choose a colour"
        className={cn("w-auto p-3", overlayZ)}
      >
        <ColorPanel
          value={current}
          swatches={palette}
          allowCustom={allowCustom !== false}
          onChange={change}
          onPickSwatch={(hex, close) => {
            change(hex);
            if (close) setOpen(false);
          }}
        />
      </PopoverContent>
      {nonEmpty(name) ? (
        <input type="hidden" name={name} value={current ?? ""} disabled={inert} />
      ) : null}
    </Popover>
  );
}
