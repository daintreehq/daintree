import type { BuiltInPanelKind, PanelKind, ViewportPresetId } from "@/types";
import type {
  FileViewMode,
  DiffSource,
  FileBrowserSortKey,
  FileBrowserTreeSnapshot,
} from "@shared/types/panel";
import type { GitStatus } from "@shared/types/git";
import type { AddTerminalArgs, SavedTerminalData } from "@/utils/stateHydration/statePatcher";
import { VIEWPORT_PRESETS } from "@/panels/dev-preview/viewportPresets";
import {
  canonicalizeRootPath,
  MAX_SNAPSHOT_LISTINGS,
  MAX_SNAPSHOT_NODES,
  MAX_SNAPSHOT_TEXT_CHARS,
} from "@/panels/file-browser/fileBrowserTree";
import { normalizeFileBrowserSidebarWidth } from "@/panels/file-browser/sidebarWidth";

type PanelKindDeserializer = (saved: SavedTerminalData) => Partial<AddTerminalArgs>;

/** Coerce a persisted viewport-preset string to a known id, dropping stale values. */
function sanitizeViewportPreset(value: string | undefined): ViewportPresetId | undefined {
  return value !== undefined && Object.hasOwn(VIEWPORT_PRESETS, value)
    ? (value as ViewportPresetId)
    : undefined;
}

/** Coerce a persisted file view mode, dropping unknown on-disk values. */
function sanitizeFileViewMode(value: string | undefined): FileViewMode | undefined {
  return value === "rendered" || value === "source" || value === "diff" ? value : undefined;
}

const GIT_STATUSES: readonly string[] = [
  "modified",
  "added",
  "deleted",
  "untracked",
  "ignored",
  "renamed",
  "copied",
  "conflicted",
];

/** Coerce a persisted git status, dropping unknown on-disk values. */
function sanitizeGitStatus(value: string | undefined): GitStatus | undefined {
  return value !== undefined && GIT_STATUSES.includes(value) ? (value as GitStatus) : undefined;
}

const DIFF_SOURCES: readonly string[] = ["working-tree", "staged", "unstaged", "base-branch"];

/** Coerce a persisted diff source, dropping unknown on-disk values. */
function sanitizeDiffSource(value: string | undefined): DiffSource | undefined {
  return value !== undefined && DIFF_SOURCES.includes(value) ? (value as DiffSource) : undefined;
}

/**
 * Upper bound on restored expansions. A snapshot can hold anything, and every
 * surviving entry becomes a directory the browser tries to re-list on each
 * refresh — so this is a work bound, not just a size check.
 */
const MAX_RESTORED_EXPANDED_PATHS = 500;
const MAX_RESTORED_PATH_LENGTH = 4096;

/**
 * Whether a persisted value is a worktree-relative path the browser can safely
 * ask for. The value round-trips through JSON on disk, so a corrupted or
 * hand-edited snapshot can hold anything; the IPC layer would reject an
 * escaping path anyway, so it is cheaper to drop it here than to fire a request
 * that can only fail.
 *
 * Both separators are rejected in traversal position regardless of platform,
 * and drive-qualified/UNC forms are refused outright — a Windows-authored
 * snapshot can be opened on POSIX and vice versa.
 */
function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_RESTORED_PATH_LENGTH) return false;
  // C0, DEL and C1 — a path is never legitimately built from any of them.
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}

/**
 * Canonical forward-slash form of a safe relative path. Tree row keys are
 * built from canonical listing paths, so a non-canonical restored value
 * (`src/`, `./src`) would never prefix-match them. `.` and empty resolve to
 * undefined — the worktree root is represented by the field's absence, never
 * a sentinel.
 */
function canonicalRelativePath(value: unknown): string | undefined {
  if (!isSafeRelativePath(value)) return undefined;
  return canonicalizeRootPath(value) || undefined;
}

/**
 * Coerce a persisted expanded-path list, dropping anything that isn't a plain
 * list of safe relative strings. An empty array is preserved: "the user had
 * nothing expanded" is a real state, distinct from "this panel predates the
 * field".
 */
function sanitizeSortKey(value: unknown): FileBrowserSortKey | undefined {
  // "name" is the default, so restoring it as an explicit value would only make
  // the record less sparse than the serializer left it.
  return value === "modified" || value === "size" || value === "type" ? value : undefined;
}

function sanitizeExpandedPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (seen.size >= MAX_RESTORED_EXPANDED_PATHS) break;
    if (isSafeRelativePath(entry)) seen.add(entry);
  }
  return [...seen];
}

/** Plain-object guard so untrusted JSON can be field-checked without assertions. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A snapshot directory key: "" is the worktree root; anything else must be safe. */
function isSnapshotDirPath(value: unknown): value is string {
  return value === "" || isSafeRelativePath(value);
}

/** An entry basename: plain, separator-free, non-traversal, and bounded. */
function isSnapshotNodeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RESTORED_PATH_LENGTH &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/**
 * Coerce a persisted last-known tree snapshot (#11367), dropping the whole
 * value on any malformed element — a partially trusted snapshot could seed
 * rows for paths that were never listed, and the cost of dropping is only a
 * cold start. Count and text bounds mirror the capture side's, so a snapshot
 * that was legal to write is legal to restore.
 *
 * Every node must be a *canonical child edge*: `path` is exactly
 * `dirPath/name`, unique within its listing. That is what the real listing
 * service produces, and it structurally rules out the pathological shapes a
 * hand-edited snapshot could otherwise smuggle in: self-cycles and duplicate
 * edges (whose traversal is exponential under the depth guard), row paths
 * that dodge the visibility filter's per-name checks, and duplicate React
 * keys (`FlatTreeRow.path` doubles as the key).
 */
function sanitizeTreeSnapshot(value: unknown): FileBrowserTreeSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { worktreeId, basePath, rootPath, listings } = value;
  // Both identity tags are optional — a workspace-rooted browser has no
  // worktree id (#11482) — but a present one must still be well-formed, since
  // a malformed tag would compare unequal and silently cold-start forever.
  if (
    worktreeId !== undefined &&
    (typeof worktreeId !== "string" ||
      worktreeId.length === 0 ||
      worktreeId.length > MAX_RESTORED_PATH_LENGTH)
  ) {
    return undefined;
  }
  if (
    basePath !== undefined &&
    (typeof basePath !== "string" ||
      basePath.length === 0 ||
      basePath.length > MAX_RESTORED_PATH_LENGTH)
  ) {
    return undefined;
  }
  // At least one identity tag is mandatory. A snapshot carrying neither would
  // compare equal to every workspace source and seed its rows there.
  if (worktreeId === undefined && basePath === undefined) return undefined;
  if (!isSnapshotDirPath(rootPath)) return undefined;
  if (!Array.isArray(listings) || listings.length > MAX_SNAPSHOT_LISTINGS) return undefined;

  let totalNodes = 0;
  let totalChars = 0;
  const seenDirs = new Set<string>();
  const sanitizedListings: FileBrowserTreeSnapshot["listings"] = [];
  for (const entry of listings) {
    if (!isRecord(entry)) return undefined;
    const { dirPath, nodes } = entry;
    if (!isSnapshotDirPath(dirPath) || seenDirs.has(dirPath)) return undefined;
    seenDirs.add(dirPath);
    if (!Array.isArray(nodes)) return undefined;
    totalNodes += nodes.length;
    if (totalNodes > MAX_SNAPSHOT_NODES) return undefined;
    // Listing keys count against the text budget too, mirroring capture.
    totalChars += dirPath.length;
    if (totalChars > MAX_SNAPSHOT_TEXT_CHARS) return undefined;
    const seenNames = new Set<string>();
    const sanitizedNodes: FileBrowserTreeSnapshot["listings"][number]["nodes"] = [];
    for (const node of nodes) {
      if (!isRecord(node)) return undefined;
      const { name, path, isDirectory } = node;
      if (!isSnapshotNodeName(name) || seenNames.has(name)) return undefined;
      seenNames.add(name);
      if (path !== (dirPath === "" ? name : `${dirPath}/${name}`)) return undefined;
      // Canonical shape alone doesn't make the composite safe: the joined
      // path must also pass the same character/length screen every other
      // restored path does (control characters, drive prefixes, 4096 cap).
      if (!isSafeRelativePath(path)) return undefined;
      if (typeof isDirectory !== "boolean") return undefined;
      totalChars += name.length + path.length;
      if (totalChars > MAX_SNAPSHOT_TEXT_CHARS) return undefined;
      sanitizedNodes.push({ name, path, isDirectory });
    }
    sanitizedListings.push({ dirPath, nodes: sanitizedNodes });
  }
  // A snapshot without its own root listing has nothing to paint from —
  // seeding it would show an empty tree where a skeleton belongs.
  if (!seenDirs.has(rootPath)) return undefined;
  return {
    ...(worktreeId !== undefined && { worktreeId }),
    ...(basePath !== undefined && { basePath }),
    rootPath,
    listings: sanitizedListings,
  };
}

/**
 * Built-in deserializer table ratcheted against `BuiltInPanelKind` so adding
 * a new built-in kind without an entry fails at compile time. `null` marks an
 * intentionally absent deserializer (terminal restores through the PTY backend;
 * review has no kind-specific state).
 */
const BUILT_IN_DESERIALIZERS = {
  terminal: null,
  browser: (saved) => ({
    browserUrl: saved.browserUrl,
    browserHistory: saved.browserHistory,
    browserZoom: saved.browserZoom,
    browserConsoleOpen: saved.browserConsoleOpen,
  }),
  "dev-preview": (saved) => {
    const devCommandCandidate = saved.devCommand?.trim();
    const devCommand = devCommandCandidate || saved.command?.trim() || undefined;
    return {
      devCommand,
      browserUrl: saved.browserUrl,
      browserHistory: saved.browserHistory,
      browserZoom: saved.browserZoom,
      devPreviewConsoleOpen: saved.devPreviewConsoleOpen,
      devPreviewConsoleTab: saved.devPreviewConsoleTab,
      viewportPreset: sanitizeViewportPreset(saved.viewportPreset),
      viewportRotated: saved.viewportRotated === true,
      viewportDpr: saved.viewportDpr === 2 || saved.viewportDpr === 3 ? saved.viewportDpr : 1,
      viewportFit: saved.viewportFit === true,
      devPreviewScrollPosition: saved.devPreviewScrollPosition,
      createdAt: saved.createdAt,
    };
  },
  review: null,
  // Legacy markdown* fields: written by the short-lived "markdown" panel kind
  // this kind generalized from (inferKind maps the old kind string here).
  file: (saved) => ({
    filePath: saved.filePath ?? saved.markdownFilePath,
    fileViewMode: sanitizeFileViewMode(saved.fileViewMode ?? saved.markdownViewMode),
  }),
  "file-browser": (saved) => ({
    // Sanitized, not trusted: the snapshot schema passes unknown keys through,
    // so a malformed value would otherwise reach the pane and be `.split()` as
    // if it were a string.
    browserSelectedPath: isSafeRelativePath(saved.browserSelectedPath)
      ? saved.browserSelectedPath
      : undefined,
    browserExpandedPaths: sanitizeExpandedPaths(saved.browserExpandedPaths),
    browserHideDotfiles:
      typeof saved.browserHideDotfiles === "boolean" ? saved.browserHideDotfiles : undefined,
    browserRootPath: canonicalRelativePath(saved.browserRootPath),
    // Only a literal `true` restores collapsed: a hand-edited or corrupted
    // snapshot holding a string or object must fall back to the open default.
    browserSidebarCollapsed: saved.browserSidebarCollapsed === true ? true : undefined,
    // Same literal-`true` rule for the viewer column (#11496). Sanitized
    // independently: the pane resolves a record holding both flags at read
    // time, so neither deserializer branch has to know about the other.
    browserViewerCollapsed: saved.browserViewerCollapsed === true ? true : undefined,
    browserTreeSnapshot: sanitizeTreeSnapshot(saved.browserTreeSnapshot),
    // A finite number is clamped into range; a string/NaN/Infinity from a
    // hand-edited snapshot falls back to the default rather than becoming a
    // broken inline `style.width` (#11331).
    browserSidebarWidth: normalizeFileBrowserSidebarWidth(saved.browserSidebarWidth),
    // Literal `true` only: anything else leaves the field absent so the create
    // path re-derives rooting from `worktreeId` instead of trusting a corrupted
    // value to redirect the browse root (#11489).
    browserWorkspaceRooted: saved.browserWorkspaceRooted === true ? true : undefined,
    // Membership-tested against the known keys rather than cast: an unknown
    // string would reach the comparator and order by nothing, silently leaving
    // the tree in the service's order while the menu claimed otherwise
    // (#11620). Anything unrecognized falls back to the absent default.
    browserSortKey: sanitizeSortKey(saved.browserSortKey),
    browserSortDirection: saved.browserSortDirection === "desc" ? "desc" : undefined,
  }),
  diff: (saved) => ({
    filePath: saved.filePath,
    fileStatus: sanitizeGitStatus(saved.fileStatus),
    diffSource: sanitizeDiffSource(saved.diffSource),
    baseBranch: saved.baseBranch,
  }),
} as const satisfies Record<BuiltInPanelKind, PanelKindDeserializer | null>;

/** Runtime registry seeded from the built-in table, dropping `null` entries. */
const DESERIALIZERS: Record<string, PanelKindDeserializer> = {};
for (const [kind, fn] of Object.entries(BUILT_IN_DESERIALIZERS)) {
  if (fn !== null) {
    DESERIALIZERS[kind] = fn as PanelKindDeserializer;
  }
}

export function getDeserializer(kind: PanelKind): PanelKindDeserializer | undefined {
  return Object.hasOwn(DESERIALIZERS, kind) ? DESERIALIZERS[kind] : undefined;
}

export function registerDeserializer(kind: PanelKind, deserializer: PanelKindDeserializer): void {
  if (kind in BUILT_IN_DESERIALIZERS) {
    console.warn(
      `[panelKindSerialisers] Refusing to overwrite built-in deserializer for "${kind}". ` +
        `Built-in kinds have their deserializers defined in BUILT_IN_DESERIALIZERS.`
    );
    return;
  }
  DESERIALIZERS[kind] = deserializer;
}
