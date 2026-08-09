import { CopyTreeHistoryFileSchema } from "../schemas/copyTreeHistory.js";
import {
  COPY_TREE_HISTORY_SCHEMA_VERSION,
  type CopyTreeHistoryRecord,
} from "../../shared/types/ipc/copyTreeHistory.js";

/**
 * Why a copy-tree history file could not be read. `future-version` is separated
 * from `corrupt` because the two quarantine under different names and mean
 * different things to a user: one is damage, the other is a downgrade.
 */
export type CopyTreeHistoryDecodeResult =
  | { ok: true; records: CopyTreeHistoryRecord[] }
  | { ok: false; reason: "corrupt" }
  | { ok: false; reason: "future-version"; onDiskVersion: number };

/**
 * Total: never throws, for any input at all. Callers branch on the result
 * instead of wrapping this in a try, so there is no path where a parse failure
 * silently degrades to "empty history" and the next write destroys the file.
 */
export function decodeCopyTreeHistoryFile(raw: string): CopyTreeHistoryDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "corrupt" };
  }

  // Version is classified before shape: a file from a newer app may legitimately
  // fail today's schema, and reporting that as damage would quarantine it under
  // the wrong name and lose why it was unreadable.
  const rawVersion = (parsed as Record<string, unknown>)._schemaVersion;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion) || rawVersion < 0) {
    return { ok: false, reason: "corrupt" };
  }
  if (rawVersion > COPY_TREE_HISTORY_SCHEMA_VERSION) {
    return { ok: false, reason: "future-version", onDiskVersion: rawVersion };
  }

  const result = CopyTreeHistoryFileSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "corrupt" };
  }

  return { ok: true, records: result.data.records };
}

/**
 * Builds the envelope field by field rather than spreading an input object, so
 * a forged `_schemaVersion` riding along on a record set is structurally
 * incapable of reaching disk.
 */
export function encodeCopyTreeHistoryFile(records: CopyTreeHistoryRecord[]): string {
  return JSON.stringify({ _schemaVersion: COPY_TREE_HISTORY_SCHEMA_VERSION, records }, null, 2);
}
