import fs from "node:fs/promises";
import path from "node:path";

/**
 * Descriptor-based containment for files a host serves to attached Shells.
 *
 * The local handlers resolve a path, check it, then open it again by path, so
 * a directory swapped for a symlink in between can move the open outside the
 * root. Here the walk starts from the project folder (the one trusted anchor)
 * and opens one component at a time with O_NOFOLLOW, and the caller reads only
 * from the descriptor the walk ends on. On Linux each step opens relative to
 * the previous directory's descriptor (through /proc/self/fd), which is
 * openat: a swap can't redirect it. Elsewhere Node has no openat, so each step
 * is also checked to be the very entry its path names (same device and inode,
 * not a symlink).
 *
 * A symlink below the anchor is never opened through. Its target is read,
 * resolved against the real directory the walk has reached, and must land
 * inside the same anchor; the walk then starts over from the anchor along that
 * target, under the same per-step rules. So links that stay inside a project
 * (pnpm's node_modules, monorepo package links) work, a link that leaves it is
 * refused, and a link swapped after it was read can only make a step fail.
 */

export type OpenedHostFile = Awaited<ReturnType<typeof fs.open>>;

const { O_RDONLY, O_NOFOLLOW } = fs.constants;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
// A FIFO or device in the path must not block the open; the type is checked on the descriptor.
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK;
const FILE_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;

let procFdUsable: Promise<boolean> | null = null;

function openatThroughProc(): Promise<boolean> {
  if (process.platform !== "linux") return Promise.resolve(false);
  procFdUsable ??= fs.access("/proc/self/fd").then(
    () => true,
    () => false
  );
  return procFdUsable;
}

/** The path components of `target` below `anchor`, or null when it isn't below it. */
export function componentsBelow(anchor: string, target: string): string[] | null {
  const rel = path.relative(path.normalize(anchor), path.normalize(target));
  if (rel === "") return [];
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

async function isSameEntry(opened: OpenedHostFile, entryPath: string): Promise<boolean> {
  try {
    const [held, named] = await Promise.all([
      opened.stat({ bigint: true }),
      fs.lstat(entryPath, { bigint: true }),
    ]);
    return !named.isSymbolicLink() && held.dev === named.dev && held.ino === named.ino;
  } catch {
    return false;
  }
}

/** Symlinks resolved per walk, as the kernel's own SYMLOOP_MAX (40 on Linux) bounds a lookup. */
const MAX_LINK_HOPS = 40;

function validComponents(components: readonly string[]): boolean {
  return components.every(
    (name) => name !== "" && name !== "." && name !== ".." && !name.includes("\0")
  );
}

function linkTargetBelow(
  anchor: string,
  anchorSpellings: readonly string[],
  resolved: string
): string[] | null {
  for (const spelling of [anchor, ...anchorSpellings]) {
    const below = componentsBelow(spelling, resolved);
    if (below !== null) return below;
  }
  return null;
}

/** The target of the symlink at `linkPath`, or null when it isn't one (or can't be read). */
async function readLinkTarget(linkPath: string): Promise<string | null> {
  try {
    return await fs.readlink(linkPath);
  } catch {
    return null;
  }
}

/**
 * Open the regular file `components` names beneath the directory `anchor`,
 * resolving any symlink below it only while it stays inside `anchor`. Returns
 * the descriptor (the caller owns it) with the real path it was reached by,
 * "not-a-file" when the walk ends on something other than a regular file, or
 * null when any step is missing, leaves the anchor, loops, or is not what its
 * path names. `anchorSpellings` are other names for the anchor (the root as
 * configured, before realpath) that an absolute link target may be written
 * against; they only translate a target string and are never opened.
 */
export async function openBeneath(
  anchor: string,
  components: readonly string[],
  anchorSpellings: readonly string[] = []
): Promise<{ handle: OpenedHostFile; canonicalPath: string } | "not-a-file" | null> {
  if (components.length === 0) return "not-a-file";
  if (!validComponents(components)) return null;
  const viaProc = await openatThroughProc();
  let remaining = [...components];
  let hops = 0;
  let current: OpenedHostFile | null = null;
  try {
    for (;;) {
      await current?.close().catch(() => {});
      current = null;
      try {
        // The anchor is the project folder itself, already canonical; only what lies below it is walked.
        current = await fs.open(anchor, DIR_FLAGS & ~O_NOFOLLOW);
      } catch {
        return null;
      }
      let dirPath = anchor;
      let restart = false;
      while (remaining.length > 0) {
        const name = remaining[0]!;
        const last = remaining.length === 1;
        const entryPath = path.join(dirPath, name);
        const stepPath = viaProc ? `/proc/self/fd/${current.fd}/${name}` : entryPath;
        let child: OpenedHostFile;
        try {
          child = await fs.open(stepPath, last ? FILE_FLAGS : DIR_FLAGS);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (last && (code === "EISDIR" || code === "ENXIO")) return "not-a-file";
          const target = await readLinkTarget(stepPath);
          if (target === null || ++hops > MAX_LINK_HOPS) return null;
          // dirPath is the real directory reached so far (every step was verified
          // not to be a link), so resolving `..` lexically matches the filesystem.
          const below = linkTargetBelow(anchor, anchorSpellings, path.resolve(dirPath, target));
          if (below === null || !validComponents(below)) return null;
          remaining = [...below, ...remaining.slice(1)];
          restart = true;
          break;
        }
        if (!viaProc && !(await isSameEntry(child, entryPath))) {
          await child.close().catch(() => {});
          return null;
        }
        await current.close().catch(() => {});
        current = child;
        dirPath = entryPath;
        remaining = remaining.slice(1);
      }
      if (restart) continue;
      if (!(await current.stat()).isFile()) return "not-a-file";
      const handle = current;
      current = null;
      return { handle, canonicalPath: dirPath };
    }
  } finally {
    await current?.close().catch(() => {});
  }
}
