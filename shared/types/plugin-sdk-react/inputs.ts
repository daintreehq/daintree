// Inputs and forms: text fields, selects, checkboxes, switches, radio groups,
// numbers, sliders, pickers, tags, file drops, emoji, dates and times, colours,
// mention autocomplete, the agent composer, inline rename, key/value and list
// editors, secrets, shortcut recording, form state and forms generated from a
// JSON Schema.
// Each input joins an enclosing `FormField` on its own; in a `SettingsRow`, pass
// the row's `labelId` and `descriptionId` as `aria-labelledby` / `aria-describedby`.

import type { KeyboardEvent, ReactElement, ReactNode, Ref } from "react";
import type { PluginArtifact } from "../pluginArtifacts.js";
import type {
  PluginAlign,
  PluginAriaRootAttributes,
  PluginButtonVariant,
  PluginDomProps,
  PluginIconSource,
  PluginRootAttributes,
  PluginSide,
} from "./common.js";
import type { PluginDropdownMenuEntry } from "./overlays.js";

/** Props of `Checkbox`. Pair it with a `<label htmlFor>` or give it an `aria-label`. */
export interface PluginCheckboxProps extends PluginDomProps<HTMLButtonElement> {
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean;
  /** Receives the new state; an indeterminate box always resolves to `true`. */
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  size?: "sm" | "md";
  className?: string;
}

/** Props of `Input`, a single-line text field. */
export interface PluginInputProps extends PluginDomProps<HTMLInputElement> {
  /**
   * `date`, `time` and `datetime-local` use the platform's
   * picker, drawn in the active theme's light or dark scheme; `value` is the
   * ISO form (`"2026-09-30"`, `"14:05"`, `"2026-09-30T14:05"`).
   */
  type?:
    | "text"
    | "search"
    | "email"
    | "url"
    | "password"
    | "number"
    | "tel"
    | "date"
    | "time"
    | "datetime-local";
  value?: string | number;
  defaultValue?: string | number;
  /** The new text on every edit, beside the native `onChange` event. */
  onValueChange?: (value: string) => void;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  spellCheck?: boolean;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  invalid?: boolean;
  /** `compact` for toolbars and filter strips. */
  density?: "default" | "compact";
  className?: string;
}

/** Props of `Textarea`. */
export interface PluginTextareaProps extends PluginDomProps<HTMLTextAreaElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  name?: string;
  rows?: number;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  spellCheck?: boolean;
  maxLength?: number;
  invalid?: boolean;
  density?: "default" | "compact";
  /** `code` for paths, prompts, JSON: anything read character by character. */
  variant?: "default" | "code";
  resize?: "vertical" | "none";
  className?: string;
}

/** One choice in a `Select` or `SegmentedControl`. */
export interface PluginSelectOption {
  /** Non-empty and unique within the control. */
  value: string;
  label: string;
  /** A second line under the label (`Select` only). */
  description?: string;
  /** A leading glyph, shown in the list and on the trigger (`Select` only). */
  icon?: PluginIconSource;
  disabled?: boolean;
}

/** A labelled run of options in a `Select`. */
export interface PluginSelectOptionGroup {
  label: string;
  options: readonly PluginSelectOption[];
}

/** Props of `Select`. The list opens in a host overlay, so only the trigger takes classes. */
export interface PluginSelectProps extends PluginAriaRootAttributes {
  options: readonly (PluginSelectOption | PluginSelectOptionGroup)[];
  /**
   * The chosen value, controlled. Passing the prop at all makes the Select
   * controlled: `""`, `null` or `undefined` then shows the `placeholder` again
   * (a form reset). Leave it out entirely for an uncontrolled Select.
   */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  disabled?: boolean;
  /** `compact` (28px) beside a compact `SearchField` in a filter bar. */
  density?: "default" | "compact";
  name?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the trigger. */
  className?: string;
}

/** One segment of a `SegmentedControl`. */
export interface PluginSegmentedOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Spoken name when the visible label is an abbreviation. */
  "aria-label"?: string;
  /** Hover detail. */
  tooltip?: ReactNode;
}

/** Props of `SegmentedControl`: pick exactly one of a few options. */
export interface PluginSegmentedControlProps extends PluginAriaRootAttributes {
  options: readonly PluginSegmentedOption[];
  value: string;
  onValueChange: (value: string) => void;
  "aria-label": string;
  "aria-describedby"?: string;
  disabled?: boolean;
  /** Fill the container, splitting it evenly. */
  fullWidth?: boolean;
  /** `compact` (24px) for a 32px toolbar strip. */
  density?: "default" | "compact";
  className?: string;
}

/** Props of `SearchField`: magnifier, text and an optional clear button in one field. */
/** Controlled only: pass `value` and update it from `onValueChange`. */
export interface PluginSearchFieldProps extends PluginDomProps<HTMLInputElement> {
  value: string;
  onValueChange?: (value: string) => void;
  /** Shows the clear button while there is text, and makes Escape clear first. */
  onClear?: () => void;
  placeholder?: string;
  "aria-label"?: string;
  clearLabel?: string;
  /** `compact` 28px (default), `dense` 24px, `palette` 38px. */
  size?: "compact" | "dense" | "palette";
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** Classes for the visible field. */
  className?: string;
}

/** What a `FormField` hands a control of your own: spread it onto the control. */
export interface PluginFormFieldControlProps {
  id: string;
  "aria-labelledby"?: string;
  /** The error, then the description. */
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * Props of `FormField`: a label, an optional description and error, and the
 * control they describe, wired for assistive tech. Kit controls (`Input`,
 * `Textarea`, `Select`, `Checkbox`, `Switch`) join the field on their own. For
 * a control of your own, pass `children` as a function and spread the props
 * it receives onto the control; `htmlFor` alone links the label only.
 */
export interface PluginFormFieldProps extends PluginRootAttributes {
  label: ReactNode;
  description?: ReactNode;
  /** Shown under the control, and marks the control invalid. */
  error?: ReactNode;
  /** Says "Required" beside the label. Also pass `required` to the control. */
  required?: boolean;
  /** The id of your own control, when it is not rendered through a `children` function. */
  htmlFor?: string;
  /** `horizontal` puts a checkbox or switch before its label, and makes the row clickable. */
  orientation?: "vertical" | "horizontal";
  /** Dims the label. Also pass `disabled` to the control. */
  disabled?: boolean;
  children: ReactNode | ((control: PluginFormFieldControlProps) => ReactNode);
  className?: string;
}

/** Props of `Switch`: an instant on/off setting. Use `Checkbox` in forms with a Save. */
export interface PluginSwitchProps extends PluginDomProps<HTMLButtonElement> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  /** @deprecated Ignored: switches draw at one size everywhere in Daintree. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Props of `FormFieldGroup`: one label over a set of controls that answer it
 * together, such as a row of checkboxes. The label matches a `FormField`'s;
 * each control inside is its own horizontal `FormField`.
 */
export interface PluginFormFieldGroupProps extends PluginRootAttributes {
  label: ReactNode;
  description?: ReactNode;
  /** Shown under the controls. */
  error?: ReactNode;
  /** Says "Required" beside the label. */
  required?: boolean;
  /** Disables every control inside and dims the label. */
  disabled?: boolean;
  /** `stack` (the default) puts one control per line; `inline` wraps them in a row. */
  layout?: "stack" | "inline";
  children?: ReactNode;
  className?: string;
}

/**
 * A calendar day as an ISO date string, `"YYYY-MM-DD"`. A day, not an
 * instant: it carries no time or zone, so `"2026-09-30"` is the 30th for
 * every user whatever their offset or daylight saving. Never round-trip one
 * through `new Date("2026-09-30")`, which reads it as UTC midnight and lands
 * on the 29th west of Greenwich.
 */
export type PluginIsoDate = string;

/** An inclusive run of days. `start` is never after `end`; a one-day range has them equal. */
export interface PluginDateRange {
  start: PluginIsoDate;
  end: PluginIsoDate;
}

export interface PluginCalendarBaseProps extends PluginRootAttributes {
  /** The earliest day that can be chosen, inclusive. */
  min?: PluginIsoDate;
  /** The latest day that can be chosen, inclusive. */
  max?: PluginIsoDate;
  /** Days that cannot be chosen (weekends, holidays). They can still take keyboard focus. */
  isDateDisabled?: (date: PluginIsoDate) => boolean;
  /** The first month shown, `"YYYY-MM"`, controlled. */
  month?: string;
  /** The first month shown at mount. Defaults to the selection's month, else this month. */
  defaultMonth?: string;
  /** The first month shown changed: a header arrow, or the keyboard moving past its edge. */
  onMonthChange?: (month: string) => void;
  /** Months side by side. Defaults to 1. */
  numberOfMonths?: 1 | 2;
  /** 0 is Sunday, 1 Monday, … 6 Saturday. Defaults to the user's locale. */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Names the calendar when nothing around it does. */
  "aria-label"?: string;
  className?: string;
}

/** Props of `Calendar` choosing one day. */
export interface PluginCalendarSingleProps extends PluginCalendarBaseProps {
  mode?: "single";
  /** The chosen day, controlled. `null` shows none. Passing the prop at all makes it controlled. */
  value?: PluginIsoDate | null;
  defaultValue?: PluginIsoDate | null;
  onValueChange?: (value: PluginIsoDate) => void;
}

/** Props of `Calendar` choosing a run of days. */
export interface PluginCalendarRangeProps extends PluginCalendarBaseProps {
  mode: "range";
  /** The chosen range, controlled. Passing the prop at all makes it controlled. */
  value?: PluginDateRange | null;
  defaultValue?: PluginDateRange | null;
  /**
   * Called once both ends are picked: the first press sets one end and the
   * second the other, in either order. Between the two the range is only
   * previewed.
   */
  onValueChange?: (value: PluginDateRange) => void;
}

/**
 * Props of `Calendar`: an inline month grid. One tab stop; arrow keys move by
 * day and week, PageUp/PageDown by month (with Shift, by year), Home/End to
 * the week's ends, Enter or Space chooses. Today is marked, selection is
 * neutral, and the month name and weekdays follow the user's locale.
 */
export type PluginCalendarProps = PluginCalendarSingleProps | PluginCalendarRangeProps;

export interface PluginDateFieldBaseProps extends PluginAriaRootAttributes {
  min?: PluginIsoDate;
  max?: PluginIsoDate;
  /** Days that cannot be chosen, in the calendar or by typing. */
  isDateDisabled?: (date: PluginIsoDate) => boolean;
  /** 0 is Sunday, 1 Monday, … 6 Saturday. Defaults to the user's locale. */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Shown while the field is empty. */
  placeholder?: string;
  /** Draws a clear button while there is a value. Default true. */
  clearable?: boolean;
  disabled?: boolean;
  /** Also pass `required` to the enclosing `FormField`. Stops the field clearing. */
  required?: boolean;
  /** Marks the field invalid, beside the field's own check of what was typed. */
  invalid?: boolean;
  /** Submits the ISO value in a native form under this name. */
  name?: string;
  /** The calendar popover, controlled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** `compact` (28px) for filter bars. */
  density?: "default" | "compact";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the field. */
  className?: string;
}

/**
 * Props of `DatePicker`: a field that takes a typed date or opens a calendar.
 * Typing is lenient (`2026-09-30`, `2026/9/30`, `Sep 30 2026`, `30 September`,
 * or the locale's numeric order) and is checked on Enter or blur: text that
 * is not a date, or a day outside `min`/`max`, marks the field invalid and
 * leaves the value alone. Escape puts the text back. Joins a `FormField` on
 * its own.
 */
export interface PluginDatePickerProps extends PluginDateFieldBaseProps {
  /** The day, controlled. `null` is empty. Passing the prop at all makes it controlled. */
  value?: PluginIsoDate | null;
  defaultValue?: PluginIsoDate | null;
  /** The new day, or `null` when the field was cleared. */
  onValueChange?: (value: PluginIsoDate | null) => void;
}

/** A shortcut in a `DateRangePicker`'s popover. Work the range out when you render. */
export interface PluginDateRangePreset {
  label: string;
  range: PluginDateRange;
}

/**
 * Props of `DateRangePicker`: `DatePicker` for a run of days. The popover
 * shows two months where the window has room, and `presets` beside them. The
 * field takes typed ranges too: two dates with `–`, ` - ` or `to` between.
 */
export interface PluginDateRangePickerProps extends PluginDateFieldBaseProps {
  /** The range, controlled. `null` is empty. Passing the prop at all makes it controlled. */
  value?: PluginDateRange | null;
  defaultValue?: PluginDateRange | null;
  /** The new range, or `null` when the field was cleared. */
  onValueChange?: (value: PluginDateRange | null) => void;
  /**
   * Shortcuts such as "Last 7 days", listed beside the calendar. One whose
   * ends `min`, `max` or `isDateDisabled` rule out is shown disabled.
   */
  presets?: readonly PluginDateRangePreset[];
}

/** One choice in a `RadioGroup`. */
export interface PluginRadioOption {
  /** Non-empty and unique within the group. */
  value: string;
  label: string;
  /** A second line under the label, announced as the option's description. */
  description?: string;
  disabled?: boolean;
}

/**
 * Props of `RadioGroup`: exactly one of a few options, each shown with its
 * label and an optional description. Native radios, so the group is one tab
 * stop and the arrow keys move the choice.
 */
export interface PluginRadioGroupProps extends PluginRootAttributes {
  options: readonly PluginRadioOption[];
  /**
   * The chosen value, controlled. Passing the prop at all makes the group
   * controlled: `""`, `null` or `undefined` then leaves nothing chosen. Leave
   * it out entirely for an uncontrolled group.
   */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** `vertical` (the default) stacks the options; `horizontal` sets them side by side. */
  orientation?: "vertical" | "horizontal";
  /** `card` (the default) draws each option as a bordered, clickable card; `plain` as a bare radio and label. */
  variant?: "card" | "plain";
  /** The radios' form name. Generated when omitted. */
  name?: string;
  disabled?: boolean;
  required?: boolean;
  /** Names the group when no `FormField` label does. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * Props of `NumberInput`: a number field with optional stepper buttons. Typing
 * is free; the value commits on blur, Enter, a stepper press or an arrow key,
 * clamped to `min`/`max` and rounded to `precision`. Text that is not a number
 * marks the field invalid while you type and reverts on commit.
 */
export interface PluginNumberInputProps extends PluginAriaRootAttributes {
  /**
   * The value, controlled. Passing the prop at all makes the field controlled;
   * `null` is an empty field. Leave it out for an uncontrolled field.
   */
  value?: number | null;
  defaultValue?: number | null;
  /** The committed value. `null` when the field is cleared (never, with `required`). */
  onValueChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  /**
   * What an arrow key or a stepper press adds. Shift, Page Up and Page Down
   * step ten times. Defaults to 1. `"any"` steps by 1 and takes away the
   * step's implicit rounding, so a typed quantity with many decimals is kept
   * as typed; an explicit `precision` still rounds.
   */
  step?: number | "any";
  /** Decimal places the value is rounded to and shown with. Defaults to the step's own (no rounding for `step="any"`). */
  precision?: number;
  /** Draws thousands separators in the user's locale while the field is not being edited. Defaults to `false`. */
  grouping?: boolean;
  /** `false` drops trailing zeros the shown value does not need (2.50 shows as 2.5). Omitted, the field formats as it always has. */
  fixedDecimals?: boolean;
  /** A suffix drawn inside the field ("ms", "px", "%") and spoken with the value. */
  unit?: string;
  /** The decrease and increase buttons. Defaults to `true`. */
  stepper?: boolean;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  /** An empty field reverts to the last value rather than committing `null`. */
  required?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  density?: "default" | "compact";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the field's outer box. */
  className?: string;
}

/**
 * Props of `Slider`: one value on a track, for a setting where the rough
 * position matters more than the exact figure. The track is neutral. Arrow
 * keys step, Page Up/Down step ten times, Home/End jump to the ends.
 */
export interface PluginSliderProps extends PluginAriaRootAttributes {
  /** The value, controlled. A number makes the slider controlled. */
  value?: number;
  defaultValue?: number;
  /** Every move of the thumb. */
  onValueChange?: (value: number) => void;
  /** Once a drag or a key press ends: the moment to save. */
  onValueCommit?: (value: number) => void;
  /** Defaults to 0. */
  min?: number;
  /** Defaults to 100. */
  max?: number;
  /** Defaults to 1. */
  step?: number;
  /** The value in words, spoken as `aria-valuetext` and shown by `showValue` ("40%", "2 s"). */
  formatValue?: (value: number) => string;
  /** Shows the formatted value beside the track. */
  showValue?: boolean;
  name?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * The props `Combobox` and `MultiSelect` share: a trigger that looks like a
 * `Select`'s, opening a searchable, virtualised list.
 */
export interface PluginPickerBaseProps extends PluginAriaRootAttributes {
  /** Values non-empty and unique, as for `Select`. */
  options: readonly (PluginSelectOption | PluginSelectOptionGroup)[];
  /** Shown on the trigger while nothing is chosen. */
  placeholder?: string;
  /** The search field's placeholder. Defaults to "Search…". */
  searchPlaceholder?: string;
  /** The query on every keystroke, for options you load as the user types. */
  onSearchChange?: (query: string) => void;
  /**
   * `contains` (the default) filters `options` by label and description as the
   * user types. `none` shows `options` as given: for options you filter or
   * fetch yourself from `onSearchChange`.
   */
  filter?: "contains" | "none";
  /** Options are on their way: the list says so rather than "No matches". */
  loading?: boolean;
  /** What the list says when nothing matches. Defaults to "No matches". */
  emptyMessage?: ReactNode;
  disabled?: boolean;
  density?: "default" | "compact";
  name?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the trigger. */
  className?: string;
}

/** Props of `Combobox`: a single choice from a list long enough to want a search. */
export interface PluginComboboxProps extends PluginPickerBaseProps {
  /**
   * The chosen value, controlled. Passing the prop at all makes it controlled:
   * `""`, `null` or `undefined` then shows the placeholder again.
   */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Offers the typed text as a value of its own when no option's label matches it exactly. */
  allowCustomValue?: boolean;
}

/** Props of `MultiSelect`: any number of choices, such as labels or assignees. */
export interface PluginMultiSelectProps extends PluginPickerBaseProps {
  /** The chosen values, controlled. Passing the prop at all makes it controlled. */
  value?: readonly string[];
  defaultValue?: readonly string[];
  /** The whole new selection, in the order the values were chosen. */
  onValueChange?: (value: string[]) => void;
  /** At most this many; the rest of the list is disabled once it is reached. */
  max?: number;
  /**
   * At most this many chips on the trigger before the rest collapse into "+N";
   * fewer when the trigger is too narrow to hold them. Defaults to 3.
   */
  maxChips?: number;
}

/**
 * Props of `TagInput`: free-text tags. Enter or a comma adds the text, a
 * pasted list is split on commas and new lines, Backspace in the empty field
 * removes the last tag, and a tag already there (ignoring case) is not added
 * twice.
 */
export interface PluginTagInputProps extends PluginAriaRootAttributes {
  /** The tags, controlled. Passing the prop at all makes it controlled. */
  value?: readonly string[];
  defaultValue?: readonly string[];
  onValueChange?: (value: string[]) => void;
  /** Refuse a tag by returning `false`: the text stays in the field, marked invalid. */
  validate?: (tag: string, tags: readonly string[]) => boolean;
  /** At most this many tags. */
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/** What every `FileDropzone` takes, whichever way it hands over the files. */
export interface PluginFileDropzoneBaseProps extends PluginRootAttributes {
  /** Dropped files `accept` ruled out. The dialog only offers accepted ones. */
  onReject?: (files: File[]) => void;
  /** As on `<input type="file">`: extensions (`.md`) and MIME types (`image/*`), comma-separated. */
  accept?: string;
  /** More than one file at a time. Without it, a drop of several keeps the first. */
  multiple?: boolean;
  disabled?: boolean;
  /** The headline. Defaults to "Drop files here" (or "Drop a file here"). */
  label?: ReactNode;
  /** One quiet line under it: what fits ("Markdown or text, up to 1 MB"). */
  description?: ReactNode;
  /** Defaults to `upload`. */
  icon?: PluginIconSource;
  /** The button's label. Defaults to "Choose files…" (or "Choose file…"). */
  browseLabel?: string;
  /** Replaces the headline, description and icon; the button stays. */
  children?: ReactNode;
  className?: string;
}

/**
 * Props of `FileDropzone`: a drop target with a button that opens the
 * system's file dialog. Pick how you want what the person chose:
 *
 * - `onFiles` hands over `File` objects: name, size, type and contents
 *   (`file.text()`, `file.arrayBuffer()`), never a path on disk. Right for a
 *   file the view reads itself.
 * - `onArtifacts` copies each file into the host's artifact cache and hands
 *   over {@link PluginArtifact} handles your worker can play, upload or read
 *   from `host.artifacts` — the way in for a file too large to pass around.
 *   Needs the `artifact:store` capability. While it copies, the zone says so;
 *   a failure is shown in the zone and reported to `onImportError`.
 */
export type PluginFileDropzoneProps = PluginFileDropzoneBaseProps &
  (
    | {
        /** The accepted files from a drop or the dialog. Never called with an empty list. */
        onFiles: (files: File[]) => void;
        onArtifacts?: never;
        onImportError?: never;
      }
    | {
        /** The accepted files, imported. Never called with an empty list. */
        onArtifacts: (artifacts: PluginArtifact[]) => void;
        /** The import failed; nothing was imported. The zone shows the reason too. */
        onImportError?: (error: Error) => void;
        onFiles?: never;
      }
  );

/**
 * Props of `EmojiPicker`: Daintree's emoji picker in a popover opened from
 * `trigger`, with search, categories and the keyboard grid. Picking closes it.
 */
export interface PluginEmojiPickerProps {
  /** The element that opens it; it must accept a ref and DOM props (a kit `Button` does). */
  trigger: ReactElement;
  onSelect: (emoji: string) => void;
  /** The emoji you hold now, marked in the grid. */
  value?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: PluginSide;
  align?: PluginAlign;
  /** Names the panel. Defaults to "Choose emoji". */
  "aria-label"?: string;
}

/** One row of a `MentionTextarea` suggestion menu. */
export interface PluginMentionSuggestion {
  /** Unique within one list. */
  id: string;
  /** The row's text, drawn in the mono face the host's composer uses for tokens. */
  label: string;
  /**
   * What replaces the trigger and the typed query. Defaults to the trigger
   * followed by `label` (`@alice`). A space follows it unless it already
   * ends in one.
   */
  insertText?: string;
  /** A quieter second part of the row: a name, a path, what a command does. */
  description?: string;
  /** A short neutral tag after the label ("Skill", "Team"). */
  badge?: string;
  disabled?: boolean;
}

/** A character that opens the suggestion menu, and how its menu reads. */
export interface PluginMentionTrigger {
  /** One character: `"@"`, `"/"`, `"#"`, `":"`. */
  char: string;
  /** The menu's header ("People", "Commands"). Defaults to none. */
  title?: string;
  /** What the menu says when nothing matches. Defaults to "No matches". */
  emptyMessage?: string;
  /**
   * Only at the very start of the text, as a slash command is. Otherwise the
   * trigger counts at the start or after whitespace, so `a@b.c` never opens it.
   */
  atStart?: boolean;
}

/**
 * Props of `MentionTextarea`: a textarea that grows with its text and opens
 * the host's autocomplete menu when a trigger character is typed. Up and
 * Down move through the suggestions, Enter or Tab insert one, Escape closes
 * the menu and keeps the text. Focus stays in the textarea throughout.
 */
export interface PluginMentionTextareaProps extends PluginAriaRootAttributes {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** The trigger characters, as `"@"` or with a title and empty message. */
  triggers?: readonly (string | PluginMentionTrigger)[];
  /**
   * The suggestions for `query`, the text typed after `trigger`. May return a
   * promise; while it is out the last rows stay up, dimmed, and a reply that
   * arrives after a newer query is dropped. At most 50 rows are shown.
   */
  getSuggestions?: (
    trigger: string,
    query: string
  ) => readonly PluginMentionSuggestion[] | Promise<readonly PluginMentionSuggestion[]>;
  /** Called after a suggestion was inserted. */
  onSuggestionInsert?: (suggestion: PluginMentionSuggestion, trigger: string) => void;
  /**
   * Keys the menu did not take. Call `preventDefault()` to keep the
   * textarea from acting on one.
   */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  spellCheck?: boolean;
  maxLength?: number;
  invalid?: boolean;
  /** Rows shown when empty. Defaults to 1. */
  minRows?: number;
  /** The height it grows to before it scrolls. Defaults to 8 rows. */
  maxRows?: number;
  /** `code` sets it in the mono face, for prompts and commands. */
  variant?: "default" | "code";
  density?: "default" | "compact";
  /** The textarea element. */
  ref?: Ref<HTMLTextAreaElement>;
  className?: string;
}

/** A file or context item attached to a `Composer`, drawn as a removable chip. */
export interface PluginComposerAttachment {
  /** Unique within the list. */
  id: string;
  /** The chip's text: a file name, "Selection", "Diff". */
  name: string;
  /** A quiet detail after the name ("12 KB", "L10–24"). */
  detail?: string;
  /** Defaults to `file`. */
  icon?: PluginIconSource;
  /** Defaults to `ready`. See `PluginAttachmentStatus`. */
  status?: PluginAttachmentStatus;
}

/**
 * Props of `Composer`: the agent composer. A `MentionTextarea` in the host
 * composer's shell, with attachment chips above the text and a footer that
 * holds an attach button, your own controls and Send, which turns into Stop
 * while `busy`. Cmd/Ctrl+Enter sends and Enter is a new line, unless
 * `submitOn` is `"enter"`. Files dropped or pasted onto it go to `onAttach`.
 */
export interface PluginComposerProps extends PluginAriaRootAttributes {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Called with the text when the user sends. Clearing the draft is up to you. */
  onSubmit?: (value: string) => void;
  /**
   * Which key sends. Defaults to `"mod+enter"`, with Enter a new line. With
   * `"enter"`, Enter sends, Shift+Enter is a new line, and Cmd/Ctrl+Enter
   * still sends.
   */
  submitOn?: "mod+enter" | "enter";
  /** An agent is working: Send becomes Stop and sending is held, the text stays editable. */
  busy?: boolean;
  /** Called by Stop, or Escape in the composer, while `busy`. */
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
  triggers?: readonly (string | PluginMentionTrigger)[];
  getSuggestions?: PluginMentionTextareaProps["getSuggestions"];
  onSuggestionInsert?: PluginMentionTextareaProps["onSuggestionInsert"];
  attachments?: readonly PluginComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  /**
   * Files from the attach button, a drop or a paste. Without it there is no
   * attach button and files are not taken.
   */
  onAttach?: (files: File[]) => void;
  /** As on `<input type="file">`: extensions and MIME types, comma-separated. */
  accept?: string;
  /**
   * At most this many characters. A count shows once the text passes 80% of
   * it.
   */
  maxLength?: number;
  /** Your controls in the footer, before Send: an agent picker, a mode toggle. */
  toolbar?: ReactNode;
  /** Send's label. Defaults to "Send". */
  submitLabel?: string;
  /** Defaults to 2. */
  minRows?: number;
  /** Defaults to 10. */
  maxRows?: number;
  autoFocus?: boolean;
  /** The textarea element. */
  ref?: Ref<HTMLTextAreaElement>;
  className?: string;
}

/**
 * Props of `InlineEdit`: text that turns into a field to rename it, as a
 * pane title does. A click (or a double-click, with `activation`), F2 or
 * Enter starts editing; Enter commits, Escape cancels, and leaving the field
 * commits unless `blurAction` is `"cancel"`. An unchanged value commits nothing.
 */
export interface PluginInlineEditProps extends PluginRootAttributes {
  value: string;
  /**
   * Called with the trimmed new value. Return a promise to hold the field,
   * read-only with a spinner, until it settles; a rejection keeps the field
   * open with the error's message under it.
   */
  onCommit: (value: string) => void | Promise<void>;
  /**
   * A message refuses the value; `null` or `undefined` accepts it, and a
   * validator that throws refuses. Unless `allowEmpty`, Enter on an emptied
   * field is refused and leaving it puts the value back.
   */
  validate?: (value: string) => string | null | undefined;
  allowEmpty?: boolean;
  /** Shown in place of an empty value. */
  placeholder?: string;
  /** What leaving the field does. Defaults to `"commit"`. */
  blurAction?: "commit" | "cancel";
  /** What starts editing with the pointer. Defaults to `"click"`. */
  activation?: "click" | "doubleClick";
  /** `stem` selects a file name up to its extension. Defaults to `all`. */
  selectOnEdit?: "all" | "stem" | "end";
  /** Editing, controlled. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  maxLength?: number;
  disabled?: boolean;
  /** The type size: `sm` for rows and headers (the default), `md` and `lg` for titles. */
  size?: "sm" | "md" | "lg";
  /** Required: names the field ("Request name"). */
  "aria-label": string;
  className?: string;
}

/** One row of a `KeyValueEditor`. */
export interface PluginKeyValuePair {
  /** Keeps a row's identity through edits and reordering. The editor adds one when it is missing. */
  id?: string;
  key: string;
  value: string;
  /** Draw the value as a `SecretInput`. */
  secret?: boolean;
}

/**
 * Props of `KeyValueEditor`: rows of key and value fields for environment
 * variables, headers and mappings. A value with no key and a repeated key are
 * marked on the row; an entirely empty row is not. Pasting `KEY=value` or `Key: value` lines into a key field adds a
 * row per line.
 */
export interface PluginKeyValueEditorProps extends PluginRootAttributes {
  value?: readonly PluginKeyValuePair[];
  defaultValue?: readonly PluginKeyValuePair[];
  onValueChange?: (pairs: PluginKeyValuePair[]) => void;
  /** Whether every row is valid, called when that changes (and once on mount). */
  onValidityChange?: (valid: boolean) => void;
  /** A message refuses a key; `null` or `undefined` accepts it. Runs after the built-in checks. */
  validateKey?: (key: string) => string | null | undefined;
  /** Compare keys ignoring case, as HTTP headers do. */
  caseInsensitiveKeys?: boolean;
  allowDuplicateKeys?: boolean;
  /** Rows can be dragged into a new order by a grip, or moved with the keyboard. */
  reorderable?: boolean;
  /** Column names over the fields. Default to "Key" and "Value". */
  keyLabel?: string;
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** The add button's label. Defaults to "Add". */
  addLabel?: string;
  /** No more rows than this. */
  max?: number;
  /** Show a toggle on each row that masks its value. */
  allowSecretToggle?: boolean;
  disabled?: boolean;
  /** Required: names the editor ("Headers"). */
  "aria-label": string;
  className?: string;
}

/**
 * Props of `ListEditor`: an editable list of single values (hosts, globs,
 * scopes). Pasting several lines into a field adds a row per line; repeated
 * values are marked.
 */
export interface PluginListEditorProps extends PluginRootAttributes {
  value?: readonly string[];
  defaultValue?: readonly string[];
  onValueChange?: (items: string[]) => void;
  onValidityChange?: (valid: boolean) => void;
  /** A message refuses an item; `null` or `undefined` accepts it. Empty rows are ignored, not refused. */
  validate?: (item: string) => string | null | undefined;
  allowDuplicates?: boolean;
  reorderable?: boolean;
  placeholder?: string;
  addLabel?: string;
  max?: number;
  /** `code` sets the fields in the mono face, for paths and globs. */
  variant?: "default" | "code";
  disabled?: boolean;
  "aria-label": string;
  className?: string;
}

/**
 * Props of `SecretInput`: a masked field for a token or key, with a reveal
 * toggle. With `stored`, the field shows that a secret is saved without
 * knowing it, and offers Replace (and Clear, with `onClear`). Copying out of
 * the field is blocked unless `allowCopy`.
 */
export interface PluginSecretInputProps extends PluginAriaRootAttributes {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** A secret is saved already; the view does not hold it. */
  stored?: boolean;
  /** The last few characters of the saved secret, shown after the dots ("a1b2"). At most 6 are used. */
  storedHint?: string;
  /** Called when the user chooses Replace; the field is then empty and focused. */
  onReplace?: () => void;
  /** Called when the user backs out of a replace, back to the saved secret. */
  onCancelReplace?: () => void;
  /** Shows Clear beside the saved secret. Asking for confirmation is up to you. */
  onClear?: () => void;
  /** Enter in the field. */
  onSubmit?: (value: string) => void;
  /** Allows copying and cutting the value out of the field. */
  allowCopy?: boolean;
  /** Defaults to true. */
  revealable?: boolean;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  density?: "default" | "compact";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * Props of `ShortcutRecorder`: focus it and press a shortcut to record it,
 * in the app's combo notation (`"Cmd+Shift+K"`; Cmd is Ctrl off macOS).
 * Escape stops recording, a plain Backspace or Delete clears, a plain Tab
 * moves on. A shortcut Daintree
 * already uses is flagged, since Daintree's binding wins over a view's.
 */
export interface PluginShortcutRecorderProps extends PluginAriaRootAttributes {
  /** The combo, controlled; `null` or `""` for none. */
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (combo: string | null) => void;
  /** Record a two-step chord ("Cmd+K Cmd+S"): a second key within a second completes it. */
  allowChords?: boolean;
  /** Refuse a first key that is bare or only Shift+key (outside F1–F24). Defaults to true. */
  requireModifier?: boolean;
  /** A message refuses the combo; `null` or `undefined` accepts it. */
  validate?: (combo: string) => string | null | undefined;
  /** A warning to show for a combo you already use elsewhere; `null` or `undefined` for none. */
  getConflict?: (combo: string) => string | null | undefined;
  /** Flag combos Daintree's own shortcuts use. Defaults to true. */
  checkHostConflicts?: boolean;
  /** Shown while no shortcut is set. Defaults to "Not set". */
  placeholder?: string;
  disabled?: boolean;
  /** `compact` matches a compact `Input` beside it. */
  density?: "default" | "compact";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/** A preset in a `ColorPicker`'s palette: a colour, or a colour with a spoken name. */
export type PluginColorSwatch = string | { value: string; label: string };

/**
 * Props of `ColorSwatch`: a small chip of one colour, drawn with an edge so a
 * pale colour keeps its shape on any surface. With an `onClick` (a `Popover`
 * or `DropdownMenu` trigger hands it one) it is a button; without, a picture.
 */
export interface PluginColorSwatchProps extends PluginDomProps<HTMLElement> {
  /** `#rgb` or `#rrggbb`, with or without the `#`. Anything else draws an empty chip. */
  color: string | null | undefined;
  /** `xs` 12px, `sm` 16px (the default), `md` 20px, `lg` 24px. */
  size?: "xs" | "sm" | "md" | "lg";
  /** `circle` (the default) or `square`. */
  shape?: "circle" | "square";
  /** Draws the chip as chosen: a ring round it, for a palette of your own. */
  selected?: boolean;
  /** The colour's spoken name. Defaults to its hex. */
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Props of `ColorPicker`: a field showing the colour and its hex that opens a
 * palette, a saturation area, a hue strip, a hex field that also takes
 * `rgb()` and `hsl()`, and the eyedropper where the platform has one. Built
 * for label and tag colours; pair it with `ColoredLabel` for the preview.
 */
export interface PluginColorPickerProps extends PluginAriaRootAttributes {
  /** `#rrggbb`, controlled. `null` is no colour. Passing the prop at all makes it controlled. */
  value?: string | null;
  defaultValue?: string | null;
  /**
   * Every change, as lowercase `#rrggbb`: a swatch, a committed hex, and each
   * move across the area or the hue strip.
   */
  onValueChange?: (value: string) => void;
  /**
   * The palette. Defaults to the theme's category colours (blue, purple, cyan,
   * green, amber, orange, teal, indigo, rose, pink, violet, slate), resolved in
   * the active theme.
   */
  swatches?: readonly PluginColorSwatch[];
  /** Focus left the control (and whatever it opened), or its panel closed: `useForm`'s `field()` hands this in. */
  onBlur?: () => void;
  /** Offers the area, hue strip, hex field and eyedropper beside the palette. Default true. */
  allowCustom?: boolean;
  /** `field` (the default) is a Select-sized field with the hex; `swatch` is the chip alone. */
  variant?: "field" | "swatch";
  /** Shown on a `field` with no colour. Defaults to "Choose a colour". */
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Submits the hex in a native form under this name. */
  name?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: PluginSide;
  align?: PluginAlign;
  density?: "default" | "compact";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the trigger. */
  className?: string;
}

/** A wall-clock time, `"HH:mm"` in 24-hour form ("09:30", "17:05"). It carries no day and no zone. */
export type PluginIsoTime = string;

/**
 * Props of `TimePicker`: a time typed into hour and minute segments (and AM/PM
 * where the locale uses a 12-hour clock), or chosen from a list. Each segment
 * is a spin button: Up/Down step it, digits type into it, Left/Right move
 * between segments, Backspace clears it. The value commits once every segment
 * is filled; a time outside `min`/`max` marks the field invalid and leaves the
 * value alone. Joins a `FormField` on its own.
 */
export interface PluginTimePickerProps extends PluginAriaRootAttributes {
  /** The time, controlled. `null` is empty. Passing the prop at all makes it controlled. */
  value?: PluginIsoTime | null;
  defaultValue?: PluginIsoTime | null;
  /** The new time, or `null` when the field was cleared. */
  onValueChange?: (value: PluginIsoTime | null) => void;
  /** Focus left the control (and whatever it opened), or its list closed: `useForm`'s `field()` hands this in. */
  onBlur?: () => void;
  /** The earliest time, inclusive. */
  min?: PluginIsoTime;
  /** The latest time, inclusive. */
  max?: PluginIsoTime;
  /**
   * Minutes per Up/Down press on the minute segment, 1–60 (default 1). The
   * list steps by the smallest multiple of it that is at least 15 minutes.
   */
  step?: number;
  /** 12 or 24. Defaults to the user's locale. */
  hourCycle?: 12 | 24;
  /** Draws a clear button while there is a value. Default true. */
  clearable?: boolean;
  disabled?: boolean;
  /** Also pass `required` to the enclosing `FormField`. Stops the field clearing. */
  required?: boolean;
  invalid?: boolean;
  /** Submits the `"HH:mm"` value in a native form under this name. */
  name?: string;
  /** The list popover, controlled. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  density?: "default" | "compact";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Classes for the field. */
  className?: string;
}

/**
 * A local date and wall-clock time, `"YYYY-MM-DDTHH:mm"` ("2026-09-30T14:05"),
 * as `<input type="datetime-local">` holds it. Read it as a time in the zone
 * the picker shows, never through `new Date()` alone.
 */
export type PluginIsoDateTime = string;

/**
 * Props of `DateTimePicker`: a `DatePicker` and a `TimePicker` side by side as
 * one value, with the time zone named after them. Picking a day with no time
 * yet fills the earliest allowed time of that day; typing a time with no day
 * yet fills today. Clearing the day clears the value.
 */
export interface PluginDateTimePickerProps extends PluginAriaRootAttributes {
  /** The date and time, controlled. `null` is empty. Passing the prop at all makes it controlled. */
  value?: PluginIsoDateTime | null;
  defaultValue?: PluginIsoDateTime | null;
  onValueChange?: (value: PluginIsoDateTime | null) => void;
  /** Focus left both parts (and their popovers): `useForm`'s `field()` hands this in. */
  onBlur?: () => void;
  /** The earliest date and time, inclusive. */
  min?: PluginIsoDateTime;
  /** The latest date and time, inclusive. */
  max?: PluginIsoDateTime;
  /** Days that cannot be chosen. */
  isDateDisabled?: (date: PluginIsoDate) => boolean;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** As `TimePicker`. */
  step?: number;
  hourCycle?: 12 | 24;
  /**
   * The IANA zone the time is in ("Europe/Berlin"), named after the field.
   * Display only: the value is the wall time as typed. Defaults to the user's zone.
   */
  timeZone?: string;
  /** Names the zone after the field. Default true. */
  showTimeZone?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  /** Submits the `"YYYY-MM-DDTHH:mm"` value in a native form under this name. */
  name?: string;
  density?: "default" | "compact";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/** A tick under a `RangeSlider`'s track: a value, or a value with a label under it. */
export type PluginRangeSliderMark = number | { value: number; label: string };

/**
 * Props of `RangeSlider`: a low and a high value on one track, drawn exactly
 * like `Slider`. Each thumb is its own slider with its own keys (arrows step,
 * Page Up/Down step ten times, Home/End go as far as the other thumb allows);
 * a press on the track moves the nearer thumb. The thumbs never cross and
 * stay `minDistance` apart.
 */
export interface PluginRangeSliderProps extends PluginAriaRootAttributes {
  /** `[low, high]`, controlled. An array makes the slider controlled. */
  value?: readonly [number, number];
  defaultValue?: readonly [number, number];
  /** Every move of either thumb. */
  onValueChange?: (value: [number, number]) => void;
  /** Once a drag or a key press ends: the moment to save. */
  onValueCommit?: (value: [number, number]) => void;
  /** Focus left both thumbs: `useForm`'s `field()` hands this in. */
  onBlur?: () => void;
  /** Marks the slider invalid, as an enclosing `FormField`'s error does. */
  invalid?: boolean;
  /** Defaults to 0. */
  min?: number;
  /** Defaults to 100. */
  max?: number;
  /** Defaults to 1. */
  step?: number;
  /** The smallest gap between the thumbs, rounded up to whole steps. Defaults to 0. */
  minDistance?: number;
  /** A value in words, spoken as `aria-valuetext` and shown by `showValue` and the tooltip. */
  formatValue?: (value: number) => string;
  /** Shows "low – high" beside the track. */
  showValue?: boolean;
  /** Ticks under the track, labelled where given a label. */
  marks?: readonly PluginRangeSliderMark[];
  /**
   * The value over a thumb: `auto` (the default) while it is dragged or has
   * keyboard focus, `never` for none.
   */
  tooltip?: "auto" | "never";
  /** The thumbs' spoken names. Defaults to "Minimum" and "Maximum". */
  thumbLabels?: readonly [string, string];
  /** Submits both values in a native form under this name, low first. */
  name?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/** One button of a `ToggleGroup`: a label, an icon, or both. */
export interface PluginToggleGroupItem {
  /** Non-empty and unique within the group. */
  value: string;
  label?: string;
  icon?: PluginIconSource;
  /** Required when there is no `label`; the spoken name when the label is an abbreviation. */
  "aria-label"?: string;
  /** Hover detail. An icon-only item shows its `aria-label` by default. */
  tooltip?: ReactNode;
  disabled?: boolean;
}

/**
 * Props of `ToggleGroup`: a row of subtle toggle buttons, as Daintree's own
 * weekday picker draws them, an "on" one with the kit `Button`'s pressed look. `multiple` (the default) turns any number on, as weekday
 * choices or text styles; `single` turns at most one on and lets it be turned
 * off again (for exactly one, always, use `SegmentedControl`). One tab stop:
 * arrow keys, Home and End move between the buttons, Space or Enter toggles.
 */
export interface PluginToggleGroupProps extends PluginAriaRootAttributes {
  items: readonly PluginToggleGroupItem[];
  type?: "multiple" | "single";
  /** The values that are on, controlled. Passing the prop at all makes it controlled. */
  value?: readonly string[];
  defaultValue?: readonly string[];
  /** The values now on, in the items' order. */
  onValueChange?: (value: string[]) => void;
  /** Focus left the group: `useForm`'s `field()` hands this in. */
  onBlur?: () => void;
  /** Marks the group invalid. */
  invalid?: boolean;
  /** Required: the group's name. */
  "aria-label": string;
  disabled?: boolean;
  /** `compact` (24px) for a 32px strip; `default` (28px) is a small `Button`'s height. */
  density?: "default" | "compact";
  className?: string;
}

/**
 * Props of `SplitButton`: a primary action and, on a separate chevron with its
 * own tab stop, a `DropdownMenu` of the alternatives ("Save" and "Save as
 * template"). The two halves share one shape in any `Button` variant and size.
 */
export interface PluginSplitButtonProps extends PluginRootAttributes {
  /** The primary action's label. */
  children: ReactNode;
  onClick?: () => void;
  /** The menu's entries, any `DropdownMenu` entry type (submenus and descriptions included). */
  items: readonly PluginDropdownMenuEntry[];
  variant?: Exclude<PluginButtonVariant, "link" | "pill">;
  size?: "default" | "sm" | "xs" | "lg";
  /** A leading icon on the primary action. */
  icon?: PluginIconSource;
  /** Busy: the primary action shows a spinner and both halves stop taking presses. */
  loading?: boolean;
  disabled?: boolean;
  /** Disables only the menu half. */
  menuDisabled?: boolean;
  /** `submit` makes the primary action submit its form. */
  type?: "button" | "submit";
  /** The chevron's spoken name and tooltip. Defaults to "More options". */
  menuLabel?: string;
  side?: PluginSide;
  /** Defaults to `end`, so the menu lines up under the chevron. */
  align?: PluginAlign;
  className?: string;
}

/** A field's error: a message, or nothing when it is fine. */
export type PluginFormError = string | null | undefined;

/** Checks one field. Return the message to show, or nothing. May be async. */
export type PluginFieldValidator<V, T> = (
  value: V,
  values: T
) => PluginFormError | Promise<PluginFormError>;

export interface UseFormOptions<T extends Record<string, unknown>> {
  /** The values the form starts from, and what "dirty" compares against. */
  initialValues: T;
  /** Per-field checks, run as the field is left and on submit. */
  validators?: { [K in keyof T]?: PluginFieldValidator<T[K], T> };
  /** A whole-form check run on submit, for rules across fields. May be async. */
  validate?: (
    values: T
  ) =>
    Partial<Record<keyof T, PluginFormError>> | Promise<Partial<Record<keyof T, PluginFormError>>>;
  /**
   * Called with the values once every check passes. A throw (or rejection)
   * keeps the form dirty and shows its message as the form's error status.
   * On success the values become the new clean state.
   */
  onSubmit: (values: T) => void | Promise<void>;
  /**
   * When a field is checked: `blur` (the default) once it is left, then on
   * every change after that; `change` on every change; `submit` only on submit.
   */
  validateOn?: "blur" | "change" | "submit";
}

/** Spread onto a kit control: its value, change and blur, and whether it is invalid. */
// A type alias rather than an interface, so it spreads into props that also
// take `data-*` attributes (an interface has no implicit index signature).
export type PluginFormFieldBinding<V> = {
  name: string;
  value: V;
  onValueChange: (value: V) => void;
  onBlur: () => void;
  invalid: boolean;
};

/**
 * Where a form stands: `clean` (nothing changed), `dirty`, `invalid` (a
 * shown check failed), `submitting`, `saved` (the last submit went through and
 * nothing changed since) or `error` (the last submit threw).
 */
export type PluginFormStatus = "clean" | "dirty" | "invalid" | "submitting" | "saved" | "error";

export interface UseFormResult<T extends Record<string, unknown>> {
  values: T;
  /** Errors to show: a field's once it has been checked, every field's after a submit. */
  errors: Partial<Record<keyof T, string>>;
  /** Fields whose value differs from the clean state. */
  dirtyFields: (keyof T)[];
  isDirty: boolean;
  isSubmitting: boolean;
  /** An async check is running. */
  isValidating: boolean;
  status: PluginFormStatus;
  /** The status in words for `SettingsActions`' `status`, or `FormStatus`: "Unsaved changes", "Saved". */
  statusMessage: string | undefined;
  /** The last submit's failure, when it threw. */
  submitError: string | undefined;
  setValue: <K extends keyof T>(name: K, value: T[K]) => void;
  setValues: (values: Partial<T>) => void;
  /** Sets or clears one field's error by hand (a server-side check, say). */
  setError: (name: keyof T, error: PluginFormError) => void;
  /** Back to the clean state, or to `values`, which become the new clean state. */
  reset: (values?: T) => void;
  /** Runs every check, then `onSubmit`. Resolves `true` when it went through. */
  submit: () => Promise<boolean>;
  /** The value, change, blur and invalid props of one field. */
  field: <K extends keyof T & string>(name: K) => PluginFormFieldBinding<T[K]>;
}

/** The part of a `useForm` result that `Form` and `FormStatus` read: pass the whole result. */
export interface PluginFormHandle {
  submit: () => Promise<boolean>;
  reset: () => void;
  status: PluginFormStatus;
  statusMessage: string | undefined;
}

/**
 * Props of `Form`: a native `<form>` driven by `useForm`. Enter in a text
 * field or a time segment, or a `type="submit"` button, submits through
 * `form.submit()` (a second submit while one is running is refused), a `type="reset"`
 * button resets, and a submit that fails a check moves focus to the first
 * invalid control.
 */
export interface PluginFormProps extends PluginRootAttributes {
  form: PluginFormHandle;
  children?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

/**
 * Props of `FormStatus`: a form's status as the `status` of `SettingsActions`
 * shows it — "Unsaved changes", "Saving…", "Saved" with a check, and a failed
 * check or submit in the error ink with its glyph. `SettingsActions` announces
 * it politely; anywhere else, put it in a `LiveRegion`.
 */
export interface PluginFormStatusProps extends PluginRootAttributes {
  form: PluginFormHandle;
}

/**
 * Props of `SchemaForm`: a settings group generated from a JSON Schema by the
 * same generator as plugin settings, so it reads and behaves like the form in
 * the plugin's settings home. The schema is an object with `properties`; each
 * is a row. `string` is a text field (`format: "password"` or `writeOnly`
 * masks it), `number`/`integer` a number field held to `minimum`/`maximum`,
 * `boolean` a switch, `enum` of strings a segmented control or select, and
 * `object`/`array` a JSON text area. `title`, `description`, `default` and the
 * root's `required` are read; anything else is ignored, with a warning in
 * development (the annotations `$schema`, `$id`, `$comment` and `examples`
 * quietly). Text commits as the field is left or on Enter, choices at once.
 */
export interface PluginSchemaFormProps extends PluginRootAttributes {
  schema: Record<string, unknown>;
  /** The values, controlled. Passing the prop at all makes it controlled. */
  value?: Record<string, unknown>;
  defaultValue?: Record<string, unknown>;
  /**
   * The whole object after one field committed. A field left empty is removed,
   * except a required one with no `default`, which says "Enter a value" instead.
   */
  onValueChange?: (value: Record<string, unknown>) => void;
  /** Errors to show by property name, beside the form's own checks (`useForm().errors`). */
  errors?: Record<string, PluginFormError>;
  /** A sub-label above the group, as `SettingsGroup`'s. */
  label?: string;
  disabled?: boolean;
}

/**
 * What an attachment is doing. `pending` is on its way (uploading, being
 * processed): it shows a spinner and cannot be opened. `failed` did not make
 * it: an error glyph, and `detail` should say why.
 */
export type PluginAttachmentStatus = "ready" | "pending" | "failed";
