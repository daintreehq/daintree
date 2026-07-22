import type { BuiltInPanelKind, PanelKind, ViewportPresetId } from "@/types";
import type { FileViewMode, DiffSource } from "@shared/types/panel";
import type { GitStatus } from "@shared/types/git";
import type { AddTerminalArgs, SavedTerminalData } from "@/utils/stateHydration/statePatcher";
import { VIEWPORT_PRESETS } from "@/panels/dev-preview/viewportPresets";

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
 * Canonical forward-slash form of a safe relative path: collapses duplicate
 * separators, drops `.` segments and trailing slashes. Tree row keys are built
 * from canonical listing paths, so a non-canonical restored value (`src/`,
 * `./src`) would never prefix-match them. `.` and empty resolve to undefined —
 * the worktree root is represented by the field's absence, never a sentinel.
 */
function canonicalRelativePath(value: unknown): string | undefined {
  if (!isSafeRelativePath(value)) return undefined;
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  return segments.length > 0 ? segments.join("/") : undefined;
}

/**
 * Coerce a persisted expanded-path list, dropping anything that isn't a plain
 * list of safe relative strings. An empty array is preserved: "the user had
 * nothing expanded" is a real state, distinct from "this panel predates the
 * field".
 */
function sanitizeExpandedPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (seen.size >= MAX_RESTORED_EXPANDED_PATHS) break;
    if (isSafeRelativePath(entry)) seen.add(entry);
  }
  return [...seen];
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
    browserShowIgnored:
      typeof saved.browserShowIgnored === "boolean" ? saved.browserShowIgnored : undefined,
    browserRootPath: canonicalRelativePath(saved.browserRootPath),
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
