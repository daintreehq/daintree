import fs, { type FileHandle } from "fs/promises";
import type { BigIntStats } from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { runExclusive } from "../../utils/keyedMutex.js";
import { readBoundedFromHandle } from "../../utils/boundedRead.js";
import { watchShared } from "../FileObservationService.js";
import { fileTreeService } from "../FileTreeService.js";

import { resolveContainedPath, PluginPathNotAllowedError } from "./pluginFsContainment.js";
import { assertPluginCallerDrives } from "./pluginDriveLease.js";
import { runReadFiles, validateReadFilesCall, type ReadOneOutcome } from "./pluginFsReadFiles.js";
import { MIN_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS } from "./pluginSubscriptionCoalescing.js";
import { fsWriteApprovers } from "./pluginInternalApprovers.js";

import { runWalk, validateWalkCall } from "./pluginFsWalk.js";
import { checkIgnoredPaths, hasTrackedIgnoredPaths } from "../../utils/gitCheckIgnore.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type {
  BuiltInPluginCapability,
  PluginFsApi,
  PluginFsDirEntry,
  PluginFsWriteErrorCode,
  PluginFsStat,
} from "../../../shared/types/plugin.js";
import type { FsRootClass } from "./PluginServiceTypes.js";
import { type PluginHostFactoryDeps, ensureCapabilityConsent } from "./pluginHostDeps.js";

/**
 * Ceiling for a `host.fs.watch` `debounceMs`. Node clamps any timer delay past
 * 2^31-1 ms to 1 ms, so an unbounded value would turn "almost never" into
 * "immediately"; a minute is already far past any useful coalescing window.
 */
const MAX_PLUGIN_FS_WATCH_DEBOUNCE_MS = 60_000;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A `host.fs` target refusal (#12323). The code rides on the error object —
 * in process and, since the worker port carries it, in a plugin worker — and
 * also prefixes the message for the renderer bridge, which keeps only that.
 */
export function fsTargetError(
  code: PluginFsWriteErrorCode,
  message: string
): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * Prove an open descriptor is the entry standing at `resolved` — not a symlink
 * swapped in after containment, and not a different file — and return its
 * stats. See {@link withVerifiedReadHandle} for why the compare is needed on
 * top of O_NOFOLLOW.
 */
async function assertHandleIsLeaf(
  pluginId: string,
  op: string,
  resolved: string,
  handle: FileHandle
): Promise<BigIntStats> {
  const [opened, entry] = await Promise.all([
    handle.stat({ bigint: true }),
    fs.lstat(resolved, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  if (entry?.isSymbolicLink()) {
    throw fsTargetError(
      "TARGET_IS_SYMLINK",
      `Plugin "${pluginId}" fs.${op}: refusing to follow a symlink at the target`
    );
  }
  if (entry === null || entry.dev !== opened.dev || entry.ino !== opened.ino) {
    throw fsTargetError(
      "TARGET_UNAVAILABLE",
      `Plugin "${pluginId}" fs.${op}: the target changed while it was being opened`
    );
  }
  return opened;
}

/**
 * Open a contained leaf for reading and prove, before a byte is read, that the
 * descriptor is the entry standing at the contained path (#12618). O_NOFOLLOW
 * refuses a leaf swapped for a symlink after containment realpathed it, but
 * only on POSIX — Windows has no such flag. So the descriptor is also compared
 * with whatever stands at the path once it is open: a symlink there, or a
 * different file, means the open may have followed something containment
 * never saw. A legitimate replace landing between the open and the compare is
 * refused too; the caller reads again.
 *
 * Ancestor directories stay out of scope, as for every other read here: the
 * open is by pathname, and O_NOFOLLOW and the compare both cover only the leaf.
 */
export async function withVerifiedReadHandle<T>(
  pluginId: string,
  op: string,
  resolved: string,
  extraFlags: number,
  read: (handle: FileHandle, opened: BigIntStats) => Promise<T>
): Promise<T> {
  let handle: FileHandle;
  try {
    handle = await fs.open(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | extraFlags
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw fsTargetError(
        "TARGET_IS_SYMLINK",
        `Plugin "${pluginId}" fs.${op}: refusing to follow a symlink at the target`
      );
    }
    throw error;
  }
  try {
    const opened = await assertHandleIsLeaf(pluginId, op, resolved, handle);
    return await read(handle, opened);
  } finally {
    // A read-only descriptor has nothing to flush, so a failed close must not
    // replace the refusal or the bytes this call is returning.
    await handle.close().catch(() => undefined);
  }
}

/**
 * {@link withVerifiedReadHandle} for a call that reads the whole file (#15584).
 * O_NONBLOCK (undefined on Windows, which has no such FIFOs) stops a FIFO with
 * no writer from holding the open — and a Main threadpool thread with it —
 * and the descriptor is then refused unless it is a regular file, so a FIFO or
 * device is never read until an EOF that may not come. A directory is let
 * through to fail on the read with Node's EISDIR, as it always has.
 */
function withVerifiedWholeFileRead<T>(
  pluginId: string,
  op: string,
  resolved: string,
  read: (handle: FileHandle) => Promise<T>
): Promise<T> {
  return withVerifiedReadHandle(
    pluginId,
    op,
    resolved,
    fs.constants.O_NONBLOCK ?? 0,
    (handle, opened) => {
      if (!opened.isFile() && !opened.isDirectory()) {
        throw fsTargetError(
          "TARGET_UNAVAILABLE",
          `Plugin "${pluginId}" fs.${op}: the target is not a regular file`
        );
      }
      return read(handle);
    }
  );
}

/**
 * Create `resolved` and every missing ancestor, one component at a time,
 * reporting each directory to `onCreated` the moment it exists — so a failure
 * further down the chain never leaves an earlier creation unaudited.
 * Containment has already proven the deepest existing ancestor is a real
 * directory inside scope; walking the missing tail with non-recursive `mkdir`
 * means a component that appears in the meantime is inspected rather than
 * silently followed — only a real directory is accepted, never a symlink to
 * one.
 *
 * The final realpath compare catches an ancestor swapped for a symlink while
 * the chain was being built. It cannot un-create what landed elsewhere, but it
 * refuses to report success for a directory that is not where containment
 * said it would be. The walk is by pathname, so the window is shrunk, not
 * closed — the same limit every host.fs write documents.
 *
 * `assertLive` runs before each directory is made: every step awaits, and a
 * plugin unloaded partway must not go on creating the rest of its chain.
 *
 * `hostOwned` is for the plugin data dir, a path the host chose rather than a
 * contained one: it is not realpathed, so its existing ancestors may be links
 * the user made (a symlinked `~/.daintree`) and there is no realpath to
 * compare against at the end.
 */
async function createDirectoryChain(
  pluginId: string,
  op: string,
  resolved: string,
  onCreated: (dir: string) => void,
  assertLive: () => void,
  hostOwned = false
): Promise<void> {
  const lstatOrNull = (target: string) =>
    (hostOwned ? fs.stat(target) : fs.lstat(target)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const moved = () =>
    fsTargetError(
      "TARGET_UNAVAILABLE",
      `Plugin "${pluginId}" fs.${op}: the target moved while the directory was being created`
    );

  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    const stat = await lstatOrNull(current);
    if (stat !== null) {
      if (stat.isDirectory()) break;
      if (current === resolved) {
        throw fsTargetError(
          "TARGET_EXISTS",
          `Plugin "${pluginId}" fs.${op}: something other than a directory exists at the target`
        );
      }
      throw moved();
    }
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw moved();
    current = parent;
  }
  if (missing.length === 0) return;

  for (const dir of missing.reverse()) {
    assertLive();
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A concurrent creator is fine as long as what it made is a directory.
      const stat = await lstatOrNull(dir);
      if (stat === null || !stat.isDirectory()) throw moved();
      continue;
    }
    onCreated(dir);
  }
  if (!hostOwned && (await fs.realpath(resolved)) !== resolved) throw moved();
}

/**
 * Append `bytes` to the contained leaf through one O_APPEND descriptor,
 * creating the file when absent. O_NOFOLLOW refuses a leaf swapped for a
 * symlink on POSIX, and the descriptor is compared with the entry at the path
 * before anything is written, exactly as reads are.
 *
 * A failure after some bytes landed — including a failed close after all of
 * them were written — carries `bytesWritten` on the error so the caller can
 * audit the partial append rather than report it as nothing.
 */
async function appendToContainedFile(
  pluginId: string,
  resolved: string,
  bytes: Buffer
): Promise<void> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK (undefined on Windows): the caller already refused a
    // non-regular leaf, but a FIFO swapped in afterwards would otherwise hold
    // the open — and this path's write lock — until some reader appeared. On
    // a regular file the flag changes nothing.
    handle = await fs.open(
      resolved,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
      0o666
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw fsTargetError(
        "TARGET_IS_SYMLINK",
        `Plugin "${pluginId}" fs.appendFile: refusing to write through a symlink`
      );
    }
    throw error;
  }
  let written = 0;
  try {
    const opened = await assertHandleIsLeaf(pluginId, "appendFile", resolved, handle);
    if (!opened.isFile()) {
      throw fsTargetError(
        "TARGET_UNAVAILABLE",
        `Plugin "${pluginId}" fs.appendFile: the target is not a regular file`
      );
    }
    // A regular file takes the whole buffer in one write; the loop only
    // matters for a short write, where each O_APPEND write still lands at
    // the end but another appender can interleave between the pieces.
    try {
      while (written < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.byteLength - written);
        written += bytesWritten;
      }
    } catch (error) {
      if (written > 0 && error instanceof Error) {
        Object.assign(error, { bytesWritten: written });
      }
      throw error;
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  // Unlike a read, a failed close after a write can mean the bytes did not
  // land, so it is surfaced — with the count, since they may well have.
  try {
    await handle.close();
  } catch (error) {
    if (written > 0 && error instanceof Error) {
      Object.assign(error, { bytesWritten: written });
    }
    throw error;
  }
}

/**
 * Build the host-mediated `host.fs` surface for one plugin. Every path
 * argument is realpath-contained to the declared `scopes.fs.allowedPaths`
 * (traversal/symlink-escape rejected), and reads/writes are capability-gated
 * (`fs:*-read` / `fs:*-write`). This is the first runtime enforcement of
 * `scopes.fs.allowedPaths` — formerly advisory-only. Writes are audited.
 */
/** How often an `allowMissing` watch checks whether its paths exist. */
const PLUGIN_FS_WATCH_PRESENCE_POLL_MS = 1000;
/**
 * An attached, quiet target is re-checked only every this many ticks. Its own
 * watcher reports a deletion or replacement, which puts it back on the fast
 * cadence (see `PLUGIN_FS_WATCH_PRESENCE_HOT_MS`); this backstop is for the
 * notification a platform drops.
 */
const PLUGIN_FS_WATCH_PRESENCE_BACKSTOP_TICKS = 10;
/** How long after attaching, or after its watcher last fired, a target is re-checked every tick. */
const PLUGIN_FS_WATCH_PRESENCE_HOT_MS = 3000;

export function buildFsApi(deps: PluginHostFactoryDeps, pluginId: string): PluginFsApi {
  const requireLoaded = (op: string): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(`PLUGIN_UNLOADED: plugin "${pluginId}" fs.${op}: plugin is no longer loaded`);
    }
  };
  // Fast-fail before any filesystem work: a plugin with no fs read/write cap
  // of any class can't touch the surface at all.
  const requireAnyReadCap = (op: string): void => {
    const caps = deps.declaredCapabilities(pluginId);
    if (!caps.has("fs:project-read") && !caps.has("fs:user-data-read")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires "fs:project-read" or "fs:user-data-read", which is not declared in manifest.capabilities`
      );
    }
  };
  // Sync capability check; returns the write capability JIT consent gates on.
  // A plugin holding both prompts once on the project-write grant — the path
  // containment already bounds where the write can land, so a single fs-write
  // grant is the meaningful unit. Consent itself fires later (after input
  // validation + containment), so an invalid call never banks a grant.
  const requireWriteCap = (op: string): BuiltInPluginCapability => {
    const caps = deps.declaredCapabilities(pluginId);
    if (!caps.has("fs:project-write") && !caps.has("fs:user-data-write")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires "fs:project-write" or "fs:user-data-write", which is not declared in manifest.capabilities`
      );
    }
    return caps.has("fs:project-write") ? "fs:project-write" : "fs:user-data-write";
  };
  // Precise per-root-class gate, applied AFTER containment resolves which root
  // class the path falls under: project/worktree paths need `fs:project-*`,
  // the data dir / home paths need `fs:user-data-*`. A plugin can't reach a
  // project path with only a user-data cap (or vice versa).
  const requireReadCapForClass = (op: string, rootClass: FsRootClass): void => {
    const needed = rootClass === "project" ? "fs:project-read" : "fs:user-data-read";
    if (!deps.declaredCapabilities(pluginId).has(needed)) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires the "${needed}" capability for ${rootClass} paths, which is not declared in manifest.capabilities`
      );
    }
  };
  const requireWriteCapForClass = (op: string, rootClass: FsRootClass): void => {
    const needed = rootClass === "project" ? "fs:project-write" : "fs:user-data-write";
    if (!deps.declaredCapabilities(pluginId).has(needed)) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" fs.${op} requires the "${needed}" capability for ${rootClass} paths, which is not declared in manifest.capabilities`
      );
    }
  };
  const containWithClass = (targetPath: string) =>
    containToDeclaredRoots(deps, pluginId, targetPath);
  // A write a call makes into a project is held to the lease of the view that
  // made the call; one into no project (the plugin's own data) passes.
  const requireCallerDrives = async (op: string, resolved: string): Promise<void> => {
    await assertPluginCallerDrives(pluginId, `fs.${op}`, { paths: [resolved] });
    requireLoaded(op);
  };
  // Every gate a mutation passes before it may touch the disk: the root-class
  // capability, containment, and JIT consent — taken exactly once, and always
  // before anything is created.
  //
  // Consent normally fires after validation + containment so a call that would
  // fail anyway never banks a grant (#10524). The implicit per-plugin data dir
  // is the exception: resolveContainedPath realpaths every root and skips ones
  // that don't exist, so a first mutation into a not-yet-created data dir must
  // create it before containment can succeed — and nothing may be created
  // before consent. There the lexical match stands in for containment until
  // the dir exists; realpath containment afterwards stays the authority.
  //
  // A data-dir target is identified from the (lexical) request path, not the
  // realpath-resolved one: on macOS the resolved path picks up the /private
  // prefix while `dataDir` does not, so comparing against `resolved` would
  // wrongly miss the match.
  const gateMutation = async (
    op: string,
    targetPath: string,
    writeCap: BuiltInPluginCapability
  ): Promise<{ resolved: string; isDataDirTarget: boolean }> => {
    const dataDir = deps.pluginDataDir(pluginId);
    const isDataDirTarget =
      path.isAbsolute(targetPath) && deps.isPathUnder(dataDir, path.normalize(targetPath));
    if (isDataDirTarget) {
      requireWriteCapForClass(op, "user-data");
      await ensureCapabilityConsent(deps, pluginId, writeCap);
      requireLoaded(op);
      // A data dir is normally in no project, but nothing stops one sitting
      // inside a registered folder: judge it before anything is created there.
      await requireCallerDrives(op, dataDir);
      await createDirectoryChain(
        pluginId,
        op,
        dataDir,
        (dir) => auditMutation("mkdir", dir),
        () => requireLoaded(op),
        true
      );
    }
    const { resolved, rootClass } = await containWithClass(targetPath);
    requireLoaded(op);
    requireWriteCapForClass(op, rootClass);
    // Before consent, so a write the lease refuses never banks a grant; the
    // resolved target, since a link inside the data dir can lead into a project.
    await requireCallerDrives(op, resolved);
    if (!isDataDirTarget) {
      await ensureCapabilityConsent(deps, pluginId, writeCap);
      requireLoaded(op);
    }
    return { resolved, isDataDirTarget };
  };
  // A nested target inside the data dir grows its parents implicitly, so a
  // plugin can lay out its own subtree; everywhere else the parent must exist.
  const createDataDirParents = async (op: string, resolved: string): Promise<void> => {
    await createDirectoryChain(
      pluginId,
      op,
      path.dirname(resolved),
      (dir) => auditMutation("mkdir", dir),
      () => requireLoaded(op)
    );
  };
  // Containment resolved before the consent prompt and the per-path queue
  // wait; both can take long enough for the path to change underneath, so a
  // mutation proves it again inside its critical section. A target that has
  // since left scope moved while waiting, the same as one that moved within it.
  const recheckContained = async (op: string, targetPath: string, resolved: string) => {
    const recheck = await containWithClass(targetPath).catch((error: unknown) => {
      if (error instanceof PluginPathNotAllowedError) {
        throw fsTargetError(
          "TARGET_UNAVAILABLE",
          `Plugin "${pluginId}" fs.${op}: the target moved while the write was waiting`
        );
      }
      throw error;
    });
    if (recheck.resolved !== resolved) {
      throw fsTargetError(
        "TARGET_UNAVAILABLE",
        `Plugin "${pluginId}" fs.${op}: the target moved while the write was waiting`
      );
    }
  };
  // A symlink leaf is refused: containment realpaths the leaf, so `resolved`
  // is already the link's destination and a bare lstat there sees a regular
  // file. Inspect the requested leaf itself. Every ancestor was validated by
  // containment; only the leaf can be a link the caller did not ask to write
  // through. Resolves the leaf's stats, or null when nothing stands there.
  const refuseSymlinkLeaf = async (op: string, targetPath: string) => {
    const leafStat = await fs
      .lstat(path.resolve(targetPath))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (leafStat?.isSymbolicLink()) {
      throw fsTargetError(
        "TARGET_IS_SYMLINK",
        `Plugin "${pluginId}" fs.${op}: refusing to write through a symlink`
      );
    }
    return leafStat;
  };
  const auditMutation = (op: string, resolved: string, bytes?: number): void => {
    deps.safeAppendAudit({
      pluginId,
      actionId: `fs.${op}:${resolved}`,
      recordType: "ipc-invoke",
      channel: "plugin:fs-write",
      result: "success",
      errorMessage: "",
      argsHash: deps.safeArgsHash([
        bytes === undefined ? { path: resolved } : { path: resolved, bytes },
      ]),
      durationMs: 0,
    });
  };

  // Approves a file another host component writes (a database backup)
  // through the same gate as writeFile. Kept off the object plugins receive.
  const prepareWrite = async (op: string, targetPath: string): Promise<string> => {
    requireLoaded(op);
    const writeCap = requireWriteCap(op);
    if (typeof targetPath !== "string" || targetPath.length === 0) {
      throw new Error(`Plugin "${pluginId}" ${op}: a destination path is required`);
    }
    const { resolved, isDataDirTarget } = await gateMutation(op, targetPath, writeCap);
    if (isDataDirTarget) await createDataDirParents(op, resolved);
    // The approval is the last this host sees of the write: judge it after the consent wait.
    await requireCallerDrives(op, resolved);
    await refuseSymlinkLeaf(op, targetPath);
    // Recorded when approved: the write itself happens in the plugin's own
    // process, which the audit trail cannot see.
    auditMutation(`${op}:approved`, resolved);
    return resolved;
  };

  const api: PluginFsApi = {
    readFile: async (filePath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readFile");
      requireAnyReadCap("readFile");
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("readFile");
      requireReadCapForClass("readFile", rootClass);
      // The open cannot be cancelled, so an abort during containment is
      // honoured here, before any filesystem work starts.
      options?.signal?.throwIfAborted();
      // Deliberately no 500KB / binary cap — this is a sanctioned plugin API,
      // not the size-limited files.read preview path. The signal cancels the
      // read itself (Node honors it) as well as the boundary checks above.
      return withVerifiedWholeFileRead(pluginId, "readFile", resolved, (handle) =>
        handle.readFile({ encoding: "utf-8", signal: options?.signal })
      );
    },
    readFileBytes: async (filePath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readFileBytes");
      requireAnyReadCap("readFileBytes");
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("readFileBytes");
      requireReadCapForClass("readFileBytes", rootClass);
      // Same as `readFile`: the open itself cannot be cancelled.
      options?.signal?.throwIfAborted();
      const buffer = await withVerifiedWholeFileRead(
        pluginId,
        "readFileBytes",
        resolved,
        (handle) => handle.readFile({ signal: options?.signal })
      );
      // Copy out of Node's pooled Buffer allocator: a small read shares its
      // backing ArrayBuffer with unrelated reads, so handing the view straight
      // to a plugin would expose whatever else the pool holds.
      return new Uint8Array(buffer);
    },
    readFileWithRevision: async (filePath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readFileWithRevision");
      requireAnyReadCap("readFileWithRevision");
      const { resolved, rootClass } = await containWithClass(filePath);
      requireLoaded("readFileWithRevision");
      requireReadCapForClass("readFileWithRevision", rootClass);
      options?.signal?.throwIfAborted();
      // Decoded and hashed from one buffer, so the revision always describes
      // the text returned — two reads could straddle a write.
      const buffer = await withVerifiedWholeFileRead(
        pluginId,
        "readFileWithRevision",
        resolved,
        (handle) => handle.readFile({ signal: options?.signal })
      );
      return { contents: buffer.toString("utf-8"), revision: sha256Hex(buffer) };
    },
    readFiles: (async (paths: readonly string[], options?: unknown) => {
      requireLoaded("readFiles");
      requireAnyReadCap("readFiles");
      const call = validateReadFilesCall(pluginId, paths, options);
      return runReadFiles(call, async (filePath, limit) => {
        // The same gates readFile applies, per path; a refusal becomes that
        // entry's error rather than failing the batch.
        const { resolved, rootClass } = await containWithClass(filePath);
        requireLoaded("readFiles");
        requireReadCapForClass("readFiles", rootClass);
        call.signal?.throwIfAborted();
        // O_NONBLOCK (undefined on Windows): a FIFO standing at the path must
        // not leave the open pending with the rest of the batch behind it. The
        // regular-file check is on the opened descriptor, not on a path that
        // could since have become something else.
        return withVerifiedReadHandle(
          pluginId,
          "readFiles",
          resolved,
          fs.constants.O_NONBLOCK ?? 0,
          async (handle, opened): Promise<ReadOneOutcome> => {
            if (!opened.isFile()) return { status: "not-a-file" };
            const bytes = await readBoundedFromHandle(
              handle,
              Number(opened.size),
              limit,
              call.signal
            );
            return bytes === null ? { status: "too-large" } : { status: "ok", bytes };
          }
        );
      });
    }) as NonNullable<PluginFsApi["readFiles"]>,
    writeFile: async (filePath, contents, options) => {
      requireLoaded("writeFile");
      const writeCap = requireWriteCap("writeFile");
      if (typeof contents !== "string") {
        throw new Error(`Plugin "${pluginId}" fs.writeFile: contents must be a string`);
      }
      // Omitted options is the same write as `{}` (#12618): every call shape
      // gets the recheck, the symlink refusal and the atomic replace. A
      // malformed options value is an authoring error, never read as absent.
      if (options !== undefined && (options === null || typeof options !== "object")) {
        throw new Error(`Plugin "${pluginId}" fs.writeFile: options must be an object`);
      }
      const expected = options?.expectedRevision;
      if (expected !== undefined && expected !== null && !/^[0-9a-f]{64}$/.test(expected)) {
        throw new Error(
          `Plugin "${pluginId}" fs.writeFile: expectedRevision must be a sha256 hex string or null`
        );
      }
      const { resolved, isDataDirTarget } = await gateMutation("writeFile", filePath, writeCap);
      if (isDataDirTarget) await createDataDirParents("writeFile", resolved);
      // One writer per resolved path at a time, so a hash-compare-and-replace
      // cannot interleave with any other host-mediated writer to the same
      // file. Distinct paths never wait on each other.
      const revision = await runExclusive(resolved, async () => {
        // A write queued behind another can outlive its plugin; say so before
        // the recheck below misreports an unloaded plugin's roots as scope.
        requireLoaded("writeFile");
        await recheckContained("writeFile", filePath, resolved);
        // The queue wait can outlast a takeover, too.
        await requireCallerDrives("writeFile", resolved);
        const leafStat = await refuseSymlinkLeaf("writeFile", filePath);
        const bytes = Buffer.from(contents, "utf-8");
        if (expected === null) {
          // Create-new is an exclusive create at the filesystem, not a check
          // followed by a replace: two writers racing on names that only
          // differ in case would otherwise both see "absent" and both win on
          // a case-insensitive volume. A directory or any other entry at the
          // leaf reads as "exists" without being opened.
          if (leafStat !== null) {
            throw fsTargetError(
              "TARGET_EXISTS",
              `Plugin "${pluginId}" fs.writeFile: the target already exists`
            );
          }
          requireLoaded("writeFile");
          try {
            await fs.writeFile(resolved, bytes, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw fsTargetError(
                "TARGET_EXISTS",
                `Plugin "${pluginId}" fs.writeFile: the target already exists`
              );
            }
            throw error;
          }
          return sha256Hex(bytes);
        }
        if (expected !== undefined) {
          // Only a revision compare needs the current bytes; a write without
          // one never reads the target, so an unreadable or oversized file
          // still gets its atomic replace. The read is verified like any
          // other, so the hash a mismatch hands back is never the hash of a
          // file a swapped-in symlink pointed at, and a FIFO there is refused
          // rather than left holding this path's write lock.
          const current = await withVerifiedWholeFileRead(
            pluginId,
            "writeFile",
            resolved,
            (handle) => handle.readFile()
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (current === null) {
            throw fsTargetError(
              "TARGET_UNAVAILABLE",
              `Plugin "${pluginId}" fs.writeFile: the target no longer exists`
            );
          }
          const currentRevision = sha256Hex(current);
          if (currentRevision !== expected) {
            throw Object.assign(
              fsTargetError(
                "REVISION_MISMATCH",
                `Plugin "${pluginId}" fs.writeFile: the file changed since it was read`
              ),
              { currentRevision }
            );
          }
        }
        // Preserve the file's mode across the replace so an executable script
        // or a read-only note keeps its bits; a new file takes the umask.
        const mode = leafStat && !leafStat.isSymbolicLink() ? leafStat.mode & 0o777 : undefined;
        // Last liveness check before the bytes land: the consent prompt and the
        // queue wait above can outlive the plugin.
        requireLoaded("writeFile");
        await resilientAtomicWriteFile(
          resolved,
          bytes,
          "utf-8",
          mode === undefined ? undefined : { mode }
        );
        return sha256Hex(bytes);
      });
      // Audit every write so host-mediated filesystem mutation is observable.
      auditMutation("writeFile", resolved, Buffer.byteLength(contents));
      return { revision };
    },
    mkdir: async (dirPath) => {
      requireLoaded("mkdir");
      const writeCap = requireWriteCap("mkdir");
      // Containment realpaths the deepest existing ancestor and re-appends the
      // missing tail, so an existing ancestor that is a symlink out of every
      // root is refused here, before anything is created.
      const { resolved } = await gateMutation("mkdir", dirPath, writeCap);
      // Only what this call made is audited; an existing directory changed
      // nothing.
      await runExclusive(resolved, async () => {
        requireLoaded("mkdir");
        await recheckContained("mkdir", dirPath, resolved);
        await requireCallerDrives("mkdir", resolved);
        await createDirectoryChain(
          pluginId,
          "mkdir",
          resolved,
          (dir) => auditMutation("mkdir", dir),
          () => requireLoaded("mkdir")
        );
      });
    },
    appendFile: async (filePath, contents) => {
      requireLoaded("appendFile");
      const writeCap = requireWriteCap("appendFile");
      if (typeof contents !== "string") {
        throw new Error(`Plugin "${pluginId}" fs.appendFile: contents must be a string`);
      }
      const { resolved, isDataDirTarget } = await gateMutation("appendFile", filePath, writeCap);
      if (isDataDirTarget) await createDataDirParents("appendFile", resolved);
      const bytes = Buffer.from(contents, "utf-8");
      // Serialised with writeFile on the same path, so an append can never
      // land between a checked write's hash compare and its rename.
      await runExclusive(resolved, async () => {
        requireLoaded("appendFile");
        await recheckContained("appendFile", filePath, resolved);
        await requireCallerDrives("appendFile", resolved);
        const leafStat = await refuseSymlinkLeaf("appendFile", filePath);
        // A FIFO or device is refused before the open, which on a FIFO with
        // no reader would otherwise block.
        if (leafStat !== null && !leafStat.isFile()) {
          throw fsTargetError(
            "TARGET_UNAVAILABLE",
            `Plugin "${pluginId}" fs.appendFile: the target is not a regular file`
          );
        }
        requireLoaded("appendFile");
        try {
          await appendToContainedFile(pluginId, resolved, bytes);
        } catch (error) {
          const partial = (error as { bytesWritten?: unknown }).bytesWritten;
          if (typeof partial === "number" && partial > 0) {
            deps.safeAppendAudit({
              pluginId,
              actionId: `fs.appendFile:${resolved}`,
              recordType: "ipc-invoke",
              channel: "plugin:fs-write",
              result: "error",
              errorMessage: formatErrorMessage(error, "append failed"),
              argsHash: deps.safeArgsHash([{ path: resolved, bytes: partial }]),
              durationMs: 0,
            });
          }
          throw error;
        }
      });
      auditMutation("appendFile", resolved, bytes.byteLength);
    },
    readdir: async (dirPath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("readdir");
      requireAnyReadCap("readdir");
      const { resolved, rootClass, root } = await containWithClass(dirPath);
      options?.signal?.throwIfAborted();
      requireLoaded("readdir");
      requireReadCapForClass("readdir", rootClass);

      if (options?.detail === true) {
        // The same listing the built-in file browser renders, rather than a
        // second implementation of ordering and symlink classification that
        // would drift from it. Scoped to the allowed root that admitted this
        // path, so `targetKind: "external"` means "outside what this plugin may
        // read" — the classification a plugin actually needs.
        // The DECLARED root is the base, not its realpath: `getFileTree`
        // resolves the real one itself and uses both, and its symlink
        // classification gates the raw link target lexically against the
        // declared prefix first. Handing it an already-realpathed base makes
        // every link written with the declared prefix (`/var/...` where the real
        // path is `/private/var/...`) read as "external". The relative dir is
        // still measured from the real root, because `resolved` is realpathed.
        //
        // This does mean the declared root is traversed a second time, after
        // authorization — so a declared root that is itself a symlink, swapped
        // between the two, would list the new target. That window grants a
        // plugin nothing: its `main` runs un-sandboxed and can read either
        // directory through raw `node:fs` regardless (see the honest-scope note
        // in docs/plugins/host-api.md). Closing it properly needs `getFileTree`
        // to take the traversal base and the classification spelling
        // separately, which is a change to a surface the file browser shares.
        const realRoot = await fs.realpath(root);
        options?.signal?.throwIfAborted();
        const nodes = await fileTreeService.getFileTree(root, path.relative(realRoot, resolved));
        options?.signal?.throwIfAborted();
        return nodes.map((node): PluginFsDirEntry => {
          const symlink = node.symlink;
          return {
            name: node.name,
            isDirectory: node.isDirectory,
            // A link is described by what it resolves to, exactly as
            // `isDirectory` already is — so a link that resolves to nothing
            // readable (broken, out of scope, unclassifiable) is neither a file
            // nor a directory. Reporting `!isDirectory` here would have called
            // every dangling link a regular file and invited a plugin to read
            // it.
            isFile: symlink ? symlink.targetKind === "file" : !node.isDirectory,
            isSymbolicLink: symlink !== undefined,
            ...(node.size !== undefined && { size: node.size }),
            ...(node.mtimeMs !== undefined && { mtimeMs: node.mtimeMs }),
            ...(symlink && {
              symlink: { target: symlink.target, targetKind: symlink.targetKind },
            }),
          };
        });
      }

      const entries = await fs.readdir(resolved, { withFileTypes: true });
      return entries.map((e): PluginFsDirEntry => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    },
    walk: async (root, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("walk");
      requireAnyReadCap("walk");
      const call = validateWalkCall(pluginId, root, options);
      // The same gate readdir applies, once, on the root: every path the walk
      // then reads is beneath the realpath containment resolved, reached
      // without following a link (see runWalk).
      const { resolved, rootClass } = await containWithClass(root);
      call.signal?.throwIfAborted();
      requireLoaded("walk");
      requireReadCapForClass("walk", rootClass);
      return runWalk(
        resolved,
        call,
        {
          opendir: (dir) => fs.opendir(dir, { bufferSize: 128 }),
          realpath: (dir) => fs.realpath(dir),
          fileSize: (file) =>
            fs.lstat(file).then(
              (stats) => (stats.isFile() ? stats.size : undefined),
              () => undefined
            ),
          checkIgnored: (cwd, paths, signal) =>
            checkIgnoredPaths(cwd, paths, { signal, timeoutMs: 10_000 }),
          // Only where git's case-sensitive index lookup can disagree with the
          // filesystem about a tracked file's spelling (see gitCheckIgnore).
          ...((process.platform === "darwin" || process.platform === "win32") && {
            hasTrackedIgnored: (cwd: string, signal: AbortSignal | undefined) =>
              hasTrackedIgnoredPaths(cwd, { signal, timeoutMs: 10_000 }),
          }),
        },
        () => requireLoaded("walk")
      );
    },
    stat: async (targetPath, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("stat");
      requireAnyReadCap("stat");
      const { resolved, rootClass } = await containWithClass(targetPath);
      options?.signal?.throwIfAborted();
      requireLoaded("stat");
      requireReadCapForClass("stat", rootClass);
      const s = await fs.stat(resolved);
      return {
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      } satisfies PluginFsStat;
    },
    watch: async (paths, callback, options) => {
      options?.signal?.throwIfAborted();
      requireLoaded("watch");
      requireAnyReadCap("watch");
      if (typeof callback !== "function") {
        throw new Error(`Plugin "${pluginId}" fs.watch: callback must be a function`);
      }
      // Validated here, not trusted from the worker port: a malformed option
      // is an authoring error, never read as "off".
      const rawRecursive = options?.recursive;
      if (rawRecursive !== undefined && typeof rawRecursive !== "boolean") {
        throw new Error(`Plugin "${pluginId}" fs.watch: recursive must be a boolean`);
      }
      const recursive = rawRecursive === true;
      const rawDebounce = options?.debounceMs;
      if (
        rawDebounce !== undefined &&
        (typeof rawDebounce !== "number" || !Number.isFinite(rawDebounce) || rawDebounce < 0)
      ) {
        throw new Error(
          `Plugin "${pluginId}" fs.watch: debounceMs must be a finite, non-negative number`
        );
      }
      // Same floor and off-switch as onDidChangeWorktrees' debounce, plus a
      // ceiling so a huge value cannot wrap to Node's 1 ms overflow delay.
      const debounceMs =
        rawDebounce === undefined || rawDebounce === 0
          ? 0
          : Math.min(
              Math.max(rawDebounce, MIN_PLUGIN_SUBSCRIPTION_DEBOUNCE_MS),
              MAX_PLUGIN_FS_WATCH_DEBOUNCE_MS
            );
      const rawAllowMissing = options?.allowMissing;
      if (rawAllowMissing !== undefined && typeof rawAllowMissing !== "boolean") {
        throw new Error(`Plugin "${pluginId}" fs.watch: allowMissing must be a boolean`);
      }
      const allowMissing = rawAllowMissing === true;
      const targets = Array.isArray(paths) ? paths : [];
      if (targets.length === 0) {
        throw new Error(`Plugin "${pluginId}" fs.watch: paths must be a non-empty array`);
      }
      // Contain every path up front so an out-of-scope watch target rejects
      // before any watcher is created; gate each on its own root class.
      const contained = await Promise.all(targets.map((p) => containWithClass(p)));
      options?.signal?.throwIfAborted();
      requireLoaded("watch");
      for (const c of contained) requireReadCapForClass("watch", c.rootClass);
      const resolvedTargets = contained.map((c) => c.resolved);

      // One native watcher per resolved path, shared across every plugin (and
      // every other subscriber) that wants it — five plugins watching one
      // worktree previously meant five `fs.watch` handles for identical events.
      // Containment and capability checks above still run per plugin; only the
      // watcher underneath is shared.
      const releases: Array<() => void> = [];
      let disposed = false;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingPath: string | null = null;
      const deliver = (changed: string): void => {
        if (disposed || !deps.plugins.has(pluginId)) return;
        try {
          callback(changed);
        } catch (err) {
          console.error(`[PluginService] plugin "${pluginId}" fs.watch callback threw:`, err);
        }
      };
      // One timer per subscription, shared across every path it watches, so a
      // burst touching several watched directories still yields one callback.
      const onChange =
        debounceMs > 0
          ? (changed: string): void => {
              if (disposed) return;
              pendingPath = changed;
              if (debounceTimer) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => {
                debounceTimer = null;
                const latest = pendingPath;
                pendingPath = null;
                if (latest !== null) deliver(latest);
              }, debounceMs);
            }
          : deliver;
      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        for (const release of releases) {
          try {
            release();
          } catch {
            // best-effort
          }
        }
        deps.pluginFsWatchers.get(pluginId)?.delete(dispose);
      };

      // Node's Linux recursive watcher follows static symlink targets, so its
      // reports are not proof of containment. The path it reports is always
      // joined onto the watched root; anything that does not stay lexically
      // inside that root is dropped rather than handed on.
      const withinRootOf =
        (resolved: string) =>
        (changed: string): void => {
          const rel = path.relative(resolved, changed);
          if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
          onChange(changed);
        };

      // `allowMissing`: each target is attached while it exists, and a timer
      // notices it appearing, disappearing or being replaced. Containment is
      // proved again at each attach — the path did not exist when it was first
      // checked, so whatever was created there could be a link leading out.
      let presenceTimer: ReturnType<typeof setInterval> | null = null;
      const presence = allowMissing
        ? targets.map((requested, index) => ({
            requested,
            resolved: resolvedTargets[index]!,
            release: null as (() => void) | null,
            identity: null as string | null,
            hotUntil: 0,
          }))
        : [];
      let presenceTick = 0;
      const refreshPresence = async (announce: boolean): Promise<void> => {
        const backstop = presenceTick++ % PLUGIN_FS_WATCH_PRESENCE_BACKSTOP_TICKS === 0;
        const now = Date.now();
        for (const target of presence) {
          if (disposed || !deps.plugins.has(pluginId)) return;
          // Only a missing target, or one whose watcher just fired, needs a stat
          // every tick: an attached directory that goes quiet was not replaced.
          if (target.identity !== null && !backstop && now >= target.hotUntil) continue;
          const stat = await fs.stat(target.resolved).catch(() => null);
          const identity = stat ? `${stat.dev}:${stat.ino}` : null;
          if (identity === target.identity) continue;
          if (target.release) {
            target.release();
            target.release = null;
          }
          target.identity = null;
          if (identity !== null) {
            const recheck = await containWithClass(target.requested).catch(() => null);
            if (disposed || !deps.plugins.has(pluginId)) return;
            if (!recheck || recheck.resolved !== target.resolved) continue;
            // The root that admits the path can differ once it exists (a data
            // dir created inside a project root), so its class is gated again.
            try {
              requireReadCapForClass("watch", recheck.rootClass);
            } catch {
              continue;
            }
            try {
              // The identity makes a replaced directory get its own watcher: a
              // shared one kept alive by another subscriber is still bound to
              // the old inode, and rejoining it would silently watch nothing.
              const forward = withinRootOf(target.resolved);
              target.release = watchShared(
                target.resolved,
                (changed) => {
                  target.hotUntil = Date.now() + PLUGIN_FS_WATCH_PRESENCE_HOT_MS;
                  forward(changed);
                },
                { recursive, identity }
              );
              target.identity = identity;
              // A native watch can miss events for a moment after it opens
              // (macOS FSEvents stream start), so a fresh attach stays hot.
              target.hotUntil = Date.now() + PLUGIN_FS_WATCH_PRESENCE_HOT_MS;
            } catch {
              // Gone again between the stat and the watch; the next tick retries.
              continue;
            }
          }
          if (announce) onChange(target.resolved);
        }
      };
      if (allowMissing) {
        releases.push(() => {
          if (presenceTimer) clearInterval(presenceTimer);
          presenceTimer = null;
          for (const target of presence) target.release?.();
        });
      }

      try {
        if (allowMissing) {
          await refreshPresence(false);
          // An unload or a cancel during that first check found no disposer to
          // call — the caller has already given up on the result.
          options?.signal?.throwIfAborted();
          requireLoaded("watch");
          // One check at a time: two overlapping checks could both attach and
          // leave the first shared watcher unreleased.
          let refreshing = false;
          presenceTimer = setInterval(() => {
            if (refreshing) return;
            refreshing = true;
            void refreshPresence(true)
              .catch(() => undefined)
              .finally(() => {
                refreshing = false;
              });
          }, PLUGIN_FS_WATCH_PRESENCE_POLL_MS);
          presenceTimer.unref?.();
        } else {
          for (const resolved of resolvedTargets) {
            releases.push(watchShared(resolved, withinRootOf(resolved), { recursive }));
          }
        }
      } catch (err) {
        // A later path's watch threw (e.g. ENOENT) after earlier subscriptions
        // were taken — release them so a partial failure doesn't leak a
        // reference and pin a shared watcher open (dispose isn't registered in
        // pluginFsWatchers yet, so teardown wouldn't catch them).
        for (const release of releases) {
          try {
            release();
          } catch {
            // best-effort
          }
        }
        throw err;
      }

      let set = deps.pluginFsWatchers.get(pluginId);
      if (!set) {
        set = new Set();
        deps.pluginFsWatchers.set(pluginId, set);
      }
      set.add(dispose);
      return dispose;
    },
  };
  fsWriteApprovers.set(api, prepareWrite);
  return api;
}

/**
 * Contain a plugin-supplied path against the plugin's call-time-expanded
 * allowed roots and report which root class matched.
 *
 * Containment runs per entry rather than against the union so the matched
 * entry's class is exact — the union would only tell us "some root", and the
 * capability gate needs to know *which*. The first containing root wins; when
 * a path sits inside two roots of different classes the earlier declaration
 * decides, which is the same "any allowed root" semantics the fs API has
 * always had.
 *
 * Shared by `host.fs` and `host.system` so the two can never drift into
 * disagreeing about what a plugin may reach or which capability guards it.
 */
export async function containToDeclaredRoots(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  targetPath: string
): Promise<{ resolved: string; rootClass: FsRootClass; root: string }> {
  const entries = await deps.expandAllowedPathEntries(pluginId, { includeDataDir: true });
  let lastErr: unknown;
  for (const entry of entries) {
    try {
      const resolved = await resolveContainedPath(pluginId, targetPath, [entry.path]);
      // The matching root travels with the result so a caller that needs to
      // reason about scope — a detailed listing classifying whether a symlink
      // leaves it — does not have to rediscover which root allowed the path.
      return { resolved, rootClass: entry.rootClass, root: entry.path };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new PluginPathNotAllowedError(pluginId, targetPath);
}
