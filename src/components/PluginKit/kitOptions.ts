import { isValidElement } from "react";
import type { PluginSelectOption } from "@shared/types/plugin-sdk-react";
import { field, nonEmpty, str } from "./kitProps";

export type SelectEntry =
  | { kind: "option"; option: PluginSelectOption }
  | { kind: "group"; label: string; options: PluginSelectOption[] };

function readSelectOption(value: unknown, seen: Set<string>): PluginSelectOption | null {
  if (typeof value !== "object" || value === null) return null;
  const optionValue = nonEmpty(field(value, "value"));
  const label = str(field(value, "label"));
  // Radix reserves "" for "no selection", and a repeated value makes two rows
  // report the same pick.
  if (optionValue === undefined || label === undefined || seen.has(optionValue)) return null;
  seen.add(optionValue);
  const icon = field(value, "icon");
  return {
    value: optionValue,
    label,
    description: str(field(value, "description")),
    // A name (any Lucide icon, loaded on first use) or the plugin's own
    // element; anything else leaves the row without an icon gutter.
    icon: nonEmpty(icon) ?? (isValidElement(icon) ? icon : undefined),
    disabled: field(value, "disabled") === true,
  };
}

/**
 * Plugin options, narrowed to what a `Select`, `Combobox` or `MultiSelect`
 * can render. Exported for tests.
 */
export function normalizeSelectOptions(options: unknown): SelectEntry[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const entries: SelectEntry[] = [];
  for (const entry of options) {
    if (typeof entry !== "object" || entry === null) continue;
    const groupOptions = field(entry, "options");
    if (Array.isArray(groupOptions)) {
      const label = str(field(entry, "label")) ?? "";
      const inner = groupOptions
        .map((option) => readSelectOption(option, seen))
        .filter((option): option is PluginSelectOption => option !== null);
      if (inner.length > 0) entries.push({ kind: "group", label, options: inner });
      continue;
    }
    const option = readSelectOption(entry, seen);
    if (option) entries.push({ kind: "option", option });
  }
  return entries;
}
