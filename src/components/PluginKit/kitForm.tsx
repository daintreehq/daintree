import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import type {
  PluginFormHandle,
  PluginFormProps,
  PluginFormStatusProps,
  PluginSchemaFormProps,
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
import { Spinner } from "@/components/ui/Spinner";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { field, finite, fn, node, nonEmpty, oneOf, pickRootProps, str } from "./kitProps";
import { warnPluginAuthor } from "./kitDiagnostics";

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

export function KitForm({
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

export function KitFormStatus({ form, ...rest }: PluginFormStatusProps) {
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
  warnPluginAuthor(`SchemaForm: "${keyword}" on ${where} is not supported; it is ignored.`);
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
    const removes = outcome.kind === "reset" || (type === "string" && draft === "");
    const refusal =
      outcome.kind === "error"
        ? outcome.message
        : outcome.kind === "value" && integer && !Number.isInteger(outcome.value)
          ? "Enter a whole number"
          : // A required field with no default to fall back on cannot be emptied.
            removes && def.required === true && def.default === undefined
            ? "Enter a value"
            : null;
    if (refusal !== null) {
      setHeld({ text: draft, source, error: refusal });
      return false;
    }
    setHeld(null);
    if (removes) onCommit(undefined, true);
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

export function KitSchemaForm(props: PluginSchemaFormProps) {
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
