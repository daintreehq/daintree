import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  BridgeError,
  FileSpool,
  type AttachmentResolver,
  type AttachmentSpool,
} from "@daintreehq/decisions-client";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { ensureOwnerOnlyDir, syncParentDirectory } from "../../utils/fs.js";
import { createWorktreeAttachmentResolver } from "./attachmentResolver.js";

/** A spool entry as `FileSpool` names it, or the temporary file a write renames from. */
const SPOOL_ENTRY = /^[A-Za-z0-9_-]{1,80}(\.tmp)?$/;

/**
 * What every bridge of an enabled lifetime asks with, whichever of them takes
 * the ask: one resolver, one durable spool, and one gate asks pass one at a
 * time.
 */
export interface QuestionAttachments {
  readonly resolver: AttachmentResolver;
  readonly spool: AttachmentSpool;
  /** Runs `ask` once every ask before it, and the cleanup after it, has settled. */
  register<T>(ask: () => Promise<T>): Promise<T>;
}

export interface DecisionsAttachmentsOptions {
  /** The spool's own directory, kept across lifetimes and restarts. */
  dir: string;
  /** Every attachment id a pending create names. Throws when it can't tell, and nothing is swept. */
  referenced(): Promise<ReadonlySet<string>>;
  resolver?: AttachmentResolver;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * The attachments of one open store (#16014). The library encrypts each image
 * as it is asked and spools the ciphertext, and the create it commits names
 * those spool entries; each attempt's flush uploads them and the library
 * deletes them once the question is published, cancelled before it ever was,
 * or refused for good. The spool is files, so what a restart interrupts is
 * uploaded by the next run from the ciphertext alone, never the screenshot.
 *
 * What the library leaves behind, this sweeps: entries no pending create
 * names. That is a crash between spooling and committing, an ask refused
 * after its first attachments were spooled (the library spools each before
 * it reads the next), and whatever a deletion of the rows left. Asks and
 * sweeps take turns on one gate, so a sweep never sees an ask's spooled
 * entries before its create has committed. A sweep runs when the store opens
 * and after an ask that spooled something fails.
 */
export class DecisionsAttachments implements QuestionAttachments {
  readonly resolver: AttachmentResolver;
  readonly spool: AttachmentSpool;
  private readonly files: FileSpool;
  private gate: Promise<void>;
  private closed = false;
  /** Whether the ask holding the gate has spooled anything. */
  private spooled = false;
  /** The spool directory's own entry, in the directory above it, is on disk. */
  private dirDurable = false;

  constructor(private readonly options: DecisionsAttachmentsOptions) {
    this.resolver = options.resolver ?? createWorktreeAttachmentResolver();
    this.files = new FileSpool(options.dir);
    this.spool = {
      put: (id, bytes) => this.put(id, bytes),
      get: (id) => this.files.get(id),
      delete: (id) => this.files.delete(id),
    };
    this.gate = this.sweepQuietly();
  }

  register<T>(ask: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      if (this.closed) {
        throw new BridgeError("forbidden", "Decisions has stopped taking questions here");
      }
      this.spooled = false;
      try {
        return await ask();
      } catch (error) {
        // A create that did commit still names its entries, so they are kept.
        if (this.spooled) await this.sweepQuietly();
        throw error;
      } finally {
        this.spooled = false;
      }
    });
    this.gate = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * Takes no more asks, and settles once the ask holding the gate, and its
   * cleanup, have: the store may close after that. The spool stays.
   */
  close(): Promise<void> {
    this.closed = true;
    return this.gate;
  }

  /**
   * Deletes every spool entry no pending create names, and every leftover
   * temporary file. Runs only on the gate; returns how many went.
   */
  async sweep(): Promise<number> {
    try {
      // Never through a symlink: the sweep would delete files wherever it led.
      const dir = await lstat(this.options.dir);
      if (dir.isSymbolicLink() || !dir.isDirectory()) {
        throw new Error("The attachment spool isn't a real directory");
      }
    } catch (error) {
      if (codeOf(error) === "ENOENT") return 0;
      throw error;
    }
    const names = await readdir(this.options.dir);
    const entries = names.filter((name) => SPOOL_ENTRY.test(name));
    if (entries.length === 0) return 0;
    const keep = await this.options.referenced();
    let removed = 0;
    for (const name of entries) {
      if (keep.has(name)) continue;
      try {
        await unlink(join(this.options.dir, name));
        removed += 1;
      } catch {
        // Gone already, or not a file (a directory named like one): left alone.
      }
    }
    return removed;
  }

  private async sweepQuietly(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      console.warn(
        `[Decisions] The attachment spool wasn't swept: ${formatErrorMessage(error, "unknown error")}`
      );
    }
  }

  /**
   * Durable before the create naming it commits: written and synced by
   * `FileSpool`, then the spool directory synced, and the directory above it
   * once the spool's own entry is new, so a crash can't keep the create and
   * lose its ciphertext.
   */
  private async put(id: string, bytes: Uint8Array): Promise<void> {
    this.spooled = true;
    await ensureOwnerOnlyDir(this.options.dir);
    if (!this.dirDurable) {
      await syncParentDirectory(this.options.dir);
      this.dirDurable = true;
    }
    await this.files.put(id, bytes);
    await syncParentDirectory(join(this.options.dir, id));
  }
}
