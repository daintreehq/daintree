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

/**
 * Diff soft-wrap: `null` means "derive it from the file", a boolean is an
 * explicit user override. Modelled as a nullable boolean rather than an
 * `"auto" | "on" | "off"` enum because every consumer resolves it to a plain
 * boolean anyway — `?? isProseFilePath(path)` is the whole translation, where
 * an enum would need mapping at each of the three call sites for no added
 * behaviour.
 */
export type DiffWrapPreference = boolean | null;

/**
 * Reading scale for rendered markdown, in reading order. The stepper walks this
 * and the persistence guard checks against it, and the type below is DERIVED
 * from it so the ladder is the single place a rung is declared — a rung added
 * to the type alone would be inert, accepted by nothing and reachable by no
 * step.
 *
 * Denser near the 14px base where a reader adjusts by feel, wider at the top
 * where a step has to be worth taking: 11 · 12 · 14 · 16 · 18 · 20 · 24 · 30.
 */
export const MARKDOWN_FONT_SIZE_STEPS = [
  "2xs",
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
] as const;

/**
 * A rung of the shared type scale, named rather than measured. Same reasoning
 * as `DIFF_FONT_SIZE`'s S/M/L: a preference that stores its own number stops
 * tracking the scale the moment the scale moves, and a stored index changes
 * meaning the moment a rung is inserted. A rung name survives both.
 */
export type MarkdownFontSize = (typeof MARKDOWN_FONT_SIZE_STEPS)[number];

/** Today's rendered-markdown scale, so an upgrade changes nothing until asked. */
export const DEFAULT_MARKDOWN_FONT_SIZE: MarkdownFontSize = "sm";

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
  /** Tapping Shift twice opens Canopy, from anywhere including a terminal. */
  doubleShiftOpensCanopy: boolean;
  setDoubleShiftOpensCanopy: (value: boolean) => void;
  diffViewType: DiffViewType;
  setDiffViewType: (value: DiffViewType) => void;
  /**
   * Soft-wrap long lines in diffs. `null` is auto: prose extensions wrap,
   * everything else doesn't (see `isProseFilePath`). A boolean is an explicit
   * override the user set from a toolbar toggle, and it applies to every file
   * until they flip it back — global and sticky, like every desktop diff tool
   * (#12170). Hosts resolve it per file; `DiffViewer` only ever sees a boolean.
   */
  diffWrapLines: DiffWrapPreference;
  setDiffWrapLines: (value: boolean) => void;
  /**
   * Show Markdown diffs as a rendered document rather than as source (#12171).
   * Deliberately NOT a third `DiffViewType`: that union is a layout for the
   * source diff and is read by surfaces (the file panel, the cross-worktree
   * diff) that render no such mode. Keeping it a separate flag also preserves
   * the user's Unified/Split choice across a round trip through rendered mode.
   */
  diffMarkdownRendered: boolean;
  setDiffMarkdownRendered: (value: boolean) => void;
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
  /**
   * Reading scale for RENDERED markdown, shared by every surface that shows a
   * document (file panel, file browser). One app-level value on purpose: a
   * per-file or per-panel size makes paging through documents feel unstable.
   */
  markdownFontSize: MarkdownFontSize;
  setMarkdownFontSize: (value: MarkdownFontSize) => void;
  lastSelectedWorktreeRecipeIdByProject: Record<string, string | null | undefined>;
  setLastSelectedWorktreeRecipeIdByProject: (
    projectId: string,
    id: string | null | undefined
  ) => void;
  /** Agent last chosen to start in a new worktree, per project. `null` = none. */
  lastSelectedWorktreeAgentIdByProject: Record<string, string | null | undefined>;
  setLastSelectedWorktreeAgentIdByProject: (projectId: string, id: string | null) => void;
  skipPushConfirmByWorktreePath: Record<string, boolean>;
  setSkipPushConfirmForWorktree: (worktreePath: string, value: boolean) => void;
  /**
   * How long a deleted worktree's row holds its surviving terminals before
   * they are moved to trash automatically. The countdown runs in real time
   * while the project view is on screen and five times slower while it is
   * cached or the window is hidden, and holds — for a bounded stretch — while
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
  /**
   * Which project-switcher bands the user has folded away, keyed by band
   * ({@link PROJECT_SECTION_ORDER}'s members plus `"scratch"`). Global for the
   * same reason the sort mode above is: it names how the user reads their whole
   * project set (#11943).
   *
   * Keys are free-form strings rather than the band union, matching
   * `skipPushConfirmByWorktreePath`. Typing them would mean importing the
   * palette hook's `ProjectSectionKey` into the store, and a band that is later
   * renamed leaves an inert unused entry either way — which is what
   * `persistWriteMerge` is built to tolerate.
   *
   * Unlike the skip map, an entry is NEVER dropped for looking like a default.
   * Absent and `false` are different facts here: Scratch's default is dynamic
   * (collapsed only while it is empty), so deleting the key on expand would
   * silently re-collapse it on the next open. Storing the explicit boolean is
   * what makes "the user has chosen" outlive the condition that set the
   * default — and at eight possible keys there is nothing to garbage-collect.
   */
  projectSwitcherCollapsedBands: Record<string, boolean>;
  setProjectSwitcherBandCollapsed: (bandKey: string, collapsed: boolean) => void;
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

function isDiffWrapPreference(value: unknown): value is DiffWrapPreference {
  return value === null || typeof value === "boolean";
}

function isMarkdownFontSize(value: unknown): value is MarkdownFontSize {
  // `some` rather than `includes`: the latter narrows its argument to the
  // tuple's own type, so it would need an assertion here to accept `unknown`.
  return MARKDOWN_FONT_SIZE_STEPS.some((step) => step === value);
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
  if (!isDiffWrapPreference(sanitized.diffWrapLines)) sanitized.diffWrapLines = null;
  if (typeof sanitized.diffMarkdownRendered !== "boolean") sanitized.diffMarkdownRendered = false;
  if (typeof sanitized.diffIgnoreWhitespace !== "boolean") sanitized.diffIgnoreWhitespace = false;
  if (typeof sanitized.diffShowFileList !== "boolean") sanitized.diffShowFileList = true;
  if (typeof sanitized.diffFullFile !== "boolean") sanitized.diffFullFile = false;
  if (!isDiffFontSize(sanitized.diffFontSize)) sanitized.diffFontSize = "m";
  if (typeof sanitized.markdownWrapLines !== "boolean") sanitized.markdownWrapLines = true;
  if (!isMarkdownFontSize(sanitized.markdownFontSize)) {
    sanitized.markdownFontSize = DEFAULT_MARKDOWN_FONT_SIZE;
  }
  if (typeof sanitized.showAgentTaskTitles !== "boolean") sanitized.showAgentTaskTitles = true;
  if (typeof sanitized.doubleShiftOpensCanopy !== "boolean") {
    sanitized.doubleShiftOpensCanopy = true;
  }
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
  sanitized.skipPushConfirmByWorktreePath = normalizeBooleanMap(
    sanitized.skipPushConfirmByWorktreePath
  );

  // Same hazard in the other direction: a hand-edited string would read as
  // "collapsed" for every band and leave the switcher looking empty.
  sanitized.projectSwitcherCollapsedBands = normalizeBooleanMap(
    sanitized.projectSwitcherCollapsedBands
  );

  sanitized.lastSelectedWorktreeAgentIdByProject = normalizeRecipeMap(
    sanitized.lastSelectedWorktreeAgentIdByProject
  );

  // A non-boolean here would be truthy for any hand-edited string, retiring the
  // hint for a user who never saw it.
  if (typeof sanitized.hasSeenActionPalettePrefixHint !== "boolean") {
    sanitized.hasSeenActionPalettePrefixHint = false;
  }

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
  | "doubleShiftOpensCanopy"
  | "diffViewType"
  | "diffWrapLines"
  | "diffMarkdownRendered"
  | "diffIgnoreWhitespace"
  | "diffShowFileList"
  | "diffFullFile"
  | "diffFontSize"
  | "markdownWrapLines"
  | "markdownFontSize"
  | "deletedWorktreeCleanupSeconds"
  | "projectSwitcherOtherSortMode"
  | "projectSwitcherCollapsedBands"
  | "lastSelectedWorktreeRecipeIdByProject"
  | "lastSelectedWorktreeAgentIdByProject"
  | "skipPushConfirmByWorktreePath"
  | "fileBrowserAlwaysHiddenPatterns"
  | "hasSeenActionPalettePrefixHint"
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
  doubleShiftOpensCanopy: true,
  diffViewType: "split",
  diffWrapLines: null,
  diffMarkdownRendered: false,
  diffIgnoreWhitespace: false,
  diffShowFileList: true,
  diffFullFile: false,
  diffFontSize: "m",
  markdownWrapLines: true,
  markdownFontSize: DEFAULT_MARKDOWN_FONT_SIZE,
  deletedWorktreeCleanupSeconds: DELETED_WORKTREE_CLEANUP_DEFAULT,
  projectSwitcherOtherSortMode: DEFAULT_OTHER_PROJECTS_SORT_MODE,
  projectSwitcherCollapsedBands: {},
  lastSelectedWorktreeRecipeIdByProject: {},
  lastSelectedWorktreeAgentIdByProject: {},
  skipPushConfirmByWorktreePath: {},
  fileBrowserAlwaysHiddenPatterns: [...DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN],
  hasSeenActionPalettePrefixHint: false,
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

/**
 * Keep only the boolean-valued keys of a persisted string→boolean map. Shared
 * by every such field: a non-boolean entry is dropped rather than coerced,
 * because a hand-edited string is truthy and would flip the flag on.
 */
function normalizeBooleanMap(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") result[key] = entry;
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
    doubleShiftOpensCanopy: coerceBool(raw.doubleShiftOpensCanopy, d.doubleShiftOpensCanopy),
    diffViewType: isDiffViewType(raw.diffViewType) ? raw.diffViewType : d.diffViewType,
    diffWrapLines: isDiffWrapPreference(raw.diffWrapLines) ? raw.diffWrapLines : d.diffWrapLines,
    diffMarkdownRendered: coerceBool(raw.diffMarkdownRendered, d.diffMarkdownRendered),
    diffIgnoreWhitespace: coerceBool(raw.diffIgnoreWhitespace, d.diffIgnoreWhitespace),
    diffShowFileList: coerceBool(raw.diffShowFileList, d.diffShowFileList),
    diffFullFile: coerceBool(raw.diffFullFile, d.diffFullFile),
    diffFontSize: isDiffFontSize(raw.diffFontSize) ? raw.diffFontSize : d.diffFontSize,
    markdownWrapLines: coerceBool(raw.markdownWrapLines, d.markdownWrapLines),
    markdownFontSize: isMarkdownFontSize(raw.markdownFontSize)
      ? raw.markdownFontSize
      : d.markdownFontSize,
    deletedWorktreeCleanupSeconds: isDeletedWorktreeCleanupSeconds(
      raw.deletedWorktreeCleanupSeconds
    )
      ? raw.deletedWorktreeCleanupSeconds
      : d.deletedWorktreeCleanupSeconds,
    projectSwitcherOtherSortMode: isOtherProjectsSortMode(raw.projectSwitcherOtherSortMode)
      ? raw.projectSwitcherOtherSortMode
      : d.projectSwitcherOtherSortMode,
    projectSwitcherCollapsedBands: normalizeBooleanMap(raw.projectSwitcherCollapsedBands),
    lastSelectedWorktreeRecipeIdByProject: normalizeRecipeMap(
      raw.lastSelectedWorktreeRecipeIdByProject
    ),
    lastSelectedWorktreeAgentIdByProject: normalizeRecipeMap(
      raw.lastSelectedWorktreeAgentIdByProject
    ),
    skipPushConfirmByWorktreePath: normalizeBooleanMap(raw.skipPushConfirmByWorktreePath),
    fileBrowserAlwaysHiddenPatterns: sanitizeAlwaysHiddenPatterns(
      raw.fileBrowserAlwaysHiddenPatterns
    ),
    hasSeenActionPalettePrefixHint: coerceBool(
      raw.hasSeenActionPalettePrefixHint,
      d.hasSeenActionPalettePrefixHint
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
      doubleShiftOpensCanopy: pickFieldByWriterDelta(
        base.doubleShiftOpensCanopy,
        inc.doubleShiftOpensCanopy,
        disk.doubleShiftOpensCanopy
      ),
      diffViewType: pickFieldByWriterDelta(base.diffViewType, inc.diffViewType, disk.diffViewType),
      diffWrapLines: pickFieldByWriterDelta(
        base.diffWrapLines,
        inc.diffWrapLines,
        disk.diffWrapLines
      ),
      diffMarkdownRendered: pickFieldByWriterDelta(
        base.diffMarkdownRendered,
        inc.diffMarkdownRendered,
        disk.diffMarkdownRendered
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
      markdownFontSize: pickFieldByWriterDelta(
        base.markdownFontSize,
        inc.markdownFontSize,
        disk.markdownFontSize
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
      // Per-key, not whole-field: two project views each folding a different
      // band must both survive, and a stale view's snapshot must not carry its
      // hydration-time copy of a band the sibling has since toggled.
      projectSwitcherCollapsedBands: mergeRecordByWriterDelta(
        base.projectSwitcherCollapsedBands,
        inc.projectSwitcherCollapsedBands,
        disk.projectSwitcherCollapsedBands
      ),
      lastSelectedWorktreeRecipeIdByProject: mergeRecordByWriterDelta(
        base.lastSelectedWorktreeRecipeIdByProject,
        inc.lastSelectedWorktreeRecipeIdByProject,
        disk.lastSelectedWorktreeRecipeIdByProject
      ),
      lastSelectedWorktreeAgentIdByProject: mergeRecordByWriterDelta(
        base.lastSelectedWorktreeAgentIdByProject,
        inc.lastSelectedWorktreeAgentIdByProject,
        disk.lastSelectedWorktreeAgentIdByProject
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
      doubleShiftOpensCanopy: true,
      setDoubleShiftOpensCanopy: (value) => set({ doubleShiftOpensCanopy: value }),
      diffViewType: "split",
      setDiffViewType: (value) => set({ diffViewType: value }),
      diffWrapLines: null,
      setDiffWrapLines: (value) => set({ diffWrapLines: value }),
      diffMarkdownRendered: false,
      setDiffMarkdownRendered: (value) => set({ diffMarkdownRendered: value }),
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
      markdownFontSize: DEFAULT_MARKDOWN_FONT_SIZE,
      setMarkdownFontSize: (value) => set({ markdownFontSize: value }),
      lastSelectedWorktreeRecipeIdByProject: {},
      setLastSelectedWorktreeRecipeIdByProject: (projectId, id) =>
        set((state) => ({
          lastSelectedWorktreeRecipeIdByProject: {
            ...state.lastSelectedWorktreeRecipeIdByProject,
            [projectId]: id,
          },
        })),
      lastSelectedWorktreeAgentIdByProject: {},
      setLastSelectedWorktreeAgentIdByProject: (projectId, id) =>
        set((state) => ({
          lastSelectedWorktreeAgentIdByProject: {
            ...state.lastSelectedWorktreeAgentIdByProject,
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
      projectSwitcherCollapsedBands: {},
      // Writes the boolean either way — see the field's note on why an expanded
      // band is stored rather than deleted.
      setProjectSwitcherBandCollapsed: (bandKey, collapsed) =>
        set((state) => {
          if (state.projectSwitcherCollapsedBands[bandKey] === collapsed) return state;
          return {
            projectSwitcherCollapsedBands: {
              ...state.projectSwitcherCollapsedBands,
              [bandKey]: collapsed,
            },
          };
        }),
      fileBrowserAlwaysHiddenPatterns: [...DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN],
      setFileBrowserAlwaysHiddenPatterns: (patterns) =>
        set({ fileBrowserAlwaysHiddenPatterns: sanitizeAlwaysHiddenPatterns(patterns) }),
      resetFileBrowserAlwaysHiddenPatterns: () =>
        set({ fileBrowserAlwaysHiddenPatterns: [...DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN] }),
      hasSeenActionPalettePrefixHint: false,
      markActionPalettePrefixHintSeen: () => set({ hasSeenActionPalettePrefixHint: true }),
    }),
    {
      name: "daintree-preferences",
      storage: createSafeJSONStorage<PreferencesPersistedState>({
        mergeOnWrite: mergePreferencesPersistedWrite,
      }),
      version: 20,
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
        doubleShiftOpensCanopy: state.doubleShiftOpensCanopy,
        diffViewType: state.diffViewType,
        diffWrapLines: state.diffWrapLines,
        diffMarkdownRendered: state.diffMarkdownRendered,
        diffIgnoreWhitespace: state.diffIgnoreWhitespace,
        diffShowFileList: state.diffShowFileList,
        diffFullFile: state.diffFullFile,
        diffFontSize: state.diffFontSize,
        markdownWrapLines: state.markdownWrapLines,
        markdownFontSize: state.markdownFontSize,
        deletedWorktreeCleanupSeconds: state.deletedWorktreeCleanupSeconds,
        projectSwitcherOtherSortMode: state.projectSwitcherOtherSortMode,
        projectSwitcherCollapsedBands: state.projectSwitcherCollapsedBands,
        lastSelectedWorktreeRecipeIdByProject: state.lastSelectedWorktreeRecipeIdByProject,
        lastSelectedWorktreeAgentIdByProject: state.lastSelectedWorktreeAgentIdByProject,
        skipPushConfirmByWorktreePath: state.skipPushConfirmByWorktreePath,
        fileBrowserAlwaysHiddenPatterns: state.fileBrowserAlwaysHiddenPatterns,
        hasSeenActionPalettePrefixHint: state.hasSeenActionPalettePrefixHint,
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
        if (version < 17 && isRecord(persisted)) {
          // Only Scratch could be folded before this shipped, and it never
          // persisted, so everyone starts with every band open (#11943).
          if (!isRecord(persisted.projectSwitcherCollapsedBands)) {
            persisted.projectSwitcherCollapsedBands = {};
          }
        }
        if (version < 18 && isRecord(persisted)) {
          // Rendered markdown had no reading control before this shipped, so
          // everyone starts on the rung it has always rendered at (#12134).
          if (!isMarkdownFontSize(persisted.markdownFontSize)) {
            persisted.markdownFontSize = DEFAULT_MARKDOWN_FONT_SIZE;
          }
        }
        if (version < 19 && isRecord(persisted)) {
          // Wrap gained an auto mode, so the old boolean has to be reinterpreted
          // (#12170). Only `true` survives: it could only ever have come from a
          // deliberate toggle, since `false` was the default. A stored `false`
          // is genuinely ambiguous — the store persists the whole default
          // snapshot and keeps no per-field provenance, so "never touched it"
          // and "turned it on, then off again" are the same bytes on disk. This
          // maps both to auto, which reads the ambiguity in favour of shipping
          // the new prose default to existing installs rather than leaving it
          // to new ones.
          persisted.diffWrapLines = persisted.diffWrapLines === true ? true : null;
        }
        if (version < 20 && isRecord(persisted)) {
          // The rendered Markdown layout is new, so nobody has an opinion yet
          // and everyone opens on the source diff they already had (#12171).
          if (typeof persisted.diffMarkdownRendered !== "boolean") {
            persisted.diffMarkdownRendered = false;
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
    "{ showProjectPulse: boolean; showDeveloperTools: boolean; showGridAgentHighlights: boolean; showDockAgentHighlights: boolean; showAgentTaskTitles: boolean; dockDensity: DockDensity; assignWorktreeToSelf: boolean; reduceAnimations: boolean; doubleShiftOpensCanopy: boolean; diffViewType: DiffViewType; diffWrapLines: boolean | null; diffMarkdownRendered: boolean; diffIgnoreWhitespace: boolean; diffShowFileList: boolean; diffFullFile: boolean; diffFontSize: DiffFontSize; markdownWrapLines: boolean; markdownFontSize: MarkdownFontSize; lastSelectedWorktreeRecipeIdByProject: Record<string, string | null | undefined>; lastSelectedWorktreeAgentIdByProject: Record<string, string | null | undefined>; skipPushConfirmByWorktreePath: Record<string, boolean>; deletedWorktreeCleanupSeconds: DeletedWorktreeCleanupSeconds; projectSwitcherOtherSortMode: OtherProjectsSortMode; projectSwitcherCollapsedBands: Record<string, boolean>; fileBrowserAlwaysHiddenPatterns: string[]; hasSeenActionPalettePrefixHint: boolean }",
});

// Turning double-Shift off in one project view must reach every other view at
// once: it is the switch for people it fires on by accident, and each view
// otherwise keeps the value it loaded until it reloads.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== "daintree-preferences") return;
    // What the store holds now, not what the event carried: events queue, and
    // an older one must not undo a newer change.
    let enabled: unknown;
    try {
      const latest = window.localStorage.getItem("daintree-preferences");
      if (latest === null) return;
      enabled = (JSON.parse(latest) as { state?: { doubleShiftOpensCanopy?: unknown } }).state
        ?.doubleShiftOpensCanopy;
    } catch {
      return;
    }
    if (
      typeof enabled === "boolean" &&
      enabled !== usePreferencesStore.getState().doubleShiftOpensCanopy
    ) {
      usePreferencesStore.setState({ doubleShiftOpensCanopy: enabled });
    }
  });
}
