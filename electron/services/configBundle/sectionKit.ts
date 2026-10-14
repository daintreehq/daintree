import type { CliAvailability } from "../../../shared/types/ipc/system.js";
import type {
  ConfigBundlePreviewChange,
  ConfigBundleSectionId,
  ConfigImportLeafResult,
} from "../../../shared/types/configBundle.js";

/** Shared shape and helpers for the sections behind `ConfigBundleService`. */

export interface SectionDiff {
  add: string[];
  update: string[];
  unchanged: string[];
}

/** What the target would refuse, and what it should say about the rest, before anything is written. */
export interface SectionCheck {
  skipped: Map<string, string>;
  notes: Map<string, string>;
  /** Names for skipped keys the diff never lists (a preset under an agent). */
  labels?: Map<string, string>;
}

export interface SectionContext {
  /** Every section in the same bundle, for checks that depend on another (a preset it adds). */
  incoming: Partial<Record<ConfigBundleSectionId, unknown>>;
  /** Which agent CLIs this machine has, or null before the first scan. */
  availability: CliAvailability | null;
  platform: NodeJS.Platform;
  /** Whether a custom agent's command resolves on this machine. */
  commandAvailable: (command: string) => Promise<boolean>;
}

export interface SectionHandler {
  id: ConfigBundleSectionId;
  /** Everything the section can change, as it is now: the rollback snapshot and the revision source. */
  read: () => Promise<unknown>;
  /** The part of `read()` that may leave this machine. Identity when absent. */
  export?: (current: unknown) => unknown;
  /** Compare an incoming payload against the current value, per leaf. */
  diff: (incoming: unknown, current: unknown) => SectionDiff;
  /** Validation the preview reports before the apply would discover it. */
  check?: (incoming: unknown, current: unknown, ctx: SectionContext) => Promise<SectionCheck>;
  /** Name one changed leaf. Sections without it fall back to the service's table. */
  describe?: (
    key: string,
    kind: "add" | "update",
    incoming: unknown,
    current: unknown,
    ctx: SectionContext
  ) => ConfigBundlePreviewChange;
  /** Write + read back. Returns one result per requested leaf. */
  apply: (incoming: unknown, current: unknown) => Promise<ConfigImportLeafResult[]>;
  /** Put the snapshot back after a failed import. */
  restore: (snapshot: unknown) => Promise<void>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Structural equality via canonical JSON — sufficient for config leaves. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Diff a keyed record: present-here-only is an add, different is an update,
 * identical is unchanged. Keys only on the target are untouched and unreported —
 * import merges, it never deletes.
 */
export function diffRecord(incoming: unknown, current: unknown): SectionDiff {
  const result: SectionDiff = { add: [], update: [], unchanged: [] };
  if (!isRecord(incoming)) return result;
  const currentRecord = isRecord(current) ? current : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!hasOwn(currentRecord, key)) result.add.push(key);
    else if (sameValue(value, currentRecord[key])) result.unchanged.push(key);
    else result.update.push(key);
  }
  return result;
}

export function emptyCheck(): SectionCheck {
  return { skipped: new Map(), notes: new Map() };
}

export function unchangedLeaf(key: string): ConfigImportLeafResult {
  return { key, status: "unchanged" };
}

export function skippedLeaf(key: string, reason: string): ConfigImportLeafResult {
  return { key, status: "skipped", reason };
}

/** "someNewSetting" → "Some new setting" — the fallback for keys no table names. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/**
 * A scalar as a person would read it, or undefined when it isn't one worth
 * showing. `maxLength` keeps free-form strings from flooding a row; a value the
 * row is built to wrap (a path pattern) passes Infinity.
 */
export function displayScalar(value: unknown, maxLength = 60): string | undefined {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "" && value.length <= maxLength) return value;
  return undefined;
}

export const NOT_A_SETTING = "Not a setting this version of Daintree has";

export interface ScalarField {
  label: string;
  /** The value as it would be stored, or undefined when it can't be. */
  normalize: (value: unknown) => unknown;
  invalidReason?: string;
  display?: (value: unknown) => string | undefined;
}

export interface ScalarSectionOptions {
  id: ConfigBundleSectionId;
  fields: Record<string, ScalarField>;
  /** The stored record the fields live in. */
  read: () => unknown;
  /** Write a patch of normalized fields through the setting's own setter. */
  write: (patch: Record<string, unknown>) => Promise<void> | void;
}

/** Whole-number `n` within `[min, max]`, rounded the way the setting's service rounds it. */
export function boundedInteger(min: number, max: number) {
  return (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.round(value)))
      : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A section made of a few named scalar fields of one stored record. Values
 * are normalized before they are compared, the way the setting's own service
 * clamps them, so a value it would round can't show as a change no write
 * closes. Writes go through the setter that keeps the running service in step.
 */
export function scalarSection(options: ScalarSectionOptions): SectionHandler {
  const { id, fields } = options;
  const readFields = (): Record<string, unknown> => {
    const raw = options.read();
    const record = isRecord(raw) ? raw : {};
    const out: Record<string, unknown> = {};
    for (const field of Object.keys(fields)) {
      if (record[field] !== undefined) out[field] = record[field];
    }
    return out;
  };
  const normalized = (field: string, value: unknown) =>
    hasOwn(fields, field) ? fields[field].normalize(value) : undefined;

  return {
    id,
    read: async () => readFields(),
    diff: (incoming, current) => {
      const result: SectionDiff = { add: [], update: [], unchanged: [] };
      if (!isRecord(incoming)) return result;
      const currentRecord = isRecord(current) ? current : {};
      for (const [field, value] of Object.entries(incoming)) {
        const next = normalized(field, value);
        if (currentRecord[field] === undefined) result.add.push(field);
        else if (next !== undefined && sameValue(next, currentRecord[field])) {
          result.unchanged.push(field);
        } else result.update.push(field);
      }
      return result;
    },
    check: async (incoming) => {
      const check = emptyCheck();
      if (!isRecord(incoming)) return check;
      for (const [field, value] of Object.entries(incoming)) {
        if (!hasOwn(fields, field)) check.skipped.set(field, NOT_A_SETTING);
        else if (fields[field].normalize(value) === undefined) {
          check.skipped.set(field, fields[field].invalidReason ?? "Not a valid value");
        }
      }
      return check;
    },
    describe: (key, kind, incoming, current) => {
      const spec = hasOwn(fields, key) ? fields[key] : undefined;
      const show = spec?.display ?? ((value: unknown) => displayScalar(value));
      const incomingRecord = isRecord(incoming) ? incoming : {};
      const currentRecord = isRecord(current) ? current : {};
      return {
        key,
        kind,
        label: spec?.label ?? humanizeKey(key),
        from: kind === "update" ? show(currentRecord[key]) : undefined,
        to: show(normalized(key, incomingRecord[key]) ?? incomingRecord[key]),
      };
    },
    apply: async (incoming, current) => {
      const results: ConfigImportLeafResult[] = [];
      if (!isRecord(incoming)) return results;
      const currentRecord = isRecord(current) ? current : {};
      const patch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(incoming)) {
        if (!hasOwn(fields, field)) {
          results.push(skippedLeaf(field, NOT_A_SETTING));
          continue;
        }
        const next = fields[field].normalize(value);
        if (next === undefined) {
          results.push(skippedLeaf(field, fields[field].invalidReason ?? "Not a valid value"));
          continue;
        }
        if (sameValue(next, currentRecord[field])) {
          results.push(unchangedLeaf(field));
          continue;
        }
        patch[field] = next;
      }
      if (Object.keys(patch).length === 0) return results;
      await options.write(patch);
      const readBack = readFields();
      for (const [field, value] of Object.entries(patch)) {
        results.push(
          sameValue(readBack[field], value)
            ? { key: field, status: "applied" }
            : skippedLeaf(field, "Value did not persist")
        );
      }
      return results;
    },
    restore: async (snapshot) => {
      const record = isRecord(snapshot) ? snapshot : {};
      if (Object.keys(record).length > 0) await options.write(record);
    },
  };
}
