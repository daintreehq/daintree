import type {
  PluginFilter,
  PluginFilterCondition,
  PluginFilterField,
  PluginFilterFieldType,
  PluginFilterOperator,
  PluginFilterValue,
  PluginSelectOption,
} from "@shared/types/plugin-sdk-react";
import { todayIso, toIsoDate } from "./dateMath";

// The filter model `FilterBuilder` edits and plugins run. Pure, so the kit's
// components and the facade's helpers read a filter the same way.

/** Each field type's comparisons, in the order the builder offers them. */
export const FILTER_OPERATORS: Readonly<
  Record<PluginFilterFieldType, readonly PluginFilterOperator[]>
> = {
  text: ["eq", "neq", "contains", "not_contains", "empty", "not_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"],
  date: ["eq", "before", "after", "empty", "not_empty"],
  select: ["eq", "neq", "empty", "not_empty"],
  boolean: ["eq", "empty", "not_empty"],
};

const FIELD_TYPES: readonly PluginFilterFieldType[] = [
  "text",
  "number",
  "date",
  "select",
  "boolean",
];

export const EMPTY_FILTER: PluginFilter = { match: "all", conditions: [] };

export function isNullaryOperator(op: unknown): boolean {
  return op === "empty" || op === "not_empty";
}

/** A schema field as the kit uses it: every part checked, its comparisons never empty. */
export interface FilterFieldModel {
  id: string;
  label: string;
  type: PluginFilterFieldType;
  operators: readonly PluginFilterOperator[];
  /** A `select` field's options; empty for the other types. */
  options: readonly PluginSelectOption[];
  placeholder: string | undefined;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readOptions(value: unknown): PluginSelectOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PluginSelectOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const optionValue = nonEmptyString(own(entry, "value"));
    const label = own(entry, "label");
    if (optionValue === undefined || typeof label !== "string" || seen.has(optionValue)) continue;
    seen.add(optionValue);
    const description = own(entry, "description");
    out.push({
      value: optionValue,
      label,
      description: typeof description === "string" ? description : undefined,
      disabled: own(entry, "disabled") === true,
    });
  }
  return out;
}

function readField(value: unknown): FilterFieldModel | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(own(value, "id"));
  const label = own(value, "label");
  const type = FIELD_TYPES.find((candidate) => candidate === own(value, "type"));
  if (id === undefined || typeof label !== "string" || type === undefined) return null;
  const allowed = FILTER_OPERATORS[type];
  const restrict = own(value, "operators");
  const operators = Array.isArray(restrict)
    ? allowed.filter((op) => restrict.includes(op))
    : allowed;
  // A restriction that leaves nothing takes the field out, rather than
  // falling back to every comparison the plugin meant to withhold.
  if (operators.length === 0) return null;
  const placeholder = own(value, "placeholder");
  return {
    id,
    label,
    type,
    operators,
    options: type === "select" ? readOptions(own(value, "options")) : [],
    placeholder: typeof placeholder === "string" ? placeholder : undefined,
  };
}

// A schema is usually one constant, and `matchesFilter` runs once per record.
const fieldCache = new WeakMap<object, ReadonlyMap<string, FilterFieldModel>>();

/** The usable fields by id, in the plugin's order; a repeated id keeps its first. */
export function readFilterFields(fields: unknown): ReadonlyMap<string, FilterFieldModel> {
  if (!Array.isArray(fields)) return new Map();
  const cached = fieldCache.get(fields);
  if (cached) return cached;
  const out = new Map<string, FilterFieldModel>();
  for (const entry of fields) {
    const model = readField(entry);
    if (model && !out.has(model.id)) out.set(model.id, model);
  }
  fieldCache.set(fields, out);
  return out;
}

/** Whether `value` is one this field can compare against. */
export function isFilterValueFor(
  field: FilterFieldModel,
  value: unknown
): value is PluginFilterValue {
  switch (field.type) {
    case "text":
      return typeof value === "string" && value !== "";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "date":
      return typeof value === "string" && toIsoDate(value) === value;
    case "select":
      return typeof value === "string" && field.options.some((option) => option.value === value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function readCondition(
  value: unknown,
  fields: ReadonlyMap<string, FilterFieldModel>
): PluginFilterCondition | null {
  // Unknown keys refuse the condition: one a later version adds (a negation,
  // a nested group) would change its meaning if it were skipped.
  if (!isRecord(value) || !hasOnlyKeys(value, ["field", "op", "value"])) return null;
  const id = own(value, "field");
  const field = typeof id === "string" ? fields.get(id) : undefined;
  if (!field) return null;
  const op = field.operators.find((candidate) => candidate === own(value, "op"));
  if (op === undefined) return null;
  const given = own(value, "value");
  if (isNullaryOperator(op)) return given === undefined ? { field: field.id, op } : null;
  if (!isFilterValueFor(field, given)) return null;
  return { field: field.id, op, value: given };
}

function readWith(
  value: unknown,
  fields: ReadonlyMap<string, FilterFieldModel>
): PluginFilter | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["match", "conditions"])) return null;
  const match = own(value, "match");
  const list = own(value, "conditions");
  if ((match !== "all" && match !== "any") || !Array.isArray(list)) return null;
  const conditions: PluginFilterCondition[] = [];
  for (const entry of list) {
    const condition = readCondition(entry, fields);
    if (!condition) return null;
    conditions.push(condition);
  }
  return { match, conditions };
}

/**
 * `value` as a filter over `fields`, copied, or `null` when any part of it
 * is incomplete or outside the schema: a field it does not have, a
 * comparison the field does not offer, a missing or mistyped value, an
 * option that is not listed, a key the format does not know. Nothing is
 * dropped or filled in, so a `null` must never be run as "no filter".
 */
export function readFilter(
  value: unknown,
  fields: readonly PluginFilterField[]
): PluginFilter | null {
  return readWith(value, readFilterFields(fields));
}

function isEmptyValue(type: PluginFilterFieldType, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return value === "" && (type === "text" || type === "select" || type === "date");
}

/** The day a record's date falls on, from a `YYYY-MM-DD` day, an ISO timestamp, epoch ms or a `Date`. */
function dayOf(value: unknown): string | null {
  if (typeof value === "string") {
    const day = toIsoDate(value);
    if (day !== null) return day;
    return dayOf(Date.parse(value));
  }
  if (value instanceof Date) return dayOf(value.getTime());
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return toIsoDate(todayIso(value));
}

function compare(
  field: FilterFieldModel,
  condition: PluginFilterCondition,
  value: unknown
): boolean {
  const { op } = condition;
  const empty = isEmptyValue(field.type, value);
  if (op === "empty") return empty;
  if (op === "not_empty") return !empty;
  // A record with no value matches no comparison, as in SQL: "is not Me"
  // leaves out the unassigned ones, and `empty` is how to ask for them.
  if (empty) return false;
  const wanted = condition.value;
  switch (field.type) {
    case "text": {
      if (typeof value !== "string" || typeof wanted !== "string") return false;
      if (op === "eq") return value === wanted;
      if (op === "neq") return value !== wanted;
      const found = value.toLocaleLowerCase().includes(wanted.toLocaleLowerCase());
      return op === "contains" ? found : op === "not_contains" && !found;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || typeof wanted !== "number") {
        return false;
      }
      if (op === "eq") return value === wanted;
      if (op === "neq") return value !== wanted;
      if (op === "gt") return value > wanted;
      if (op === "gte") return value >= wanted;
      if (op === "lt") return value < wanted;
      return op === "lte" && value <= wanted;
    }
    case "date": {
      const day = dayOf(value);
      if (day === null || typeof wanted !== "string") return false;
      if (op === "eq") return day === wanted;
      if (op === "before") return day < wanted;
      return op === "after" && day > wanted;
    }
    case "select":
      if (typeof value !== "string") return false;
      return op === "eq" ? value === wanted : op === "neq" && value !== wanted;
    case "boolean":
      return typeof value === "boolean" && op === "eq" && value === wanted;
  }
}

/**
 * Whether one record passes `filter`. `values` holds the record's values by
 * field id, read as its own properties (never a dotted path). A filter
 * `readFilter` refuses matches nothing; one with no conditions matches
 * everything. `contains` ignores case; `eq` is exact. A date field reads a
 * `YYYY-MM-DD` day, or an ISO timestamp, epoch ms or `Date` on the user's
 * local day. A missing value matches only `empty`.
 */
export function matchesFilter(
  filter: PluginFilter,
  values: Readonly<Record<string, unknown>>,
  fields: readonly PluginFilterField[]
): boolean {
  const schema = readFilterFields(fields);
  const read = readWith(filter, schema);
  if (!read) return false;
  if (read.conditions.length === 0) return true;
  if (typeof values !== "object" || values === null) return false;
  const test = (condition: PluginFilterCondition) => {
    const field = schema.get(condition.field);
    return field !== undefined && compare(field, condition, own(values, condition.field));
  };
  return read.match === "all" ? read.conditions.every(test) : read.conditions.some(test);
}
