import type { KeyboardEvent } from "react";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import {
  SETTINGS_CONTROL_WIDTH,
  type SettingsRowControlIds,
} from "@/components/Settings/SettingsGroup";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SettingDefinition, SettingFieldType } from "@shared/types/plugin";

// The generator behind a declared settings field: which control a field gets,
// how its value reads as text while it is edited, and what a committed draft
// means. The plugin settings form and the kit's SchemaForm both draw fields
// through this, so a field reads and behaves the same in either.

/** Path-backed field types — rendered as a read-only input plus a Browse button. */
export const PATH_FIELD_TYPES: ReadonlySet<SettingFieldType> = new Set([
  "path",
  "directory",
  "file",
]);

export function settingFieldType(def: SettingDefinition): SettingFieldType {
  if (def.secret === true) return "secret";
  return def.type ?? "string";
}

export function settingFieldLabel(def: SettingDefinition): string {
  return def.label ?? def.id;
}

/** Longest default a plain string field shows on the rail rather than full width. */
export const INLINE_STRING_MAX = 24;

/** Stringify a stored/default value for a text, number, or JSON input. */
export function settingDraft(value: unknown, type: SettingFieldType): string {
  if (value === undefined || value === null) return "";
  if (type === "json") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }
  return String(value);
}

/**
 * An enum this small, with labels this short, is a segmented control on the rail
 * rather than a select — the same control-choice rule every other settings page follows.
 */
const SEGMENTED_MAX_OPTIONS = 5;
const SEGMENTED_MAX_LABEL = 12;

export function fitsSegmented(options: readonly string[]): boolean {
  return (
    options.length >= 2 &&
    options.length <= SEGMENTED_MAX_OPTIONS &&
    options.every((opt) => opt.length <= SEGMENTED_MAX_LABEL)
  );
}

/**
 * What committing a text draft means: store `value`, go back to the default
 * (an empty number or JSON field), or refuse the draft with `message`.
 */
export type SettingDraftOutcome =
  { kind: "value"; value: unknown } | { kind: "reset" } | { kind: "error"; message: string };

/** Reads a string, number or JSON draft the way the settings form commits it. */
export function parseSettingDraft(
  def: SettingDefinition,
  type: SettingFieldType,
  draft: string
): SettingDraftOutcome {
  if (type === "number") {
    const trimmed = draft.trim();
    if (trimmed === "") return { kind: "reset" };
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return { kind: "error", message: "Enter a valid number" };
    if (def.min !== undefined && num < def.min) {
      return { kind: "error", message: `Must be at least ${def.min}` };
    }
    if (def.max !== undefined && num > def.max) {
      return { kind: "error", message: `Must be at most ${def.max}` };
    }
    return { kind: "value", value: num };
  }
  if (type === "json") {
    const trimmed = draft.trim();
    if (trimmed === "") return { kind: "reset" };
    try {
      return { kind: "value", value: JSON.parse(trimmed) };
    } catch {
      return { kind: "error", message: "Enter valid JSON" };
    }
  }
  return { kind: "value", value: draft };
}

/**
 * A short declared default says a string is a word or two, which sits on the
 * rail; anything else could be a URL or a command, so full width.
 */
export function settingStringIsInline(def: SettingDefinition): boolean {
  return (
    typeof def.default === "string" &&
    def.default.length > 0 &&
    def.default.length <= INLINE_STRING_MAX
  );
}

/** The row layout a field's control needs. */
export function settingRowLayout(
  def: SettingDefinition,
  type: SettingFieldType
): "inline" | "stacked" {
  if (type === "json" || type === "secret" || PATH_FIELD_TYPES.has(type)) return "stacked";
  if (type === "string") return settingStringIsInline(def) ? "inline" : "stacked";
  return "inline";
}

export interface SettingFieldControlProps {
  def: SettingDefinition;
  /** `boolean`, `enum`, `number`, `json` or `string`; the other types draw nothing here. */
  type: SettingFieldType;
  ids: SettingsRowControlIds;
  /** The spoken name, for a control that is named rather than labelled. */
  label: string;
  /** Text (and enum) draft. */
  draft: string;
  onDraftChange: (draft: string) => void;
  /** The text control was left: commit the draft. */
  onCommit: () => void;
  /** An enum choice, committed at once. */
  onChoose: (value: string) => void;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  invalid: boolean;
  /** A write is in flight: the control is disabled, the row is not. */
  busy: boolean;
  /** The enum list's open state, when the caller needs to hold it. */
  enumOpen?: boolean;
  onEnumOpenChange?: (open: boolean) => void;
  /** Masks a string field, for a secret held outside the keychain flow. */
  masked?: boolean;
  /** Enter in a single-line field, before any enclosing form submits on it. */
  onEnter?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/** The control for one generated field, wired to its row's ids. */
export function SettingFieldControl({
  def,
  type,
  ids: { labelId, descriptionId, disabled },
  label,
  draft,
  onDraftChange,
  onCommit,
  onChoose,
  checked,
  onCheckedChange,
  invalid,
  busy,
  enumOpen,
  onEnumOpenChange,
  masked = false,
  onEnter,
}: SettingFieldControlProps) {
  const onKeyDown = onEnter
    ? (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) onEnter(event);
      }
    : undefined;
  if (type === "boolean") {
    return (
      <SettingsSwitch
        checked={checked}
        disabled={disabled || busy}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        aria-invalid={invalid}
        onCheckedChange={onCheckedChange}
      />
    );
  }

  if (type === "enum") {
    const options = def.options ?? [];
    if (fitsSegmented(options)) {
      return (
        <SegmentedRadioGroup
          aria-label={label}
          aria-describedby={descriptionId}
          aria-invalid={invalid}
          options={options.map((opt) => ({ value: opt, label: opt }))}
          value={draft}
          onChange={onChoose}
          disabled={disabled || busy}
        />
      );
    }
    const wide = options.some((opt) => opt.length > 24);
    return (
      <Select
        open={enumOpen}
        onOpenChange={onEnumOpenChange}
        value={draft}
        disabled={disabled || busy}
        onValueChange={onChoose}
      >
        <SelectTrigger
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          aria-invalid={invalid || undefined}
          className={SETTINGS_CONTROL_WIDTH[wide ? "wide" : "select"]}
        >
          {/* An unset enum shows the placeholder rather than silently adopting the first option. */}
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (type === "number") {
    return (
      // Text, not type=number: the draft is validated on commit, and a number input
      // reports anything it can't parse as "" — which would read as "clear to default".
      <Input
        type="text"
        inputMode="decimal"
        value={draft}
        aria-required={def.required === true || undefined}
        disabled={disabled || busy}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        invalid={invalid}
        className={SETTINGS_CONTROL_WIDTH.number}
        onChange={(e) => onDraftChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={onKeyDown}
      />
    );
  }

  if (type === "json") {
    return (
      <Textarea
        variant="code"
        value={draft}
        disabled={disabled || busy}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        invalid={invalid}
        rows={4}
        spellCheck={false}
        onChange={(e) => onDraftChange(e.target.value)}
        onBlur={onCommit}
      />
    );
  }

  if (type !== "string" && type !== "secret") return null;
  const inline = !masked && settingStringIsInline(def);
  return (
    <Input
      type={masked ? "password" : "text"}
      value={draft}
      disabled={disabled || busy}
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      aria-required={def.required === true || undefined}
      invalid={invalid}
      autoComplete={masked ? "off" : undefined}
      className={inline ? SETTINGS_CONTROL_WIDTH.wide : undefined}
      onChange={(e) => onDraftChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={onKeyDown}
    />
  );
}
