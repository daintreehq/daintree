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
  return value === "rendered" || value === "source" ? value : undefined;
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
