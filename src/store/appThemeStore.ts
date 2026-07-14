import { create } from "zustand";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { applyAccentOverrideToScheme, resolveAppTheme, type AppColorScheme } from "@shared/theme";
import type { ColorVisionMode } from "@shared/types";
import { applyAppThemeToRoot, applyColorVisionMode } from "@/theme/applyAppTheme";
import { runThemeCrossfade } from "@/lib/appThemeViewTransition";

const RECENT_SCHEMES_LIMIT = 5;

interface AppThemeState {
  selectedSchemeId: string;
  customSchemes: AppColorScheme[];
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
   */
  setSelectedSchemeIdSilent: (id: string, opts?: { crossfade?: boolean }) => void;
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
  colorVisionMode: "default" as ColorVisionMode,
  followSystem: false,
  preferredDarkSchemeId: "daintree",
  preferredLightSchemeId: "bondi",
  recentSchemeIds: [],
  accentColorOverride: null,
  previewSchemeId: null,

  setPreviewSchemeId: (id) => set({ previewSchemeId: id }),

  setSelectedSchemeId: (id) => {
    const { customSchemes } = useAppThemeStore.getState();
    const scheme = resolveAppTheme(id, customSchemes);
    set((state) => ({
      selectedSchemeId: scheme.id,
      recentSchemeIds: [scheme.id, ...state.recentSchemeIds.filter((x) => x !== scheme.id)].slice(
        0,
        RECENT_SCHEMES_LIMIT
      ),
    }));
    injectSchemeToDOM(scheme);
  },

  commitSchemeSelection: (id) => {
    const { customSchemes } = useAppThemeStore.getState();
    const scheme = resolveAppTheme(id, customSchemes);
    set((state) => ({
      selectedSchemeId: scheme.id,
      recentSchemeIds: [scheme.id, ...state.recentSchemeIds.filter((x) => x !== scheme.id)].slice(
        0,
        RECENT_SCHEMES_LIMIT
      ),
    }));
  },

  setSelectedSchemeIdSilent: (id, opts) => {
    const { customSchemes, selectedSchemeId: previousSchemeId } = useAppThemeStore.getState();
    const scheme = resolveAppTheme(id, customSchemes);
    set({ selectedSchemeId: scheme.id });

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

  addCustomScheme: (scheme) =>
    set((state) => ({
      customSchemes: [...state.customSchemes.filter((s) => s.id !== scheme.id), scheme],
    })),

  removeCustomScheme: (id) => {
    const needsFallback = useAppThemeStore.getState().selectedSchemeId === id;
    set((state) => ({
      customSchemes: state.customSchemes.filter((s) => s.id !== id),
      selectedSchemeId: needsFallback ? DEFAULT_APP_SCHEME_ID : state.selectedSchemeId,
      recentSchemeIds: state.recentSchemeIds.filter((x) => x !== id),
    }));
    if (needsFallback) {
      const defaultScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === DEFAULT_APP_SCHEME_ID)!;
      injectSchemeToDOM(defaultScheme);
    }
  },

  injectTheme: (scheme) => {
    injectSchemeToDOM(scheme);
  },

  setColorVisionMode: (mode) => {
    set({ colorVisionMode: mode });
    // Pass the active scheme so base --theme-* values are restored for tokens
    // the mode doesn't override, rather than stripped to undefined.
    const { selectedSchemeId, customSchemes, accentColorOverride } = useAppThemeStore.getState();
    const effective = applyAccentOverrideToScheme(
      resolveAppTheme(selectedSchemeId, customSchemes),
      accentColorOverride
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
    const { selectedSchemeId, customSchemes } = useAppThemeStore.getState();
    const scheme = resolveAppTheme(selectedSchemeId, customSchemes);
    injectSchemeToDOM(scheme);
  },
}));

export { injectSchemeToDOM, flushPendingTheme };
