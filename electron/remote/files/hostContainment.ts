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

interface WalkStep {
  path: string;
  handle: OpenedHostFile;
}

type WalkResult =
  { steps: WalkStep[]; canonicalPath: string; viaProc: boolean } | "wrong-kind" | null;

/**
 * The walk both entry points share. It ends on a regular file (`want:
 * "file"`) or a directory, and hands back the descriptors it holds: only the
 * last one via /proc, where each step was an openat, and otherwise every step
 * from the anchor down, so a caller can re-check the whole chain later.
 */
async function walkBeneath(
  anchor: string,
  components: readonly string[],
  anchorSpellings: readonly string[],
  want: "file" | "directory"
): Promise<WalkResult> {
  if (!validComponents(components)) return null;
  const viaProc = await openatThroughProc();
  let remaining = [...components];
  let hops = 0;
  let steps: WalkStep[] = [];
  const release = async (held: WalkStep[]) => {
    await Promise.all(held.map((step) => step.handle.close().catch(() => {})));
  };
  try {
    for (;;) {
      await release(steps.splice(0));
      try {
        // The anchor is the project folder itself, already canonical, so it is
        // opened without following a symlink too: one swapped in after the
        // realpath can't move the walk's starting point.
        steps.push({ path: anchor, handle: await fs.open(anchor, DIR_FLAGS) });
      } catch {
        return null;
      }
      let dirPath = anchor;
      let restart = false;
      while (remaining.length > 0) {
        const current = steps[steps.length - 1]!.handle;
        const name = remaining[0]!;
        const last = remaining.length === 1;
        const entryPath = path.join(dirPath, name);
        const stepPath = viaProc ? `/proc/self/fd/${current.fd}/${name}` : entryPath;
        let child: OpenedHostFile;
        try {
          child = await fs.open(stepPath, last && want === "file" ? FILE_FLAGS : DIR_FLAGS);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (last && want === "file" && (code === "EISDIR" || code === "ENXIO")) {
            return "wrong-kind";
          }
          const target = await readLinkTarget(stepPath);
          if (target === null) {
            if (last && want === "directory" && code === "ENOTDIR") return "wrong-kind";
            return null;
          }
          if (++hops > MAX_LINK_HOPS) return null;
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
        if (viaProc) await release(steps.splice(0));
        steps.push({ path: entryPath, handle: child });
        dirPath = entryPath;
        remaining = remaining.slice(1);
      }
      if (restart) continue;
      const end = steps[steps.length - 1]!.handle;
      const stat = await end.stat();
      if (want === "file" ? !stat.isFile() : !stat.isDirectory()) return "wrong-kind";
      const held = steps;
      steps = [];
      return { steps: held, canonicalPath: dirPath, viaProc };
    }
  } finally {
    await release(steps);
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
  const walked = await walkBeneath(anchor, components, anchorSpellings, "file");
  if (walked === null) return null;
  if (walked === "wrong-kind") return "not-a-file";
  const handle = walked.steps.pop()!.handle;
  await Promise.all(walked.steps.map((step) => step.handle.close().catch(() => {})));
  return { handle, canonicalPath: walked.canonicalPath };
}

/**
 * A directory reached by {@link openDirectoryBeneath}, held open so that what
 * is created, replaced or removed in it lands in that directory and not in
 * whatever its path names by then.
 */
export interface HeldDirectory {
  /** The real path the walk reached it by. */
  readonly canonicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  /**
   * A path for `name` inside the held directory. On Linux it goes through the
   * held descriptor (/proc/self/fd), which is openat: no swap of any ancestor
   * can redirect it. Elsewhere it is the canonical path, which {@link verify}
   * pins down immediately before and after each use.
   */
  entry(name: string): string;
  /**
   * Throws unless every component from the anchor down still names the very
   * directory the walk opened there (same device and inode, not a symlink).
   * Nothing to check through /proc.
   */
  verify(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Walk to the directory `components` names beneath `anchor`, under the same
 * rules as {@link openBeneath}, and hold it. "not-a-directory" when the walk
 * ends on something else; null when a step is missing, leaves the anchor,
 * loops, or is not what its path names.
 */
export async function openDirectoryBeneath(
  anchor: string,
  components: readonly string[],
  anchorSpellings: readonly string[] = []
): Promise<HeldDirectory | "not-a-directory" | null> {
  const walked = await walkBeneath(anchor, components, anchorSpellings, "directory");
  if (walked === null) return null;
  if (walked === "wrong-kind") return "not-a-directory";
  const { steps, canonicalPath, viaProc } = walked;
  const held = steps[steps.length - 1]!.handle;
  const stat = await held.stat({ bigint: true });
  const fdPath = `/proc/self/fd/${held.fd}`;
  let closed = false;
  return {
    canonicalPath,
    dev: stat.dev,
    ino: stat.ino,
    entry: (name) => {
      if (!validComponents([name]) || name.includes("/") || name.includes(path.sep)) {
        throw new Error("Invalid entry name");
      }
      return viaProc ? `${fdPath}/${name}` : path.join(canonicalPath, name);
    },
    async verify() {
      if (closed) throw new Error("The folder is no longer held");
      if (viaProc) return;
      for (const step of steps) {
        if (!(await isSameEntry(step.handle, step.path))) {
          throw new Error("The folder changed during the upload");
        }
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(steps.map((step) => step.handle.close().catch(() => {})));
    },
  };
}
