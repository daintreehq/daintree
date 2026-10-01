import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import type {
  PluginCalendarProps,
  PluginDatePickerProps,
  PluginDateRangePickerProps,
  PluginTimeAgoProps,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import {
  getPopoverAvailableWidth,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWallClock } from "@/hooks/useWallClock";
import { ESCAPE_RADIX_LAYER_ATTR } from "@/lib/dialogEscapeBackstop";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { cn } from "@/lib/utils";
import { formatTimeAgo } from "@/utils/timeAgo";
// The SDK's own clock, compiled from its source into the one module instance
// raw plugin views import, so kit ages and a view's `useNow` share timers.
import { useNow } from "../../../packages/plugin-sdk/src/react/useNow";
import {
  addDays,
  addMonths,
  clampIso,
  FIRST_ISO,
  firstOfMonth,
  formatDayNumber,
  formatEditableRange,
  formatFieldDate,
  formatFieldRange,
  formatFullDate,
  fitMonthsToMax,
  formatMonthLabel,
  LAST_ISO,
  localeWeekStart,
  monthOf,
  monthWeeks,
  msUntilLocalMidnight,
  parseDateText,
  parseRangeText,
  shiftMonth,
  toDateRange,
  toIsoDate,
  toIsoMonth,
  todayIso,
  weekday,
  weekdayNames,
  type DateRange,
} from "@/pluginUi/dateMath";
import { fn, nonEmpty, pickRootProps, str, useKitOwnerAttributes } from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { invalidProp, useKitFieldControl } from "./kitField";
import { toTimestamp } from "./kitTime";

type Mode = "single" | "range";

const WEEK_STARTS = [0, 1, 2, 3, 4, 5, 6] as const;

function readWeekStart(value: unknown): number {
  return WEEK_STARTS.find((day) => day === value) ?? localeWeekStart();
}

/** A plugin's `isDateDisabled`, made safe: a throw or a non-boolean leaves the day enabled. */
function callDisabled(check: ((date: string) => boolean) | undefined, iso: string): boolean {
  if (!check) return false;
  try {
    return check(iso) === true;
  } catch {
    return false;
  }
}

/** A plugin's `onValueChange`, whichever mode's signature it has, as one callable. */
function reporter(callback: unknown): ((value: unknown) => void) | undefined {
  if (typeof callback !== "function") return undefined;
  return (value) => {
    Reflect.apply(callback, undefined, [value]);
  };
}

function sameRange(a: DateRange | null, b: DateRange | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end);
}

// Wakes at local midnight, so a calendar left open overnight moves its today mark.
function useToday(): string {
  return todayIso(useWallClock(null, msUntilLocalMidnight));
}

// ── Calendar ─────────────────────────────────────────────────────────────

interface CalendarViewProps {
  mode: Mode;
  selected: string | null;
  range: DateRange | null;
  onPick: (iso: string) => void;
  onPickRange: (range: DateRange) => void;
  min: string | null;
  max: string | null;
  isDateDisabled: ((date: string) => boolean) | undefined;
  /** Controlled first month; omitted, the view keeps its own from `initialMonth`. */
  month?: string;
  initialMonth: string | null;
  /** `initialMonth` was asked for by name, so show it first even past `max`. */
  pinInitialMonth?: boolean;
  onMonthChange?: (month: string) => void;
  numberOfMonths: 1 | 2;
  weekStart: number;
  ariaLabel?: string;
  rootAttributes?: Record<string, string | number | boolean>;
  className?: string;
}

const NAV_BUTTON = "text-text-secondary";

// The day button. Selection is the neutral inverse fill (the contrast
// button's), never accent: accent is the focus ring's, and a range is several
// cells at once.
const DAY_BUTTON =
  "relative flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-xs tabular-nums transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2";

function CalendarView({
  mode,
  selected,
  range,
  onPick,
  onPickRange,
  min,
  max,
  isDateDisabled,
  month: controlledMonth,
  initialMonth,
  pinInitialMonth = false,
  onMonthChange,
  numberOfMonths,
  weekStart,
  ariaLabel,
  rootAttributes,
  className,
}: CalendarViewProps) {
  const today = useToday();
  const baseId = useId();
  const [ownMonth, setOwnMonth] = useState(() => {
    const first = initialMonth ?? monthOf(clampIso(today, min, max));
    return pinInitialMonth ? first : fitMonthsToMax(first, numberOfMonths, min, max);
  });
  const month = controlledMonth ?? ownMonth;
  const lastMonth = shiftMonth(month, numberOfMonths - 1);
  const [focused, setFocused] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const focusPending = useRef(false);

  const inView = (iso: string | null): iso is string =>
    iso !== null && monthOf(iso) >= month && monthOf(iso) <= lastMonth;
  // The one tab stop: where the keyboard left off, else the selection, else
  // today, else the first of the month, whichever is on screen.
  const active =
    [focused, anchor, selected, range?.start ?? null, today].find(inView) ?? firstOfMonth(month);

  const isDisabled = (iso: string) =>
    (min !== null && iso < min) || (max !== null && iso > max) || callDisabled(isDateDisabled, iso);

  const changeMonth = (next: string) => {
    if (controlledMonth === undefined) setOwnMonth(next);
    onMonthChange?.(next);
  };

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${active}"]`)?.focus();
  });

  const moveTo = (target: string) => {
    const next = clampIso(target, min, max);
    setFocused(next);
    setHovered(null);
    const nextMonth = monthOf(next);
    if (nextMonth < month) changeMonth(nextMonth);
    else if (nextMonth > lastMonth) changeMonth(shiftMonth(nextMonth, 1 - numberOfMonths));
    focusPending.current = true;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = event.target instanceof HTMLElement ? event.target.dataset.date : undefined;
    if (from === undefined) return;
    const intoWeek = (weekday(from) - weekStart + 7) % 7;
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(from, -1),
      ArrowRight: () => addDays(from, 1),
      ArrowUp: () => addDays(from, -7),
      ArrowDown: () => addDays(from, 7),
      PageUp: () => addMonths(from, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(from, event.shiftKey ? 12 : 1),
      Home: () => addDays(from, -intoWeek),
      End: () => addDays(from, 6 - intoWeek),
    };
    const target = Object.hasOwn(step, event.key) ? step[event.key]!() : null;
    if (target === null) return;
    event.preventDefault();
    moveTo(target);
  };

  const pick = (iso: string) => {
    setFocused(iso);
    if (isDisabled(iso)) return;
    if (mode === "single") {
      onPick(iso);
      return;
    }
    if (anchor === null) {
      setAnchor(iso);
      return;
    }
    setAnchor(null);
    setHovered(null);
    onPickRange(anchor <= iso ? { start: anchor, end: iso } : { start: iso, end: anchor });
  };

  // While the second end is being chosen, the range runs from the first to
  // whatever the pointer or keyboard is on.
  const previewEnd = anchor === null ? null : (hovered ?? focused ?? anchor);
  const band: DateRange | null =
    anchor !== null && previewEnd !== null
      ? anchor <= previewEnd
        ? { start: anchor, end: previewEnd }
        : { start: previewEnd, end: anchor }
      : mode === "range"
        ? range
        : null;

  const names = weekdayNames(weekStart);
  const months = Array.from({ length: numberOfMonths }, (_, index) => shiftMonth(month, index));
  const canGoBack = month > monthOf(FIRST_ISO) && (min === null || monthOf(min) < month);
  const canGoForward = lastMonth < monthOf(LAST_ISO) && (max === null || monthOf(max) > lastMonth);

  return (
    <div
      {...rootAttributes}
      ref={gridRef}
      role="group"
      aria-label={ariaLabel}
      data-slot="calendar"
      className={cn("inline-flex gap-4 text-text-primary", className)}
      onKeyDown={handleKeyDown}
      onPointerLeave={() => setHovered(null)}
    >
      {months.map((shown, index) => {
        const captionId = `${baseId}-caption-${index}`;
        return (
          <div key={shown} className="flex flex-col gap-1">
            <div className="flex h-7 items-center justify-between gap-1">
              {index === 0 ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={NAV_BUTTON}
                  aria-label="Previous month"
                  disabled={!canGoBack}
                  onClick={() => changeMonth(shiftMonth(month, -1))}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
              ) : (
                <span className="w-6" aria-hidden="true" />
              )}
              <span id={captionId} aria-live="polite" className="text-sm font-medium">
                {formatMonthLabel(shown)}
              </span>
              {index === numberOfMonths - 1 ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={NAV_BUTTON}
                  aria-label="Next month"
                  disabled={!canGoForward}
                  onClick={() => changeMonth(shiftMonth(month, 1))}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              ) : (
                <span className="w-6" aria-hidden="true" />
              )}
            </div>
            <table
              role="grid"
              aria-labelledby={captionId}
              aria-multiselectable={mode === "range" ? true : undefined}
              className="border-collapse"
            >
              <thead>
                <tr>
                  {names.map((name) => (
                    <th
                      key={name.long}
                      scope="col"
                      abbr={name.long}
                      className="h-7 w-8 p-0 text-2xs font-normal text-text-secondary"
                    >
                      {name.short}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthWeeks(shown, weekStart).map((week, row) => (
                  <tr key={row}>
                    {week.map((iso, column) => {
                      if (iso === null) return <td key={`blank-${column}`} className="p-0" />;
                      const disabled = isDisabled(iso);
                      const inBand = band !== null && iso >= band.start && iso <= band.end;
                      const isEnd =
                        mode === "range"
                          ? band !== null && (iso === band.start || iso === band.end)
                          : iso === selected;
                      const isSelected = mode === "range" ? inBand && anchor === null : isEnd;
                      return (
                        <td
                          key={iso}
                          aria-selected={isSelected}
                          className={cn(
                            "p-0",
                            inBand && "bg-overlay-selected",
                            band !== null && iso === band.start && "rounded-l-[var(--radius-md)]",
                            band !== null && iso === band.end && "rounded-r-[var(--radius-md)]"
                          )}
                        >
                          <button
                            type="button"
                            data-date={iso}
                            tabIndex={iso === active ? 0 : -1}
                            aria-label={formatFullDate(iso)}
                            aria-current={iso === today ? "date" : undefined}
                            aria-disabled={disabled || undefined}
                            onClick={() => pick(iso)}
                            onPointerEnter={anchor === null ? undefined : () => setHovered(iso)}
                            className={cn(
                              DAY_BUTTON,
                              isEnd
                                ? "bg-text-primary font-medium text-text-inverse"
                                : "text-text-primary hover:bg-overlay-hover",
                              disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                              iso === today &&
                                "after:absolute after:bottom-1 after:h-0.5 after:w-0.5 after:rounded-full after:bg-current"
                            )}
                          >
                            {formatDayNumber(iso)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function KitCalendar(props: PluginCalendarProps) {
  const {
    mode,
    min,
    max,
    isDateDisabled,
    month,
    defaultMonth,
    onMonthChange,
    numberOfMonths,
    weekStartsOn,
    "aria-label": ariaLabel,
    className,
  } = props;
  const rangeMode = mode === "range";
  const controlled = Object.hasOwn(props, "value");
  const [ownSingle, setOwnSingle] = useState(() =>
    rangeMode ? null : toIsoDate(props.defaultValue)
  );
  const [ownRange, setOwnRange] = useState(() =>
    rangeMode ? toDateRange(props.defaultValue) : null
  );
  const selected = rangeMode ? null : controlled ? toIsoDate(props.value) : ownSingle;
  const range = rangeMode ? (controlled ? toDateRange(props.value) : ownRange) : null;
  const onValueChange = reporter(props.onValueChange);
  const minIso = toIsoDate(min);
  const maxIso = toIsoDate(max);
  const controlledMonth = toIsoMonth(month) ?? undefined;
  return (
    <CalendarView
      mode={rangeMode ? "range" : "single"}
      selected={selected}
      range={range}
      onPick={(iso) => {
        if (!controlled) setOwnSingle(iso);
        onValueChange?.(iso);
      }}
      onPickRange={(next) => {
        if (!controlled) setOwnRange(next);
        onValueChange?.(next);
      }}
      min={minIso}
      max={maxIso !== null && minIso !== null && maxIso < minIso ? null : maxIso}
      isDateDisabled={fn(isDateDisabled)}
      month={controlledMonth}
      initialMonth={
        toIsoMonth(defaultMonth) ??
        (selected !== null ? monthOf(selected) : range ? monthOf(range.start) : null)
      }
      pinInitialMonth={toIsoMonth(defaultMonth) !== null}
      onMonthChange={fn(onMonthChange)}
      numberOfMonths={numberOfMonths === 2 ? 2 : 1}
      weekStart={readWeekStart(weekStartsOn)}
      ariaLabel={str(ariaLabel)}
      rootAttributes={pickRootProps(props)}
      className={str(className)}
    />
  );
}

// ── Date fields ──────────────────────────────────────────────────────────

// One box drawn like the kit Input and Select trigger, holding the text and
// its buttons. The ring is painted once on the box via has-[input:focus-visible]
// (the compound-field pattern of the project dialogs), so the input inside
// draws none of its own.
const FIELD =
  "flex w-full items-center gap-0.5 bg-surface-input border border-border-input rounded-[var(--radius-md)] text-text-primary transition-colors duration-150 ease-out has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-accent-primary has-[input:focus-visible]:outline-offset-2";

// The box's height comes from the text, as the Input's does: the input inside
// carries the Input's vertical padding and the box its type size, so default
// is the Input's 34px, and compact the 28px step of a compact Select trigger.
// No percentage height on the input: against the box's auto height Chromium
// resolves one to less than the text needs, and the field came out short.
const FIELD_DENSITY = {
  default: "pl-3 pr-1 text-sm",
  compact: "h-7 pl-2 pr-0.5 text-xs",
} as const;

const FIELD_INPUT_DENSITY = {
  default: "py-1.5",
  compact: "py-1",
} as const;

// `truncate`: a value wider than the field ends in an ellipsis while it is not
// being edited, instead of being cut off mid-date.
const FIELD_INPUT =
  "min-w-0 flex-1 truncate bg-transparent text-text-primary placeholder:text-text-placeholder focus:outline-hidden disabled:cursor-not-allowed";

interface DateFieldProps {
  mode: Mode;
  /** Every field prop, still untyped: this component narrows them. */
  props: PluginDatePickerProps | PluginDateRangePickerProps;
}

// The panel's widths, from the classes that draw it: a month is seven `w-8`
// days, months sit `gap-4` apart, the panel pads `p-3` inside a 1px border,
// and the preset rail is `min-w-28` plus its `pr-3`, rule and `gap-3`.
const MONTH_WIDTH = 7 * 32;
const MONTH_GAP = 16;
const PANEL_CHROME = 2 * 12 + 2;
const PRESET_RAIL = 112 + 12 + 1 + 12;

export interface RangePanelLayout {
  months: 1 | 2;
  /** Where the presets go: a rail beside the months, or wrapped above one. */
  presets: "beside" | "above";
}

/**
 * How a range picker's panel fits `availableWidth`: two months only when
 * they fit in a row with the preset rail, else one; and when even the rail
 * and one month do not fit, the presets wrap above the month instead.
 */
export function rangePanelLayout(availableWidth: number, hasPresets: boolean): RangePanelLayout {
  const rail = hasPresets ? PRESET_RAIL : 0;
  const twoMonths = PANEL_CHROME + rail + 2 * MONTH_WIDTH + MONTH_GAP;
  if (availableWidth >= twoMonths) return { months: 2, presets: "beside" };
  const oneMonth = PANEL_CHROME + rail + MONTH_WIDTH;
  return { months: 1, presets: !hasPresets || availableWidth >= oneMonth ? "beside" : "above" };
}

type FieldValue = string | DateRange | null;

function readValue(mode: Mode, value: unknown): FieldValue {
  return mode === "range" ? toDateRange(value) : toIsoDate(value);
}

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return sameRange(a, b);
}

// A range reads collapsed at rest and in full while edited (see `formatEditableRange`).
function formatValue(value: FieldValue, editing: boolean): string {
  if (value === null) return "";
  if (typeof value === "string") return formatFieldDate(value);
  return editing ? formatEditableRange(value) : formatFieldRange(value);
}

function isoValue(value: FieldValue): string {
  if (value === null) return "";
  return typeof value === "string" ? value : `${value.start}/${value.end}`;
}

function DateField({ mode, props }: DateFieldProps) {
  const {
    min,
    max,
    isDateDisabled,
    weekStartsOn,
    placeholder,
    clearable,
    disabled,
    required,
    invalid,
    name,
    open,
    onOpenChange,
    density,
    id,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    className,
  } = props;
  // The id names the input, where a FormField's label points; the box takes the rest.
  const { id: _inputId, ...rootAttributes } = pickRootProps(props);
  const presets = mode === "range" ? readPresets(Reflect.get(props, "presets")) : [];
  const today = useToday();
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Alt+Down opens the calendar from the input, not the trigger, so the close
  // hands focus back there; a press inside the panel makes that ringless.
  const openedFromInput = useRef(false);
  const pressedInside = useRef(false);
  const controlled = Object.hasOwn(props, "value");
  const [ownValue, setOwnValue] = useState<FieldValue>(() => readValue(mode, props.defaultValue));
  const value = controlled ? readValue(mode, props.value) : ownValue;
  const [text, setText] = useState<string | null>(null);
  const [typedInvalid, setTypedInvalid] = useState(false);
  const [editing, setEditing] = useState(false);
  const controlledOpen = typeof open === "boolean" ? open : undefined;
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = controlledOpen ?? ownOpen;
  // The room the panel has, measured as it opens (however it was opened) and
  // again as the window resizes under it. The portal mounts the panel from its
  // own layout effect, so the calendar first renders with this width, before paint.
  const [roomWidth, setRoomWidth] = useState(Number.POSITIVE_INFINITY);
  const layout = rangePanelLayout(roomWidth, presets.length > 0);
  const handleOpen = fn(onOpenChange);
  const handleValue = reporter(props.onValueChange);

  const minIso = toIsoDate(min);
  const maxRaw = toIsoDate(max);
  const maxIso = maxRaw !== null && minIso !== null && maxRaw < minIso ? null : maxRaw;
  const disabledCheck = fn(isDateDisabled);
  const inert = disabled === true;
  const mustHaveValue = required === true;

  const allowed = (iso: string) =>
    !(minIso !== null && iso < minIso) &&
    !(maxIso !== null && iso > maxIso) &&
    !callDisabled(disabledCheck, iso);

  const setOpen = (next: boolean, fromInput = false) => {
    if (next) {
      openedFromInput.current = fromInput;
      pressedInside.current = false;
    }
    if (controlledOpen === undefined) setOwnOpen(next);
    handleOpen?.(next);
  };

  const change = (next: FieldValue) => {
    setText(null);
    setTypedInvalid(false);
    if (sameValue(next, value)) return;
    if (!controlled) setOwnValue(next);
    handleValue?.(next);
  };

  const commitText = () => {
    if (text === null) return;
    if (text.trim() === "") {
      if (mustHaveValue) {
        setText(null);
        setTypedInvalid(false);
      } else {
        change(null);
      }
      return;
    }
    const parsed = mode === "range" ? parseRangeText(text, today) : parseDateText(text, today);
    const ok =
      parsed !== null &&
      (typeof parsed === "string" ? allowed(parsed) : allowed(parsed.start) && allowed(parsed.end));
    if (!ok) {
      setTypedInvalid(true);
      return;
    }
    change(parsed);
  };

  useLayoutEffect(() => {
    if (isOpen) setRoomWidth(getPopoverAvailableWidth());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const measure = () => setRoomWidth(getPopoverAvailableWidth());
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isOpen]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      // Settle typed text before an enclosing form sees the key and submits.
      if (text === null) return;
      event.preventDefault();
      commitText();
    } else if (event.key === "Escape" && text !== null) {
      // The first Escape puts the text back; the next reaches the surface.
      event.preventDefault();
      event.stopPropagation();
      setText(null);
      setTypedInvalid(false);
    } else if (event.key === "ArrowDown" && event.altKey) {
      event.preventDefault();
      commitText();
      setOpen(true, true);
    }
  };

  const { invalid: showInvalid, controlProps } = useKitFieldControl(
    {
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
    },
    typedInvalid ? true : invalidProp(invalid)
  );

  const noun = mode === "range" ? "dates" : "date";
  const canClear = clearable !== false && !mustHaveValue && !inert && value !== null;
  const compact = density === "compact";
  const selected = typeof value === "string" ? value : null;
  const range = value !== null && typeof value !== "string" ? value : null;
  const pickedPreset = presets.find((preset) => sameRange(preset.range, range));
  // A preset is held to the same rules as a typed range: both ends allowed.
  const presetAllowed = (preset: DateRange) => allowed(preset.start) && allowed(preset.end);

  const calendar = (
    <CalendarView
      mode={mode}
      selected={selected}
      range={range}
      onPick={(iso) => {
        change(iso);
        setOpen(false);
      }}
      onPickRange={(next) => {
        change(next);
        setOpen(false);
      }}
      min={minIso}
      max={maxIso}
      isDateDisabled={disabledCheck}
      initialMonth={
        selected !== null ? monthOf(selected) : range !== null ? monthOf(range.start) : null
      }
      numberOfMonths={mode === "range" ? layout.months : 1}
      weekStart={readWeekStart(weekStartsOn)}
    />
  );

  return (
    // Modal, as the date picker dialog pattern asks: Tab stays in the calendar,
    // the page behind is inert, and Escape or a click away closes it and hands
    // focus back (to the calendar button, or the text when Alt+Down opened it).
    <Popover modal open={isOpen} onOpenChange={(next) => setOpen(next)}>
      <PopoverAnchor asChild>
        <div
          {...rootAttributes}
          data-slot={mode === "range" ? "date-range-picker" : "date-picker"}
          className={cn(
            FIELD,
            FIELD_DENSITY[compact ? "compact" : "default"],
            showInvalid && "border-status-error has-[input:focus-visible]:outline-status-error",
            inert && "cursor-not-allowed opacity-50",
            str(className)
          )}
        >
          <input
            ref={inputRef}
            type="text"
            id={nonEmpty(id)}
            aria-label={str(ariaLabel)}
            aria-labelledby={str(ariaLabelledBy)}
            aria-describedby={str(ariaDescribedBy)}
            {...controlProps}
            value={text ?? formatValue(value, editing)}
            onChange={(event) => {
              setText(event.target.value);
              setTypedInvalid(false);
            }}
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false);
              commitText();
            }}
            onKeyDown={handleKeyDown}
            placeholder={str(placeholder) ?? (mode === "range" ? "Choose dates" : "Choose a date")}
            disabled={inert}
            required={mustHaveValue}
            autoComplete="off"
            spellCheck={false}
            className={cn(FIELD_INPUT, FIELD_INPUT_DENSITY[compact ? "compact" : "default"])}
          />
          {canClear ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-text-secondary"
              aria-label={`Clear ${noun}`}
              onClick={() => {
                change(null);
                inputRef.current?.focus();
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
              disabled={inert}
            >
              <CalendarDays aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          {nonEmpty(name) ? <input type="hidden" name={name} value={isoValue(value)} /> : null}
        </div>
      </PopoverAnchor>
      <PopoverContent
        {...owner}
        align="start"
        aria-label={`Choose ${noun}`}
        // Radix traps focus and hides the page but leaves the role unqualified.
        aria-modal="true"
        // Still a popover to the Escape backstop, so a Sheet under it stays open.
        {...{ [ESCAPE_RADIX_LAYER_ATTR]: "" }}
        className={cn("w-auto max-w-[var(--radix-popover-content-available-width)] p-3", overlayZ)}
        onPointerDownCapture={() => {
          pressedInside.current = true;
        }}
        onKeyDownCapture={() => {
          pressedInside.current = false;
        }}
        onCloseAutoFocus={(event) => {
          if (!openedFromInput.current) return;
          openedFromInput.current = false;
          event.preventDefault();
          // A click away that gave focus to something else keeps it there.
          const active = document.activeElement;
          if (active !== null && active !== document.body) return;
          inputRef.current?.focus({ preventScroll: true, focusVisible: !pressedInside.current });
        }}
        onOpenAutoFocus={(event) => {
          // Straight to the grid's tab stop, as the grid pattern expects,
          // rather than the first focusable thing (the previous-month arrow).
          const panel = event.currentTarget;
          const cell =
            panel instanceof HTMLElement
              ? panel.querySelector<HTMLElement>('[data-date][tabindex="0"]')
              : null;
          if (cell) {
            event.preventDefault();
            cell.focus();
          }
        }}
      >
        {presets.length > 0 ? (
          <div
            data-presets={layout.presets}
            className={layout.presets === "beside" ? "flex gap-3" : "inline-flex flex-col gap-3"}
          >
            <div
              role="group"
              aria-label="Presets"
              className={
                layout.presets === "beside"
                  ? "flex min-w-28 flex-col gap-0.5 border-r border-border-subtle pr-3"
                  : // As wide as the month below, not the row of buttons: they wrap.
                    "flex w-0 min-w-full flex-wrap gap-1 border-b border-border-subtle pb-3"
              }
            >
              {presets.map((preset) => (
                <Button
                  key={preset.label}
                  variant="ghost"
                  size="sm"
                  pressed={preset === pickedPreset}
                  disabled={!presetAllowed(preset.range)}
                  className={cn("font-normal", layout.presets === "beside" && "justify-start")}
                  onClick={() => {
                    change(preset.range);
                    setOpen(false);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            {calendar}
          </div>
        ) : (
          calendar
        )}
      </PopoverContent>
    </Popover>
  );
}

function readPresets(value: unknown): { label: string; range: DateRange }[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: { label: string; range: DateRange }[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const label = nonEmpty(Reflect.get(entry, "label"));
    const range = toDateRange(Reflect.get(entry, "range"));
    if (label === undefined || range === null || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, range });
  }
  return out;
}

function KitDatePicker(props: PluginDatePickerProps) {
  return <DateField mode="single" props={props} />;
}

function KitDateRangePicker(props: PluginDateRangePickerProps) {
  return <DateField mode="range" props={props} />;
}

// ── TimeAgo ──────────────────────────────────────────────────────────────

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How often an age this old can visibly change. Every `TimeAgo` asking for
 * the same interval shares one `useNow` clock, so a list of ages runs a
 * handful of timers however long it is, and a day-old age wakes hourly.
 */
export function timeAgoTick(ageMs: number, verbose: boolean): number {
  const age = Math.abs(ageMs);
  // Only the spelled-out wording counts seconds; the compact one says "just now".
  if (verbose && age < MINUTE) return SECOND;
  if (age < HOUR) return 30 * SECOND;
  if (age < DAY) return 5 * MINUTE;
  return HOUR;
}

function KitTimeAgo({ value, verbose, prefix, tooltip, className, ...rest }: PluginTimeAgoProps) {
  const overlayZ = useKitOverlayZClass();
  const timestamp = toTimestamp(value);
  const valid = !Number.isNaN(timestamp);
  const spelled = verbose === true;
  const key = `${timestamp}:${spelled}`;
  const [tick, setTick] = useState(() => ({
    key,
    interval: valid ? timeAgoTick(Date.now() - timestamp, spelled) : HOUR,
  }));
  const now = useNow({ intervalMs: tick.interval });
  const wanted = valid ? timeAgoTick(now - timestamp, spelled) : HOUR;
  // The clocks at different intervals read slightly different times, so a
  // past age only ever moves to a coarser clock and a future one to a finer
  // one; a change between two clocks can then never flip back.
  const past = now >= timestamp;
  if (tick.key !== key || (past && wanted > tick.interval) || (!past && wanted < tick.interval)) {
    setTick({ key, interval: wanted });
  }
  // A time ahead of the clock by less than one tick is the clock's lag, not
  // the future: "in 1 second" for something that just happened is wrong.
  const at = timestamp > now && timestamp - now < tick.interval ? timestamp : now;
  const label = !valid
    ? "Unknown"
    : spelled
      ? formatRelativeTime(timestamp, at)
      : formatTimeAgo(timestamp, at);
  const full = valid ? new Date(timestamp).toLocaleString() : undefined;
  const lead = str(prefix);
  const element = (
    <time
      {...pickRootProps(rest)}
      dateTime={valid ? new Date(timestamp).toISOString() : undefined}
      title={tooltip === false ? full : undefined}
      className={cn("tabular-nums", str(className))}
    >
      {lead}
      {label}
    </time>
  );
  if (tooltip === false || full === undefined) return element;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{element}</TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {full}
      </TooltipContent>
    </Tooltip>
  );
}

export const pluginKitDates = {
  Calendar: KitCalendar,
  DatePicker: KitDatePicker,
  DateRangePicker: KitDateRangePicker,
  TimeAgo: KitTimeAgo,
};
