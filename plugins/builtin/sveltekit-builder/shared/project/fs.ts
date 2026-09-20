/**
 * The filesystem surface the project model is allowed to assume.
 *
 * Deliberately narrower than `node:fs`: the plugin's main side hands this
 * straight through from `host.fs` (`PluginFsApi`), whose reads are capability-
 * gated and realpath-contained to the declared scopes. Structurally
 * `PluginFsApi` satisfies it — its richer `PluginFsDirEntry` / `PluginFsStat`
 * and its optional options argument are assignable to these — so no adapter is
 * needed at the call site, and a test can hand over a fixture tree instead.
 *
 * Note what is *not* here: `mkdir`, `rename`, `rm`. Detection reads. It never
 * repairs a project, and the host API would not let it.
 */
export interface ProjectFsDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface ProjectFsStat {
  isDirectory: boolean;
  isFile: boolean;
}

/**
 * The trailing options every read here accepts, mirroring the host's
 * `PluginHostCallOptions` so a `PluginFsApi` still satisfies this interface
 * unchanged. The signal is how a closed workspace stops a scan already in
 * flight: the reader rejects, and the helpers below let that rejection through
 * instead of reporting the file as missing.
 */
export interface ProjectReadOptions {
  signal?: AbortSignal;
}

export interface ProjectBoundedReadOptions extends ProjectReadOptions {
  limitBytes: number;
}

/**
 * What a bounded read found. `too-large` and `not-a-file` are separate from
 * `missing` for the same reason {@link JsonReadStatus} separates them: a
 * resolution that climbs on absence must not climb past a file it refused.
 */
export type BoundedTextRead =
  | { status: "ok"; text: string }
  | { status: "too-large" }
  | { status: "not-a-file" }
  | { status: "missing" };

export interface ProjectFileReader {
  readFile(path: string, options?: ProjectReadOptions): Promise<string>;
  readdir(path: string, options?: ProjectReadOptions): Promise<ProjectFsDirEntry[]>;
  stat(path: string, options?: ProjectReadOptions): Promise<ProjectFsStat>;
  /**
   * Read a metadata file under a byte ceiling the read itself obeys, refusing
   * anything that is not a regular file. Optional: a reader over a fixture tree
   * has no descriptors to bound, and the text-read fallback in
   * {@link readTextFile} covers it. Every reader main builds supplies it.
   */
  readBoundedText?(path: string, options: ProjectBoundedReadOptions): Promise<BoundedTextRead>;
}

/**
 * Ceiling on one metadata or config read — `package.json`, `svelte.config.js`,
 * a lockfile probe, an installed package's manifest.
 *
 * Deliberately far below the 1 MiB source cap: these are files of a few
 * kilobytes, and unlike a source file (read when the user selects an element)
 * discovery reads one per directory it visits, up to its 2000-directory
 * budget. The host's own `plugin.json` cap is 512 KiB for a manifest read once
 * per project open; half that is generous for a file read two thousand times.
 */
export const MAX_METADATA_BYTES = 256 * 1024;

/**
 * Ceiling on the entries one directory listing contributes. The host has no
 * count-limited `readdir` — the whole listing is materialised there either way
 * — but nothing past this is retained, so a directory with a million entries
 * costs one transient array rather than a walk queue that never drains.
 */
export const MAX_DIRECTORY_ENTRIES = 4096;

/**
 * An aborted read is not a missing file, and every helper here reports failure
 * as absence. Without this an abort would be swallowed silently and the scan
 * would walk the rest of the tree reading nothing.
 *
 * The signal is the reliable witness: `throwIfAborted()` throws the abort
 * *reason*, which a caller may set to any value at all, so the error itself
 * need not look like an abort. The name check is the fallback for a reader
 * that rejected on its own signal without telling us which one.
 */
export function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    throw error;
  }
}

/**
 * Separator of an existing absolute path. Worktree paths arrive from the host
 * in the platform's own form, and a Windows path must not acquire a stray `/`
 * halfway through — `host.fs` containment compares resolved paths.
 */
function separatorOf(base: string): "\\" | "/" {
  return base.includes("\\") && !base.includes("/") ? "\\" : "/";
}

export function joinPath(base: string, ...parts: string[]): string {
  const sep = separatorOf(base);
  const trimmed = base.endsWith(sep) ? base.slice(0, -sep.length) : base;
  const tail = parts
    .flatMap((part) => part.split(/[\\/]+/))
    .filter((segment) => segment.length > 0 && segment !== ".");
  return tail.length === 0 ? trimmed : `${trimmed}${sep}${tail.join(sep)}`;
}

export function parentPath(target: string): string | null {
  const sep = separatorOf(target);
  const index = target.lastIndexOf(sep);
  if (index <= 0) return null;
  const parent = target.slice(0, index);
  // `C:\` and `/` are their own roots; stopping here avoids an endless climb.
  return parent.length === 0 || parent.endsWith(":") ? null : parent;
}

export function basename(target: string): string {
  const segments = target.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? target;
}

/** Separator-insensitive form, for comparing two paths that may spell the same place differently. */
function normaliseSeparators(target: string): string {
  return target.split(/[\\/]+/).join("/");
}

/**
 * Worktree-relative, POSIX-separated — the form every path on the wire takes,
 * so a route reported on macOS reads the same as one reported on Windows.
 * Returns the absolute path unchanged when it is not inside the root, which is
 * the honest answer for an app outside the worktree rather than a `../..` chain
 * the UI would have to re-resolve.
 */
export function toWorktreeRelative(worktreeRoot: string, target: string): string {
  const sep = separatorOf(worktreeRoot);
  const root = worktreeRoot.endsWith(sep) ? worktreeRoot.slice(0, -sep.length) : worktreeRoot;
  if (target === root) return ".";
  if (!target.startsWith(root + sep)) return target.split(/[\\/]+/).join("/");
  return target
    .slice(root.length + sep.length)
    .split(/[\\/]+/)
    .join("/");
}

/**
 * The same place, spelled without `.` or `..`.
 *
 * {@link joinPath} drops `.` but keeps `..`, because a segment it was handed is
 * a segment the caller meant. A containment check cannot work on that spelling:
 * `/repo/app/../../elsewhere` starts with `/repo` and is not inside it. A `..`
 * at the root is dropped rather than kept, which is what the filesystem does.
 */
export function normalisePath(target: string): string {
  const sep = separatorOf(target);
  const [root = "", ...segments] = target.split(/[\\/]+/);
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      kept.pop();
      continue;
    }
    kept.push(segment);
  }
  return kept.length === 0 ? `${root}${sep}` : [root, ...kept].join(sep);
}

/** True when `candidate` is `root` or lives under it. */
export function isWithin(root: string, candidate: string): boolean {
  const base = normaliseSeparators(root).replace(/\/+$/, "");
  const target = normaliseSeparators(candidate).replace(/\/+$/, "");
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Every directory from `start` up to and including `stop`, nearest first. When
 * `start` is not under `stop` the walk is just `[start]` — an app root outside
 * the worktree gets no implicit access to the tree above it.
 */
export function directoriesUpTo(start: string, stop: string): string[] {
  if (!isWithin(stop, start)) return [start];
  const chain: string[] = [];
  let current: string | null = start;
  while (current && isWithin(stop, current)) {
    chain.push(current);
    if (current === stop) break;
    current = parentPath(current);
  }
  return chain;
}

/**
 * A metadata file as text, bounded.
 *
 * Prefers the reader's bounded primitive, which stops at the cap inside the
 * read and refuses a FIFO on the open descriptor. A reader without one falls
 * back to a plain read and measures afterwards — bounded after allocation,
 * which is all a fixture or a proxied host can offer.
 */
export async function readBoundedTextFile(
  reader: ProjectFileReader,
  path: string,
  options: Partial<ProjectBoundedReadOptions> = {}
): Promise<BoundedTextRead> {
  const limitBytes = options.limitBytes ?? MAX_METADATA_BYTES;
  const bounded = reader.readBoundedText;
  if (bounded) {
    try {
      return await bounded.call(reader, path, { ...options, limitBytes });
    } catch (error) {
      rethrowIfAborted(error, options.signal);
      return { status: "missing" };
    }
  }
  try {
    const text = await reader.readFile(path, options);
    // UTF-16 code units, not bytes: an approximation that can only under-count
    // a multi-byte file, and the exact bound is the bounded reader's job.
    return text.length > limitBytes ? { status: "too-large" } : { status: "ok", text };
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    return { status: "missing" };
  }
}

/**
 * The lenient form. Note what a caller reading `null` cannot tell: a config
 * that is absent from one that was refused for its size or its file type. A
 * caller that treats `null` as "not configured" — `resolveBasePath`, the
 * routes-directory resolver — reports its default for a config it never read.
 * Fixing that means widening those callers to carry a reason, which is a
 * change to their shape rather than to this one.
 */
export async function readTextFile(
  reader: ProjectFileReader,
  path: string,
  options: Partial<ProjectBoundedReadOptions> = {}
): Promise<string | null> {
  const read = await readBoundedTextFile(reader, path, options);
  return read.status === "ok" ? read.text : null;
}

/**
 * Why a JSON read produced no object.
 *
 * `unreadable` and `malformed` are not `missing`. A resolution that climbs on
 * absence must stop on either of the other two, or an unreadable app-local
 * package silently reports the version of a package one directory up.
 */
export type JsonReadStatus = "ok" | "missing" | "malformed";

export interface JsonReadResult {
  status: JsonReadStatus;
  value: Record<string, unknown> | null;
}

export async function readJsonFileResult(
  reader: ProjectFileReader,
  path: string,
  options: Partial<ProjectBoundedReadOptions> = {}
): Promise<JsonReadResult> {
  const read = await readBoundedTextFile(reader, path, options);
  if (read.status === "missing") return { status: "missing", value: null };
  // A manifest too large to read, or a pipe wearing a manifest's name, is not
  // an absent manifest: a climbing resolution must stop here.
  if (read.status !== "ok") return { status: "malformed", value: null };
  try {
    // The parse itself is synchronous and uninterruptible; the byte cap above
    // is what keeps it short, not the signal.
    const parsed: unknown = JSON.parse(read.text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { status: "ok", value: parsed as Record<string, unknown> }
      : { status: "malformed", value: null };
  } catch {
    return { status: "malformed", value: null };
  }
}

/**
 * The lenient form, for callers that genuinely cannot act on the difference: a
 * project with a broken `package.json` is a project we cannot support, not an
 * exception that should take the whole detection pass down.
 */
export async function readJsonFile(
  reader: ProjectFileReader,
  path: string,
  options: Partial<ProjectBoundedReadOptions> = {}
): Promise<Record<string, unknown> | null> {
  return (await readJsonFileResult(reader, path, options)).value;
}

/**
 * One directory's entries, capped, with whether the cap hid any. Discovery
 * uses the flag to report an incomplete scan rather than quietly losing an app
 * that sorted past the cutoff.
 */
export async function readDirectoryBounded(
  reader: ProjectFileReader,
  path: string,
  options: ProjectReadOptions & { maxEntries?: number } = {}
): Promise<{ entries: ProjectFsDirEntry[]; truncated: boolean }> {
  const maxEntries = options.maxEntries ?? MAX_DIRECTORY_ENTRIES;
  try {
    const entries = await reader.readdir(path, options);
    return entries.length > maxEntries
      ? { entries: entries.slice(0, maxEntries), truncated: true }
      : { entries, truncated: false };
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    // A directory we could not list is not an empty directory. Reported as
    // truncation because that is what it is to the caller: whatever was in
    // there went unread, so the scan above cannot call itself complete.
    return { entries: [], truncated: true };
  }
}

/**
 * The whole listing, for callers that have nowhere to report a dropped entry.
 * Route analysis is one: a `+page.svelte` past an entry cap would vanish from
 * the route tree with nothing to say it had been there, which is worse than
 * the listing being large. The cap belongs where truncation is reportable —
 * {@link readDirectoryBounded}, which discovery uses.
 */
export async function readDirectory(
  reader: ProjectFileReader,
  path: string,
  options: ProjectReadOptions = {}
): Promise<ProjectFsDirEntry[]> {
  try {
    return await reader.readdir(path, options);
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    return [];
  }
}

export async function fileExists(
  reader: ProjectFileReader,
  path: string,
  options: ProjectReadOptions = {}
): Promise<boolean> {
  try {
    return (await reader.stat(path, options)).isFile;
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    return false;
  }
}

export async function directoryExists(
  reader: ProjectFileReader,
  path: string,
  options: ProjectReadOptions = {}
): Promise<boolean> {
  try {
    return (await reader.stat(path, options)).isDirectory;
  } catch (error) {
    rethrowIfAborted(error, options.signal);
    return false;
  }
}
