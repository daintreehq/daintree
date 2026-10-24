/**
 * The in-memory filesystem, processes, git, clipboard, system, documents and
 * artifacts for `createMockHost`: what a plugin writes lands here, and what it
 * reads back, renders or imports comes from the same store.
 */

import { createHash } from "node:crypto";
import { validateRenderPdfOptions } from "../../utils/pluginPdfOptions.js";
import { parsePluginExternalUrl } from "../../utils/pluginExternalUrl.js";
import { homedir } from "node:os";
import path from "node:path";
import { join as joinPath } from "node:path";
import { PLUGIN_INVOKE_MAX_RESULT_BYTES } from "../../config/pluginBudgets.js";
import type {
  PluginRenderPdfOptions,
  PluginArtifact,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessApi,
  PluginDuplexProcessHandle,
  PluginDuplexProcessSpawnOptions,
  PluginPtyProcessHandle,
  PluginPtyProcessSpawnOptions,
  PluginFsApi,
  PluginFsReadFilesEntry,
  PluginFsReadFilesOptions,
  PluginFsWalkEntry,
  PluginFsWalkOptions,
  PluginFsWalkResult,
  PluginGitCommitResult,
} from "../../types/plugin.js";
import type { MockHostIdentity } from "./identity.js";
import type {
  SpawnRecord,
  FsWriteRecord,
  GitCommitRecord,
  CreateMockHostOptions,
  MockHost,
} from "./types.js";

export type FilesMembers = Pick<
  MockHost,
  | "process"
  | "fs"
  | "git"
  | "clipboard"
  | "system"
  | "documents"
  | "artifacts"
  | "spawnCalls"
  | "fsWriteCalls"
  | "fsAppendCalls"
  | "fsMkdirCalls"
  | "gitCommitCalls"
  | "clipboardWriteCalls"
  | "clipboardWriteImageCalls"
  | "systemOpenPathCalls"
  | "systemShowItemCalls"
  | "systemOpenExternalCalls"
  | "documentsRenderPdfCalls"
  | "artifactRecords"
  | "artifactUploadCalls"
  | "simulateArtifactExpiry"
  | "simulateFsWatch"
>;

/** One `host.fs.watch` registration in the mock. */
interface MockFsWatcher {
  readonly paths: string[];
  readonly callback: (changedPath: string) => void;
  readonly recursive: boolean;
  readonly debounceMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending: string | null;
}
/**
 * The revision the mock reports for a text: sha256 hex of its UTF-8 bytes,
 * the same shape the real host returns, so a plugin can hand it straight back
 * as `expectedRevision`.
 */
/** The host's `fs.walk` bounds (electron/services/plugin/pluginFsWalk.ts). */
const MOCK_WALK_DEFAULT_LIMIT = 10_000;
const MOCK_WALK_MAX_LIMIT = 50_000;
const MOCK_WALK_MAX_DEPTH = 64;
const MOCK_WALK_MAX_PATTERNS = 64;

/** The host's walk ordering: by path, with `/` before every other character. */
function compareWalkPaths(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (ca === 47) return -1;
    if (cb === 47) return 1;
    return ca - cb;
  }
  return a.length - b.length;
}

/** The host's `fs.readFiles` bounds (electron/services/plugin/pluginFsReadFiles.ts). */
const MOCK_READ_FILES_MAX_PATHS = 1024;
const MOCK_READ_FILES_MAX_TOTAL_BYTES = PLUGIN_INVOKE_MAX_RESULT_BYTES / 2;

function mockRevision(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fsWriteError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

const MOCK_ARTIFACT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export interface FilesFacet {
  members: FilesMembers;
}

export function createFilesFacet(
  identity: MockHostIdentity,
  options: CreateMockHostOptions,
  collaborators: {
    worktreeRoots(): string[];
  }
): FilesFacet {
  const { pluginId, projectId: mockProjectId } = identity;
  const spawnCalls: SpawnRecord[] = [];
  const fsFiles = new Map<string, string>();
  const fsWriteCalls: FsWriteRecord[] = [];
  const fsAppendCalls: FsWriteRecord[] = [];
  const fsMkdirCalls: string[] = [];
  // Directories made through `mkdir`; directories implied by a written file's
  // path are derived from `fsFiles` instead, as before.
  const fsDirs = new Set<string>();
  const gitCommitCalls: GitCommitRecord[] = [];
  const clipboardWriteCalls: string[] = [];
  const clipboardWriteImageCalls: number[] = [];
  const systemOpenPathCalls: string[] = [];
  const systemShowItemCalls: string[] = [];
  const systemOpenExternalCalls: string[] = [];
  const documentsRenderPdfCalls: PluginRenderPdfOptions[] = [];
  const artifacts = new Map<string, PluginArtifact>();
  const artifactUploadCalls: { artifactId: string; url: string; method: "PUT" | "POST" }[] = [];
  let artifactSeq = 0;
  const mockArtifact = (
    origin: PluginArtifact["origin"],
    rawName: string,
    size: number,
    artifactOptions?: { projectId?: string; mimeType?: string; ttlMs?: number }
  ): PluginArtifact => {
    // As the real host does: a project plugin's artifacts are its project's,
    // and it can't name another.
    if (
      mockProjectId !== null &&
      artifactOptions?.projectId !== undefined &&
      artifactOptions.projectId !== mockProjectId
    ) {
      throw new Error(
        "VALIDATION: mock artifacts: a project plugin's artifacts belong to its own project"
      );
    }
    const name = rawName.split(/[\\/]/).pop() || "artifact";
    const ext = name.toLowerCase().split(".").pop() ?? "";
    const createdAt = Date.now();
    const artifact: PluginArtifact = {
      id: (++artifactSeq).toString(16).padStart(32, "0"),
      projectId: artifactOptions?.projectId ?? mockProjectId,
      name,
      mimeType: artifactOptions?.mimeType ?? MOCK_ARTIFACT_TYPES[ext] ?? "application/octet-stream",
      size,
      createdAt,
      expiresAt: createdAt + (artifactOptions?.ttlMs ?? 24 * 60 * 60 * 1000),
      origin,
    };
    artifacts.set(artifact.id, artifact);
    return artifact;
  };
  let clipboardText = "";
  // Active `host.fs.watch` registrations; a watcher's disposer removes its
  // record, and `simulateFsWatch` fires each one's callback.
  const fsWatchers = new Set<MockFsWatcher>();

  const parentOf = (target: string): string => {
    const slash = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
    return slash <= 0 ? "/" : target.slice(0, slash);
  };
  const trimDir = (dir: string): string =>
    dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
  // A directory exists when `mkdir` made it, when a stored file or directory
  // sits beneath it, or when it is (or contains) a worktree the mock was given.
  // A path holding a file is never a directory.
  const mockDirExists = (dir: string): boolean => {
    if (dir === "/") return true;
    if (fsFiles.has(dir)) return false;
    if (fsDirs.has(dir)) return true;
    const prefix = `${dir}/`;
    for (const key of fsFiles.keys()) if (key.startsWith(prefix)) return true;
    for (const made of fsDirs) if (made.startsWith(prefix)) return true;
    const roots = collaborators.worktreeRoots();
    return roots.some((root) => root !== undefined && (root === dir || root.startsWith(prefix)));
  };
  // Every ancestor of `dir`, outermost first, then `dir` itself; "/" excluded.
  const dirChain = (dir: string): string[] => {
    const chain: string[] = [];
    for (let current = trimDir(dir); current !== "/"; current = parentOf(current)) {
      chain.unshift(current);
    }
    return chain;
  };
  // The host's implicit per-plugin data dir grows missing parents for a write
  // inside it — and only inside it, so the match is anchored at the root, not
  // found anywhere in the path. Separators are compared as "/" so a Windows
  // root matches either spelling.
  const toSlashes = (target: string): string => target.replace(/\\/g, "/");
  const mockDataDir = trimDir(
    toSlashes(options.pluginDataDir ?? joinPath(homedir(), ".daintree", "plugin-data", pluginId))
  );
  const isMockDataDirPath = (target: string): boolean =>
    toSlashes(target).startsWith(`${mockDataDir}/`);
  // A path is a file or a directory, never both. The host refuses a regular
  // file standing where a directory chain it grows must go: TARGET_EXISTS at
  // the directory it was asked for (or the data dir it bootstraps), and the
  // lookup's own ENOTDIR for anything beneath a file.
  const refuseFileInChain = (dir: string): void => {
    const blocked = dirChain(dir).find((candidate) => fsFiles.has(candidate));
    if (blocked === undefined) return;
    const atTarget = blocked === trimDir(dir) || toSlashes(blocked) === mockDataDir;
    throw fsWriteError(
      atTarget ? "TARGET_EXISTS" : "ENOTDIR",
      `mock fs: "${blocked}" is a file, not a directory`
    );
  };
  // Outside the data dir nothing is grown, and a file among the ancestors
  // fails the host's own lookup of the leaf.
  const refuseFileAncestor = (target: string): void => {
    const blocked = dirChain(parentOf(target)).find((candidate) => fsFiles.has(candidate));
    if (blocked !== undefined) {
      throw fsWriteError("ENOTDIR", `mock fs: "${blocked}" is a file, not a directory`);
    }
  };

  const members: FilesMembers = {
    process: {
      async spawn(
        command: string,
        options?:
          PluginProcessSpawnOptions | PluginDuplexProcessSpawnOptions | PluginPtyProcessSpawnOptions
      ): Promise<PluginProcessHandle | PluginDuplexProcessHandle | PluginPtyProcessHandle> {
        spawnCalls.push({ command, options });
        // A no-op handle: the mock records the call without spawning anything.
        // Lifecycle and data callbacks never fire (no real process), and
        // kill/restart/write/resize are inert — tests that exercise real process
        // behavior use PluginProcessManager directly with an injected fake spawner.
        const base: PluginProcessHandle = {
          id: `mock-process-${spawnCalls.length}`,
          kill: () => {},
          restart: async () => {},
          onExit: () => () => {},
          onCrash: () => () => {},
          onData: () => () => {},
        };
        // Shape matches the real host: `write` exists only for a writable mode
        // (duplex or PTY) and `resize` only for a PTY, so a test asserting "pipe
        // mode has no writable input" stays honest.
        if (options?.mode === "duplex") return { ...base, write: () => {} };
        if (options?.mode !== "pty") return base;
        return { ...base, write: () => {}, resize: () => {} };
      },
    } as PluginProcessApi,
    // In-memory fs mock: writes land in `fsFiles` and are recorded; reads return
    // a previously-written value or reject ENOENT. No containment is modeled
    // (containment lives in pluginFsContainment and is unit-tested directly) —
    // this mock is for exercising a plugin's activate()/handlers, not the guard.
    fs: {
      async readFile(filePath, options) {
        options?.signal?.throwIfAborted();
        const v = fsFiles.get(filePath);
        if (v === undefined) {
          throw new Error(`ENOENT: mock fs has no file "${filePath}"`);
        }
        return v;
      },
      async readFileBytes(filePath, options) {
        options?.signal?.throwIfAborted();
        const v = fsFiles.get(filePath);
        if (v === undefined) {
          throw new Error(`ENOENT: mock fs has no file "${filePath}"`);
        }
        // The mock stores text, so bytes are the UTF-8 encoding of it — enough
        // to exercise a plugin's byte path without modelling binary storage.
        return new TextEncoder().encode(v);
      },
      async readFileWithRevision(filePath, options) {
        options?.signal?.throwIfAborted();
        const v = fsFiles.get(filePath);
        if (v === undefined) {
          throw new Error(`ENOENT: mock fs has no file "${filePath}"`);
        }
        return { contents: v, revision: mockRevision(v) };
      },
      // Same validation, bounds and per-entry results as the host; a path the
      // mock fs does not hold is `NOT_FOUND`.
      readFiles: (async (
        paths: readonly string[],
        readOptions?: PluginFsReadFilesOptions
      ): Promise<PluginFsReadFilesEntry<string | Uint8Array>[]> => {
        const fail = (why: string): never => {
          throw new Error(`VALIDATION: plugin "${pluginId}" fs.readFiles: ${why}`);
        };
        if (!Array.isArray(paths)) fail("paths must be an array of strings");
        if (paths.length > MOCK_READ_FILES_MAX_PATHS) {
          fail(`at most ${MOCK_READ_FILES_MAX_PATHS} paths per call (got ${paths.length})`);
        }
        if (paths.some((p) => typeof p !== "string" || p.length === 0)) {
          fail("every path must be a non-empty string");
        }
        const encoding = readOptions?.encoding ?? "utf-8";
        if (encoding !== "utf-8" && encoding !== "bytes") {
          fail('encoding must be "utf-8" or "bytes"');
        }
        const max = readOptions?.maxBytesPerFile;
        if (max !== undefined && (!Number.isSafeInteger(max) || max < 0)) {
          fail("maxBytesPerFile must be a non-negative integer");
        }
        readOptions?.signal?.throwIfAborted();
        let remaining = MOCK_READ_FILES_MAX_TOTAL_BYTES;
        return paths.map((filePath): PluginFsReadFilesEntry<string | Uint8Array> => {
          const v = fsFiles.get(filePath);
          if (v === undefined) {
            return {
              path: filePath,
              ok: false,
              error: { code: "NOT_FOUND", message: `ENOENT: mock fs has no file "${filePath}"` },
            };
          }
          const bytes = new TextEncoder().encode(v);
          if (max !== undefined && max <= remaining && bytes.length > max) {
            return {
              path: filePath,
              ok: false,
              error: { code: "TOO_LARGE", message: `larger than maxBytesPerFile (${max})` },
            };
          }
          if (bytes.length > remaining) {
            return {
              path: filePath,
              ok: false,
              error: {
                code: "RESULT_TOO_LARGE",
                message: "the call's content budget is spent; read this path in another call",
              },
            };
          }
          remaining -= bytes.length;
          return { path: filePath, ok: true, content: encoding === "bytes" ? bytes : v };
        });
      }) as NonNullable<PluginFsApi["readFiles"]>,
      async mkdir(dirPath) {
        if (typeof dirPath !== "string" || dirPath.length === 0) {
          throw new Error(`Plugin "${pluginId}" fs.mkdir: path must be a non-empty string`);
        }
        refuseFileInChain(dirPath);
        // Recursive, like the host: every missing ancestor is created too.
        for (const dir of dirChain(dirPath)) fsDirs.add(dir);
        fsMkdirCalls.push(dirPath);
      },
      async appendFile(filePath, contents) {
        if (typeof contents !== "string") {
          throw new Error(`Plugin "${pluginId}" fs.appendFile: contents must be a string`);
        }
        const parent = parentOf(filePath);
        if (!mockDirExists(parent)) {
          if (!isMockDataDirPath(filePath)) {
            refuseFileAncestor(filePath);
            throw new Error(`ENOENT: mock fs: parent directory "${parent}" does not exist`);
          }
          refuseFileInChain(parent);
          for (const dir of dirChain(parent)) fsDirs.add(dir);
        }
        if (!fsFiles.has(filePath) && mockDirExists(filePath)) {
          throw fsWriteError("TARGET_UNAVAILABLE", `mock fs: "${filePath}" is not a regular file`);
        }
        fsFiles.set(filePath, (fsFiles.get(filePath) ?? "") + contents);
        fsAppendCalls.push({ path: filePath, contents });
      },
      async writeFile(filePath, contents, options) {
        // The checked-write contract (#12323), modelled just far enough for a
        // plugin's conflict path to be exercised: `expectedRevision` compares
        // against the stored text's revision, `null` means create-new.
        const existing = fsFiles.get(filePath);
        if (isMockDataDirPath(filePath)) refuseFileInChain(parentOf(filePath));
        else refuseFileAncestor(filePath);
        if (existing === undefined && mockDirExists(filePath)) {
          // Create-new sees any entry as taken; every other write fails on
          // the directory itself.
          if (options?.expectedRevision === null) {
            throw fsWriteError("TARGET_EXISTS", `mock fs: "${filePath}" already exists`);
          }
          throw new Error(`EISDIR: mock fs: "${filePath}" is a directory`);
        }
        if (options !== undefined) {
          const expected = options.expectedRevision;
          if (expected === null && existing !== undefined) {
            throw fsWriteError("TARGET_EXISTS", `mock fs: "${filePath}" already exists`);
          }
          if (typeof expected === "string") {
            if (existing === undefined) {
              throw fsWriteError("TARGET_UNAVAILABLE", `mock fs: "${filePath}" does not exist`);
            }
            const currentRevision = mockRevision(existing);
            if (currentRevision !== expected) {
              throw Object.assign(
                fsWriteError(
                  "REVISION_MISMATCH",
                  `mock fs: "${filePath}" changed since it was read`
                ),
                { currentRevision }
              );
            }
          }
        }
        fsFiles.set(filePath, contents);
        fsWriteCalls.push({ path: filePath, contents });
        return { revision: mockRevision(contents) };
      },
      async readdir(dirPath, options) {
        options?.signal?.throwIfAborted();
        // Derive entries from files written via writeFile whose parent directory
        // is `dirPath` (#10617). Previously always returned [], so a plugin that
        // wrote files then listed the dir saw nothing — a false-green gap. Each
        // immediate child name is reported once: a name with a deeper path
        // segment is a directory, a name that is itself a written file is a file
        // (basename only, like a real readdir).
        const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
        const isDir = new Map<string, boolean>();
        for (const made of fsDirs) {
          if (!made.startsWith(prefix)) continue;
          const rest = made.slice(prefix.length);
          const slash = rest.indexOf("/");
          const name = slash === -1 ? rest : rest.slice(0, slash);
          if (name.length > 0) isDir.set(name, true);
        }
        for (const filePath of fsFiles.keys()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash === -1) {
            if (rest.length > 0 && !isDir.has(rest)) isDir.set(rest, false);
          } else {
            isDir.set(rest.slice(0, slash), true);
          }
        }
        const entries = [...isDir.entries()].map(([name, directory]) => ({
          name,
          isDirectory: directory,
          isFile: !directory,
          isSymbolicLink: false,
          // A detailed read promises size and mtime, so the mock supplies them
          // rather than letting a plugin that reads `entry.size` pass here and
          // fail against the real host. Written files have a real byte length;
          // directories carry no size, matching the production listing. There
          // are no symlinks to classify in an in-memory filesystem.
          ...(options?.detail === true &&
            !directory && { size: fsFiles.get(`${prefix}${name}`)?.length ?? 0 }),
          ...(options?.detail === true && { mtimeMs: 0 }),
        }));
        if (options?.detail !== true) return entries;
        // Same ordering the production listing applies: directories first, then
        // a numeric-aware name collation.
        const collator = new Intl.Collator(undefined, { numeric: true });
        return entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return collator.compare(a.name, b.name);
        });
      },
      // Same validation, ordering, pruning and truncation as the host, over the
      // mock's files and directories. There is no git here, so
      // `respectGitignore` is accepted and has nothing to act on; nor are there
      // symlinks to skip.
      async walk(root: string, walkOptions?: PluginFsWalkOptions): Promise<PluginFsWalkResult> {
        const fail = (why: string): never => {
          throw new Error(`VALIDATION: plugin "${pluginId}" fs.walk: ${why}`);
        };
        if (typeof root !== "string" || root.length === 0) fail("root must be a non-empty string");
        if (
          walkOptions !== undefined &&
          (walkOptions === null || typeof walkOptions !== "object")
        ) {
          fail("options must be an object");
        }
        const opts = walkOptions ?? {};
        const patterns = (name: string, value: unknown): readonly string[] | null => {
          if (value === undefined) return null;
          if (!Array.isArray(value)) return fail(`${name} must be an array of glob strings`);
          if (value.length > MOCK_WALK_MAX_PATTERNS) {
            fail(`${name} takes at most ${MOCK_WALK_MAX_PATTERNS} patterns (got ${value.length})`);
          }
          if (value.some((p) => typeof p !== "string" || p.length === 0 || p.length > 1024)) {
            fail(`every ${name} pattern must be a non-empty string of at most 1024 characters`);
          }
          return value as string[];
        };
        const integer = (name: string, value: unknown, max: number, fallback: number): number => {
          if (value === undefined) return fallback;
          if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
            return fail(`${name} must be an integer from 1 to ${max}`);
          }
          return value;
        };
        const include = patterns("include", opts.include);
        const exclude = patterns("exclude", opts.exclude) ?? [];
        const maxDepth = integer(
          "maxDepth",
          opts.maxDepth,
          MOCK_WALK_MAX_DEPTH,
          MOCK_WALK_MAX_DEPTH
        );
        const limit = integer("limit", opts.limit, MOCK_WALK_MAX_LIMIT, MOCK_WALK_DEFAULT_LIMIT);
        for (const name of ["respectGitignore", "includeSize"] as const) {
          if (opts[name] !== undefined && typeof opts[name] !== "boolean") {
            fail(`${name} must be a boolean`);
          }
        }
        opts.signal?.throwIfAborted();
        const base = trimDir(root);
        if (!mockDirExists(base)) {
          throw new Error(`ENOENT: mock fs has no directory "${root}"`);
        }
        const prefix = base === "/" ? "/" : `${base}/`;
        const types = new Map<string, "file" | "dir">();
        const addDirs = (rel: string): void => {
          const parts = rel.split("/");
          for (let i = 1; i < parts.length; i++) types.set(parts.slice(0, i).join("/"), "dir");
        };
        for (const made of fsDirs) {
          if (!made.startsWith(prefix)) continue;
          const rel = made.slice(prefix.length);
          if (rel.length === 0) continue;
          addDirs(rel);
          types.set(rel, "dir");
        }
        for (const [filePath] of fsFiles) {
          if (!filePath.startsWith(prefix)) continue;
          const rel = filePath.slice(prefix.length);
          addDirs(rel);
          if (!types.has(rel)) types.set(rel, "file");
        }
        const matches = (list: readonly string[], rel: string): boolean =>
          list.some((pattern) => path.posix.matchesGlob(rel, pattern));
        const depthOf = (rel: string): number => rel.split("/").length;
        // Breadth-first, like the host: truncation keeps the shallowest entries.
        const candidates = [...types.entries()]
          .filter(([rel]) => depthOf(rel) <= maxDepth)
          .filter(([rel]) => {
            // An excluded entry is left out, and so is everything under an
            // excluded directory.
            const parts = rel.split("/");
            for (let i = 1; i <= parts.length; i++) {
              if (matches(exclude, parts.slice(0, i).join("/"))) return false;
            }
            return true;
          })
          .sort(([a], [b]) => depthOf(a) - depthOf(b) || compareWalkPaths(a, b));
        const entries: PluginFsWalkEntry[] = [];
        let truncated = false;
        for (const [rel, type] of candidates) {
          if (include !== null && !matches(include, rel)) continue;
          if (entries.length >= limit) {
            truncated = true;
            break;
          }
          const size =
            opts.includeSize === true && type === "file"
              ? new TextEncoder().encode(fsFiles.get(`${prefix}${rel}`) ?? "").length
              : undefined;
          entries.push(size === undefined ? { path: rel, type } : { path: rel, type, size });
        }
        entries.sort((a, b) => compareWalkPaths(a.path, b.path));
        return { entries, truncated };
      },
      async stat(targetPath, options) {
        options?.signal?.throwIfAborted();
        return {
          isDirectory: fsDirs.has(targetPath),
          isFile: fsFiles.has(targetPath),
          isSymbolicLink: false,
          size: fsFiles.get(targetPath)?.length ?? 0,
          mtimeMs: 0,
        };
      },
      async watch(paths, callback, options) {
        options?.signal?.throwIfAborted();
        // Mirror PluginService.createHost fs.watch validation order so a watch
        // call the production host would reject fails the mock the same way.
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" fs.watch: callback must be a function`);
        }
        const recursive = options?.recursive;
        if (recursive !== undefined && typeof recursive !== "boolean") {
          throw new Error(`Plugin "${pluginId}" fs.watch: recursive must be a boolean`);
        }
        const debounceMs = options?.debounceMs;
        if (
          debounceMs !== undefined &&
          (typeof debounceMs !== "number" || !Number.isFinite(debounceMs) || debounceMs < 0)
        ) {
          throw new Error(
            `Plugin "${pluginId}" fs.watch: debounceMs must be a finite, non-negative number`
          );
        }
        const allowMissing = options?.allowMissing;
        if (allowMissing !== undefined && typeof allowMissing !== "boolean") {
          throw new Error(`Plugin "${pluginId}" fs.watch: allowMissing must be a boolean`);
        }
        if (!Array.isArray(paths) || paths.length === 0) {
          throw new Error(`Plugin "${pluginId}" fs.watch: paths must be a non-empty array`);
        }
        // Record the watcher so `simulateFsWatch` can fire it. The disposer
        // removes the record (idempotent) — once disposed the watcher no longer
        // receives simulated changes, and a pending debounced one is dropped.
        const record: MockFsWatcher = {
          paths: paths.map(trimDir),
          callback,
          recursive: recursive === true,
          // Same floor and ceiling as the host.
          debounceMs:
            debounceMs === undefined || debounceMs === 0
              ? 0
              : Math.min(Math.max(debounceMs, 50), 60_000),
          timer: null,
          pending: null,
        };
        fsWatchers.add(record);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          if (record.timer !== null) clearTimeout(record.timer);
          record.timer = null;
          fsWatchers.delete(record);
        };
      },
    },
    // In-memory git mock. `commit` mirrors the host's #7880 guard — an empty
    // message rejects — so a plugin tested against the mock sees the same
    // no-silent-fallback contract as production.
    git: {
      async status(worktreePath, options) {
        options?.signal?.throwIfAborted();
        return { worktreePath, files: [], changedFileCount: 0 };
      },
      async diff(_worktreePath, _filePath, options) {
        options?.signal?.throwIfAborted();
        return "";
      },
      async add(_worktreePath, _paths, options) {
        options?.signal?.throwIfAborted();
      },
      async commit(worktreePath, options, callOptions): Promise<PluginGitCommitResult> {
        callOptions?.signal?.throwIfAborted();
        const message = typeof options?.message === "string" ? options.message : "";
        if (message.trim().length === 0) {
          throw new Error(
            `COMMIT_MESSAGE_REQUIRED: mock git.commit requires an explicit non-empty message`
          );
        }
        gitCommitCalls.push({ worktreePath, message });
        return { commit: `mock-${gitCommitCalls.length}`, message, preview: "" };
      },
    },
    // In-memory clipboard mock. `writeText` records the text and updates the
    // in-memory buffer `readText` returns, so a round-trip works in tests. No
    // capability gating is modeled (matches the fs/git mocks — gating lives in
    // PluginService and is unit-tested there); `readText` returns "" until the
    // first write, mirroring Electron's empty-clipboard behaviour.
    clipboard: {
      async writeText(text) {
        clipboardWriteCalls.push(text);
        clipboardText = text;
      },
      async writeImage(pngData) {
        clipboardWriteImageCalls.push(pngData.byteLength);
        // A real image write replaces the clipboard, so text no longer reads
        // back — leaving the buffer intact would let a test pass that the
        // real host would fail.
        clipboardText = "";
      },
      async readText() {
        return clipboardText;
      },
    },
    // Records only — a mock must never actually launch a file or open a
    // Finder window, which is exactly what the real implementation does.
    // Containment and capability gating live in PluginService and are unit
    // tested there, matching the fs/git/clipboard mocks.
    system: {
      async openPath(targetPath) {
        systemOpenPathCalls.push(targetPath);
      },
      async showItemInFolder(targetPath) {
        systemShowItemCalls.push(targetPath);
      },
      async openExternal(url) {
        const parsed = parsePluginExternalUrl(url);
        if (!parsed.ok) {
          throw new Error(`INVALID_URL: system.openExternal: ${parsed.reason}`);
        }
        systemOpenExternalCalls.push(parsed.link.href);
      },
    },
    // No Chromium here, so nothing is rendered: the call is recorded and a
    // placeholder PDF lands in the in-memory fs, so a plugin that reads,
    // lists or opens its export afterwards sees a file. Options go through
    // the real host's validator and an `htmlPath` must exist in the mock fs;
    // containment and gating live in the real host and are tested there.
    documents: {
      async renderPdf(options) {
        // The real host's own validator, so a plugin's export test fails on
        // exactly what Daintree refuses.
        validateRenderPdfOptions(pluginId, options);
        if (options.htmlPath !== undefined && !fsFiles.has(options.htmlPath)) {
          throw new Error(`INVALID_PATH: mock fs has no file "${options.htmlPath}"`);
        }
        documentsRenderPdfCalls.push({ ...options });
        const placeholder = `%PDF-1.4\n% createMockHost placeholder\n%%EOF\n`;
        fsFiles.set(options.outputPath, placeholder);
        return {
          path: options.outputPath,
          bytes: new TextEncoder().encode(placeholder).byteLength,
          revision: mockRevision(placeholder),
        };
      },
    },
    // No disk and no network: an artifact is a record, its size the bytes the
    // mock fs or `artifactDownloads` held. Only argument shapes are checked —
    // capability, containment and URL scope are the real host's, tested there.
    artifacts: {
      async import(source, artifactOptions) {
        const filePath = source?.path;
        if (typeof filePath !== "string") {
          throw new Error("VALIDATION: mock artifacts.import: source.path must be a string");
        }
        const text = fsFiles.get(filePath);
        if (text === undefined) throw new Error(`INVALID_PATH: mock fs has no file "${filePath}"`);
        return mockArtifact(
          "import",
          artifactOptions?.name ?? filePath,
          new TextEncoder().encode(text).byteLength,
          artifactOptions
        );
      },
      async download(request, artifactOptions) {
        artifactOptions?.signal?.throwIfAborted();
        const body = options.artifactDownloads?.[request?.url];
        if (body === undefined) {
          throw new Error(
            `ARTIFACT_TRANSFER_FAILED: mock artifacts.download has no body for that URL`
          );
        }
        const size =
          typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
        artifactOptions?.onProgress?.({ transferredBytes: size, totalBytes: size, attempt: 1 });
        const name = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "artifact";
        return mockArtifact("download", artifactOptions?.name ?? name, size, artifactOptions);
      },
      async upload(artifactId, request, uploadOptions) {
        uploadOptions?.signal?.throwIfAborted();
        const artifact = artifacts.get(artifactId);
        if (!artifact) throw new Error(`ARTIFACT_NOT_FOUND: mock has no artifact "${artifactId}"`);
        const method = request?.method ?? "PUT";
        artifactUploadCalls.push({ artifactId, url: request.url, method });
        uploadOptions?.onProgress?.({
          transferredBytes: artifact.size,
          totalBytes: artifact.size,
          attempt: 1,
        });
        return { status: 200, headers: {}, body: "", bodyTruncated: false };
      },
      async stat(artifactId) {
        return artifacts.get(artifactId) ?? null;
      },
      async list(listOptions) {
        return [...artifacts.values()].filter(
          (a) => listOptions?.projectId === undefined || a.projectId === listOptions.projectId
        );
      },
      async release(artifactId) {
        return artifacts.delete(artifactId);
      },
    },
    spawnCalls,
    fsWriteCalls,
    fsAppendCalls,
    fsMkdirCalls,
    gitCommitCalls,
    clipboardWriteCalls,
    clipboardWriteImageCalls,
    systemOpenPathCalls,
    systemShowItemCalls,
    systemOpenExternalCalls,
    documentsRenderPdfCalls,
    artifactRecords: artifacts,
    artifactUploadCalls,
    simulateArtifactExpiry(artifactId) {
      artifacts.delete(artifactId);
    },
    simulateFsWatch(changedPath) {
      // Snapshot before firing so a callback that registers/disposes a watcher
      // doesn't mutate the set mid-iteration.
      for (const record of [...fsWatchers]) {
        if (!fsWatchers.has(record)) continue;
        // The paths the real watcher would report: the watched path itself, a
        // direct child, or — only for a recursive watch — anything beneath it.
        const covered = record.paths.some(
          (watched) =>
            changedPath === watched ||
            parentOf(changedPath) === watched ||
            (record.recursive && changedPath.startsWith(watched === "/" ? "/" : `${watched}/`))
        );
        if (!covered) continue;
        if (record.debounceMs === 0) {
          record.callback(changedPath);
          continue;
        }
        // One trailing callback per burst, carrying the latest path — drive it
        // with fake timers or a real wait.
        record.pending = changedPath;
        if (record.timer !== null) clearTimeout(record.timer);
        record.timer = setTimeout(() => {
          record.timer = null;
          const latest = record.pending;
          record.pending = null;
          if (latest !== null && fsWatchers.has(record)) record.callback(latest);
        }, record.debounceMs);
      }
    },
  };

  return { members };
}
