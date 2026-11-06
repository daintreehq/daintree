import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Clock, X } from "lucide-react";
import type {
  PluginDateTimePickerProps,
  PluginTimePickerProps,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { FieldBoundary, InlineError } from "@/components/ui/field";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ESCAPE_RADIX_LAYER_ATTR } from "@/lib/dialogEscapeBackstop";
import { cn } from "@/lib/utils";
import { todayIso } from "@/pluginUi/dateMath";
import {
  clamp,
  field,
  fn,
  nonEmpty,
  pickRootProps,
  positive,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { joinIds } from "./kitTextInputHelpers";
import { useKitOverlayZClass, KitFocusScopeContext } from "./kitScope";
import { pluginKitDates } from "./PluginKitDates";
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
import {
  invalidProp,
  type KitAriaInput,
  useKitFieldControl,
  focusLeft,
  useKitFocusScope,
} from "./kitField";

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
  /** The plugin's verdict; `undefined` defers to the FormField. */
  invalid: boolean | undefined;
  density: "default" | "compact";
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  name: string | undefined;
  ariaProps: KitAriaInput & { id?: unknown };
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
  const focusScope = useKitFocusScope();
  // A draft belongs to the value it was edited from: a new value from outside
  // replaces it, rather than a half-typed edit of the old one outliving it.
  const [held, setHeld] = useState<{ parts: TimeDraft; source: number | null } | null>(null);
  const [typedState, setTypedState] = useState<{
    segment: SegmentKind;
    digits: string;
    source: number | null;
  } | null>(null);
  // Why a whole typed time was refused. While the draft stays the field is
  // invalid; once leaving it put the committed time back, the line says the
  // time wasn't changed, so what is on screen is always what the form holds.
  // A refusal belongs to the value it was made against, like a draft: a new
  // value from outside makes its "wasn't changed" untrue.
  const [refusal, setRefusalState] = useState<{
    reason: string;
    reverted: boolean;
    source: number | null;
  } | null>(null);
  const setRefusal = (next: { reason: string; reverted: boolean } | null) =>
    setRefusalState(next === null ? null : { ...next, source: value });
  const typedInvalid = refusal !== null && !refusal.reverted;
  const setTypedInvalid = (invalidNow: boolean) =>
    setRefusal(invalidNow ? { reason: boundsReason(), reverted: false } : null);
  const refusalId = useId();
  const typed = typedState;
  const setTyped = (next: { segment: SegmentKind; digits: string } | null) =>
    setTypedState(next === null ? null : { ...next, source: value });
  if (
    (held !== null && held.source !== value) ||
    (typed !== null && typed.source !== value) ||
    (refusal !== null && refusal.source !== value)
  ) {
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
  // The segment Alt+Down opened the list from, which gets focus back on close.
  const openedFrom = useRef<SegmentKind | null>(null);
  const shown = draft ?? draftOf(value, cycle);
  const [am, pm] = dayPeriodNames();
  const segments: SegmentKind[] = cycle === 12 ? ["hour", "minute", "period"] : ["hour", "minute"];
  const { invalid: showInvalid, controlProps } = useKitFieldControl(
    ariaProps,
    typedInvalid ? true : invalid,
    false
  );

  const setOpen = (next: boolean) => {
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
    if (!next) onBlur?.();
  };

  const inRange = (minutes: number) =>
    !(min !== null && minutes < min) && !(max !== null && minutes > max);
  function boundsReason(): string {
    const from = min === null ? null : formatTimeLabel(min, cycle);
    const to = max === null ? null : formatTimeLabel(max, cycle);
    if (from !== null && to !== null) return `Choose a time from ${from} to ${to}`;
    return from !== null ? `Choose ${from} or later` : `Choose ${to ?? ""} or earlier`;
  }

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
      if (minutes !== value) {
        // A digit still being typed belongs to the value this edit just sent,
        // not the one it replaced: the next digit carries on from it.
        setTypedState((current) => (current === null ? null : { ...current, source: minutes }));
        onChange(minutes);
      }
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
    // A new edit has begun, so the line about the last one is over, even for a
    // held leading digit that doesn't reach apply().
    if (refusal?.reverted) setRefusal(null);
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
      openedFrom.current = kind;
      setOpen(true);
    } else if (key === "Enter") {
      // A segment is not an input, so the form's implicit submission is ours to give.
      event.preventDefault();
      event.currentTarget.closest("form")?.requestSubmit();
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      stepSegment(kind, key === "ArrowUp" ? 1 : -1);
    } else if (key === "Home" || key === "End") {
      // The spin button's bounds, as its aria-valuemin and aria-valuemax say.
      event.preventDefault();
      setTyped(null);
      apply({ ...shown, [kind]: range(kind)[key === "Home" ? 0 : 1] });
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

  const box = (
    <Popover modal open={isOpen} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          {...rootAttributes}
          data-slot="time-picker"
          onBlur={(event) => {
            if (!isOpen && focusLeft(event, focusScope.id)) onBlur?.();
          }}
          onPointerDown={(event) => {
            // The segments are only as big as their digits, so a press anywhere
            // else in the box goes to the one nearest it, as a native field does.
            if (disabled || event.button !== 0) return;
            const target = event.target as HTMLElement;
            if (target.closest("[data-segment], button")) return;
            const nearest = [
              ...(boxRef.current?.querySelectorAll<HTMLElement>("[data-segment]") ?? []),
            ].reduce<{ el: HTMLElement; distance: number } | null>((best, el) => {
              const rect = el.getBoundingClientRect();
              const distance = Math.abs(event.clientX - (rect.left + rect.width / 2));
              return best === null || distance < best.distance ? { el, distance } : best;
            }, null);
            if (!nearest) return;
            event.preventDefault();
            nearest.el.focus();
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
            {...(refusal
              ? {
                  "aria-describedby": joinIds([
                    refusalId,
                    str(field(controlProps, "aria-describedby")) ??
                      str(ariaProps["aria-describedby"]),
                  ]),
                }
              : {})}
            id={nonEmpty(ariaProps.id) ?? controlProps.id}
            aria-disabled={disabled || undefined}
            aria-description={spokenValue}
            onBlur={(event) => {
              // Leaving the field with any draft it hasn't committed (half a
              // time, an empty one that may not be cleared, or a whole one out
              // of range) puts the committed time back. The field's own list
              // is not leaving it: it is modal, and closing it hands focus back
              // to the segment it opened from. Either way the line says so, or
              // the time on screen changes back with nothing to say why.
              if (!focusLeft(event, focusScope.id)) return;
              // A held leading digit (the 0 of a 12-hour "09") never reached the
              // draft, but leaving drops it all the same.
              const heldBelowRange =
                typed !== null && Number(typed.digits) < range(typed.segment)[0];
              setTyped(null);
              if (draft === null) {
                if (heldBelowRange) setRefusal({ reason: `Enter a whole ${noun}`, reverted: true });
                return;
              }
              setDraft(null);
              setRefusal({
                reason: typedInvalid ? boundsReason() : `Enter a whole ${noun}`,
                reverted: true,
              });
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
        {...focusScope.attributes}
        align="start"
        // As wide as the field, it unrolls from it, as the host's lists do.
        motion="drop"
        aria-label={`Choose ${noun}`}
        aria-modal="true"
        {...{ [ESCAPE_RADIX_LAYER_ATTR]: "" }}
        className={cn("w-auto p-0", overlayZ)}
        onCloseAutoFocus={(event) => {
          const from = openedFrom.current;
          openedFrom.current = null;
          if (from === null) return;
          event.preventDefault();
          // A click away that gave focus to something else keeps it there.
          const active = document.activeElement;
          if (active !== null && active !== document.body) return;
          boxRef.current
            ?.querySelector<HTMLElement>(`[data-segment="${from}"]`)
            ?.focus({ preventScroll: true });
        }}
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
  // Beside the field rather than in it, as the DatePicker's: a fragment keeps
  // the segments mounted when the line comes and goes.
  return (
    <>
      {box}
      {refusal ? (
        <InlineError id={refusalId} role="alert" className="mt-1.5 basis-full">
          {refusal.reverted ? `${refusal.reason}. The ${noun} wasn't changed.` : refusal.reason}
        </InlineError>
      ) : null}
    </>
  );
}

function readCycle(value: unknown): 12 | 24 {
  return value === 12 || value === 24 ? value : localeHourCycle();
}

export function KitTimePicker(props: PluginTimePickerProps) {
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
      invalid={invalidProp(props.invalid)}
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

export function KitDateTimePicker(props: PluginDateTimePickerProps) {
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
  // A time typed before any day, when today is ruled out: kept and shown, and
  // used once a day is chosen, rather than dropped without a word.
  const [pendingTime, setPendingTime] = useState<number | null>(null);
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
  const { controlProps } = useKitFieldControl(props, invalidProp(invalid), false);
  const focusScope = useKitFocusScope();
  const overlayZ = useKitOverlayZClass();
  const compact = density === "compact";
  const { id: _id, ...rootAttributes } = pickRootProps(props);

  // A held day only stands in while there is no value; a whole value from
  // outside replaces it, so clearing that later cannot bring it back.
  if (value !== null && pendingDate !== null) setPendingDate(null);
  if (value !== null && pendingTime !== null) setPendingTime(null);
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
        if (focusLeft(event, focusScope.id)) onBlur?.();
      }}
      className={cn("flex w-full min-w-0 flex-wrap items-center gap-2", str(className))}
    >
      {/* The two parts' popovers are this field's own: focus moving into one
          is not leaving it. */}
      <KitFocusScopeContext.Provider value={focusScope.scopes}>
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
              // The time kept from before (or typed while there was no day),
              // else the day's earliest, held to the new day's bounds.
              setPendingDate(null);
              setPendingTime(null);
              emit({
                date: nextDate,
                minutes: fitTime(nextDate, value?.minutes ?? pendingTime ?? 0),
              });
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
              value={value?.minutes ?? pendingTime}
              onChange={(minutes) => {
                setPendingTime(null);
                if (minutes === null) {
                  if (value !== null) setPendingDate(value.date);
                  emit(null);
                  return;
                }
                // No day yet: today, held to the allowed days. A day the plugin
                // rules out is not filled in behind the user's back; the time
                // waits for one instead.
                let day = date ?? todayIso(Date.now());
                if (date === null) {
                  if (lo !== null && day < lo.date) day = lo.date;
                  if (hi !== null && day > hi.date) day = hi.date;
                  if (dayDisabled(isDateDisabled, day)) {
                    setPendingTime(minutes);
                    return;
                  }
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
              invalid={invalidProp(invalid)}
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
      </KitFocusScopeContext.Provider>
      {pendingTime !== null && date === null ? (
        <p role="status" className="m-0 basis-full text-xs text-text-secondary">
          Choose a date to use this time
        </p>
      ) : null}
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
          <TooltipContent side="bottom" className={overlayZ}>
            {zoneId ?? zoneName}
          </TooltipContent>
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
