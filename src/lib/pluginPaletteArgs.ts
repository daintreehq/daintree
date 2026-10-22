/**
 * Decides whether a plugin command's raw JSON Schema is small and flat enough
 * for the action palette to collect its arguments itself, and describes the
 * prompts if so. Keyword allowlists only — no schema compiler — so the
 * palette never pays a clone or compile per action. Anything unrecognised
 * fails closed: the command stays out of the palette, as it did before.
 *
 * The plugin host still validates the dispatched object with AJV; this module
 * only has to stop the user submitting an obviously invalid value.
 */

export type PromptValue = string | number | boolean;

export interface PromptOption {
  value: PromptValue;
  label: string;
}

interface PromptFieldBase {
  name: string;
  title: string;
}

export interface EnumPromptField extends PromptFieldBase {
  kind: "enum";
  options: readonly PromptOption[];
}

export interface BooleanPromptField extends PromptFieldBase {
  kind: "boolean";
}

export interface StringPromptField extends PromptFieldBase {
  kind: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
}

export type PromptField = EnumPromptField | BooleanPromptField | StringPromptField;

export interface PluginPaletteArgs {
  /** Required fields only, in declaration order. Optional fields are never asked. */
  readonly fields: readonly PromptField[];
}

const MAX_PROPERTIES = 5;
const MAX_ENUM_OPTIONS = 12;
const UNSAFE_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const ROOT_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "title",
  "description",
]);
const STRING_KEYS: ReadonlySet<string> = new Set([
  "type",
  "title",
  "description",
  "minLength",
  "maxLength",
  "pattern",
]);
const ENUM_KEYS: ReadonlySet<string> = new Set(["type", "title", "description", "enum"]);
const BOOLEAN_KEYS: ReadonlySet<string> = new Set(["type", "title", "description"]);

// The pattern is tested on every keystroke on the renderer's main thread, so
// shapes that can backtrack catastrophically — a quantified group that itself
// contains a quantifier, or a backreference — fail closed.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[+*{]|\\[1-9]|\\k</;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

function isLength(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseEnum(name: string, title: string, prop: Record<string, unknown>) {
  const values = prop.enum;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ENUM_OPTIONS) {
    return null;
  }
  const type = prop.type;
  const options: PromptOption[] = [];
  for (const value of values) {
    const matches =
      (type === "string" && typeof value === "string") ||
      ((type === "number" || type === "integer") &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        (type === "number" || Number.isInteger(value)));
    if (!matches) return null;
    options.push({ value: value as PromptValue, label: String(value) });
  }
  if (new Set(values).size !== values.length) return null;
  return { kind: "enum", name, title, options } satisfies EnumPromptField;
}

function parseField(name: string, prop: unknown): PromptField | null {
  if (!isRecord(prop) || UNSAFE_NAMES.has(name)) return null;
  const title = typeof prop.title === "string" && prop.title.trim() ? prop.title.trim() : name;
  if ("title" in prop && typeof prop.title !== "string") return null;
  if ("description" in prop && typeof prop.description !== "string") return null;

  if ("enum" in prop) {
    if (!onlyKeys(prop, ENUM_KEYS)) return null;
    return parseEnum(name, title, prop);
  }

  switch (prop.type) {
    case "boolean":
      return onlyKeys(prop, BOOLEAN_KEYS) ? { kind: "boolean", name, title } : null;
    case "string": {
      if (!onlyKeys(prop, STRING_KEYS)) return null;
      const { minLength, maxLength, pattern } = prop;
      if (minLength !== undefined && !isLength(minLength)) return null;
      if (maxLength !== undefined && !isLength(maxLength)) return null;
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) return null;
      let regex: RegExp | undefined;
      if (pattern !== undefined) {
        if (typeof pattern !== "string") return null;
        if (NESTED_QUANTIFIER.test(pattern)) return null;
        try {
          regex = new RegExp(pattern, "u");
        } catch {
          return null;
        }
      }
      const field: StringPromptField = { kind: "string", name, title };
      if (minLength !== undefined) field.minLength = minLength as number;
      if (maxLength !== undefined) field.maxLength = maxLength as number;
      if (regex) field.pattern = regex;
      return field;
    }
    default:
      return null;
  }
}

/** Returns the prompts for a supported schema, or null when the palette should leave it out. */
export function parsePluginPaletteArgs(schema: unknown): PluginPaletteArgs | null {
  if (!isRecord(schema) || !onlyKeys(schema, ROOT_KEYS)) return null;
  if (schema.type !== "object") return null;
  if ("$schema" in schema && typeof schema.$schema !== "string") return null;
  if ("additionalProperties" in schema && typeof schema.additionalProperties !== "boolean") {
    return null;
  }
  const { properties, required } = schema;
  if (!isRecord(properties)) return null;
  const names = Object.keys(properties);
  if (names.length === 0 || names.length > MAX_PROPERTIES) return null;
  if (!Array.isArray(required) || required.length === 0) return null;
  if (
    !required.every(
      (name): name is string => typeof name === "string" && Object.hasOwn(properties, name)
    ) ||
    new Set(required).size !== required.length
  ) {
    return null;
  }

  const byName = new Map<string, PromptField>();
  for (const name of names) {
    const field = parseField(name, properties[name]);
    if (!field) return null;
    byName.set(name, field);
  }
  const requiredSet = new Set<string>(required);
  const fields = names.filter((name) => requiredSet.has(name)).map((name) => byName.get(name)!);
  return fields.length > 0 ? { fields } : null;
}

/** The reason `value` can't be submitted for `field`, or null when it can. */
export function validateStringField(field: StringPromptField, value: string): string | null {
  const length = Array.from(value).length;
  if (field.minLength !== undefined && length < field.minLength) {
    return `Enter at least ${field.minLength} ${field.minLength === 1 ? "character" : "characters"}`;
  }
  if (field.maxLength !== undefined && length > field.maxLength) {
    return `Enter at most ${field.maxLength} ${field.maxLength === 1 ? "character" : "characters"}`;
  }
  if (field.pattern && !field.pattern.test(value)) return "Doesn't match the expected format";
  return null;
}
