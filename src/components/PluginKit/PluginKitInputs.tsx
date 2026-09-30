import {
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown, Minus, Plus, X } from "lucide-react";
import { Virtuoso, type ItemProps, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import type {
  PluginComboboxProps,
  PluginEmojiPickerProps,
  PluginFileDropzoneProps,
  PluginMultiSelectProps,
  PluginNumberInputProps,
  PluginPickerBaseProps,
  PluginRadioGroupProps,
  PluginRadioOption,
  PluginSelectOption,
  PluginSliderProps,
  PluginTagInputProps,
} from "@shared/types/plugin-sdk-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxGlyph } from "@/components/ui/checkbox";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { useFieldControl } from "@/components/ui/field";
import { Input, inputVariants } from "@/components/ui/input";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PopoverSearchField } from "@/components/ui/PopoverSearchField";
import { RadioChoiceRow } from "@/components/ui/RadioChoice";
import { clearSearchBeforeDismiss } from "@/components/ui/SearchField";
import { selectTriggerVariants } from "@/components/ui/select";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { keyBelongsToField, stepListboxCursor } from "@/hooks/useListboxCursor";
import { cn } from "@/lib/utils";
import { renderIconSource, resolvePluginKitIcon } from "./PluginKitIcons";
import { normalizeSelectOptions, type SelectEntry } from "./kitOptions";
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
  positive,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";

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

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let out = value;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

/** Non-empty strings, first occurrence kept. */
function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "" && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function count(value: unknown): number | undefined {
  const n = positive(value, 100_000);
  return n === undefined ? undefined : Math.floor(n);
}

function readRadioOptions(options: unknown): PluginRadioOption[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const out: PluginRadioOption[] = [];
  for (const entry of options) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = nonEmpty(field(entry, "value"));
    const label = str(field(entry, "label"));
    if (value === undefined || label === undefined || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      label,
      description: nonEmpty(field(entry, "description")),
      disabled: field(entry, "disabled") === true,
    });
  }
  return out;
}

// A plain row has no card to carry the focus ring (the radio's own is
// transparent in RadioChoiceRow), so the row draws the card's ring itself.
const PLAIN_RADIO_ROW =
  "rounded-[var(--radius-sm)] px-0 py-1 has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent-primary";

function KitRadioGroup(props: PluginRadioGroupProps) {
  const {
    options,
    value,
    defaultValue,
    onValueChange,
    orientation,
    variant,
    name,
    disabled,
    required,
    className,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [uncontrolled, setUncontrolled] = useState(() => str(defaultValue) ?? "");
  const chosen = controlled ? (str(value) ?? "") : uncontrolled;
  const generatedName = useId();
  const groupName = nonEmpty(name) ?? generatedName;
  const onChange = fn(onValueChange);
  const { controlProps } = useKitFieldControl(props, undefined, false);
  const inert = disabled === true;
  const horizontal = orientation === "horizontal";
  const plain = variant === "plain";
  return (
    <div
      {...pickRootProps(props, { aria: true })}
      role="radiogroup"
      aria-label={str(props["aria-label"])}
      {...controlProps}
      aria-required={required === true ? true : undefined}
      aria-disabled={inert ? true : undefined}
      data-orientation={horizontal ? "horizontal" : "vertical"}
      className={cn(
        horizontal ? "flex flex-wrap gap-2" : plain ? "grid gap-0.5" : "grid gap-2",
        str(className)
      )}
    >
      {readRadioOptions(options).map((choice) => (
        <RadioChoiceRow
          key={choice.value}
          name={groupName}
          value={choice.value}
          checked={choice.value === chosen}
          onChange={() => {
            if (!controlled) setUncontrolled(choice.value);
            onChange?.(choice.value);
          }}
          label={choice.label}
          description={choice.description}
          disabled={inert || choice.disabled === true}
          required={required === true}
          bare={plain}
          className={cn(horizontal && !plain && "min-w-32 flex-1", plain && PLAIN_RADIO_ROW)}
        />
      ))}
    </div>
  );
}

function decimalsOf(value: number): number {
  const text = String(value);
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent) return Number(exponent[1]);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const GROUPED_NUMBER_TEXT = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * What a typed number means: a number, `null` for an empty field, or
 * `undefined` for text that is not a number. The unit may be typed along with
 * it, and thousands may be grouped with commas.
 */
export function parseNumberText(text: string, unit?: string): number | null | undefined {
  let body = text.trim();
  if (unit && body.toLowerCase().endsWith(unit.toLowerCase())) {
    body = body.slice(0, body.length - unit.length).trim();
  }
  if (body === "") return null;
  if (GROUPED_NUMBER_TEXT.test(body)) body = body.replace(/,/g, "");
  if (!NUMBER_TEXT.test(body)) return undefined;
  const parsed = Number(body);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function KitNumberInput(props: PluginNumberInputProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    min,
    max,
    step,
    precision,
    unit,
    stepper,
    placeholder,
    name,
    disabled,
    readOnly,
    required,
    invalid,
    autoFocus,
    density,
    className,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const lo = finite(min);
  const rawHi = finite(max);
  const hi = lo !== undefined && rawHi !== undefined && rawHi < lo ? undefined : rawHi;
  const stepBy = positive(step, Number.MAX_SAFE_INTEGER) ?? 1;
  const places =
    typeof precision === "number" && Number.isInteger(precision) && precision >= 0
      ? Math.min(precision, 12)
      : undefined;
  const digits = places ?? Math.min(decimalsOf(stepBy), 12);
  const suffix = nonEmpty(unit);
  const compact = density === "compact";
  const inert = disabled === true || readOnly === true;
  const withStepper = stepper !== false;
  const onChange = fn(onValueChange);

  const [own, setOwn] = useState<number | null>(() => finite(defaultValue) ?? null);
  const current = controlled ? (finite(value) ?? null) : own;
  // The text while it is being edited; `null` shows the committed value.
  const [draft, setDraft] = useState<string | null>(null);
  const format = (n: number | null) =>
    n === null ? "" : places !== undefined ? n.toFixed(places) : String(n);
  const parsed = draft === null ? current : parseNumberText(draft, suffix);
  // What stepping starts from, and so what the buttons' limits read: the
  // typed number when there is one.
  const shownValue = typeof parsed === "number" ? parsed : current;

  const commit = (next: number | null) => {
    setDraft(null);
    // Rounded, then held in bounds again: rounding can step past a bound that
    // is finer than the precision.
    const resolved =
      next === null ? null : clamp(Number(clamp(next, lo, hi).toFixed(digits)), lo, hi);
    if (resolved === current) return;
    if (!controlled) setOwn(resolved);
    onChange?.(resolved);
  };
  const commitDraft = () => {
    if (draft === null) return;
    const next = parseNumberText(draft, suffix);
    // Garbage, or an empty required field, goes back to the last value.
    if (next === undefined || (next === null && required === true)) {
      setDraft(null);
      return;
    }
    commit(next);
  };
  const stepBySteps = (steps: number) => {
    if (inert) return;
    commit(shownValue === null ? (lo ?? 0) : shownValue + steps * stepBy);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const jump = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        stepBySteps(jump);
        return;
      case "ArrowDown":
        event.preventDefault();
        stepBySteps(-jump);
        return;
      case "PageUp":
        event.preventDefault();
        stepBySteps(10);
        return;
      case "PageDown":
        event.preventDefault();
        stepBySteps(-10);
        return;
      case "Home":
        if (lo !== undefined && !inert) {
          event.preventDefault();
          commit(lo);
        }
        return;
      case "End":
        if (hi !== undefined && !inert) {
          event.preventDefault();
          commit(hi);
        }
        return;
      case "Enter":
        commitDraft();
        return;
      case "Escape":
        // The first Escape drops the edit; only an untouched field lets the layer close.
        if (draft !== null) {
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
        }
        return;
    }
  };

  const atMin = shownValue !== null && lo !== undefined && shownValue <= lo;
  const atMax = shownValue !== null && hi !== undefined && shownValue >= hi;
  const stepperButton = (direction: 1 | -1) => (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      // The arrow keys step from the field, so the buttons are for the pointer
      // and stay out of the tab order, as a native spin button's do.
      tabIndex={-1}
      aria-label={direction > 0 ? "Increase" : "Decrease"}
      disabled={inert || (direction > 0 ? atMax : atMin)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => stepBySteps(direction)}
      className={compact ? "h-5 w-5" : undefined}
    >
      {direction > 0 ? <Plus aria-hidden="true" /> : <Minus aria-hidden="true" />}
    </Button>
  );

  // Room at the field's end for the unit and the buttons drawn over it.
  const trailing = suffix !== undefined || withStepper;
  const buttonsRem = withStepper ? (compact ? 2.625 : 3.125) : 0;
  const trailingPad = trailing
    ? `calc(${0.75 + buttonsRem}rem + ${suffix ? `${suffix.length}ch` : "0px"})`
    : undefined;

  return (
    <div className={cn("relative w-full min-w-0", str(className))}>
      <Input
        {...pickRootProps(props, { aria: true })}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        autoComplete="off"
        spellCheck={false}
        value={draft ?? format(current)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={onKeyDown}
        aria-valuenow={current ?? undefined}
        aria-valuemin={lo}
        aria-valuemax={hi}
        aria-valuetext={current !== null && suffix ? `${format(current)} ${suffix}` : undefined}
        placeholder={str(placeholder)}
        name={str(name)}
        disabled={disabled === true}
        readOnly={readOnly === true}
        required={required === true}
        autoFocus={autoFocus === true}
        invalid={parsed === undefined || invalid === true ? true : undefined}
        density={compact ? "compact" : "default"}
        className="tabular-nums"
        style={trailingPad ? { paddingRight: trailingPad } : undefined}
      />
      {trailing ? (
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 pr-1">
          {suffix ? (
            <span
              aria-hidden="true"
              className={cn(
                "select-none text-text-secondary",
                compact ? "text-xs" : "text-sm",
                withStepper ? "mr-1" : "mr-2"
              )}
            >
              {suffix}
            </span>
          ) : null}
          {withStepper ? (
            <span className="pointer-events-auto flex items-center gap-0.5">
              {stepperButton(-1)}
              {stepperButton(1)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const SLIDER_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

// The host's range: the platform control, tinted with the primary ink rather
// than the accent, so the track and thumb stay neutral and the focus ring is
// the one accent on it.
const SLIDER_CLASS =
  "h-5 min-w-0 flex-1 cursor-pointer rounded-full accent-[var(--color-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A value as the native range holds it: in bounds and on a step from `lo`,
 * the nearer step winning and a tie going up, as the HTML range state does.
 */
export function snapToStep(value: number, lo: number, hi: number, step: number): number {
  const places = Math.min(Math.max(decimalsOf(step), decimalsOf(lo)), 12);
  const at = (n: number) => Number((lo + n * step).toFixed(places));
  const steps = Math.round((clamp(value, lo, hi) - lo) / step);
  const out = at(steps);
  return out > hi ? at(Math.floor((hi - lo) / step)) : out;
}

function KitSlider(props: PluginSliderProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    onValueCommit,
    min,
    max,
    step,
    formatValue,
    showValue,
    name,
    disabled,
    className,
  } = props;
  const rawLo = finite(min) ?? 0;
  const rawHi = finite(max) ?? 100;
  const [lo, hi] = rawHi > rawLo ? [rawLo, rawHi] : [0, 100];
  const stepBy = positive(step, hi - lo) ?? 1;
  const controlled = finite(value) !== undefined;
  const [own, setOwn] = useState(() => finite(defaultValue) ?? lo);
  // Snapped here rather than left to the input, so the readout and the spoken
  // value describe the value the thumb is actually on.
  const current = snapToStep(controlled ? (finite(value) ?? lo) : own, lo, hi, stepBy);
  const onChange = fn(onValueChange);
  const onCommit = fn(onValueCommit);
  const formatter = fn(formatValue);
  const words = formatter ? nonEmpty(formatter(current)) : undefined;
  const { controlProps } = useKitFieldControl(props);
  return (
    <div className={cn("flex w-full min-w-0 items-center gap-3", str(className))}>
      <input
        {...pickRootProps(props, { aria: true })}
        type="range"
        aria-label={str(props["aria-label"])}
        {...controlProps}
        min={lo}
        max={hi}
        step={stepBy}
        value={current}
        name={str(name)}
        disabled={disabled === true}
        aria-valuetext={words}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!controlled) setOwn(next);
          onChange?.(next);
        }}
        onPointerUp={(event) => onCommit?.(Number(event.currentTarget.value))}
        onKeyUp={(event) => {
          if (SLIDER_KEYS.has(event.key)) onCommit?.(Number(event.currentTarget.value));
        }}
        className={SLIDER_CLASS}
      />
      {showValue === true ? (
        <span
          aria-hidden="true"
          className={cn(
            "shrink-0 text-xs tabular-nums text-text-secondary",
            disabled === true && "opacity-50"
          )}
        >
          {words ?? String(current)}
        </span>
      ) : null}
    </div>
  );
}

type PickerRow =
  | { kind: "label"; label: string }
  | { kind: "option"; option: PluginSelectOption }
  | { kind: "custom"; value: string };

function allOptions(entries: SelectEntry[]): PluginSelectOption[] {
  return entries.flatMap((entry) => (entry.kind === "option" ? [entry.option] : entry.options));
}

function optionMatches(option: PluginSelectOption, query: string): boolean {
  return (
    option.label.toLowerCase().includes(query) ||
    (option.description?.toLowerCase().includes(query) ?? false)
  );
}

/** The list's rows for a query: group labels as rows of their own, empty groups dropped. */
export function pickerRows(entries: SelectEntry[], query: string, filtering: boolean): PickerRow[] {
  const q = query.trim().toLowerCase();
  const keep = (option: PluginSelectOption) => !filtering || q === "" || optionMatches(option, q);
  const rows: PickerRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "option") {
      if (keep(entry.option)) rows.push({ kind: "option", option: entry.option });
      continue;
    }
    const inner = entry.options.filter(keep);
    if (inner.length === 0) continue;
    if (entry.label) rows.push({ kind: "label", label: entry.label });
    for (const option of inner) rows.push({ kind: "option", option });
  }
  return rows;
}

const PICKER_ROW_PX = 28;
const PICKER_LIST_MAX_PX = 280;
const PICKER_ROW_CLASS = cn(
  PALETTE_ROW_CLASS,
  "flex cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs text-text-primary"
);

function PickerSpacer() {
  return <div aria-hidden="true" className="h-1" />;
}

// Virtuoso wraps each row; in a listbox the wrapper steps aside so the rows
// are the listbox's own options.
function PickerItem({ item: _item, ...props }: ItemProps<PickerRow>) {
  return <div {...props} role="none" className="px-1" />;
}

const PICKER_COMPONENTS = { Header: PickerSpacer, Footer: PickerSpacer, Item: PickerItem };

interface PickerProps {
  base: PluginPickerBaseProps;
  multi: boolean;
  entries: SelectEntry[];
  isChecked: (value: string) => boolean;
  isBlocked: (value: string) => boolean;
  allowCustomValue: boolean;
  hasValue: boolean;
  triggerContent: ReactNode;
  onPick: (value: string, label: string) => void;
}

/**
 * The trigger and list `Combobox` and `MultiSelect` share: a `Select`-looking
 * trigger opening a popover with the picker search strip over a virtualised
 * listbox. The search field keeps focus and drives the cursor through
 * `aria-activedescendant`, like the host's own pickers.
 */
function Picker({
  base,
  multi,
  entries,
  isChecked,
  isBlocked,
  allowCustomValue,
  hasValue,
  triggerContent,
  onPick,
}: PickerProps) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const listId = useId();
  const optionIdBase = useId();
  const optionId = (index: number) => `${optionIdBase}option-${index}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [range, setRange] = useState<ListRange | null>(null);
  const [listPx, setListPx] = useState<number | null>(null);
  const pointerOpen = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const handle = useRef<VirtuosoHandle>(null);

  const filtering = base.filter !== "none";
  const onSearch = fn(base.onSearchChange);
  const loading = base.loading === true;
  const showLoading = useDohertyGate(loading);
  const inert = base.disabled === true;
  // Disabled while open (say, during a save): the list goes with it.
  if (inert && open) setOpen(false);

  const trimmed = query.trim();
  const options = allOptions(entries);
  const offerCustom =
    allowCustomValue &&
    trimmed !== "" &&
    !options.some(
      (option) => option.value === trimmed || option.label.toLowerCase() === trimmed.toLowerCase()
    );
  const rows: PickerRow[] = [
    ...(offerCustom ? [{ kind: "custom" as const, value: trimmed }] : []),
    ...pickerRows(entries, query, filtering),
  ];
  const selectable = (row: PickerRow | undefined) =>
    row !== undefined &&
    (row.kind === "custom" ||
      (row.kind === "option" && !row.option.disabled && !isBlocked(row.option.value)));
  const selectableIndexes = rows.flatMap((row, index) => (selectable(row) ? [index] : []));
  // Clamped at read time: rows change under a fixed cursor as options load.
  // A query with no cursor of its own puts it on the first match.
  const active = selectableIndexes.includes(cursor)
    ? cursor
    : trimmed !== ""
      ? (selectableIndexes[0] ?? -1)
      : -1;
  const activeMounted =
    active >= 0 && (range === null || (active >= range.startIndex && active <= range.endIndex));

  useEffect(() => {
    if (open && active >= 0) handle.current?.scrollIntoView({ index: active });
  }, [open, active]);

  const changeQuery = (next: string) => {
    setQuery(next);
    setCursor(-1);
    onSearch?.(next);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      if (query !== "") changeQuery("");
      // A pointer opening places no cursor; a keyboard one lands on the
      // current choice, so Enter straight away changes nothing.
      const initial = pickerRows(entries, "", filtering).findIndex(
        (row) => row.kind === "option" && isChecked(row.option.value)
      );
      setCursor(pointerOpen.current ? -1 : initial);
    }
    pointerOpen.current = false;
    setOpen(next);
  };

  const pick = (row: PickerRow) => {
    if (inert || row.kind === "label") return;
    if (row.kind === "custom") onPick(row.value, row.value);
    else onPick(row.option.value, row.option.label);
    if (multi) {
      setCursor(rows.indexOf(row));
      return;
    }
    handleOpenChange(false);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const position = selectableIndexes.indexOf(active);
    const next = keyBelongsToField(event)
      ? null
      : stepListboxCursor(event.key, position, selectableIndexes.length);
    if (next !== null) {
      event.preventDefault();
      setCursor(selectableIndexes[next] ?? -1);
      return;
    }
    if (event.key === "Enter") {
      const row = active >= 0 ? rows[active] : undefined;
      // The popover portals out of any form, but its React events still reach
      // the view's ancestors: an Enter that picks is spent here.
      event.preventDefault();
      event.stopPropagation();
      if (row) pick(row);
    }
  };

  const renderRow = (index: number, row: PickerRow) => {
    if (row.kind === "label") {
      // A disabled option rather than a group label: group labels drop under
      // Chromium and VoiceOver, as the host's own pickers found.
      return (
        <div
          role="option"
          aria-disabled="true"
          aria-selected={multi ? undefined : "false"}
          aria-label={row.label}
          className={cn("px-2 pt-2.5 pb-1", PALETTE_SECTION_LABEL_CLASS)}
        >
          {row.label}
        </div>
      );
    }
    const value = row.kind === "custom" ? row.value : row.option.value;
    const blocked = !selectable(row);
    const checked = row.kind === "option" && isChecked(value);
    const Glyph =
      row.kind === "option" && row.option.icon ? resolvePluginKitIcon(row.option.icon) : undefined;
    const description = row.kind === "option" ? row.option.description : undefined;
    return (
      <div
        id={optionId(index)}
        role="option"
        // One list, one selection attribute: a single pick follows the cursor
        // through `aria-selected`; a multiple one is membership through
        // `aria-checked`, with the cursor drawn from `data-selected` alone.
        aria-selected={multi ? undefined : index === active}
        aria-checked={multi ? checked : undefined}
        aria-current={!multi && checked ? "true" : undefined}
        data-selected={multi && index === active ? "true" : undefined}
        aria-disabled={blocked ? true : undefined}
        // Move, not enter: a list opening under a resting pointer must not
        // light the row beneath it before the pointer does anything.
        onPointerMove={() => {
          if (!blocked && index !== active) setCursor(index);
        }}
        // The search field keeps focus, and with it the typing and the arrows.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!blocked) pick(row);
        }}
        className={cn(PICKER_ROW_CLASS, blocked && "cursor-not-allowed opacity-50")}
      >
        {multi ? (
          <CheckboxGlyph checked={checked} size="sm" className="mt-px" />
        ) : (
          <Check
            className={cn("mt-px h-3.5 w-3.5 shrink-0", !checked && "invisible")}
            aria-hidden="true"
          />
        )}
        {Glyph ? (
          <Glyph className="mt-px h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        ) : null}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate">
            {row.kind === "custom" ? `Use “${row.value}”` : row.option.label}
          </span>
          {description ? <span className="text-2xs text-text-secondary">{description}</span> : null}
        </span>
      </div>
    );
  };

  const estimatePx = Math.min(rows.length * PICKER_ROW_PX + 8, PICKER_LIST_MAX_PX);
  const ariaLabel = str(base["aria-label"]);
  const { controlProps } = useKitFieldControl(base);
  const emptyMessage = content(base.emptyMessage) ?? "No matches";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...pickRootProps(base, { aria: true })}
          id={str(base.id)}
          aria-label={ariaLabel}
          {...controlProps}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          disabled={inert}
          data-placeholder={hasValue ? undefined : ""}
          onPointerDown={() => {
            pointerOpen.current = true;
          }}
          onKeyDown={(event) => {
            pointerOpen.current = false;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              handleOpenChange(true);
            }
          }}
          className={cn(
            selectTriggerVariants({
              density: oneOf(base.density, ["default", "compact"] as const),
            }),
            "group min-w-0 text-left data-[placeholder]:text-text-secondary",
            str(base.className)
          )}
        >
          {triggerContent}
          <ChevronDown
            data-animated-chevron
            className="h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform duration-150 ease-out group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...owner}
        align="start"
        sideOffset={4}
        motion="drop"
        className={cn(
          "w-[var(--radix-popover-trigger-width)] min-w-56 max-w-[calc(100vw-2rem)] p-0",
          overlayZ
        )}
        onEscapeKeyDown={(event) =>
          clearSearchBeforeDismiss(event, searchRef.current, () => changeQuery(""))
        }
      >
        <PopoverSearchField
          ref={searchRef}
          autoFocus
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={nonEmpty(base.searchPlaceholder) ?? "Search…"}
          role="combobox"
          aria-label={ariaLabel ? `Search ${ariaLabel}` : "Search"}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeMounted ? optionId(active) : undefined}
        />
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-multiselectable={multi ? true : undefined}
        >
          {rows.length > 0 ? (
            <Virtuoso
              ref={handle}
              data={rows}
              style={{ height: listPx ?? estimatePx }}
              components={PICKER_COMPONENTS}
              defaultItemHeight={PICKER_ROW_PX}
              increaseViewportBy={PICKER_ROW_PX * 4}
              computeItemKey={(index, row) =>
                row.kind === "option"
                  ? `option:${row.option.value}`
                  : row.kind === "custom"
                    ? "custom"
                    : `label:${index}`
              }
              itemContent={renderRow}
              totalListHeightChanged={(px) => setListPx(Math.min(px, PICKER_LIST_MAX_PX))}
              rangeChanged={setRange}
            />
          ) : null}
        </div>
        {loading ? (
          showLoading ? (
            <div
              role="status"
              className="flex items-center gap-2 border-t border-border-default px-3 py-2 text-xs text-text-secondary"
            >
              <Spinner size="xs" />
              Loading…
            </div>
          ) : null
        ) : rows.length === 0 ? (
          <div role="status" className="px-3 py-3 text-xs text-text-secondary">
            <PluginStyleScope>{emptyMessage}</PluginStyleScope>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function hiddenInputs(
  name: string | undefined,
  values: readonly string[],
  disabled: unknown
): ReactNode {
  if (!name) return null;
  // A disabled control submits nothing, as a disabled native field does not.
  return values.map((value) => (
    <input key={value} type="hidden" name={name} value={value} disabled={disabled === true} />
  ));
}

function OptionLabel({ option, label }: { option: PluginSelectOption | undefined; label: string }) {
  const Glyph = option?.icon ? resolvePluginKitIcon(option.icon) : undefined;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {Glyph ? (
        <Glyph className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

function KitCombobox(props: PluginComboboxProps) {
  const { value, defaultValue, onValueChange, options, placeholder, allowCustomValue, name } =
    props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => str(defaultValue) ?? "");
  const current = controlled ? (str(value) ?? "") : own;
  // Options fetched per query come and go, so the label of the last pick is
  // kept for a trigger whose value is no longer in the list.
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
  const onChange = fn(onValueChange);
  const entries = normalizeSelectOptions(options);
  const known = allOptions(entries).find((option) => option.value === current);
  const label =
    current === ""
      ? undefined
      : (known?.label ?? (picked?.value === current ? picked.label : current));
  return (
    <>
      <Picker
        base={props}
        multi={false}
        entries={entries}
        isChecked={(candidate) => candidate === current}
        isBlocked={() => false}
        allowCustomValue={allowCustomValue === true}
        hasValue={label !== undefined}
        triggerContent={
          label !== undefined ? (
            <OptionLabel option={known} label={label} />
          ) : (
            <span className="min-w-0 flex-1 truncate">{str(placeholder) ?? ""}</span>
          )
        }
        onPick={(next, nextLabel) => {
          setPicked({ value: next, label: nextLabel });
          if (next === current) return;
          if (!controlled) setOwn(next);
          onChange?.(next);
        }}
      />
      {hiddenInputs(str(name), current ? [current] : [], props.disabled)}
    </>
  );
}

function KitMultiSelect(props: PluginMultiSelectProps) {
  const { value, defaultValue, onValueChange, options, placeholder, max, maxChips, name } = props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => readStrings(defaultValue));
  const current = controlled ? readStrings(value) : own;
  // A Map, not an object: values are the plugin's strings, `__proto__` included.
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
  const onChange = fn(onValueChange);
  const limit = count(max);
  const chipLimit = count(maxChips) ?? 3;
  const entries = normalizeSelectOptions(options);
  const byValue = new Map(allOptions(entries).map((option) => [option.value, option]));
  const labelOf = (v: string) => byValue.get(v)?.label ?? labels.get(v) ?? v;
  const shown = current.slice(0, chipLimit);
  const overflow = current.length - shown.length;
  return (
    <>
      <Picker
        base={props}
        multi
        entries={entries}
        isChecked={(candidate) => current.includes(candidate)}
        isBlocked={(candidate) =>
          limit !== undefined && current.length >= limit && !current.includes(candidate)
        }
        allowCustomValue={false}
        hasValue={current.length > 0}
        triggerContent={
          current.length > 0 ? (
            <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {/* The chips are drawn; the names are read once, whole. */}
              <span className="sr-only">{current.map(labelOf).join(", ")}</span>
              {shown.map((v) => (
                <Badge key={v} aria-hidden="true" size="sm" className="min-w-0 max-w-40">
                  <span className="truncate">{labelOf(v)}</span>
                </Badge>
              ))}
              {overflow > 0 ? (
                <Badge aria-hidden="true" size="sm" tone="outline" className="tabular-nums">
                  +{overflow}
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{str(placeholder) ?? ""}</span>
          )
        }
        onPick={(picked, pickedLabel) => {
          const next = current.includes(picked)
            ? current.filter((v) => v !== picked)
            : [...current, picked];
          setLabels((known) => new Map(known).set(picked, pickedLabel));
          if (!controlled) setOwn(next);
          onChange?.(next);
        }}
      />
      {hiddenInputs(str(name), current, props.disabled)}
    </>
  );
}

const TAG_SEPARATOR = /[,\n]/;

function KitTagInput(props: PluginTagInputProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    validate,
    max,
    placeholder,
    disabled,
    invalid,
    className,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => readStrings(defaultValue));
  const tags = controlled ? readStrings(value) : own;
  const [draft, setDraft] = useState("");
  const [refused, setRefused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const onChange = fn(onValueChange);
  const check = fn(validate);
  const limit = count(max);
  const inert = disabled === true;
  const { invalid: shownInvalid, controlProps } = useKitFieldControl(
    props,
    refused || invalid === true ? true : undefined
  );

  const update = (next: string[]) => {
    if (!controlled) setOwn(next);
    onChange?.(next);
  };
  const add = (pieces: readonly string[]) => {
    const next = [...tags];
    const kept: string[] = [];
    for (const piece of pieces) {
      const tag = piece.trim();
      if (tag === "") continue;
      if (next.some((existing) => existing.toLowerCase() === tag.toLowerCase())) continue;
      if ((limit !== undefined && next.length >= limit) || check?.(tag, next) === false) {
        kept.push(tag);
        continue;
      }
      next.push(tag);
    }
    if (next.length !== tags.length) update(next);
    // What was refused stays in the field, marked, to be fixed or cleared.
    setDraft(kept.join(", "));
    setRefused(kept.length > 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "," || (event.key === "Enter" && draft.trim() !== "")) {
      event.preventDefault();
      add([draft]);
      return;
    }
    if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      event.preventDefault();
      update(tags.slice(0, -1));
    }
  };

  const remove = (index: number, button: HTMLButtonElement) => {
    // The focused button is about to go; focus moves to the next tag's, or
    // to the text after the last, rather than falling to the document.
    if (button.ownerDocument.activeElement === button) {
      const buttons = boxRef.current?.querySelectorAll<HTMLButtonElement>("[data-tag-remove]");
      (buttons?.[index + 1] ?? inputRef.current)?.focus();
    }
    update(tags.filter((_, at) => at !== index));
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!TAG_SEPARATOR.test(text)) return;
    event.preventDefault();
    // The paste lands where a plain paste would: over the selection, at the caret.
    const input = event.currentTarget;
    const start = input.selectionStart ?? draft.length;
    const end = input.selectionEnd ?? start;
    add(`${draft.slice(0, start)}${text}${draft.slice(end)}`.split(TAG_SEPARATOR));
  };

  return (
    <div
      ref={boxRef}
      className={cn(
        inputVariants({ invalid: shownInvalid }),
        "flex min-w-0 flex-wrap items-center gap-1 px-1.5 py-1",
        "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent-primary",
        inert ? "cursor-not-allowed opacity-50" : "cursor-text",
        str(className)
      )}
      onPointerDown={(event) => {
        // A press on the box's padding puts the caret in the text, as it
        // would in a plain field.
        if (event.target !== event.currentTarget || inert) return;
        event.preventDefault();
        inputRef.current?.focus();
      }}
    >
      {tags.map((tag, index) => (
        <Badge key={tag} size="sm" className="min-w-0 max-w-full gap-0.5 pr-0.5 text-text-primary">
          <span className="truncate">{tag}</span>
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            disabled={inert}
            data-tag-remove=""
            onClick={(event) => remove(index, event.currentTarget)}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-xs)] text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-medium hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:pointer-events-none"
          >
            <X aria-hidden="true" />
          </button>
        </Badge>
      ))}
      <input
        ref={inputRef}
        {...pickRootProps(props, { aria: true })}
        aria-label={str(props["aria-label"])}
        {...controlProps}
        type="text"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setRefused(false);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => {
          if (draft.trim() !== "") add([draft]);
        }}
        placeholder={tags.length === 0 ? str(placeholder) : undefined}
        disabled={inert}
        autoComplete="off"
        // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the box wraps the tags and this input as one field and paints its ring via has-[input:focus-visible]; a ring here would draw a second one inside it
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-text-primary outline-hidden placeholder:text-text-placeholder disabled:cursor-not-allowed"
      />
    </div>
  );
}

/** `accept` as `<input type="file">` reads it: extensions, `type/*` and exact MIME types. */
export function fileMatchesAccept(file: { name: string; type: string }, accept?: string): boolean {
  const tokens = (accept ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const fileName = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return tokens.some((token) =>
    token.startsWith(".")
      ? fileName.endsWith(token)
      : token.endsWith("/*")
        ? type.startsWith(token.slice(0, -1))
        : type === token
  );
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function KitFileDropzone({
  onFiles,
  onReject,
  accept,
  multiple,
  disabled,
  label,
  description,
  icon,
  browseLabel,
  children,
  className,
  ...rest
}: PluginFileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Counted, because entering a child fires `dragleave` on the parent.
  const [depth, setDepth] = useState(0);
  const textId = useId();
  const inert = disabled === true;
  const many = multiple === true;
  const acceptText = nonEmpty(accept);
  const deliver = fn(onFiles);
  const reject = fn(onReject);
  const { controlProps } = useFieldControl({}, undefined, { labelable: false });
  const fieldLabel = str(field(controlProps, "aria-labelledby"));
  const over = depth > 0 && !inert;

  const take = (list: FileList | null | undefined) => {
    const files = list ? Array.from(list) : [];
    const accepted = files.filter((file) => fileMatchesAccept(file, acceptText));
    const refused = files.filter((file) => !fileMatchesAccept(file, acceptText));
    const kept = many ? accepted : accepted.slice(0, 1);
    if (refused.length > 0) reject?.(refused);
    if (kept.length > 0) deliver?.(kept);
  };
  const openDialog = () => {
    if (!inert) inputRef.current?.click();
  };

  const glyph = icon === undefined ? renderIconSource("upload") : renderIconSource(icon);
  const headline = content(label) ?? (many ? "Drop files here" : "Drop a file here");
  const detail = content(description);

  return (
    <div
      {...pickRootProps(rest)}
      data-drag-over={over ? "" : undefined}
      aria-disabled={inert ? true : undefined}
      onDragEnter={(event) => {
        if (inert || !carriesFiles(event)) return;
        event.preventDefault();
        setDepth((n) => n + 1);
      }}
      onDragOver={(event) => {
        if (inert || !carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return;
        setDepth((n) => Math.max(0, n - 1));
      }}
      onDrop={(event) => {
        if (inert || !carriesFiles(event)) return;
        event.preventDefault();
        setDepth(0);
        take(event.dataTransfer.files);
      }}
      onClick={(event) => {
        // The whole zone answers a click; the button is the keyboard's way in.
        if (event.target instanceof Element && event.target.closest("button, a, input")) return;
        openDialog();
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed px-4 py-6 text-center transition-colors duration-150 ease-out",
        over ? "border-border-strong bg-overlay-soft" : "border-border-default",
        inert ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        str(className)
      )}
    >
      {hasContent(children) ? (
        node(children)
      ) : (
        <>
          {glyph ? (
            <span className="text-text-secondary [&_svg]:h-5 [&_svg]:w-5">{glyph}</span>
          ) : null}
          <span className="text-sm text-text-primary">{headline}</span>
          {detail !== undefined ? (
            <span className="text-xs text-text-secondary">{detail}</span>
          ) : null}
        </>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={inert}
        onClick={openDialog}
        {...controlProps}
        // Inside a FormField the button is named by the field's label and
        // then its own words ("Attachments Choose files…").
        aria-labelledby={fieldLabel ? `${fieldLabel} ${textId}` : undefined}
      >
        <span id={textId}>
          {nonEmpty(browseLabel) ?? (many ? "Choose files…" : "Choose file…")}
        </span>
      </Button>
      <input
        ref={inputRef}
        type="file"
        hidden
        tabIndex={-1}
        accept={acceptText}
        multiple={many}
        disabled={inert}
        onChange={(event) => {
          take(event.target.files);
          // Cleared, so choosing the same file again still reports it.
          event.target.value = "";
        }}
      />
    </div>
  );
}

function KitEmojiPicker({
  trigger,
  onSelect,
  value,
  open,
  defaultOpen,
  onOpenChange,
  side,
  align,
  "aria-label": ariaLabel,
}: PluginEmojiPickerProps) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const controlled = typeof open === "boolean";
  const [own, setOwn] = useState(defaultOpen === true);
  const select = fn(onSelect);
  const changeOpen = fn(onOpenChange);
  if (!isValidElement(trigger)) return null;
  const setOpen = (next: boolean) => {
    if (!controlled) setOwn(next);
    changeOpen?.(next);
  };
  return (
    <Popover open={controlled ? open : own} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        {...owner}
        side={oneOf(side, SIDES)}
        align={oneOf(align, ALIGNS) ?? "start"}
        aria-label={nonEmpty(ariaLabel) ?? "Choose emoji"}
        className={cn("w-auto p-0", overlayZ)}
      >
        <EmojiPicker
          currentEmoji={nonEmpty(value)}
          onEmojiSelect={({ emoji }) => {
            select?.(emoji);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export const pluginKitInputs = {
  RadioGroup: KitRadioGroup,
  NumberInput: KitNumberInput,
  Slider: KitSlider,
  Combobox: KitCombobox,
  MultiSelect: KitMultiSelect,
  TagInput: KitTagInput,
  FileDropzone: KitFileDropzone,
  EmojiPicker: KitEmojiPicker,
};
