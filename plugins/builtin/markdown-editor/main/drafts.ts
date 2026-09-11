import os from "node:os";
import path from "node:path";
import { unlink } from "node:fs/promises";
import type { PluginFsApi } from "../../../../shared/types/plugin.js";
import { runExclusive } from "../../../../electron/utils/keyedMutex.js";
import {
  DRAFT_RECORD_LIMIT,
  DRAFT_STORAGE_LIMIT_BYTES,
  DraftRecordSchema,
  identityKey,
  PLUGIN_ID,
  type DocumentIdentity,
  type DraftPutResult,
  type DraftRecord,
  type DraftSummary,
} from "../shared/protocol.js";
import { sha256Hex } from "./documentCodec.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

/**
 * Draft recovery records (#12323): one JSON file per document identity under
 * the plugin's own data directory, keyed by a hash of the identity so a path
 * never leaks into a file name. Ordinary Markdown files stay the durable
 * documents; this is a recovery net, not a second document system.
 *
 * Writes go through the host's checked `fs.writeFile`, so a record is
 * replaced atomically and audited like any other plugin write. Deletion has
 * no host API, so it is the one raw `node:fs` call here, and it is fenced to
 * files this store itself named inside its own directory.
 *
 * Every operation on one identity is serialised, and a put carries the
 * generation the renderer minted for it: a delete records its generation, and
 * a put at or below that generation is ignored, so a debounced write that
 * lands after a save or discard can never bring the draft back.
 */
export interface DraftStoreDeps {
  fs: Pick<PluginFsApi, "readFile" | "writeFile" | "readdir" | "stat">;
  /** Overridable so tests can point the store at a fixture directory. */
  draftsDir?: string;
  now?: () => number;
}

const RECORD_FILE = /^[0-9a-f]{64}\.json$/;

export function defaultDraftsDir(): string {
  return path.join(os.homedir(), ".daintree", "plugin-data", PLUGIN_ID, "drafts");
}

export class DraftStore {
  private readonly fs: DraftStoreDeps["fs"];
  private readonly dir: string;
  private readonly deletedAt = new Map<string, number>();

  constructor(deps: DraftStoreDeps) {
    this.fs = deps.fs;
    this.dir = deps.draftsDir ?? defaultDraftsDir();
  }

  get directory(): string {
    return this.dir;
  }

  private recordPath(identity: DocumentIdentity): string {
    return path.join(this.dir, `${sha256Hex(identityKey(identity))}.json`);
  }

  /**
   * One lock for the whole store, not one per identity: the record and byte
   * caps are measured against every file in the directory, so two identities
   * racing past the cap would each see room and both land.
   */
  private lockKey(_identity: DocumentIdentity): string {
    return `markdown-editor-drafts:${this.dir}`;
  }

  async get(identity: DocumentIdentity): Promise<DraftRecord | null> {
    return runExclusive(this.lockKey(identity), () => this.readRecord(this.recordPath(identity)));
  }

  private async readRecord(filePath: string): Promise<DraftRecord | null> {
    let raw: string;
    try {
      raw = await this.fs.readFile(filePath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = DraftRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  async put(record: DraftRecord, generation: number): Promise<DraftPutResult> {
    return runExclusive(this.lockKey(record.identity), async () => {
      const key = identityKey(record.identity);
      const tombstone = this.deletedAt.get(key);
      if (tombstone !== undefined && generation <= tombstone) return { status: "ignored" };
      const target = this.recordPath(record.identity);
      const serialized = JSON.stringify(record);
      const usage = await this.usage();
      const existing = usage.files.get(path.basename(target));
      const records = usage.files.size + (existing === undefined ? 1 : 0);
      const bytes = usage.bytes - (existing ?? 0) + Buffer.byteLength(serialized, "utf-8");
      if (records > DRAFT_RECORD_LIMIT || bytes > DRAFT_STORAGE_LIMIT_BYTES) {
        return { status: "full", records: usage.files.size, bytes: usage.bytes };
      }
      try {
        await this.fs.writeFile(target, serialized, {});
      } catch (error) {
        return { status: "error", message: formatErrorMessage(error, "Draft could not be stored") };
      }
      return { status: "stored" };
    });
  }

  async delete(identity: DocumentIdentity, generation: number): Promise<boolean> {
    return runExclusive(this.lockKey(identity), async () => {
      const key = identityKey(identity);
      const previous = this.deletedAt.get(key) ?? -1;
      if (generation > previous) this.deletedAt.set(key, generation);
      const target = this.recordPath(identity);
      if (!RECORD_FILE.test(path.basename(target)) || path.dirname(target) !== this.dir) {
        throw new Error("DraftStore: refusing to delete outside the drafts directory");
      }
      try {
        await unlink(target);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    });
  }

  async list(): Promise<DraftSummary[]> {
    const usage = await this.usage();
    const summaries: DraftSummary[] = [];
    for (const [name, bytes] of usage.files) {
      const record = await this.readRecord(path.join(this.dir, name));
      if (!record) continue;
      summaries.push({ identity: record.identity, updatedAt: record.updatedAt, bytes });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  private async usage(): Promise<{ files: Map<string, number>; bytes: number }> {
    const files = new Map<string, number>();
    let entries: Awaited<ReturnType<PluginFsApi["readdir"]>>;
    try {
      entries = await this.fs.readdir(this.dir, { detail: true });
    } catch (error) {
      if (isMissing(error)) return { files, bytes: 0 };
      throw error;
    }
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile || !RECORD_FILE.test(entry.name)) continue;
      const size = entry.size ?? 0;
      files.set(entry.name, size);
      bytes += size;
    }
    return { files, bytes };
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = (error as { message?: unknown }).message;
  // The host wraps a missing path as a containment failure (the realpath of a
  // file that does not exist resolves nowhere) — read that as absent too.
  return typeof message === "string" && /ENOENT|PATH_NOT_ALLOWED|no such file/i.test(message);
}
