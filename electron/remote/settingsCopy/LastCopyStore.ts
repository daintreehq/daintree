import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  isConfigBundleSectionId,
  type ConfigBundleSectionId,
} from "../../../shared/types/configBundle.js";
import type { SettingsCopyLastCopy } from "../../../shared/types/ipc/settingsCopy.js";
import { resilientAtomicWriteFile } from "../../utils/fs.js";

/** One leaf the last copy changed, with what it held before: private to this machine. */
export interface LastCopyLeaf {
  section: ConfigBundleSectionId;
  key: string;
  label: string;
  before?: unknown;
  after?: unknown;
}

export interface LastCopyRecord {
  copy: SettingsCopyLastCopy;
  /** Present while the copy can still be undone. */
  leaves?: LastCopyLeaf[];
}

/**
 * Previous values can be secrets this machine already held, so the record is
 * capped: a copy whose undo would outgrow it is recorded without one.
 */
export const LAST_COPY_MAX_BYTES = 4 * 1024 * 1024;

const FileSchema = z.object({
  version: z.literal(1),
  copy: z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/),
    source: z.string().max(256),
    at: z.number().int().nonnegative(),
    sections: z.array(
      z.object({ section: z.string(), applied: z.number().int(), skipped: z.number().int() })
    ),
    undo: z.enum(["available", "unavailable", "done"]),
    undone: z
      .object({
        at: z.number().int().nonnegative(),
        leaves: z.array(
          z.object({
            section: z.string(),
            key: z.string(),
            label: z.string(),
            status: z.enum(["restored", "unchanged", "edited", "failed"]),
          })
        ),
      })
      .optional(),
  }),
  leaves: z
    .array(
      z.object({
        section: z.string(),
        key: z.string(),
        label: z.string(),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
      })
    )
    .optional(),
});

function serialize(record: LastCopyRecord): string {
  return JSON.stringify({ version: 1, ...record });
}

/**
 * The last settings copy this host received, kept in its own file under
 * userData (owner-only), never in the settings store: so no settings backup,
 * export or Copy settings ever carries the earlier values it holds. One
 * record; each copy replaces it.
 */
export class LastCopyStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<LastCopyRecord | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[LastCopyStore] Failed to read the last copy:", error);
      }
      return null;
    }
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(raw));
    } catch (error) {
      console.error("[LastCopyStore] The last copy record is unreadable:", error);
      return null;
    }
    const known = <T extends { section: string }>(items: T[]) =>
      items.filter((item): item is T & { section: ConfigBundleSectionId } =>
        isConfigBundleSectionId(item.section)
      );
    const { undone, ...rest } = parsed.copy;
    const copy: SettingsCopyLastCopy = {
      ...rest,
      sections: known(rest.sections),
      ...(undone ? { undone: { ...undone, leaves: known(undone.leaves) } } : {}),
    };
    return parsed.leaves ? { copy, leaves: known(parsed.leaves) } : { copy };
  }

  /** Write `record`, dropping its undo when it would outgrow the cap. */
  async write(record: LastCopyRecord): Promise<LastCopyRecord> {
    let kept = record;
    let data = serialize(kept);
    if (kept.leaves && Buffer.byteLength(data, "utf8") > LAST_COPY_MAX_BYTES) {
      kept = { copy: { ...record.copy, undo: "unavailable" } };
      data = serialize(kept);
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await resilientAtomicWriteFile(this.filePath, data, "utf-8", { mode: 0o600 });
    return kept;
  }
}
