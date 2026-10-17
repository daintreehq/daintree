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
  /**
   * Compare an incoming payload against the current value, per leaf. `ctx`
   * is there during a preview, for a section whose result depends on another
   * section of the same bundle landing first.
   */
  diff: (incoming: unknown, current: unknown, ctx?: SectionContext) => SectionDiff;
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
  /**
   * The stored value behind one leaf the apply reported, or undefined when it
   * isn't there. A plain keyed record by default; a section whose leaves are
   * array entries or nested names says how to find them.
   */
  leafValue?: (value: unknown, key: string) => unknown;
  /** `value` with one leaf replaced, or removed when `leaf` is undefined. */
  withLeaf?: (value: unknown, key: string, leaf: unknown) => unknown;
  /**
   * Undo a copy's leaves itself, for a section whose `restore` would rewrite
   * entries the undo has no business touching. Same contract as the generic
   * undo: restore a leaf only while it still holds what the copy wrote.
   */
  undo?: (leaves: UndoLeaf[]) => Promise<UndoLeafResult[]>;
}

/** One leaf a copy changed: what it held before (absent when undefined) and what the copy wrote. */
export interface UndoLeaf {
  key: string;
  before?: unknown;
  after?: unknown;
}

export type UndoLeafStatus = "restored" | "unchanged" | "edited" | "failed";

export interface UndoLeafResult {
  key: string;
  status: UndoLeafStatus;
}

export function recordLeafValue(value: unknown, key: string): unknown {
  return isRecord(value) && hasOwn(value, key) ? value[key] : undefined;
}

export function withRecordLeaf(value: unknown, key: string, leaf: unknown): unknown {
  const next: Record<string, unknown> = isRecord(value) ? { ...value } : {};
  if (leaf === undefined) delete next[key];
  else next[key] = leaf;
  return next;
}

export interface UndoPlan {
  /** `current` with every leaf that still holds what the copy wrote put back. */
  next: unknown;
  /** The leaves `next` puts back; whether they landed is read back after the write. */
  pending: UndoLeaf[];
  statuses: Map<string, UndoLeafStatus>;
}

/**
 * The three-way call for each leaf: already as it was is `unchanged`, still
 * what the copy wrote is put back, anything else was edited since and stays.
 */
export function planUndo(
  leaves: readonly UndoLeaf[],
  current: unknown,
  leafOf: (value: unknown, key: string) => unknown = recordLeafValue,
  put: (value: unknown, key: string, leaf: unknown) => unknown = withRecordLeaf
): UndoPlan {
  const statuses = new Map<string, UndoLeafStatus>();
  const pending: UndoLeaf[] = [];
  let next = current;
  for (const leaf of leaves) {
    const now = leafOf(current, leaf.key);
    if (sameValue(now, leaf.before)) statuses.set(leaf.key, "unchanged");
    else if (sameValue(now, leaf.after)) {
      next = put(next, leaf.key, leaf.before);
      pending.push(leaf);
    } else statuses.set(leaf.key, "edited");
  }
  return { next, pending, statuses };
}

/** One result per leaf, a put-back leaf `restored` only if the read-back shows it. */
export function settleUndo(
  leaves: readonly UndoLeaf[],
  plan: UndoPlan,
  readBack: unknown,
  leafOf: (value: unknown, key: string) => unknown = recordLeafValue
): UndoLeafResult[] {
  for (const leaf of plan.pending) {
    plan.statuses.set(
      leaf.key,
      sameValue(leafOf(readBack, leaf.key), leaf.before) ? "restored" : "failed"
    );
  }
  return leaves.map(({ key }) => ({ key, status: plan.statuses.get(key) ?? "failed" }));
}

/**
 * An undo for a keyed map, worked on the map as stored rather than on
 * `read()`: a read that sanitizes (drops an entry it can't parse, a field it
 * doesn't know) would otherwise write that loss back over leaves the undo
 * isn't touching. A write whose follow-up throws (a menu rebuild) is still
 * judged by what the store now holds.
 */
export function storedMapUndo(
  readStored: () => unknown,
  writeStored: (value: Record<string, unknown>) => Promise<void> | void
): (leaves: UndoLeaf[]) => Promise<UndoLeafResult[]> {
  return async (leaves) => {
    const stored = readStored();
    const plan = planUndo(leaves, isRecord(stored) ? stored : {});
    if (plan.pending.length > 0) {
      try {
        await writeStored(plan.next as Record<string, unknown>);
      } catch (error) {
        console.error("[ConfigBundleService] Undo write failed:", error);
      }
    }
    return settleUndo(leaves, plan, readStored());
  };
}

/** A list of records keyed by `id`, as recipes and custom themes are kept. */
export function listLeafValue(list: unknown, id: string): unknown {
  return Array.isArray(list)
    ? list.find((item) => isRecord(item) && String(item.id) === id)
    : undefined;
}

/** `list` with the entry for `id` replaced in place, appended, or removed when `leaf` is undefined. */
export function withListLeaf(list: unknown, id: string, leaf: unknown): unknown[] {
  const items = Array.isArray(list) ? [...list] : [];
  const index = items.findIndex((item) => isRecord(item) && String(item.id) === id);
  if (leaf === undefined) {
    if (index !== -1) items.splice(index, 1);
  } else if (index === -1) items.push(leaf);
  else items[index] = leaf;
  return items;
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
