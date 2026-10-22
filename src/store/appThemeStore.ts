import { create } from "zustand";
import { DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import {
  applyAccentOverrideToScheme,
  getAppThemeById,
  isPluginThemeId,
  readPluginThemeSnapshot,
  resolveAppTheme,
  type AppColorScheme,
  type ProjectThemeChoice,
} from "@shared/theme";
import type { ColorVisionMode } from "@shared/types";
import { applyAppThemeToRoot, applyColorVisionMode } from "@/theme/applyAppTheme";
import { selectSelectableSchemes } from "@/theme/selectableSchemes";
import { runThemeCrossfade } from "@/lib/appThemeViewTransition";

const RECENT_SCHEMES_LIMIT = 5;

interface AppThemeState {
  selectedSchemeId: string;
  customSchemes: AppColorScheme[];
  /** Themes installed plugins offer, as main last published them (#13832). */
  pluginSchemes: AppColorScheme[];
  /**
   * The selected theme when it is a plugin's, kept so it still resolves while
   * the catalog lacks it: at boot before plugins load (seeded from the persisted
   * snapshot) and between a reload's unload and load. Null otherwise, so a
   * theme the user moved off can't linger as selectable once its plugin goes.
   */
  pluginSnapshotScheme: AppColorScheme | null;
  /**
   * The theme this view's project shows instead of the global one (#13833), or
   * null when it follows the global selection. `selectedSchemeId` stays the
   * global selection either way, so the global pickers keep editing it.
   */
  projectSchemeId: string | null;
  /** The project's plugin theme from its persisted snapshot, while the catalog lacks it. */
  projectSnapshotScheme: AppColorScheme | null;
  colorVisionMode: ColorVisionMode;
  followSystem: boolean;
  preferredDarkSchemeId: string;
  preferredLightSchemeId: string;
  recentSchemeIds: string[];
  accentColorOverride: string | null;
  previewSchemeId: string | null;
  setPreviewSchemeId: (id: string | null) => void;
  setSelectedSchemeId: (id: string) => void;
  /**
   * Updates Zustand state for a deliberate scheme selection (selectedSchemeId
   * + recentSchemeIds LRU) WITHOUT touching the DOM. The caller is responsible
   * for invoking `injectSchemeToDOM` separately — this split exists so the DOM
   * mutation can be wrapped in a View Transition (see `runThemeReveal`).
   */
  commitSchemeSelection: (id: string) => void;
  /**
   * Like setSelectedSchemeId, but does NOT update recentSchemeIds. Used for
   * OS-driven follow-system changes and startup hydration, where the change
   * does not reflect direct user intent.
   *
   * Pass `{ crossfade: true }` when the app has already painted the outgoing
   * theme (OS appearance switch, first-run auto-select) so the swap fades
   * rather than cutting. Startup hydration leaves it unset on purpose — there
   * is no prior theme to fade from, only the placeholder default.
   *
   * `fallbackType` picks the built-in used when `id` names no scheme; both
   * callers resolve persisted or OS-chosen ids, which can outlive their scheme.
   */
  setSelectedSchemeIdSilent: (
    id: string,
    opts?: { crossfade?: boolean; fallbackType?: AppColorScheme["type"] }
  ) => void;
  /**
   * Replace the plugin theme catalog. When the selected theme is a plugin's,
   * it is repainted, since a plugin update can change its palette.
   */
  setPluginSchemes: (schemes: AppColorScheme[]) => void;
  /**
   * Main replaced the selected plugin theme because nothing offers it any more:
   * move to `schemeId` and forget the vanished theme.
   */
  applyPluginThemeFallback: (schemeId: string) => void;
  /**
   * This view's project's own theme changed, or arrived at boot. Pass
   * `{ crossfade: true }` when the outgoing theme is already on screen.
   */
  setProjectTheme: (choice: ProjectThemeChoice | null, opts?: { crossfade?: boolean }) => void;
  addCustomScheme: (scheme: AppColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  injectTheme: (scheme: AppColorScheme) => void;
  setColorVisionMode: (mode: ColorVisionMode) => void;
  setFollowSystem: (enabled: boolean) => void;
  setPreferredDarkSchemeId: (id: string) => void;
  setPreferredLightSchemeId: (id: string) => void;
  setRecentSchemeIds: (ids: string[]) => void;
  setAccentColorOverride: (color: string | null) => void;
}

/** What `pluginSnapshotScheme` holds once `scheme` is the selection. */
function retainedPluginScheme(scheme: AppColorScheme): AppColorScheme | null {
  return scheme.plugin ? scheme : null;
}

type CommittedSchemeSources = Pick<
  AppThemeState,
  | "selectedSchemeId"
  | "customSchemes"
  | "pluginSchemes"
  | "pluginSnapshotScheme"
  | "projectSchemeId"
  | "projectSnapshotScheme"
>;

/**
 * The project's own theme when it has one that resolves. One that does not —
 * an imported theme since deleted, a plugin theme whose plugin is gone — shows
 * the global theme instead and comes back if its theme does.
 */
function resolveProjectScheme(state: CommittedSchemeSources): AppColorScheme | null {
  const id = state.projectSchemeId;
  if (!id) return null;
  const snapshot = state.projectSnapshotScheme;
  return (
    getAppThemeById(id, selectSelectableSchemes(state)) ?? (snapshot?.id === id ? snapshot : null)
  );
}

/**
 * The scheme this view paints when no preview holds the DOM: its project's own
 * theme, else the global selection. Colour vision and the accent override are
 * applied on top of whichever it is.
 */
export function resolveCommittedScheme(state: CommittedSchemeSources): AppColorScheme {
  return (
    resolveProjectScheme(state) ??
    resolveAppTheme(state.selectedSchemeId, selectSelectableSchemes(state))
  );
}

let pendingScheme: AppColorScheme | null = null;
let pendingFrame: number | null = null;

// Monotonic "latest theme intent". A crossfade's DOM write is deferred to a View
// Transition callback a frame later, by which time a newer write (deliberate pick,
// hover preview, accent change) may have superseded it. Claiming an intent up front
// lets that stale callback recognise it lost and bail — critical because its
// `{ immediate: true }` write would otherwise CANCEL the newer write's pending RAF
// and strand the DOM out of sync with the store.
let themeIntentSeq = 0;

function claimThemeIntent(): number {
  return ++themeIntentSeq;
}

function applySchemeToDOMNow(scheme: AppColorScheme): void {
  const { colorVisionMode, accentColorOverride } = useAppThemeStore.getState();
  const effective = applyAccentOverrideToScheme(scheme, accentColorOverride);
  applyAppThemeToRoot(document.documentElement, effective);
  if (colorVisionMode !== "default") {
    applyColorVisionMode(document.documentElement, colorVisionMode, effective);
  }
}

/**
 * Inject a scheme's CSS custom properties into the DOM. By default, mutations
 * are RAF-coalesced — rapid calls within a single animation frame are collapsed
 * into one write. Pass `{ immediate: true }` inside a `startViewTransition`
 * mutate callback or during unmount cleanup where synchronous DOM is required.
 */
function injectSchemeToDOM(scheme: AppColorScheme, opts?: { immediate?: boolean }): void {
  // Every direct write is itself the latest intent, superseding any deferred one.
  claimThemeIntent();

  if (opts?.immediate) {
    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    pendingScheme = null;
    applySchemeToDOMNow(scheme);
    return;
  }

  pendingScheme = scheme;
  if (pendingFrame === null) {
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      if (pendingScheme) applySchemeToDOMNow(pendingScheme);
      pendingScheme = null;
    });
  }
}

/** Flush any pending RAF theme injection synchronously. No-op if nothing is pending. */
function flushPendingTheme(): void {
  if (pendingFrame !== null) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = null;
  }
  if (pendingScheme) {
    applySchemeToDOMNow(pendingScheme);
    pendingScheme = null;
  }
}

export const useAppThemeStore = create<AppThemeState>()((set) => ({
  selectedSchemeId: DEFAULT_APP_SCHEME_ID,
  customSchemes: [],
  pluginSchemes: [],
  pluginSnapshotScheme: null,
  projectSchemeId: null,
  projectSnapshotScheme: null,
  colorVisionMode: "default" as ColorVisionMode,
  followSystem: false,
  preferredDarkSchemeId: "daintree",
  preferredLightSchemeId: "bondi",
  recentSchemeIds: [],
  accentColorOverride: null,
  previewSchemeId: null,

  setPreviewSchemeId: (id) => set({ previewSchemeId: id }),

  setSelectedSchemeId: (id) => {
    const scheme = resolveAppTheme(id, selectSelectableSchemes(useAppThemeStore.getState()));
    set((state) => ({
      selectedSchemeId: scheme.id,
      pluginSnapshotScheme: retainedPluginScheme(scheme),
      recentSchemeIds: [scheme.id, ...state.recentSchemeIds.filter((x) => x !== scheme.id)].slice(
        0,
        RECENT_SCHEMES_LIMIT
      ),
    }));
    injectSchemeToDOM(resolveCommittedScheme(useAppThemeStore.getState()));
  },

  commitSchemeSelection: (id) => {
    const scheme = resolveAppTheme(id, selectSelectableSchemes(useAppThemeStore.getState()));
    set((state) => ({
      selectedSchemeId: scheme.id,
      pluginSnapshotScheme: retainedPluginScheme(scheme),
      recentSchemeIds: [scheme.id, ...state.recentSchemeIds.filter((x) => x !== scheme.id)].slice(
        0,
        RECENT_SCHEMES_LIMIT
      ),
    }));
  },

  setSelectedSchemeIdSilent: (id, opts) => {
    const state = useAppThemeStore.getState();
    const previousSchemeId = resolveCommittedScheme(state).id;
    const selected = resolveAppTheme(id, selectSelectableSchemes(state), opts?.fallbackType);
    set({ selectedSchemeId: selected.id, pluginSnapshotScheme: retainedPluginScheme(selected) });
    // A project with its own theme keeps showing it.
    const scheme = resolveCommittedScheme(useAppThemeStore.getState());

    // Only transition on a real change. `nativeTheme` can re-fire for OS changes that
    // don't move the light/dark bucket, and crossfading there would skipTransition() an
    // in-flight wipe to animate between two identical snapshots.
    if (opts?.crossfade && previousSchemeId !== scheme.id) {
      // Claimed before the transition starts, so anything scheduled after this — including
      // a second crossfade — outranks it regardless of which callback the browser runs first.
      const intent = claimThemeIntent();
      runThemeCrossfade(() => {
        if (intent !== themeIntentSeq) return;
        // `immediate` is required inside a transition callback: the RAF-coalesced write
        // would land after the API has already snapshotted the new state.
        injectSchemeToDOM(scheme, { immediate: true });
      });
    } else {
      injectSchemeToDOM(scheme);
    }
  },

  setPluginSchemes: (schemes) => {
    const { selectedSchemeId, previewSchemeId, pluginSnapshotScheme, projectSchemeId } =
      useAppThemeStore.getState();
    // An update to the selected theme replaces the retained copy; a catalog
    // that lacks it keeps the copy until main says the theme is gone.
    const offered = schemes.find((scheme) => scheme.id === selectedSchemeId);
    set({ pluginSchemes: schemes, pluginSnapshotScheme: offered ?? pluginSnapshotScheme });
    const state = useAppThemeStore.getState();
    const selectable = selectSelectableSchemes(state);
    if (previewSchemeId !== null) {
      // A preview owns the DOM and restores the selection when it ends, unless
      // the theme it shows has just gone.
      if (!isPluginThemeId(previewSchemeId) || selectable.some((s) => s.id === previewSchemeId)) {
        return;
      }
      set({ previewSchemeId: null });
    } else if (!isPluginThemeId(selectedSchemeId) && !isPluginThemeId(projectSchemeId ?? "")) {
      return;
    }
    injectSchemeToDOM(resolveCommittedScheme(state));
  },

  applyPluginThemeFallback: (schemeId) => {
    const {
      selectedSchemeId: lostId,
      previewSchemeId,
      setSelectedSchemeIdSilent,
    } = useAppThemeStore.getState();
    set((state) => ({
      pluginSnapshotScheme: null,
      recentSchemeIds: state.recentSchemeIds.filter((id) => id !== lostId),
    }));
    if (previewSchemeId !== null && previewSchemeId !== lostId) {
      // A preview owns the DOM and paints the committed theme when it ends,
      // which is now the fallback.
      const fallback = resolveAppTheme(
        schemeId,
        selectSelectableSchemes(useAppThemeStore.getState())
      );
      set({ selectedSchemeId: fallback.id, pluginSnapshotScheme: retainedPluginScheme(fallback) });
      return;
    }
    if (previewSchemeId !== null) set({ previewSchemeId: null });
    // The vanished theme is on screen, so fade off it rather than cut.
    setSelectedSchemeIdSilent(schemeId, { crossfade: true });
  },

  setProjectTheme: (choice, opts) => {
    const state = useAppThemeStore.getState();
    const previousSchemeId = resolveCommittedScheme(state).id;
    const projectSchemeId = choice?.colorSchemeId ?? null;
    set({
      projectSchemeId,
      projectSnapshotScheme: projectSchemeId ? readPluginThemeSnapshot(choice) : null,
    });
    // A preview owns the DOM and paints the committed theme when it ends.
    if (state.previewSchemeId !== null) return;
    const scheme = resolveCommittedScheme(useAppThemeStore.getState());
    if (opts?.crossfade && previousSchemeId !== scheme.id) {
      const intent = claimThemeIntent();
      runThemeCrossfade(() => {
        if (intent !== themeIntentSeq) return;
        injectSchemeToDOM(scheme, { immediate: true });
      });
    } else {
      injectSchemeToDOM(scheme);
    }
  },

  addCustomScheme: (scheme) =>
    set((state) => ({
      customSchemes: [...state.customSchemes.filter((s) => s.id !== scheme.id), scheme],
    })),

  removeCustomScheme: (id) => {
    const { selectedSchemeId, projectSchemeId } = useAppThemeStore.getState();
    const needsFallback = selectedSchemeId === id;
    set((state) => ({
      customSchemes: state.customSchemes.filter((s) => s.id !== id),
      selectedSchemeId: needsFallback ? DEFAULT_APP_SCHEME_ID : state.selectedSchemeId,
      recentSchemeIds: state.recentSchemeIds.filter((x) => x !== id),
    }));
    // A project showing the removed theme falls back to the global one.
    if (needsFallback || projectSchemeId === id) {
      injectSchemeToDOM(resolveCommittedScheme(useAppThemeStore.getState()));
    }
  },

  injectTheme: (scheme) => {
    injectSchemeToDOM(scheme);
  },

  setColorVisionMode: (mode) => {
    set({ colorVisionMode: mode });
    // Pass the active scheme so base --theme-* values are restored for tokens
    // the mode doesn't override, rather than stripped to undefined.
    const state = useAppThemeStore.getState();
    const effective = applyAccentOverrideToScheme(
      resolveCommittedScheme(state),
      state.accentColorOverride
    );
    applyColorVisionMode(document.documentElement, mode, effective);
  },

  setFollowSystem: (enabled) => set({ followSystem: enabled }),
  setPreferredDarkSchemeId: (id) => set({ preferredDarkSchemeId: id }),
  setPreferredLightSchemeId: (id) => set({ preferredLightSchemeId: id }),
  setRecentSchemeIds: (ids) =>
    set({ recentSchemeIds: Array.from(new Set(ids)).slice(0, RECENT_SCHEMES_LIMIT) }),

  setAccentColorOverride: (color) => {
    set({ accentColorOverride: color });
    injectSchemeToDOM(resolveCommittedScheme(useAppThemeStore.getState()));
  },
}));

export { injectSchemeToDOM, flushPendingTheme };
