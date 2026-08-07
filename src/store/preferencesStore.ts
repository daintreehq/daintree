import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import {
  DEFAULT_OTHER_PROJECTS_SORT_MODE,
  isOtherProjectsSortMode,
  type OtherProjectsSortMode,
} from "@/lib/projectSort";

export type DockDensity = "compact" | "normal" | "comfortable";

// Mirrors react-diff-view's ViewType so the persistence layer stays decoupled
// from the UI library.
export type DiffViewType = "split" | "unified";

export type DiffFontSize = "s" | "m" | "l";

/** Seconds before a deleted worktree's surviving terminals auto-close (0 = never). */
export type DeletedWorktreeCleanupSeconds = 0 | 30 | 60 | 300;

export const DELETED_WORKTREE_CLEANUP_DEFAULT: DeletedWorktreeCleanupSeconds = 60;

/**
 * File-browser "always hidden" junk list. Basename globs (literal text plus `*`
 * wildcards) matched against entry names, hiding OS/tooling cruft in every
 * panel regardless of the per-panel dotfile toggle (#11330). User-editable in
 * settings; `.git` is a default rather than a structural exclusion so it can be
 * removed to browse repository internals.
 */
export const DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN: readonly string[] = [
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "._*",
  ".git",
];

/** Caps kept small — this is a curated junk list, not a general ignore file. */
export const MAX_ALWAYS_HIDDEN_PATTERNS = 100;
export const MAX_ALWAYS_HIDDEN_PATTERN_LENGTH = 200;

/**
 * Coerce arbitrary input (hydrated JSON or a setter argument) into a clean
 * basename-pattern list: strings only, trimmed, no empties, no path separators
 * (basename matching only), de-duplicated in order, and bounded. A non-array
 * falls back to the defaults; an array that legitimately reduces to empty stays
 * empty — clearing the list is a deliberate "hide nothing" choice, not
 * corruption.
 */
export function sanitizeAlwaysHiddenPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed === "" || trimmed.length > MAX_ALWAYS_HIDDEN_PATTERN_LENGTH) continue;
    if (trimmed.includes("/") || trimmed.includes("\\")) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_ALWAYS_HIDDEN_PATTERNS) break;
  }
  return result;
}

interface PreferencesState {
  showProjectPulse: boolean;
  setShowProjectPulse: (show: boolean) => void;
  showDeveloperTools: boolean;
  setShowDeveloperTools: (show: boolean) => void;
  showGridAgentHighlights: boolean;
  setShowGridAgentHighlights: (show: boolean) => void;
  /** Compose the agent's observed task title into terminal tab/header titles. */
  showAgentTaskTitles: boolean;
  setShowAgentTaskTitles: (show: boolean) => void;
  showDockAgentHighlights: boolean;
  setShowDockAgentHighlights: (show: boolean) => void;
  dockDensity: DockDensity;
  setDockDensity: (density: DockDensity) => void;
  assignWorktreeToSelf: boolean;
  setAssignWorktreeToSelf: (value: boolean) => void;
  reduceAnimations: boolean;
  setReduceAnimations: (value: boolean) => void;
  diffViewType: DiffViewType;
  setDiffViewType: (value: DiffViewType) => void;
  diffWrapLines: boolean;
  setDiffWrapLines: (value: boolean) => void;
  diffIgnoreWhitespace: boolean;
  setDiffIgnoreWhitespace: (value: boolean) => void;
  /** Show the changed-files sidebar in the diff workspace (multi-file review). */
  diffShowFileList: boolean;
  setDiffShowFileList: (value: boolean) => void;
  /**
   * Expand every hunk to cover the whole file instead of showing changed
   * regions with their context. Orthogonal to `diffViewType` — full file is a
   * content scope, and stays meaningful in both unified and split layouts.
   */
  diffFullFile: boolean;
  setDiffFullFile: (value: boolean) => void;
  diffFontSize: DiffFontSize;
  setDiffFontSize: (value: DiffFontSize) => void;
  /** Soft-wrap long lines in markdown Source view (panel + file viewer). */
  markdownWrapLines: boolean;
  setMarkdownWrapLines: (value: boolean) => void;
  lastSelectedWorktreeRecipeIdByProject: Record<string, string | null | undefined>;
  setLastSelectedWorktreeRecipeIdByProject: (
    projectId: string,
    id: string | null | undefined
  ) => void;
  skipPushConfirmByWorktreePath: Record<string, boolean>;
  setSkipPushConfirmForWorktree: (worktreePath: string, value: boolean) => void;
  /**
   * How long a deleted worktree's row holds its surviving terminals before
   * they are moved to trash automatically. The countdown measures time the
   * project view was actually awake, and holds — for a bounded stretch — while
   * a drag is in progress, an agent is still working, or the row's
   * close-confirm dialog is open (`deletedWorktreeCleanup.ts`).
   * 0 disables auto-cleanup.
   */
  deletedWorktreeCleanupSeconds: DeletedWorktreeCleanupSeconds;
  /**
   * Sort order for the project switcher's "Other projects" band and the welcome
   * screen's recent list (#11455). Global rather than per-project: it names how
   * the user reads their whole project set, not anything about one project.
   */
  projectSwitcherOtherSortMode: OtherProjectsSortMode;
  setProjectSwitcherOtherSortMode: (mode: OtherProjectsSortMode) => void;
  setDeletedWorktreeCleanupSeconds: (value: DeletedWorktreeCleanupSeconds) => void;
  /**
   * Basename globs always hidden in the file browser, across every panel. See
   * {@link DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN}.
   */
  fileBrowserAlwaysHiddenPatterns: string[];
  setFileBrowserAlwaysHiddenPatterns: (patterns: string[]) => void;
  resetFileBrowserAlwaysHiddenPatterns: () => void;
  /**
   * Whether the action palette's prefix table (`>` `@` `#` `:` `/`) has already
   * had its one showing. Teaching content, not a setting — it earns a first
   * opening and then stops being chrome every later open has to scroll past
   * (#11690). Deliberately monotonic `false → true`: a view count would lose
   * concurrent increments across project views, where this only ever converges
   * on "seen".
   */
  hasSeenActionPalettePrefixHint: boolean;
  markActionPalettePrefixHintSeen: () => void;
  /**
   * How many times a keyboard-dispatched layout change has been announced and
   * left standing, keyed {@link keyboardLayoutBindingKey}. Each confirmation
   * that actually surfaced counts up; using its Undo clears the action's entry,
   * because taking the change back is evidence the keypress was a slip rather
   * than a habit. At {@link KEYBOARD_LAYOUT_CONFIRMATION_LIMIT} the toast stops
   * firing for that binding, so someone who hits the shortcut on purpose fifty
   * times a day isn't told what their own key does fifty times (#11704).
   *
   * Keyed by combo, not by action alone: the message names the combo, so a
   * rebind is a new thing to learn and earns a fresh allowance.
   */
  keyboardLayoutConfirmationsByBinding: Record<string, number>;
  recordKeyboardLayoutConfirmation: (actionId: string, combo: string) => void;
  clearKeyboardLayoutConfirmations: (actionId: string) => void;
}

/** Confirmations of one binding before it stops announcing itself (#11704). */
export const KEYBOARD_LAYOUT_CONFIRMATION_LIMIT = 3;

/**
 * Storage key for a keyboard layout-change confirmation count. Mirrors
 * `shortcutHintStore`'s `actionId@…` convention.
 */
export function keyboardLayoutBindingKey(actionId: string, combo: string): string {
  return `${actionId}@${combo}`;
}

function isDockDensity(value: unknown): value is DockDensity {
  return value === "compact" || value === "normal" || value === "comfortable";
}

function isDiffViewType(value: unknown): value is DiffViewType {
  return value === "split" || value === "unified";
}

function isDiffFontSize(value: unknown): value is DiffFontSize {
  return value === "s" || value === "m" || value === "l";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isDeletedWorktreeCleanupSeconds(
  value: unknown
): value is DeletedWorktreeCleanupSeconds {
  return value === 0 || value === 30 || value === 60 || value === 300;
}

/**
 * Normalise the closed-set and record-shaped fields of a persisted blob against
 * the current schema. Run from the persist `merge` callback so it executes on
 * EVERY hydration — not only on version change, which is all `migrate` covers
 * (issue #9170). A corrupt-but-parseable value (e.g. hand-edited
 * `dockDensity: "dense"`, or a string where a record is expected) is replaced
 * with a safe default instead of flowing into live state unchecked.
 */
function sanitizePersistedPreferences(
  raw: Partial<PreferencesState> | undefined | null
): Partial<PreferencesState> {
  if (!raw || typeof raw !== "object") return {};
  const sanitized: Partial<PreferencesState> = { ...raw };

  if (!isDockDensity(sanitized.dockDensity)) sanitized.dockDensity = "normal";
  if (!isDiffViewType(sanitized.diffViewType)) sanitized.diffViewType = "split";
  if (typeof sanitized.diffWrapLines !== "boolean") sanitized.diffWrapLines = false;
  if (typeof sanitized.diffIgnoreWhitespace !== "boolean") sanitized.diffIgnoreWhitespace = false;
  if (typeof sanitized.diffShowFileList !== "boolean") sanitized.diffShowFileList = true;
  if (typeof sanitized.diffFullFile !== "boolean") sanitized.diffFullFile = false;
  if (!isDiffFontSize(sanitized.diffFontSize)) sanitized.diffFontSize = "m";
  if (typeof sanitized.markdownWrapLines !== "boolean") sanitized.markdownWrapLines = true;
  if (typeof sanitized.showAgentTaskTitles !== "boolean") sanitized.showAgentTaskTitles = true;
  if (!isDeletedWorktreeCleanupSeconds(sanitized.deletedWorktreeCleanupSeconds)) {
    sanitized.deletedWorktreeCleanupSeconds = DELETED_WORKTREE_CLEANUP_DEFAULT;
  }
  if (!isOtherProjectsSortMode(sanitized.projectSwitcherOtherSortMode)) {
    sanitized.projectSwitcherOtherSortMode = DEFAULT_OTHER_PROJECTS_SORT_MODE;
  }
  // Absent (new field) → defaults; a hand-edited array is filtered to valid
  // basename patterns; a legitimately empty list is preserved.
  sanitized.fileBrowserAlwaysHiddenPatterns = sanitizeAlwaysHiddenPatterns(
    sanitized.fileBrowserAlwaysHiddenPatterns
  );

  // A truthy non-record value here would otherwise bypass the push-confirm gate.
  const skip = sanitized.skipPushConfirmByWorktreePath;
  const validatedSkip: Record<string, boolean> = {};
  if (skip !== null && typeof skip === "object" && !Array.isArray(skip)) {
    for (const [key, value] of Object.entries(skip)) {
      if (typeof value === "boolean") validatedSkip[key] = value;
    }
  }
  sanitized.skipPushConfirmByWorktreePath = validatedSkip;

  // A non-boolean here would be truthy for any hand-edited string, retiring the
  // hint for a user who never saw it.
  if (typeof sanitized.hasSeenActionPalettePrefixHint !== "boolean") {
    sanitized.hasSeenActionPalettePrefixHint = false;
  }

  // A corrupt count breaks in both directions: a NaN would nag forever, and an
  // oversized one would silence a binding the user never confirmed.
  sanitized.keyboardLayoutConfirmationsByBinding = normalizeConfirmationMap(
    sanitized.keyboardLayoutConfirmationsByBinding
  );

  return sanitized;
}

type PreferencesPersistedState = Pick<
  PreferencesState,
  | "showProjectPulse"
  | "showDeveloperTools"
  | "showGridAgentHighlights"
  | "showAgentTaskTitles"
  | "showDockAgentHighlights"
  | "dockDensity"
  | "assignWorktreeToSelf"
  | "reduceAnimations"
  | "diffViewType"
  | "diffWrapLines"
  | "diffIgnoreWhitespace"
  | "diffShowFileList"
  | "diffFullFile"
  | "diffFontSize"
  | "markdownWrapLines"
  | "deletedWorktreeCleanupSeconds"
  | "projectSwitcherOtherSortMode"
  | "lastSelectedWorktreeRecipeIdByProject"
  | "skipPushConfirmByWorktreePath"
  | "fileBrowserAlwaysHiddenPatterns"
  | "hasSeenActionPalettePrefixHint"
  | "keyboardLayoutConfirmationsByBinding"
>;

const PREFERENCES_PERSISTED_DEFAULTS: PreferencesPersistedState = {
  showProjectPulse: true,
  showDeveloperTools: false,
  showGridAgentHighlights: false,
  showAgentTaskTitles: true,
  showDockAgentHighlights: false,
  dockDensity: "normal",
  assignWorktreeToSelf: false,
  reduceAnimations: false,
  diffViewType: "split",
  diffWrapLines: false,
  diffIgnoreWhitespace: false,
  diffShowFileList: true,
  diffFullFile: false,
  diffFontSize: "m",
  markdownWrapLines: true,
  deletedWorktreeCleanupSeconds: DELETED_WORKTREE_CLEANUP_DEFAULT,
  projectSwitcherOtherSortMode: DEFAULT_OTHER_PROJECTS_SORT_MODE,
  lastSelectedWorktreeRecipeIdByProject: {},
  skipPushConfirmByWorktreePath: {},
  fileBrowserAlwaysHiddenPatterns: [...DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN],
  hasSeenActionPalettePrefixHint: false,
  keyboardLayoutConfirmationsByBinding: {},
};

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Coerce the per-project recipe map, dropping `undefined` values: JSON omits them
 * on disk, and `mergeRecordByWriterDelta` reads `undefined` as "key absent", so an
 * explicit `undefined` (a cleared selection — semantically a deletion) must not
 * reach the diff as a live value.
 */
function normalizeRecipeMap(value: unknown): Record<string, string | null> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || typeof entry === "string") result[key] = entry;
  }
  return result;
}

function normalizeSkipMap(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") result[key] = entry;
  }
  return result;
}

/**
 * Keep only whole counts inside the real range. Out-of-range values are dropped
 * rather than clamped: clamping an oversized one would land on exactly the
 * limit and silence a binding the user never confirmed, which is the single
 * failure this notice can't recover from. Erring toward showing it again costs
 * one toast. `Number.isInteger` also rejects NaN, Infinity and fractions.
 */
function normalizeConfirmationMap(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) continue;
    if (entry < 1 || entry > KEYBOARD_LAYOUT_CONFIRMATION_LIMIT) continue;
    result[key] = entry;
  }
  return result;
}

/**
 * Counter-aware merge for the confirmation tallies. The generic
 * `mergeRecordByWriterDelta` is last-writer-wins per key, which is wrong for a
 * count two project views both increment: a view still holding 1 would write it
 * over a sibling's 3 and reopen an allowance the user had already spent. Take
 * the higher count instead, and keep the writer-delta rule for deletions so an
 * Undo still clears the key rather than losing to a sibling's stale tally.
 */
function mergeConfirmationCounts(
  baseline: Record<string, number>,
  incoming: Record<string, number>,
  onDisk: Record<string, number>
): Record<string, number> {
  // Map lookups rather than `in`/bracket reads, which see the prototype chain —
  // the same reason `mergeRecordByWriterDelta` builds Maps from `Object.entries`.
  const baselineMap = new Map(Object.entries(baseline));
  const incomingMap = new Map(Object.entries(incoming));
  const onDiskMap = new Map(Object.entries(onDisk));
  const result: Record<string, number> = {};

  for (const [key, incomingCount] of incomingMap) {
    const diskCount = onDiskMap.get(key);
    if (baselineMap.get(key) === incomingCount) {
      // This writer didn't touch the key, so the sibling's value stands —
      // including its absence, which is a sibling's Undo that must survive.
      if (diskCount !== undefined) result[key] = diskCount;
      continue;
    }
    // This writer counted up. Never let its total lower a sibling's.
    result[key] = diskCount === undefined ? incomingCount : Math.max(incomingCount, diskCount);
  }
  for (const [key, diskCount] of onDiskMap) {
    if (incomingMap.has(key)) continue;
    // Held at hydration and gone now → this writer's Undo cleared it.
    if (baselineMap.has(key)) continue;
    result[key] = diskCount;
  }
  return result;
}

/**
 * Coerce a persisted (or in-memory) snapshot into a fully-defined persisted shape
 * so the write merge compares canonical values (issue #11351). Reuses the store's
 * closed-set guards and the pattern sanitizers.
 */
function toPreferencesPersisted(
  state: Partial<PreferencesState> | null | undefined
): PreferencesPersistedState {
  const raw = (state ?? {}) as Record<string, unknown>;
  const d = PREFERENCES_PERSISTED_DEFAULTS;
  return {
    showProjectPulse: coerceBool(raw.showProjectPulse, d.showProjectPulse),
    showDeveloperTools: coerceBool(raw.showDeveloperTools, d.showDeveloperTools),
    showGridAgentHighlights: coerceBool(raw.showGridAgentHighlights, d.showGridAgentHighlights),
    showAgentTaskTitles: coerceBool(raw.showAgentTaskTitles, d.showAgentTaskTitles),
    showDockAgentHighlights: coerceBool(raw.showDockAgentHighlights, d.showDockAgentHighlights),
    dockDensity: isDockDensity(raw.dockDensity) ? raw.dockDensity : d.dockDensity,
    assignWorktreeToSelf: coerceBool(raw.assignWorktreeToSelf, d.assignWorktreeToSelf),
    reduceAnimations: coerceBool(raw.reduceAnimations, d.reduceAnimations),
    diffViewType: isDiffViewType(raw.diffViewType) ? raw.diffViewType : d.diffViewType,
    diffWrapLines: coerceBool(raw.diffWrapLines, d.diffWrapLines),
    diffIgnoreWhitespace: coerceBool(raw.diffIgnoreWhitespace, d.diffIgnoreWhitespace),
    diffShowFileList: coerceBool(raw.diffShowFileList, d.diffShowFileList),
    diffFullFile: coerceBool(raw.diffFullFile, d.diffFullFile),
    diffFontSize: isDiffFontSize(raw.diffFontSize) ? raw.diffFontSize : d.diffFontSize,
    markdownWrapLines: coerceBool(raw.markdownWrapLines, d.markdownWrapLines),
    deletedWorktreeCleanupSeconds: isDeletedWorktreeCleanupSeconds(
      raw.deletedWorktreeCleanupSeconds
    )
      ? raw.deletedWorktreeCleanupSeconds
      : d.deletedWorktreeCleanupSeconds,
    projectSwitcherOtherSortMode: isOtherProjectsSortMode(raw.projectSwitcherOtherSortMode)
      ? raw.projectSwitcherOtherSortMode
      : d.projectSwitcherOtherSortMode,
    lastSelectedWorktreeRecipeIdByProject: normalizeRecipeMap(
      raw.lastSelectedWorktreeRecipeIdByProject
    ),
    skipPushConfirmByWorktreePath: normalizeSkipMap(raw.skipPushConfirmByWorktreePath),
    fileBrowserAlwaysHiddenPatterns: sanitizeAlwaysHiddenPatterns(
      raw.fileBrowserAlwaysHiddenPatterns
    ),
    hasSeenActionPalettePrefixHint: coerceBool(
      raw.hasSeenActionPalettePrefixHint,
      d.hasSeenActionPalettePrefixHint
    ),
    keyboardLayoutConfirmationsByBinding: normalizeConfirmationMap(
      raw.keyboardLayoutConfirmationsByBinding
    ),
  };
}

/**
 * Baseline-aware three-way merge for preferences writes across project views
 * (issue #11351). The two id-keyed maps are the primary victims —
 * `lastSelectedWorktreeRecipeIdByProject` (per project) and
 * `skipPushConfirmByWorktreePath` (per worktree path): each view writes its own
 * keys, so a stale whole-snapshot write must not wipe a sibling's entries. Every
 * scalar (and the Settings-edited hidden-patterns list) defers to a sibling's
 * on-disk value unless this writer changed it. Version guards keep the raw
 * (un-migrated) reads from diffing a foreign schema across the v13 migrate chain.
 */
function mergePreferencesPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<PreferencesPersistedState>): StorageValue<PreferencesPersistedState> {
  if (!onDisk || onDisk.version !== incoming.version) return incoming;
  const disk = toPreferencesPersisted(onDisk.state);
  const inc = toPreferencesPersisted(incoming.state);
  if (baseline && typeof baseline.version === "number" && baseline.version !== incoming.version) {
    return { version: incoming.version, state: disk };
  }
  const base = toPreferencesPersisted(baseline?.state);
  return {
    version: incoming.version,
    state: {
      showProjectPulse: pickFieldByWriterDelta(
        base.showProjectPulse,
        inc.showProjectPulse,
        disk.showProjectPulse
      ),
      showDeveloperTools: pickFieldByWriterDelta(
        base.showDeveloperTools,
        inc.showDeveloperTools,
        disk.showDeveloperTools
      ),
      showGridAgentHighlights: pickFieldByWriterDelta(
        base.showGridAgentHighlights,
        inc.showGridAgentHighlights,
        disk.showGridAgentHighlights
      ),
      showAgentTaskTitles: pickFieldByWriterDelta(
        base.showAgentTaskTitles,
        inc.showAgentTaskTitles,
        disk.showAgentTaskTitles
      ),
      showDockAgentHighlights: pickFieldByWriterDelta(
        base.showDockAgentHighlights,
        inc.showDockAgentHighlights,
        disk.showDockAgentHighlights
      ),
      dockDensity: pickFieldByWriterDelta(base.dockDensity, inc.dockDensity, disk.dockDensity),
      assignWorktreeToSelf: pickFieldByWriterDelta(
        base.assignWorktreeToSelf,
        inc.assignWorktreeToSelf,
        disk.assignWorktreeToSelf
      ),
      reduceAnimations: pickFieldByWriterDelta(
        base.reduceAnimations,
        inc.reduceAnimations,
        disk.reduceAnimations
      ),
      diffViewType: pickFieldByWriterDelta(base.diffViewType, inc.diffViewType, disk.diffViewType),
      diffWrapLines: pickFieldByWriterDelta(
        base.diffWrapLines,
        inc.diffWrapLines,
        disk.diffWrapLines
      ),
      diffIgnoreWhitespace: pickFieldByWriterDelta(
        base.diffIgnoreWhitespace,
        inc.diffIgnoreWhitespace,
        disk.diffIgnoreWhitespace
      ),
      diffShowFileList: pickFieldByWriterDelta(
        base.diffShowFileList,
        inc.diffShowFileList,
        disk.diffShowFileList
      ),
      diffFullFile: pickFieldByWriterDelta(base.diffFullFile, inc.diffFullFile, disk.diffFullFile),
      diffFontSize: pickFieldByWriterDelta(base.diffFontSize, inc.diffFontSize, disk.diffFontSize),
      markdownWrapLines: pickFieldByWriterDelta(
        base.markdownWrapLines,
        inc.markdownWrapLines,
        disk.markdownWrapLines
      ),
      deletedWorktreeCleanupSeconds: pickFieldByWriterDelta(
        base.deletedWorktreeCleanupSeconds,
        inc.deletedWorktreeCleanupSeconds,
        disk.deletedWorktreeCleanupSeconds
      ),
      projectSwitcherOtherSortMode: pickFieldByWriterDelta(
        base.projectSwitcherOtherSortMode,
        inc.projectSwitcherOtherSortMode,
        disk.projectSwitcherOtherSortMode
      ),
      lastSelectedWorktreeRecipeIdByProject: mergeRecordByWriterDelta(
        base.lastSelectedWorktreeRecipeIdByProject,
        inc.lastSelectedWorktreeRecipeIdByProject,
        disk.lastSelectedWorktreeRecipeIdByProject
      ),
      skipPushConfirmByWorktreePath: mergeRecordByWriterDelta(
        base.skipPushConfirmByWorktreePath,
        inc.skipPushConfirmByWorktreePath,
        disk.skipPushConfirmByWorktreePath
      ),
      fileBrowserAlwaysHiddenPatterns: pickFieldByWriterDelta(
        base.fileBrowserAlwaysHiddenPatterns,
        inc.fileBrowserAlwaysHiddenPatterns,
        disk.fileBrowserAlwaysHiddenPatterns
      ),
      // A view that hydrated before a sibling marked the hint seen still holds
      // `false`; without the writer-delta guard its next unrelated preference
      // write would hand the user the hint a second time.
      hasSeenActionPalettePrefixHint: pickFieldByWriterDelta(
        base.hasSeenActionPalettePrefixHint,
        inc.hasSeenActionPalettePrefixHint,
        disk.hasSeenActionPalettePrefixHint
      ),
      // Counts rather than independent values, so this one needs the
      // counter-aware merge — see {@link mergeConfirmationCounts}.
      keyboardLayoutConfirmationsByBinding: mergeConfirmationCounts(
        base.keyboardLayoutConfirmationsByBinding,
        inc.keyboardLayoutConfirmationsByBinding,
        disk.keyboardLayoutConfirmationsByBinding
      ),
    },
  };
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      showProjectPulse: true,
      setShowProjectPulse: (show) => set({ showProjectPulse: show }),
      showDeveloperTools: false,
      setShowDeveloperTools: (show) => set({ showDeveloperTools: show }),
      showGridAgentHighlights: false,
      setShowGridAgentHighlights: (show) => set({ showGridAgentHighlights: show }),
      showAgentTaskTitles: true,
      setShowAgentTaskTitles: (show) => set({ showAgentTaskTitles: show }),
      showDockAgentHighlights: false,
      setShowDockAgentHighlights: (show) => set({ showDockAgentHighlights: show }),
      dockDensity: "normal",
      setDockDensity: (density) => set({ dockDensity: density }),
      assignWorktreeToSelf: false,
      setAssignWorktreeToSelf: (value) => set({ assignWorktreeToSelf: value }),
      reduceAnimations: false,
      setReduceAnimations: (value) => set({ reduceAnimations: value }),
      diffViewType: "split",
      setDiffViewType: (value) => set({ diffViewType: value }),
      diffWrapLines: false,
      setDiffWrapLines: (value) => set({ diffWrapLines: value }),
      diffIgnoreWhitespace: false,
      setDiffIgnoreWhitespace: (value) => set({ diffIgnoreWhitespace: value }),
      diffShowFileList: true,
      setDiffShowFileList: (value) => set({ diffShowFileList: value }),
      diffFullFile: false,
      setDiffFullFile: (value) => set({ diffFullFile: value }),
      diffFontSize: "m",
      setDiffFontSize: (value) => set({ diffFontSize: value }),
      markdownWrapLines: true,
      setMarkdownWrapLines: (value) => set({ markdownWrapLines: value }),
      lastSelectedWorktreeRecipeIdByProject: {},
      setLastSelectedWorktreeRecipeIdByProject: (projectId, id) =>
        set((state) => ({
          lastSelectedWorktreeRecipeIdByProject: {
            ...state.lastSelectedWorktreeRecipeIdByProject,
            [projectId]: id,
          },
        })),
      skipPushConfirmByWorktreePath: {},
      setSkipPushConfirmForWorktree: (worktreePath, value) =>
        set((state) => {
          if (value) {
            return {
              skipPushConfirmByWorktreePath: {
                ...state.skipPushConfirmByWorktreePath,
                [worktreePath]: true,
              },
            };
          }
          // Drop the key when clearing so the record doesn't accumulate
          // `false` entries on every confirm-without-opt-out.
          if (state.skipPushConfirmByWorktreePath[worktreePath] === undefined) {
            return state;
          }
          const { [worktreePath]: _removed, ...rest } = state.skipPushConfirmByWorktreePath;
          return { skipPushConfirmByWorktreePath: rest };
        }),
      deletedWorktreeCleanupSeconds: DELETED_WORKTREE_CLEANUP_DEFAULT,
      setDeletedWorktreeCleanupSeconds: (value) => set({ deletedWorktreeCleanupSeconds: value }),
      projectSwitcherOtherSortMode: DEFAULT_OTHER_PROJECTS_SORT_MODE,
      setProjectSwitcherOtherSortMode: (mode) => set({ projectSwitcherOtherSortMode: mode }),
      fileBrowserAlwaysHiddenPatterns: [...DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN],
      setFileBrowserAlwaysHiddenPatterns: (patterns) =>
        set({ fileBrowserAlwaysHiddenPatterns: sanitizeAlwaysHiddenPatterns(patterns) }),
      resetFileBrowserAlwaysHiddenPatterns: () =>
        set({ fileBrowserAlwaysHiddenPatterns: [...DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN] }),
      hasSeenActionPalettePrefixHint: false,
      markActionPalettePrefixHintSeen: () => set({ hasSeenActionPalettePrefixHint: true }),
      keyboardLayoutConfirmationsByBinding: {},
      recordKeyboardLayoutConfirmation: (actionId, combo) =>
        set((state) => {
          const key = keyboardLayoutBindingKey(actionId, combo);
          const current = state.keyboardLayoutConfirmationsByBinding[key] ?? 0;
          if (current >= KEYBOARD_LAYOUT_CONFIRMATION_LIMIT) return state;
          // One entry per action: a rebind supersedes the old combo's tally
          // instead of leaving it to accumulate in persisted JSON forever.
          const prefix = `${actionId}@`;
          const next: Record<string, number> = {};
          for (const [existing, count] of Object.entries(
            state.keyboardLayoutConfirmationsByBinding
          )) {
            if (!existing.startsWith(prefix)) next[existing] = count;
          }
          next[key] = current + 1;
          return { keyboardLayoutConfirmationsByBinding: next };
        }),
      clearKeyboardLayoutConfirmations: (actionId) =>
        set((state) => {
          const prefix = `${actionId}@`;
          const next: Record<string, number> = {};
          let removed = false;
          for (const [existing, count] of Object.entries(
            state.keyboardLayoutConfirmationsByBinding
          )) {
            if (existing.startsWith(prefix)) removed = true;
            else next[existing] = count;
          }
          if (!removed) return state;
          return { keyboardLayoutConfirmationsByBinding: next };
        }),
    }),
    {
      name: "daintree-preferences",
      storage: createSafeJSONStorage<PreferencesPersistedState>({
        mergeOnWrite: mergePreferencesPersistedWrite,
      }),
      version: 16,
      // Explicit persisted subset — matches the pre-existing default (setters are
      // dropped by JSON serialization); named so the write merge (#11351) has a
      // typed persisted shape to reconcile.
      partialize: (state): PreferencesPersistedState => ({
        showProjectPulse: state.showProjectPulse,
        showDeveloperTools: state.showDeveloperTools,
        showGridAgentHighlights: state.showGridAgentHighlights,
        showAgentTaskTitles: state.showAgentTaskTitles,
        showDockAgentHighlights: state.showDockAgentHighlights,
        dockDensity: state.dockDensity,
        assignWorktreeToSelf: state.assignWorktreeToSelf,
        reduceAnimations: state.reduceAnimations,
        diffViewType: state.diffViewType,
        diffWrapLines: state.diffWrapLines,
        diffIgnoreWhitespace: state.diffIgnoreWhitespace,
        diffShowFileList: state.diffShowFileList,
        diffFullFile: state.diffFullFile,
        diffFontSize: state.diffFontSize,
        markdownWrapLines: state.markdownWrapLines,
        deletedWorktreeCleanupSeconds: state.deletedWorktreeCleanupSeconds,
        projectSwitcherOtherSortMode: state.projectSwitcherOtherSortMode,
        lastSelectedWorktreeRecipeIdByProject: state.lastSelectedWorktreeRecipeIdByProject,
        skipPushConfirmByWorktreePath: state.skipPushConfirmByWorktreePath,
        fileBrowserAlwaysHiddenPatterns: state.fileBrowserAlwaysHiddenPatterns,
        hasSeenActionPalettePrefixHint: state.hasSeenActionPalettePrefixHint,
        keyboardLayoutConfirmationsByBinding: state.keyboardLayoutConfirmationsByBinding,
      }),
      // Runs on every hydration (unlike `migrate`, which Zustand skips when the
      // persisted version matches). Closed-set normalisation lives here so a
      // corrupt-but-parseable value is clamped even at the current version.
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersistedPreferences(persisted as Partial<PreferencesState> | undefined | null),
      }),
      migrate: (persisted, version) => {
        if (version === 0 || version === undefined) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            delete state.lastSelectedWorktreeRecipeId;
            state.lastSelectedWorktreeRecipeIdByProject = {};
          } else {
            return { lastSelectedWorktreeRecipeIdByProject: {} } as PreferencesState;
          }
        }
        if (version < 2) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.showGridAgentHighlights ??= false;
            state.showDockAgentHighlights ??= false;
          }
        }
        if (version < 3) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.dockDensity ??= "normal";
          }
        }
        if (version < 4) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            state.reduceAnimations ??= false;
          }
        }
        if (version < 6) {
          // skipWorkingCloseConfirm was retired with the close-confirm dialog
          // (issue #6920). Drop the field so persisted state matches the
          // current schema.
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            delete state.skipWorkingCloseConfirm;
          }
        }
        if (version < 7) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            // Validate against the closed set rather than `??=` so a corrupt
            // value (e.g. hand-edited `"side-by-side"`) is normalised.
            if (state.diffViewType !== "split" && state.diffViewType !== "unified") {
              state.diffViewType = "split";
            }
          }
        }
        if (version < 8) {
          // Issue #7979 — dockDensity is now exposed in the dock context menu's
          // radio group, so a corrupt persisted value (e.g. hand-edited
          // "dense") would leave the radio with no checked item and apply an
          // unknown CSS data attribute. Validate against the closed set.
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            if (
              state.dockDensity !== "compact" &&
              state.dockDensity !== "normal" &&
              state.dockDensity !== "comfortable"
            ) {
              state.dockDensity = "normal";
            }
          }
        }
        if (version < 9) {
          if (persisted && typeof persisted === "object") {
            const state = persisted as Record<string, unknown>;
            // Validate the record shape rather than just `??=` so a corrupt
            // value (e.g. hand-edited array or string) is normalised. A
            // truthy string would otherwise bypass the confirm gate.
            const current = state.skipPushConfirmByWorktreePath;
            const validated: Record<string, boolean> = {};
            if (current !== null && typeof current === "object" && !Array.isArray(current)) {
              for (const [key, value] of Object.entries(current)) {
                if (typeof value === "boolean") validated[key] = value;
              }
            }
            state.skipPushConfirmByWorktreePath = validated;
          }
        }
        if (version < 10 && isRecord(persisted)) {
          if (typeof persisted.diffWrapLines !== "boolean") persisted.diffWrapLines = false;
          if (typeof persisted.diffIgnoreWhitespace !== "boolean") {
            persisted.diffIgnoreWhitespace = false;
          }
        }
        if (version < 11 && isRecord(persisted)) {
          if (typeof persisted.showAgentTaskTitles !== "boolean") {
            persisted.showAgentTaskTitles = true;
          }
        }
        if (version < 12 && isRecord(persisted)) {
          if (typeof persisted.diffShowFileList !== "boolean") persisted.diffShowFileList = true;
          if (!isDiffFontSize(persisted.diffFontSize)) persisted.diffFontSize = "m";
        }
        if (version < 13 && isRecord(persisted)) {
          if (!isDeletedWorktreeCleanupSeconds(persisted.deletedWorktreeCleanupSeconds)) {
            persisted.deletedWorktreeCleanupSeconds = DELETED_WORKTREE_CLEANUP_DEFAULT;
          }
        }
        if (version < 14 && isRecord(persisted)) {
          if (!isOtherProjectsSortMode(persisted.projectSwitcherOtherSortMode)) {
            persisted.projectSwitcherOtherSortMode = DEFAULT_OTHER_PROJECTS_SORT_MODE;
          }
        }
        if (version < 15 && isRecord(persisted)) {
          // Existing users have never been shown the decaying prefix hint, so
          // they get their one showing on the next action-palette open rather
          // than inheriting "seen" from an absent key.
          if (typeof persisted.hasSeenActionPalettePrefixHint !== "boolean") {
            persisted.hasSeenActionPalettePrefixHint = false;
          }
        }
        if (version < 16 && isRecord(persisted)) {
          // Nobody has confirmed a keyboard layout change before this shipped,
          // so everyone starts with the full allowance rather than inheriting
          // silence from an absent key (#11704).
          if (!isRecord(persisted.keyboardLayoutConfirmationsByBinding)) {
            persisted.keyboardLayoutConfirmationsByBinding = {};
          }
        }
        return persisted as PreferencesState;
      },
    }
  )
);

registerPersistedStore({
  storeId: "preferencesStore",
  store: usePreferencesStore,
  persistedStateType:
    "{ showProjectPulse: boolean; showDeveloperTools: boolean; showGridAgentHighlights: boolean; showDockAgentHighlights: boolean; showAgentTaskTitles: boolean; dockDensity: DockDensity; assignWorktreeToSelf: boolean; reduceAnimations: boolean; diffViewType: DiffViewType; diffWrapLines: boolean; diffIgnoreWhitespace: boolean; diffShowFileList: boolean; diffFullFile: boolean; diffFontSize: DiffFontSize; markdownWrapLines: boolean; lastSelectedWorktreeRecipeIdByProject: Record<string, string | null | undefined>; skipPushConfirmByWorktreePath: Record<string, boolean>; deletedWorktreeCleanupSeconds: DeletedWorktreeCleanupSeconds; projectSwitcherOtherSortMode: OtherProjectsSortMode; fileBrowserAlwaysHiddenPatterns: string[]; hasSeenActionPalettePrefixHint: boolean; keyboardLayoutConfirmationsByBinding: Record<string, number> }",
});
