import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown, Clock, Pipette, X } from "lucide-react";
import { HexColorPicker } from "react-colorful";
import type {
  PluginColorPickerProps,
  PluginColorSwatchProps,
  PluginDateTimePickerProps,
  PluginFormHandle,
  PluginFormProps,
  PluginFormStatusProps,
  PluginRangeSliderProps,
  PluginSchemaFormProps,
  PluginSplitButtonProps,
  PluginTimePickerProps,
  PluginToggleGroupProps,
} from "@shared/types/plugin-sdk-react";
import type { SettingDefinition } from "@shared/types/plugin";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import {
  parseSettingDraft,
  SettingFieldControl,
  settingDraft,
  settingFieldLabel,
  settingFieldType,
  settingRowLayout,
} from "@/components/Settings/pluginSettingFields";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldBoundary, useFieldControl } from "@/components/ui/field";
import { inputVariants } from "@/components/ui/input";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { selectTriggerVariants } from "@/components/ui/select";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ESCAPE_RADIX_LAYER_ATTR } from "@/lib/dialogEscapeBackstop";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { todayIso } from "@/pluginUi/dateMath";
import { useDaintreeTheme } from "@/pluginUi/theme";
import {
  CATEGORY_SWATCH_KEYS,
  categorySwatchName,
  hexToHsl,
  normalizeHex,
  parseColorText,
} from "./kitColor";
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
  pickDomProps,
  pickRootProps,
  PluginStyleScope,
  positive,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import "./kitColorArea.css";
import { pluginKitDates } from "./PluginKitDates";
import { renderIconSource } from "./PluginKitIcons";
import {
  dayPeriodNames,
  formatIsoDateTime,
  formatIsoTime,
  formatTimeLabel,
  localeHourCycle,
  MINUTES_PER_DAY,
  parseIsoDateTime,
  parseIsoTime,
  resolvedTimeZone,
  timeListOptions,
  timeZoneLabel,
} from "./kitTime";

interface AriaInput {
  "aria-label"?: unknown;
  "aria-labelledby"?: unknown;
  "aria-describedby"?: unknown;
  "aria-invalid"?: unknown;
}

/** The enclosing `FormField`'s ids, merged with whatever ARIA the plugin passed. */
function useKitFieldControl(props: AriaInput, invalid?: boolean, labelable = true) {
  const ariaInvalid = props["aria-invalid"];
  return useFieldControl(
    {
      "aria-label": str(props["aria-label"]),
      "aria-labelledby": str(props["aria-labelledby"]),
      "aria-describedby": str(props["aria-describedby"]),
      "aria-invalid":
        ariaInvalid === true || ariaInvalid === "true"
          ? true
          : oneOf(ariaInvalid, ["false", "grammar", "spelling"] as const),
    },
    invalid,
    { labelable }
  );
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Whether focus left a composite control: to somewhere outside it, and not
 * into one of the kit overlays it opens (they portal out of it).
 */
function focusLeft(event: ReactFocusEvent<HTMLElement>): boolean {
  const next = event.relatedTarget;
  if (!(next instanceof Element)) return true;
  return (
    !event.currentTarget.contains(next) &&
    next.closest("[data-radix-popper-content-wrapper]") === null
  );
}

// ── Colour ───────────────────────────────────────────────────────────────

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

function KitColorSwatch({
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
        </>
      ) : null}
    </div>
  );
}

function KitColorPicker(props: PluginColorPickerProps) {
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
  const { controlProps } = useKitFieldControl(props, invalid === true ? true : undefined);
  const shownInvalid = controlProps["aria-invalid"] === true;

  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpen?.(next);
    // Closing the panel is the end of an edit, as leaving a field is.
    if (!next) onBlur?.();
  };
  const onTriggerBlur = (event: ReactFocusEvent<HTMLElement>) => {
    if (!isOpen && focusLeft(event)) onBlur?.();
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

// ── Time ─────────────────────────────────────────────────────────────────

// The DatePicker's box: drawn like the kit Input and Select trigger, its one
// ring painted on the box whenever a segment inside has keyboard focus.
const TIME_FIELD =
  "flex w-full items-center gap-0.5 bg-surface-input border border-border-input rounded-[var(--radius-md)] text-text-primary transition-colors duration-150 ease-out has-[[data-segment]:focus-visible]:outline has-[[data-segment]:focus-visible]:outline-2 has-[[data-segment]:focus-visible]:outline-accent-primary has-[[data-segment]:focus-visible]:outline-offset-2";

const TIME_FIELD_DENSITY = {
  default: "min-h-[34px] pl-2 pr-1 text-sm",
  compact: "h-7 pl-1.5 pr-0.5 text-xs",
} as const;

// A segment takes the selection fill while it has focus, as a native time
// field's does; the ring is the box's.
const SEGMENT =
  "rounded-[var(--radius-xs)] px-0.5 tabular-nums caret-transparent outline-hidden focus:bg-overlay-selected focus:text-text-primary data-[empty]:text-text-placeholder";

type SegmentKind = "hour" | "minute" | "period";

interface TimeDraft {
  hour: number | null;
  minute: number | null;
  /** 0 before noon, 1 after; unused on a 24-hour clock. */
  period: 0 | 1 | null;
}

function draftOf(minutes: number | null, cycle: 12 | 24): TimeDraft {
  if (minutes === null) return { hour: null, minute: null, period: null };
  const hours = Math.floor(minutes / 60);
  return {
    hour: cycle === 24 ? hours : hours % 12 === 0 ? 12 : hours % 12,
    minute: minutes % 60,
    period: cycle === 24 ? null : hours < 12 ? 0 : 1,
  };
}

/** The draft's time, once every segment the clock needs is filled. */
function minutesOf(draft: TimeDraft, cycle: 12 | 24): number | null {
  if (draft.hour === null || draft.minute === null) return null;
  if (cycle === 24) return draft.hour * 60 + draft.minute;
  if (draft.period === null) return null;
  return ((draft.hour % 12) + (draft.period === 1 ? 12 : 0)) * 60 + draft.minute;
}

function isEmptyDraft(draft: TimeDraft, cycle: 12 | 24): boolean {
  return draft.hour === null && draft.minute === null && (cycle === 24 || draft.period === null);
}

const TIME_LIST_ROW = cn(
  PALETTE_ROW_CLASS,
  "flex h-7 snap-start cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 text-xs tabular-nums text-text-primary"
);

function TimeList({
  options,
  chosen,
  cycle,
  onPick,
}: {
  options: number[];
  chosen: number | null;
  cycle: 12 | 24;
  onPick: (minutes: number) => void;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  // The cursor starts on the chosen time, else the first one after it.
  const start =
    chosen === null
      ? 0
      : Math.max(
          0,
          options.findIndex((option) => option >= chosen)
        );
  const [cursor, setActive] = useState(start);
  // Held inside the list, which can shrink while open (new bounds, a new step).
  const active = Math.min(Math.max(cursor, 0), Math.max(options.length - 1, 0));
  // Opening centres the chosen time, so the times around it show on both
  // sides; after that the list follows the cursor only as far as it must.
  const opened = useRef(false);
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: opened.current ? "nearest" : "center" });
    opened.current = true;
  }, [active]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      PageDown: Math.min(last, active + 8),
      PageUp: Math.max(0, active - 8),
      Home: 0,
      End: last,
    };
    const target = moves[event.key];
    if (target !== undefined) {
      event.preventDefault();
      setActive(target);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const picked = options[active];
      if (picked !== undefined) onPick(picked);
    }
  };
  if (options.length === 0) {
    return (
      <div role="status" className="px-3 py-3 text-xs text-text-secondary">
        No times in range
      </div>
    );
  }
  return (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label="Times"
      tabIndex={0}
      aria-activedescendant={`${listId}-${active}`}
      onKeyDown={onKeyDown}
      data-time-list=""
      // The active row's fill is the cursor; the ring says the list has the keys.
      // Nine whole rows, snapped so a row is never cut through, as wide as the field.
      className="max-h-[calc(9*1.75rem+0.5rem)] w-[var(--radix-popover-trigger-width)] min-w-36 snap-y snap-mandatory scroll-py-1 overflow-y-auto rounded-[var(--radius-md)] p-1 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
    >
      {options.map((minutes, index) => (
        <div
          key={minutes}
          id={`${listId}-${index}`}
          data-index={index}
          role="option"
          aria-selected={index === active}
          aria-current={minutes === chosen ? "true" : undefined}
          onPointerMove={() => {
            if (index !== active) setActive(index);
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(minutes)}
          className={TIME_LIST_ROW}
        >
          <Check
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 shrink-0", minutes !== chosen && "invisible")}
          />
          {formatTimeLabel(minutes, cycle)}
        </div>
      ))}
    </div>
  );
}

function readStep(value: unknown): number {
  const step = positive(value, 60);
  return step === undefined ? 1 : Math.max(1, Math.round(step));
}

interface TimeFieldProps {
  value: number | null;
  onChange: (minutes: number | null) => void;
  min: number | null;
  max: number | null;
  step: number;
  cycle: 12 | 24;
  clearable: boolean;
  required: boolean;
  disabled: boolean;
  invalid: boolean;
  density: "default" | "compact";
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  name: string | undefined;
  ariaProps: AriaInput & { id?: unknown };
  rootAttributes: Record<string, string | number | boolean>;
  className: string | undefined;
  onBlur: (() => void) | undefined;
  /** The noun the buttons name ("time"). */
  noun?: string;
}

function TimeField({
  value,
  onChange,
  min,
  max,
  step,
  cycle,
  clearable,
  required,
  disabled,
  invalid,
  density,
  open,
  onOpenChange,
  name,
  ariaProps,
  rootAttributes,
  className,
  onBlur,
  noun = "time",
}: TimeFieldProps) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  // A draft belongs to the value it was edited from: a new value from outside
  // replaces it, rather than a half-typed edit of the old one outliving it.
  const [held, setHeld] = useState<{ parts: TimeDraft; source: number | null } | null>(null);
  const [typedState, setTypedState] = useState<{
    segment: SegmentKind;
    digits: string;
    source: number | null;
  } | null>(null);
  const [typedInvalid, setTypedInvalid] = useState(false);
  const typed = typedState;
  const setTyped = (next: { segment: SegmentKind; digits: string } | null) =>
    setTypedState(next === null ? null : { ...next, source: value });
  if ((held !== null && held.source !== value) || (typed !== null && typed.source !== value)) {
    setHeld(null);
    setTyped(null);
    setTypedInvalid(false);
  }
  const draft = held?.parts ?? null;
  const setDraft = (parts: TimeDraft | null) =>
    setHeld(parts === null ? null : { parts, source: value });
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = (open ?? ownOpen) && !disabled;
  const boxRef = useRef<HTMLDivElement>(null);
  const shown = draft ?? draftOf(value, cycle);
  const [am, pm] = dayPeriodNames();
  const segments: SegmentKind[] = cycle === 12 ? ["hour", "minute", "period"] : ["hour", "minute"];
  const { invalid: showInvalid, controlProps } = useKitFieldControl(
    ariaProps,
    invalid || typedInvalid ? true : undefined,
    false
  );

  const setOpen = (next: boolean) => {
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
    if (!next) onBlur?.();
  };

  const inRange = (minutes: number) =>
    !(min !== null && minutes < min) && !(max !== null && minutes > max);

  /** Takes an edited draft: commits it once it is a whole allowed time, or empties the value. */
  const apply = (next: TimeDraft) => {
    const minutes = minutesOf(next, cycle);
    if (minutes !== null) {
      if (!inRange(minutes)) {
        setDraft(next);
        setTypedInvalid(true);
        return;
      }
      setDraft(null);
      setTypedInvalid(false);
      if (minutes !== value) onChange(minutes);
      return;
    }
    setTypedInvalid(false);
    if (isEmptyDraft(next, cycle) && !required) {
      setDraft(null);
      if (value !== null) onChange(null);
      return;
    }
    setDraft(next);
  };

  const focusSegment = (kind: SegmentKind) => {
    boxRef.current?.querySelector<HTMLElement>(`[data-segment="${kind}"]`)?.focus();
  };

  const range = (kind: SegmentKind): [number, number] =>
    kind === "hour" ? (cycle === 12 ? [1, 12] : [0, 23]) : kind === "minute" ? [0, 59] : [0, 1];

  const stepSegment = (kind: SegmentKind, direction: 1 | -1) => {
    const [lo, hi] = range(kind);
    const current = shown[kind];
    let next: number;
    if (kind === "minute") {
      if (current === null) next = direction > 0 ? 0 : Math.floor(59 / step) * step;
      else {
        const onStep =
          direction > 0
            ? (Math.floor(current / step) + 1) * step
            : (Math.ceil(current / step) - 1) * step;
        next = onStep > 59 ? 0 : onStep < 0 ? Math.floor(59 / step) * step : onStep;
      }
    } else if (current === null) {
      next = direction > 0 ? lo : hi;
    } else {
      next = current + direction > hi ? lo : current + direction < lo ? hi : current + direction;
    }
    setTyped(null);
    apply({ ...shown, [kind]: next });
  };

  const typeDigit = (kind: SegmentKind, digit: string) => {
    const [lo, hi] = range(kind);
    const digits = typed?.segment === kind ? typed.digits + digit : digit;
    let number = Number(digits);
    if (number > hi) number = Number(digit);
    // A second digit could still follow: wait for it, unless none could fit.
    const complete = digits.length >= 2 || number * 10 > hi;
    setTyped(complete ? null : { segment: kind, digits: String(number) });
    // A leading digit below the segment's range (the 0 of a 12-hour "09") is
    // held, shown but not taken, until the next one makes it a real hour.
    if (!complete && number < lo) return;
    apply({ ...shown, [kind]: number < lo ? lo : number });
    if (complete) {
      const nextKind = segments[segments.indexOf(kind) + 1];
      if (nextKind) focusSegment(nextKind);
    }
  };

  const onSegmentKeyDown = (kind: SegmentKind, event: KeyboardEvent<HTMLSpanElement>) => {
    if (disabled || event.metaKey || event.ctrlKey) return;
    const index = segments.indexOf(kind);
    const key = event.key;
    if (key === "ArrowDown" && event.altKey) {
      event.preventDefault();
      setOpen(true);
    } else if (key === "Enter") {
      // A segment is not an input, so the form's implicit submission is ours to give.
      event.preventDefault();
      event.currentTarget.closest("form")?.requestSubmit();
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      stepSegment(kind, key === "ArrowUp" ? 1 : -1);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const target = segments[index + (key === "ArrowRight" ? 1 : -1)];
      if (target) {
        event.preventDefault();
        setTyped(null);
        focusSegment(target);
      }
    } else if (key === "Backspace" || key === "Delete") {
      event.preventDefault();
      setTyped(null);
      apply({ ...shown, [kind]: null });
    } else if (/^\d$/.test(key) && kind !== "period") {
      event.preventDefault();
      typeDigit(kind, key);
    } else if (kind === "period" && key.length === 1) {
      const letter = key.toLowerCase();
      if (am.toLowerCase().startsWith(letter)) apply({ ...shown, period: 0 });
      else if (pm.toLowerCase().startsWith(letter)) apply({ ...shown, period: 1 });
      else return;
      event.preventDefault();
    } else if (key === ":" || key === " ") {
      const target = segments[index + 1];
      if (target) {
        event.preventDefault();
        setTyped(null);
        focusSegment(target);
      }
    } else if (key === "Escape" && draft !== null) {
      // The first Escape puts the committed time back; the next reaches the surface.
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
      setTyped(null);
      setTypedInvalid(false);
    }
  };

  const segmentText = (kind: SegmentKind): string => {
    if (typed?.segment === kind) return typed.digits;
    const part = shown[kind];
    if (part === null) return "––";
    if (kind === "period") return part === 0 ? am : pm;
    if (kind === "hour" && cycle === 12) return String(part);
    return String(part).padStart(2, "0");
  };
  const segmentLabel = { hour: "Hour", minute: "Minute", period: "AM/PM" } as const;

  const canClear = clearable && !required && !disabled && value !== null;
  const options = timeListOptions(step, min, max);
  const compact = density === "compact";
  const spokenValue = value === null ? undefined : formatTimeLabel(value, cycle);

  return (
    <Popover modal open={isOpen} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          {...rootAttributes}
          data-slot="time-picker"
          onBlur={(event) => {
            if (!isOpen && focusLeft(event)) onBlur?.();
          }}
          className={cn(
            TIME_FIELD,
            TIME_FIELD_DENSITY[compact ? "compact" : "default"],
            showInvalid &&
              "border-status-error has-[[data-segment]:focus-visible]:outline-status-error",
            disabled && "cursor-not-allowed opacity-50",
            className
          )}
        >
          <div
            ref={boxRef}
            role="group"
            aria-label={str(ariaProps["aria-label"])}
            aria-labelledby={str(ariaProps["aria-labelledby"])}
            aria-describedby={str(ariaProps["aria-describedby"])}
            {...controlProps}
            id={nonEmpty(ariaProps.id) ?? controlProps.id}
            aria-disabled={disabled || undefined}
            aria-description={spokenValue}
            onBlur={(event) => {
              // Leaving the field with half a time, or an empty one that may
              // not be cleared, puts the committed time back.
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              setTyped(null);
              if (draft !== null && minutesOf(draft, cycle) === null) {
                setDraft(null);
                setTypedInvalid(false);
              }
            }}
            className="flex min-w-0 flex-1 items-center py-1"
          >
            {segments.map((kind, index) => (
              <span key={kind} className="flex items-center">
                {kind === "minute" ? (
                  // The colon tucks into the segments' own padding, so the
                  // time reads "9:00" rather than "9 : 00".
                  <span aria-hidden="true" className="-mx-px text-text-secondary">
                    :
                  </span>
                ) : null}
                <span
                  data-segment={kind}
                  data-empty={shown[kind] === null ? "" : undefined}
                  role="spinbutton"
                  tabIndex={disabled ? -1 : 0}
                  aria-label={segmentLabel[kind]}
                  aria-valuemin={range(kind)[0]}
                  aria-valuemax={range(kind)[1]}
                  aria-valuenow={shown[kind] ?? undefined}
                  aria-valuetext={shown[kind] === null ? "Empty" : segmentText(kind)}
                  aria-disabled={disabled || undefined}
                  aria-required={required || undefined}
                  onKeyDown={(event) => onSegmentKeyDown(kind, event)}
                  onPointerDown={(event) => {
                    if (disabled) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                  }}
                  className={cn(SEGMENT, index === 0 && "ml-0.5")}
                >
                  {segmentText(kind)}
                </span>
              </span>
            ))}
          </div>
          {canClear ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-secondary"
              aria-label={`Clear ${noun}`}
              onClick={() => {
                setDraft(null);
                setTypedInvalid(false);
                onChange(null);
                focusSegment("hour");
              }}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-secondary"
              aria-label={`Choose ${noun}`}
              disabled={disabled}
            >
              <Clock aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          {name ? (
            <input
              type="hidden"
              name={name}
              value={value === null ? "" : formatIsoTime(value)}
              disabled={disabled}
            />
          ) : null}
        </div>
      </PopoverAnchor>
      <PopoverContent
        {...owner}
        align="start"
        // As wide as the field, it unrolls from it, as the host's lists do.
        motion="drop"
        aria-label={`Choose ${noun}`}
        aria-modal="true"
        {...{ [ESCAPE_RADIX_LAYER_ATTR]: "" }}
        className={cn("w-auto p-0", overlayZ)}
        onOpenAutoFocus={(event) => {
          const panel = event.currentTarget;
          const list =
            panel instanceof HTMLElement
              ? panel.querySelector<HTMLElement>("[data-time-list]")
              : null;
          if (list) {
            event.preventDefault();
            list.focus();
          }
        }}
      >
        <TimeList
          options={options}
          chosen={value}
          cycle={cycle}
          onPick={(minutes) => {
            setDraft(null);
            setTypedInvalid(false);
            if (minutes !== value) onChange(minutes);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function readCycle(value: unknown): 12 | 24 {
  return value === 12 || value === 24 ? value : localeHourCycle();
}

function KitTimePicker(props: PluginTimePickerProps) {
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState<number | null>(() => parseIsoTime(props.defaultValue));
  const value = controlled ? parseIsoTime(props.value) : own;
  const onValueChange = fn(props.onValueChange);
  const lo = parseIsoTime(props.min);
  const rawHi = parseIsoTime(props.max);
  const hi = lo !== null && rawHi !== null && rawHi < lo ? null : rawHi;
  const { id: _id, ...rootAttributes } = pickRootProps(props);
  return (
    <TimeField
      value={value}
      onChange={(minutes) => {
        if (!controlled) setOwn(minutes);
        onValueChange?.(minutes === null ? null : formatIsoTime(minutes));
      }}
      min={lo}
      max={hi}
      step={readStep(props.step)}
      cycle={readCycle(props.hourCycle)}
      clearable={props.clearable !== false}
      required={props.required === true}
      disabled={props.disabled === true}
      invalid={props.invalid === true}
      density={props.density === "compact" ? "compact" : "default"}
      open={typeof props.open === "boolean" ? props.open : undefined}
      onOpenChange={fn(props.onOpenChange)}
      name={nonEmpty(props.name)}
      ariaProps={props}
      rootAttributes={rootAttributes}
      className={str(props.className)}
      onBlur={fn(props.onBlur)}
    />
  );
}

const DatePickerPart = pluginKitDates.DatePicker;

/** "2026-10-05" as Date.UTC's year, month index and day. */
function isoParts(iso: string): [number, number, number] {
  const [year, month, day] = iso.split("-").map(Number);
  return [year ?? 1970, (month ?? 1) - 1, day ?? 1];
}

/** A plugin's `isDateDisabled`, made safe: a throw or a non-boolean leaves the day enabled. */
function dayDisabled(check: unknown, iso: string): boolean {
  if (typeof check !== "function") return false;
  try {
    return Reflect.apply(check, undefined, [iso]) === true;
  } catch {
    return false;
  }
}

function KitDateTimePicker(props: PluginDateTimePickerProps) {
  const {
    min,
    max,
    isDateDisabled,
    weekStartsOn,
    step,
    hourCycle,
    timeZone,
    showTimeZone,
    clearable,
    disabled,
    required,
    invalid,
    name,
    density,
    className,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => parseIsoDateTime(props.defaultValue));
  const value = controlled ? parseIsoDateTime(props.value) : own;
  // A day picked with no time yet, or a time with no day, held until the pair is whole.
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const onValueChange = fn(props.onValueChange);
  const onBlur = fn(props.onBlur);
  const lo = parseIsoDateTime(min);
  const rawHi = parseIsoDateTime(max);
  const hi =
    lo !== null &&
    rawHi !== null &&
    formatIsoDateTime(rawHi.date, rawHi.minutes) < formatIsoDateTime(lo.date, lo.minutes)
      ? null
      : rawHi;
  const zone = nonEmpty(timeZone);
  const zoneId = resolvedTimeZone(zone);
  const [now] = useState(() => Date.now());
  const { controlProps } = useKitFieldControl(props, invalid === true ? true : undefined, false);
  const compact = density === "compact";
  const { id: _id, ...rootAttributes } = pickRootProps(props);

  // A held day only stands in while there is no value; a whole value from
  // outside replaces it, so clearing that later cannot bring it back.
  if (value !== null && pendingDate !== null) setPendingDate(null);
  const date = value?.date ?? pendingDate;
  // The zone's name on the day chosen, not today: daylight saving can start
  // between now and then. Noon UTC on that day falls on the same day in every
  // zone's daytime, well clear of the small-hours switch.
  const zoneInstant = date === null ? now : Date.UTC(...isoParts(date), 12);
  const zoneName = showTimeZone === false ? null : timeZoneLabel(zoneId ?? undefined, zoneInstant);
  // The time bounds that hold on a day: min on its first day, max on its last.
  const timeMinOn = (day: string | null) => (lo !== null && day === lo.date ? lo.minutes : null);
  const timeMaxOn = (day: string | null) => (hi !== null && day === hi.date ? hi.minutes : null);
  const timeMin = timeMinOn(date);
  const timeMax = timeMaxOn(date);
  /** `minutes` held to the times `day` allows. */
  const fitTime = (day: string, minutes: number) =>
    clamp(minutes, timeMinOn(day) ?? 0, timeMaxOn(day) ?? MINUTES_PER_DAY - 1);

  const emit = (next: { date: string; minutes: number } | null) => {
    if (!controlled) setOwn(next);
    onValueChange?.(next === null ? null : formatIsoDateTime(next.date, next.minutes));
  };

  return (
    <div
      {...rootAttributes}
      role="group"
      aria-label={str(props["aria-label"])}
      {...controlProps}
      id={nonEmpty(props.id) ?? controlProps.id}
      data-slot="date-time-picker"
      onBlur={(event) => {
        if (focusLeft(event)) onBlur?.();
      }}
      className={cn("flex w-full min-w-0 flex-wrap items-center gap-2", str(className))}
    >
      <FieldBoundary>
        <DatePickerPart
          aria-label="Date"
          className="min-w-36 flex-[3]"
          value={date}
          onValueChange={(nextDate) => {
            if (nextDate === null) {
              setPendingDate(null);
              emit(null);
              return;
            }
            // The time kept from before, or the day's earliest, held to the new day's bounds.
            setPendingDate(null);
            emit({ date: nextDate, minutes: fitTime(nextDate, value?.minutes ?? 0) });
          }}
          min={lo?.date}
          max={hi?.date}
          isDateDisabled={isDateDisabled}
          weekStartsOn={weekStartsOn}
          clearable={clearable}
          disabled={disabled}
          required={required}
          invalid={invalid}
          density={density}
        />
        <div className="min-w-28 flex-[2]">
          <TimeField
            value={value?.minutes ?? null}
            onChange={(minutes) => {
              if (minutes === null) {
                if (value !== null) setPendingDate(value.date);
                emit(null);
                return;
              }
              // No day yet: today, held to the allowed days. A day the plugin
              // rules out is not filled in behind the user's back.
              let day = date ?? todayIso(Date.now());
              if (date === null) {
                if (lo !== null && day < lo.date) day = lo.date;
                if (hi !== null && day > hi.date) day = hi.date;
                if (dayDisabled(isDateDisabled, day)) return;
              }
              setPendingDate(null);
              emit({ date: day, minutes: fitTime(day, minutes) });
            }}
            min={timeMin}
            max={timeMax}
            step={readStep(step)}
            cycle={readCycle(hourCycle)}
            clearable={clearable !== false}
            required={required === true}
            disabled={disabled === true}
            invalid={invalid === true}
            density={compact ? "compact" : "default"}
            open={undefined}
            onOpenChange={undefined}
            name={undefined}
            ariaProps={{ "aria-label": "Time" }}
            rootAttributes={{}}
            className={undefined}
            onBlur={undefined}
          />
        </div>
      </FieldBoundary>
      {zoneName ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={-1}
              aria-label={zoneId ? `Time zone ${zoneId}` : `Time zone ${zoneName}`}
              className="shrink-0 text-xs tabular-nums text-text-secondary"
            >
              {zoneName}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{zoneId ?? zoneName}</TooltipContent>
        </Tooltip>
      ) : null}
      {nonEmpty(name) ? (
        <input
          type="hidden"
          name={name}
          value={value === null ? "" : formatIsoDateTime(value.date, value.minutes)}
          disabled={disabled === true}
        />
      ) : null}
    </div>
  );
}

// ── Range slider ─────────────────────────────────────────────────────────

function decimalsOf(value: number): number {
  const text = String(value);
  // "2.5e-7": the mantissa's own places plus the exponent's.
  const scientific = /^[+-]?\d*(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (scientific) return Math.max(0, (scientific[1]?.length ?? 0) - Number(scientific[2]));
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * A range slider's values as steps from `lo`: `top` is the last step inside
 * the range, and `gap` the smallest number of steps between the thumbs, the
 * minimum distance rounded up so the thumbs are never closer than it.
 */
interface RangeGrid {
  lo: number;
  step: number;
  top: number;
  gap: number;
  places: number;
}

// A hair under a whole step, so float error in (hi - lo) / step does not lose one.
const STEP_EPSILON = 1e-9;

function rangeGrid(lo: number, hi: number, step: number, minDistance: number): RangeGrid {
  const top = Math.floor((hi - lo) / step + STEP_EPSILON);
  return {
    lo,
    step,
    top,
    gap: Math.min(top, Math.max(0, Math.ceil(minDistance / step - STEP_EPSILON))),
    places: Math.min(Math.max(decimalsOf(step), decimalsOf(lo)), 12),
  };
}

function valueAtStep(grid: RangeGrid, index: number): number {
  return Number((grid.lo + index * grid.step).toFixed(grid.places));
}

/** The nearest step to a value, inside the range. */
function stepOf(grid: RangeGrid, value: number): number {
  return clamp(Math.round((value - grid.lo) / grid.step), 0, grid.top);
}

/** A pair as steps: in order, inside the range, and at least the gap apart. */
function pairSteps(grid: RangeGrid, pair: readonly [number, number]): [number, number] {
  let a = stepOf(grid, pair[0]);
  let b = stepOf(grid, pair[1]);
  if (a > b) [a, b] = [b, a];
  if (b - a < grid.gap) {
    b = Math.min(grid.top, a + grid.gap);
    a = b - grid.gap;
  }
  return [a, b];
}

/** A pair in order, on steps, at least `minDistance` apart, and inside the range. */
export function normalizeRange(
  pair: readonly [number, number],
  lo: number,
  hi: number,
  step: number,
  minDistance: number
): [number, number] {
  const grid = rangeGrid(lo, hi, step, minDistance);
  const [a, b] = pairSteps(grid, pair);
  return [valueAtStep(grid, a), valueAtStep(grid, b)];
}

/** A plugin's formatter, made safe: a throw or a non-string reads as the number. */
function formatSafely(formatter: ((value: number) => string) | undefined, value: number): string {
  if (!formatter) return String(value);
  try {
    return nonEmpty(formatter(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function readPair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const a = finite(value[0]);
  const b = finite(value[1]);
  return a === undefined || b === undefined ? undefined : [a, b];
}

function readMarks(value: unknown, lo: number, hi: number): { value: number; label?: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { value: number; label?: string }[] = [];
  for (const entry of value) {
    const at =
      typeof entry === "number"
        ? finite(entry)
        : typeof entry === "object" && entry !== null
          ? finite(field(entry, "value"))
          : undefined;
    if (at === undefined || at < lo || at > hi) continue;
    const label =
      typeof entry === "object" && entry !== null ? nonEmpty(field(entry, "label")) : undefined;
    out.push({ value: at, label });
  }
  return out;
}

const RANGE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

// Slider's parts, drawn as elements rather than a native range's pseudo
// elements: the input-edge ink for the empty track, the primary ink for the
// span between the thumbs, and the thumb a field-coloured disc ringed in the
// primary ink. The track is inset half a thumb each side, so a thumb's centre
// sits on its value exactly as the native range's does.
const RANGE_THUMB =
  "absolute top-1/2 box-border size-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-solid border-text-primary bg-surface-input focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary data-[dragging]:cursor-grabbing aria-disabled:cursor-not-allowed";

// The host tooltip's card, drawn in place over the thumb rather than portalled:
// it follows the thumb frame by frame while it moves.
const RANGE_TOOLTIP =
  "pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-md)] surface-overlay shadow-overlay px-2 py-1 text-xs tabular-nums text-text-primary";

function KitRangeSlider(props: PluginRangeSliderProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    onValueCommit,
    min,
    max,
    step,
    minDistance,
    formatValue,
    showValue,
    marks,
    tooltip,
    thumbLabels,
    name,
    disabled,
    invalid,
    className,
  } = props;
  const onBlur = fn(props.onBlur);
  const rawLo = finite(min) ?? 0;
  const rawHi = finite(max) ?? 100;
  const [lo, hi] = rawHi > rawLo ? [rawLo, rawHi] : [0, 100];
  const stepBy = positive(step, hi - lo) ?? 1;
  const grid = rangeGrid(lo, hi, stepBy, finite(minDistance) ?? 0);
  const controlledPair = readPair(value);
  const [own, setOwn] = useState<[number, number]>(() => readPair(defaultValue) ?? [lo, hi]);
  const steps = pairSteps(grid, controlledPair ?? own);
  const current: [number, number] = [valueAtStep(grid, steps[0]), valueAtStep(grid, steps[1])];
  // Each thumb's reach: as far as the range's end and the other thumb allow.
  const bounds: [[number, number], [number, number]] = [
    [0, steps[1] - grid.gap],
    [steps[0] + grid.gap, grid.top],
  ];
  const onChange = fn(onValueChange);
  const onCommit = fn(onValueCommit);
  const formatter = fn(formatValue);
  const words = (n: number) => formatSafely(formatter, n);
  const inert = disabled === true;
  const names: [string, string] = [
    nonEmpty(Array.isArray(thumbLabels) ? thumbLabels[0] : undefined) ?? "Minimum",
    nonEmpty(Array.isArray(thumbLabels) ? thumbLabels[1] : undefined) ?? "Maximum",
  ];
  const [dragging, setDragging] = useState<0 | 1 | null>(null);
  const [focusVisible, setFocusVisible] = useState<0 | 1 | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Set while a press puts focus on a thumb: that focus shows no tooltip of
  // its own, since the drag is what shows it.
  const pointerFocus = useRef(false);
  const thumbRefs = useRef<(HTMLDivElement | null)[]>([]);
  // The pair this gesture last proposed. A controlled parent can lag a move
  // behind, so the gesture steps on from, and commits, what it proposed.
  const proposed = useRef<[number, number] | null>(null);
  const { invalid: shownInvalid, controlProps } = useKitFieldControl(
    props,
    invalid === true ? true : undefined,
    false
  );
  const tickList = readMarks(marks, lo, hi);
  const labelled = tickList.some((mark) => mark.label !== undefined);

  const frac = (n: number) => (n - lo) / (hi - lo);
  const position = (n: number) => `calc(0.5rem + (100% - 1rem) * ${frac(n)})`;

  /** Moves one thumb to a step, held between the range's end and the other thumb. */
  const moveThumb = (index: 0 | 1, targetStep: number) => {
    const base = proposed.current ? pairSteps(grid, proposed.current) : steps;
    const reach: [number, number] =
      index === 0 ? [0, base[1] - grid.gap] : [base[0] + grid.gap, grid.top];
    const nextSteps: [number, number] = [...base];
    nextSteps[index] = clamp(Math.round(targetStep), reach[0], reach[1]);
    const next: [number, number] = [
      valueAtStep(grid, nextSteps[0]),
      valueAtStep(grid, nextSteps[1]),
    ];
    const from: [number, number] = [valueAtStep(grid, base[0]), valueAtStep(grid, base[1])];
    proposed.current = next;
    if (next[0] !== from[0] || next[1] !== from[1]) {
      if (controlledPair === undefined) setOwn(next);
      onChange?.(next);
    }
  };

  const commit = () => {
    const pair = proposed.current ?? current;
    proposed.current = null;
    onCommit?.(pair);
  };

  const valueAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return lo;
    const rect = track.getBoundingClientRect();
    const inner = Math.max(1, rect.width - 16);
    return lo + clamp((clientX - rect.left - 8) / inner, 0, 1) * (hi - lo);
  };
  const stepAt = (clientX: number) => (valueAt(clientX) - lo) / stepBy;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (inert || event.button !== 0) return;
    event.preventDefault();
    const target = valueAt(event.clientX);
    const [a, b] = current;
    // The nearer thumb; on a tie (thumbs together) the one on the press's side.
    const index: 0 | 1 =
      Math.abs(target - a) < Math.abs(target - b)
        ? 0
        : Math.abs(target - a) > Math.abs(target - b)
          ? 1
          : target < a
            ? 0
            : 1;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(index);
    pointerFocus.current = true;
    thumbRefs.current[index]?.focus({ preventScroll: true, focusVisible: false });
    pointerFocus.current = false;
    proposed.current = null;
    moveThumb(index, stepAt(event.clientX));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    moveThumb(dragging, stepAt(event.clientX));
  };

  const endDrag = () => {
    if (dragging === null) return;
    setDragging(null);
    commit();
  };

  const onThumbKeyDown = (index: 0 | 1, event: KeyboardEvent<HTMLDivElement>) => {
    if (inert || !RANGE_KEYS.has(event.key)) return;
    event.preventDefault();
    const at = (proposed.current ? pairSteps(grid, proposed.current) : steps)[index];
    const deltas: Record<string, number> = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageUp: 10,
      PageDown: -10,
    };
    const target =
      event.key === "Home"
        ? bounds[index][0]
        : event.key === "End"
          ? bounds[index][1]
          : at + (deltas[event.key] ?? 0);
    moveThumb(index, target);
  };

  const showTip = tooltip !== "never";

  return (
    <div
      {...pickRootProps(props)}
      role="group"
      aria-label={str(props["aria-label"])}
      {...controlProps}
      aria-disabled={inert || undefined}
      data-slot="range-slider"
      onBlur={(event) => {
        if (focusLeft(event)) onBlur?.();
      }}
      className={cn(
        "flex w-full min-w-0 items-center gap-3",
        inert && "opacity-50",
        str(className)
      )}
    >
      <div
        className={cn(
          "relative min-w-0 flex-1",
          // Room above for the value tooltip, held at rest too so nothing jumps
          // and the tooltip never covers the row's own words.
          showTip && "pt-7",
          labelled ? "pb-5" : tickList.length ? "pb-2" : ""
        )}
      >
        <div
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          className={cn(
            "relative h-5 touch-none select-none",
            inert ? "cursor-not-allowed" : "cursor-pointer"
          )}
        >
          <div className="absolute inset-x-2 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--color-selection-outline)]" />
          <div
            data-slot="range-fill"
            className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-text-primary"
            style={{ left: position(current[0]), right: `calc(100% - ${position(current[1])})` }}
          />
          {([0, 1] as const).map((index) => {
            const at = current[index];
            const spoken = words(at);
            const tipShown = showTip && (dragging === index || focusVisible === index);
            return (
              <div
                key={index}
                ref={(el) => {
                  thumbRefs.current[index] = el;
                }}
                role="slider"
                tabIndex={inert ? -1 : 0}
                aria-label={names[index]}
                aria-valuemin={valueAtStep(grid, bounds[index][0])}
                aria-valuemax={valueAtStep(grid, bounds[index][1])}
                aria-valuenow={at}
                aria-valuetext={formatter ? spoken : undefined}
                aria-orientation="horizontal"
                aria-disabled={inert || undefined}
                data-dragging={dragging === index ? "" : undefined}
                onKeyDown={(event) => onThumbKeyDown(index, event)}
                onKeyUp={(event) => {
                  if (!inert && RANGE_KEYS.has(event.key)) commit();
                }}
                onFocus={() => {
                  if (!pointerFocus.current) setFocusVisible(index);
                }}
                onBlur={() => {
                  setFocusVisible(null);
                  // A key gesture whose key-up never came (focus moved mid-press) ends here.
                  if (dragging === null && proposed.current !== null) commit();
                }}
                className={cn(RANGE_THUMB, shownInvalid && "border-status-error")}
                // The later thumb sits on top where they meet, unless the first is held.
                style={{ left: position(at), zIndex: dragging === index ? 3 : index + 1 }}
              >
                {tipShown ? (
                  <span aria-hidden="true" className={RANGE_TOOLTIP}>
                    {spoken}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {tickList.length > 0 ? (
          <div aria-hidden="true" className="absolute inset-x-0 top-5 h-4">
            {tickList.map((mark) => (
              <span
                key={mark.value}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
                style={{ left: position(mark.value) }}
              >
                <span className="h-1.5 w-px bg-border-strong" />
                {mark.label ? (
                  <span className="whitespace-nowrap text-2xs tabular-nums text-text-secondary">
                    {mark.label}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {showValue === true ? (
        <span aria-hidden="true" className="shrink-0 text-xs tabular-nums text-text-secondary">
          {`${words(current[0])} – ${words(current[1])}`}
        </span>
      ) : null}
      {nonEmpty(name) ? (
        <>
          <input type="hidden" name={name} value={current[0]} disabled={inert} />
          <input type="hidden" name={name} value={current[1]} disabled={inert} />
        </>
      ) : null}
    </div>
  );
}

// ── Toggle group ─────────────────────────────────────────────────────────

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

// The kit Button's one pressed look (`pressed`): the filter chip's selected
// fill with a secondary-ink edge, which clears 3:1 against the button and the
// pane in either polarity where the toolbar's armed hairline does not, so a
// day that is on reads as on without leaning on the fill alone.
const TOGGLE_SIZE = {
  default: { text: "sm", icon: "icon-sm" },
  compact: { text: "xs", icon: "icon-xs" },
} as const;

function inToolbar(group: Element): boolean {
  return group.parentElement?.closest('[role="toolbar"]') != null;
}

function KitToggleGroup(props: PluginToggleGroupProps) {
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
        if (focusLeft(event)) onBlur?.();
      }}
      data-slot="toggle-group"
      className={cn("inline-flex shrink-0 items-center gap-0.5", str(className))}
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
            variant="ghost"
            size={iconOnly ? sizes.icon : sizes.text}
            pressed={pressed}
            aria-label={entry.ariaLabel}
            disabled={inert || entry.disabled}
            onFocus={() => setCursor(index)}
            onClick={() => toggle(entry)}
            className={cn(!iconOnly && "px-2.5 font-normal", "[&_svg]:size-3.5")}
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
            <TooltipContent side="bottom">
              <PluginStyleScope>{node(tip)}</PluginStyleScope>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── Split button ─────────────────────────────────────────────────────────

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

function KitSplitButton({
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

// ── Form ─────────────────────────────────────────────────────────────────

function callQuietly(callback: unknown, self: unknown): void {
  if (typeof callback !== "function") return;
  try {
    Reflect.apply(callback, self, []);
  } catch {
    // A plugin's reset that throws leaves the form as it was.
  }
}

/** A `useForm` result as `Form` and `FormStatus` read it, from untyped JS. */
function readForm(form: unknown): PluginFormHandle | null {
  if (typeof form !== "object" || form === null) return null;
  const submit = field(form, "submit");
  const reset = field(form, "reset");
  if (typeof submit !== "function" || typeof reset !== "function") return null;
  const status = oneOf(field(form, "status"), [
    "clean",
    "dirty",
    "invalid",
    "submitting",
    "saved",
    "error",
  ] as const);
  return {
    // A throw, sync or async, is a submit that did not go through, not a crash of the view.
    submit: () =>
      new Promise((resolve) => resolve(Reflect.apply(submit, form, []))).then(
        (ok) => ok === true,
        () => false
      ),
    reset: () => {
      callQuietly(reset, form);
    },
    status: status ?? "clean",
    statusMessage: nonEmpty(field(form, "statusMessage")),
  };
}

const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled]):not([aria-disabled="true"])';

/**
 * The first control a failed submit marked invalid that can take focus: the
 * control itself, or the first focusable part of it. A marked element that
 * is disabled or holds nothing focusable is passed over for the next.
 */
function firstInvalidControl(root: HTMLElement): HTMLElement | null {
  for (const marked of root.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    const target = marked.matches(FOCUSABLE)
      ? marked
      : marked.querySelector<HTMLElement>(FOCUSABLE);
    // Inside a disabled fieldset nothing takes focus, whatever its own attributes say.
    if (target && target.closest("fieldset:disabled") === null) return target;
  }
  return null;
}

function KitForm({
  form,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  className,
  ...rest
}: PluginFormProps) {
  const ref = useRef<HTMLFormElement>(null);
  const handle = readForm(form);
  // Bumped by a submit a check turned back; the effect runs once the errors
  // it found have rendered, so the invalid control is marked by then.
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    const root = ref.current;
    if (refused > 0 && root) firstInvalidControl(root)?.focus();
  }, [refused]);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!handle) return;
    void handle.submit().then((ok) => {
      if (!ok) setRefused((count) => count + 1);
    });
  };
  return (
    <form
      {...pickRootProps(rest)}
      ref={ref}
      noValidate
      aria-label={str(ariaLabel)}
      aria-labelledby={str(ariaLabelledBy)}
      aria-busy={handle?.status === "submitting" || undefined}
      onSubmit={onSubmit}
      onReset={(event) => {
        event.preventDefault();
        handle?.reset();
      }}
      className={str(className)}
    >
      {node(children)}
    </form>
  );
}

function KitFormStatus({ form, ...rest }: PluginFormStatusProps) {
  const handle = readForm(form);
  const status = handle?.status ?? "clean";
  const message = handle?.statusMessage;
  const root = pickRootProps(rest);
  if (!message) return <span {...root} data-slot="form-status" />;
  if (status === "error" || status === "invalid") {
    const { Icon, toneClass } = SEVERITY_VISUAL.error;
    return (
      <span
        {...root}
        data-slot="form-status"
        data-status={status}
        className={cn("inline-flex min-w-0 items-center gap-1.5", toneClass)}
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{message}</span>
      </span>
    );
  }
  return (
    <span
      {...root}
      data-slot="form-status"
      data-status={status}
      className="inline-flex min-w-0 items-center gap-1.5 text-text-secondary"
    >
      {status === "submitting" ? <Spinner size="xs" /> : null}
      {status === "saved" ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 truncate">{message}</span>
    </span>
  );
}

// ── Schema form ──────────────────────────────────────────────────────────

/** Keywords a SchemaForm property reads; any other is ignored, with a warning in development. */
const PROPERTY_KEYWORDS = new Set([
  "type",
  "title",
  "description",
  "default",
  "enum",
  "minimum",
  "maximum",
  "format",
  "writeOnly",
  "$comment",
  "examples",
]);
const ROOT_KEYWORDS = new Set([
  "$schema",
  "$id",
  "type",
  "title",
  "description",
  "properties",
  "required",
  "$comment",
]);

const warnedSchemaKeywords = new Set<string>();

/** A keyword's value for a warning, without calling into it (a value may throw when stringified). */
function describeValue(value: unknown): string {
  return typeof value === "string" ? value : typeof value;
}

function warnSchemaKeyword(where: string, keyword: string): void {
  if (!import.meta.env.DEV) return;
  const key = `${where}:${keyword}`;
  if (warnedSchemaKeywords.has(key)) return;
  warnedSchemaKeywords.add(key);
  console.warn(`[plugin-ui] SchemaForm: "${keyword}" on ${where} is not supported; it is ignored.`);
}

export interface SchemaField {
  def: SettingDefinition;
  /** A masked string (`format: "password"` or `writeOnly`). */
  masked: boolean;
  /** An integer field: a fraction is refused. */
  integer: boolean;
}

/**
 * The rows a JSON Schema describes, as the settings generator's field
 * definitions: one per property of a root `object`, in declaration order.
 * Properties of a type the generator has no control for are left out.
 */
export function schemaFields(schema: unknown): SchemaField[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return [];
  for (const keyword of Object.keys(schema)) {
    if (!ROOT_KEYWORDS.has(keyword)) warnSchemaKeyword("the schema", keyword);
  }
  const rootType = field(schema, "type");
  if (rootType !== undefined && rootType !== "object") {
    warnSchemaKeyword("the schema", `type: ${describeValue(rootType)}`);
    return [];
  }
  const properties = field(schema, "properties");
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
  const requiredRaw = field(schema, "required");
  const required = new Set(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter((entry): entry is string => typeof entry === "string")
      : []
  );
  const out: SchemaField[] = [];
  for (const [id, property] of Object.entries(properties)) {
    if (typeof property !== "object" || property === null || Array.isArray(property)) continue;
    const where = `"${id}"`;
    for (const keyword of Object.keys(property)) {
      if (!PROPERTY_KEYWORDS.has(keyword)) warnSchemaKeyword(where, keyword);
    }
    const rawType = field(property, "type");
    const enumValues = field(property, "enum");
    const options = Array.isArray(enumValues)
      ? enumValues.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : null;
    const format = field(property, "format");
    const base = {
      id,
      label: nonEmpty(field(property, "title")),
      description: nonEmpty(field(property, "description")),
      default: field(property, "default"),
      required: required.has(id) || undefined,
    };
    if (options !== null && options.length > 0 && (rawType === undefined || rawType === "string")) {
      out.push({ def: { ...base, type: "enum", options }, masked: false, integer: false });
      continue;
    }
    if (format !== undefined && format !== "password")
      warnSchemaKeyword(where, `format: ${describeValue(format)}`);
    switch (rawType) {
      case "string":
        out.push({
          def: { ...base, type: "string" },
          masked: format === "password" || field(property, "writeOnly") === true,
          integer: false,
        });
        break;
      case "number":
      case "integer":
        out.push({
          def: {
            ...base,
            type: "number",
            min: finite(field(property, "minimum")),
            max: finite(field(property, "maximum")),
          },
          masked: false,
          integer: rawType === "integer",
        });
        break;
      case "boolean":
        out.push({ def: { ...base, type: "boolean" }, masked: false, integer: false });
        break;
      case "object":
      case "array":
        out.push({ def: { ...base, type: "json" }, masked: false, integer: false });
        break;
      default:
        warnSchemaKeyword(where, `type: ${describeValue(rawType)}`);
    }
  }
  return out;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/**
 * A value as the field's type holds it, or `undefined`: the settings generator
 * trusts what it is handed, and a plugin's values are untyped.
 */
function fieldValue(def: SettingDefinition, type: string, value: unknown): unknown {
  switch (type) {
    case "string":
    case "secret":
      return typeof value === "string" ? value : undefined;
    case "number":
      return finite(value);
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "enum":
      return typeof value === "string" && (def.options ?? []).includes(value) ? value : undefined;
    default:
      return value;
  }
}

function SchemaFieldRow({
  schemaField,
  value,
  hasValue,
  externalError,
  disabled,
  onCommit,
}: {
  schemaField: SchemaField;
  value: unknown;
  hasValue: boolean;
  externalError: string | undefined;
  disabled: boolean;
  onCommit: (value: unknown, remove: boolean) => void;
}) {
  const { def, masked, integer } = schemaField;
  const type = settingFieldType(def);
  const shownValue =
    fieldValue(def, type, hasValue ? value : undefined) ?? fieldValue(def, type, def.default);
  const committedDraft = settingDraft(shownValue, type);
  // Stored or defaulted, as well as what it reads as: removing a stored value
  // equal to the default still replaces an edit of it.
  const source = `${hasValue ? "stored" : "default"}:${committedDraft}`;
  // An edit belongs to the value it began from: a new value from outside (a
  // reset) replaces it and whatever was wrong with it.
  const [held, setHeld] = useState<{
    text: string;
    source: string;
    error: string | null;
  } | null>(null);
  if (held !== null && held.source !== source) setHeld(null);
  const draft = held?.text ?? null;
  const error = held?.error ?? null;
  const label = settingFieldLabel(def);
  const text = draft ?? committedDraft;

  /** Settles the draft; `false` when it was refused and stays for fixing. */
  const commitText = (): boolean => {
    if (draft === null) return true;
    if (draft === committedDraft) {
      setHeld(null);
      return true;
    }
    const outcome = parseSettingDraft(def, type, draft);
    const refusal =
      outcome.kind === "error"
        ? outcome.message
        : outcome.kind === "value" && integer && !Number.isInteger(outcome.value)
          ? "Enter a whole number"
          : null;
    if (refusal !== null) {
      setHeld({ text: draft, source, error: refusal });
      return false;
    }
    setHeld(null);
    if (outcome.kind === "reset" || (type === "string" && draft === "")) onCommit(undefined, true);
    else if (outcome.kind === "value") onCommit(outcome.value, false);
    return true;
  };

  const shownError = error ?? externalError;
  return (
    <SettingsRow
      label={label}
      description={def.description}
      accessory={def.required === true ? <Badge size="xs">Required</Badge> : undefined}
      layout={masked ? "stacked" : settingRowLayout(def, type)}
      disabled={disabled}
      error={shownError ?? undefined}
      onRowClick={
        type === "boolean" && !disabled ? () => onCommit(shownValue !== true, false) : undefined
      }
      control={(ids) => (
        <SettingFieldControl
          def={def}
          type={type}
          ids={ids}
          label={label}
          draft={text}
          onDraftChange={(next) => setHeld({ text: next, source, error: null })}
          onCommit={() => void commitText()}
          onEnter={(event) => {
            // Settled before an enclosing form sees the key and submits the old value.
            if (!commitText()) event.preventDefault();
          }}
          onChoose={(next) => onCommit(next, false)}
          checked={shownValue === true}
          onCheckedChange={(next) => onCommit(next, false)}
          invalid={shownError !== undefined && shownError !== null}
          busy={false}
          masked={masked}
        />
      )}
    />
  );
}

function KitSchemaForm(props: PluginSchemaFormProps) {
  const { schema, value, defaultValue, onValueChange, errors, label, disabled } = props;
  const fields = schemaFields(schema);
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState<Record<string, unknown>>(() => readRecord(defaultValue));
  const values = controlled ? readRecord(value) : own;
  const onChange = fn(onValueChange);
  const errorMap = readRecord(errors);
  return (
    <SettingsGroup rootAttributes={pickRootProps(props)} label={nonEmpty(label)}>
      {fields.map((schemaField) => {
        const id = schemaField.def.id;
        return (
          <SchemaFieldRow
            key={id}
            schemaField={schemaField}
            value={values[id]}
            hasValue={Object.hasOwn(values, id)}
            externalError={nonEmpty(errorMap[id])}
            disabled={disabled === true}
            onCommit={(next, remove) => {
              const updated = { ...values };
              if (remove) delete updated[id];
              // Defined, not assigned, so a property named `__proto__` is a field like any other.
              else
                Object.defineProperty(updated, id, {
                  value: next,
                  enumerable: true,
                  writable: true,
                  configurable: true,
                });
              if (!controlled) setOwn(updated);
              onChange?.(updated);
            }}
          />
        );
      })}
    </SettingsGroup>
  );
}

export const pluginKitPickersForms = {
  ColorSwatch: KitColorSwatch,
  ColorPicker: KitColorPicker,
  TimePicker: KitTimePicker,
  DateTimePicker: KitDateTimePicker,
  RangeSlider: KitRangeSlider,
  ToggleGroup: KitToggleGroup,
  SplitButton: KitSplitButton,
  Form: KitForm,
  FormStatus: KitFormStatus,
  SchemaForm: KitSchemaForm,
};
