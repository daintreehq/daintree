import { useState } from "react";
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

export function useControllable<T>(
  controlled: T | undefined,
  initial: () => T,
  onChange: ((value: T) => void) | undefined
): [T, (value: T) => void] {
  const [own, setOwn] = useState<T>(initial);
  const value = controlled ?? own;
  const set = (next: T) => {
    if (controlled === undefined) setOwn(next);
    onChange?.(next);
  };
  return [value, set];
}
