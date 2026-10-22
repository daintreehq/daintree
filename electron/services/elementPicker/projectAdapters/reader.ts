import path from "node:path";
import fs, { type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { readBoundedFromHandle } from "../../../utils/boundedRead.js";
import { isStrictlyInside } from "../containment.js";
import {
  MAX_METADATA_BYTES,
  type BoundedTextRead,
  type ProjectBoundedReadOptions,
  type ProjectFileReader,
  type ProjectReadOptions,
} from "./fs.js";

const decoder = new TextDecoder("utf-8");

function outsideWorkspace(): Error {
  return new Error("the path is outside the workspace");
}

/**
 * A project reader held to one workspace's worktree, the same authority the
 * legacy plugin's `host.fs` grants: an app's toolchain is hoisted to the
 * worktree root in a monorepo, so its manifests and lockfiles are read above
 * the app. Nothing here reads past the worktree, follows a symlink out of it,
 * or writes.
 *
 * `root` must already be canonical, as `PickerWorkspace.roots` is. Every path
 * is checked lexically before the disk is touched, then by its real path, so a
 * link inside the worktree that leads out of it is refused. A refusal rejects
 * like a missing file; the project helpers report either as absence.
 *
 * `signal` is bound in, as the adapter's helpers take a reader and nothing
 * else: a deadline or a released workspace ends every read they make. An open
 * or a stat already started in the OS is abandoned, not interrupted.
 */
export function createWorkspaceReader(root: string, signal?: AbortSignal): ProjectFileReader {
  const within = (candidate: string) => candidate === root || isStrictlyInside(root, candidate);
  // A caller's own signal narrows the bound one, never replaces it: a closed
  // workspace ends a read whatever the call was handed.
  const signalOf = (options?: ProjectReadOptions) => {
    const own = options?.signal;
    if (!own || !signal || own === signal) return own ?? signal;
    return AbortSignal.any([own, signal]);
  };

  const contain = async (target: string, active: AbortSignal | undefined): Promise<string> => {
    active?.throwIfAborted();
    const lexical = path.resolve(target);
    if (!within(lexical)) throw outsideWorkspace();
    const real = await fs.realpath(lexical);
    active?.throwIfAborted();
    if (!within(real)) throw outsideWorkspace();
    return real;
  };

  const readBoundedText = async (
    target: string,
    options: ProjectBoundedReadOptions
  ): Promise<BoundedTextRead> => {
    const active = signalOf(options);
    const real = await contain(target, active);
    let handle: FileHandle;
    try {
      // O_NONBLOCK so a FIFO standing at the path cannot hold the open; the
      // regular-file check is then made on the descriptor, not on the name.
      handle = await fs.open(
        real,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
      );
    } catch (error) {
      active?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      throw error;
    }
    try {
      // What was opened must be what containment resolved. Windows has no
      // O_NOFOLLOW, so a leaf swapped for a link out of the worktree is caught
      // by comparing the descriptor with what stands at the path; an ancestor
      // swapped and left in place, by resolving the path again. As in
      // `readBoundedSource`, a swap undone between the two is not caught.
      const [opened, entry, again] = await Promise.all([
        handle.stat({ bigint: true }),
        fs.lstat(real, { bigint: true }).catch(() => null),
        fs.realpath(real).catch(() => null),
      ]);
      active?.throwIfAborted();
      if (
        !entry ||
        entry.isSymbolicLink() ||
        entry.dev !== opened.dev ||
        entry.ino !== opened.ino ||
        again !== real
      ) {
        throw outsideWorkspace();
      }
      if (!opened.isFile()) return { status: "not-a-file" };
      const bytes = await readBoundedFromHandle(
        handle,
        Number(opened.size),
        options.limitBytes,
        active
      );
      if (bytes === null) return { status: "too-large" };
      const text = decoder.decode(bytes);
      // A BOM would fail `JSON.parse`; every other caller reads config text.
      return { status: "ok", text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  return {
    // The helpers read through `readBoundedText`; this is the interface's
    // plain read, held to the same ceiling rather than left unbounded in main.
    async readFile(target, options) {
      const read = await readBoundedText(target, {
        limitBytes: MAX_METADATA_BYTES,
        signal: signalOf(options),
      });
      if (read.status !== "ok") throw new Error(`the file could not be read: ${read.status}`);
      return read.text;
    },
    async readdir(target, options) {
      const active = signalOf(options);
      const entries = await fs.readdir(await contain(target, active), { withFileTypes: true });
      active?.throwIfAborted();
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    },
    async stat(target, options) {
      const active = signalOf(options);
      const stats = await fs.stat(await contain(target, active));
      active?.throwIfAborted();
      return { isDirectory: stats.isDirectory(), isFile: stats.isFile() };
    },
    readBoundedText,
  };
}
