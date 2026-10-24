import { field, nonEmpty, oneOf, positive, str } from "./kitProps";
import { readColumns, type TableColumn } from "./PluginKitLists";
import type { RowKey } from "./kitDataTableModel";
import { guardCallbacks } from "./kitDiagnostics";

// A plugin callback that throws must not take the table down with it.
export const attempt = guardCallbacks("DataTable");

export function isRowKey(value: unknown): value is RowKey {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export function keyList(value: unknown): RowKey[] | undefined {
  return Array.isArray(value) ? value.filter(isRowKey) : undefined;
}

export function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : undefined;
}

export function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  const out = { ...record };
  delete out[key];
  return out;
}

export function widthRecord(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, width] of Object.entries(value)) {
    if (typeof width === "number" && Number.isFinite(width) && width > 0) out[key] = width;
  }
  return out;
}

const DEFAULT_MIN_WIDTH = 48;
const DEFAULT_MAX_WIDTH = 1200;
/** What an unsized column counts as when the table works out whether it must scroll sideways. */
export const UNSIZED_MIN_PX = 120;
export const CHECK_COLUMN_PX = 32;
export const MENU_COLUMN_PX = 32;

type EditorKind = "text" | "number" | "select";

export interface RichColumn extends TableColumn {
  resizable: boolean;
  minWidth: number;
  maxWidth: number;
  hideable: boolean;
  menuLabel: string;
  editable: ((row: unknown) => boolean) | null;
  editor: EditorKind;
  editOptions: { value: string; label: string; disabled: boolean }[];
  editValue: ((row: unknown) => string) | undefined;
  validate: ((value: string, row: unknown) => string | undefined) | undefined;
}

function readOptions(value: unknown): RichColumn["editOptions"] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: RichColumn["editOptions"] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const optionValue = nonEmpty(field(entry, "value"));
    if (!optionValue || seen.has(optionValue)) continue;
    seen.add(optionValue);
    out.push({
      value: optionValue,
      label: str(field(entry, "label")) ?? optionValue,
      disabled: field(entry, "disabled") === true,
    });
  }
  return out;
}

export function readRichColumns(columns: unknown): RichColumn[] {
  const base = readColumns(columns);
  const raw = new Map<string, object>();
  if (Array.isArray(columns)) {
    for (const entry of columns) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = nonEmpty(field(entry, "id"));
      if (id !== undefined && !raw.has(id)) raw.set(id, entry);
    }
  }
  return base.map((column) => {
    const entry = raw.get(column.id) ?? {};
    const min = positive(field(entry, "minWidth"), 10_000) ?? DEFAULT_MIN_WIDTH;
    const max = Math.max(min, positive(field(entry, "maxWidth"), 10_000) ?? DEFAULT_MAX_WIDTH);
    const editable = field(entry, "editable");
    const editValue = field(entry, "editValue");
    const validate = field(entry, "validate");
    const header = field(entry, "header");
    return {
      ...column,
      resizable: field(entry, "resizable") === true,
      minWidth: min,
      maxWidth: max,
      hideable: field(entry, "hideable") !== false,
      menuLabel:
        nonEmpty(field(entry, "menuLabel")) ??
        (typeof header === "string" && header !== "" ? header : column.id),
      editable:
        editable === true
          ? () => true
          : typeof editable === "function"
            ? (row: unknown) =>
                attempt(() => Reflect.apply(editable, undefined, [row]) === true, false)
            : null,
      editor: oneOf(field(entry, "editor"), ["text", "number", "select"] as const) ?? "text",
      editOptions: readOptions(field(entry, "editOptions")),
      editValue:
        typeof editValue === "function"
          ? (row: unknown) => {
              const text: unknown = attempt(
                () => Reflect.apply(editValue, undefined, [row]),
                undefined
              );
              return typeof text === "string" ? text : "";
            }
          : undefined,
      validate:
        typeof validate === "function"
          ? (value: string, row: unknown) => {
              // A check that throws refuses the draft rather than letting it through.
              const message: unknown = attempt(
                () => Reflect.apply(validate, undefined, [value, row]),
                "Couldn't check this value"
              );
              return nonEmpty(message);
            }
          : undefined,
    };
  });
}
