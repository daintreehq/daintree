import type { ITheme } from "@xterm/xterm";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import {
  useTerminalColorSchemeStore,
  selectWrapperBackground,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";

/**
 * Unified terminal appearance state consumed by `XtermAdapter` and the
 * renderer-side prewarm paths. Combines font, scrollback, performance mode,
 * color scheme, and screen reader settings from across the Zustand stores.
 *
 * `projectScrollback` is returned raw so callers can branch on agent vs.
 * terminal kinds before computing effective scrollback.
 */
export interface TerminalAppearanceState {
  fontSize: number;
  fontFamily: string;
  performanceMode: boolean;
  scrollbackLines: number;
  projectScrollback: number | undefined;
  effectiveTheme: ITheme;
  wrapperBackground: string;
  screenReaderMode: boolean;
}

/**
 * Imperative snapshot of the current terminal appearance state. Safe to call
 * from non-React code (e.g., prewarm paths, async callbacks) since it reads
 * `store.getState()` at call time rather than closing over React state.
 */
export function getTerminalAppearanceSnapshot(): TerminalAppearanceState {
  const { scrollbackLines } = useScrollbackStore.getState();
  const { performanceMode } = usePerformanceModeStore.getState();
  const { fontSize, fontFamily } = useTerminalFontStore.getState();
  const projectScrollback =
    useProjectSettingsStore.getState().settings?.terminalSettings?.scrollbackLines;
  const screenReaderMode = useScreenReaderStore.getState().resolvedScreenReaderEnabled();
  const colorSchemeState = useTerminalColorSchemeStore.getState();

  return {
    fontSize,
    fontFamily,
    performanceMode,
    scrollbackLines,
    projectScrollback,
    effectiveTheme: selectEffectiveTheme(colorSchemeState),
    wrapperBackground: selectWrapperBackground(colorSchemeState),
    screenReaderMode,
  };
}

/**
 * Reactive hook returning all terminal appearance state in one call.
 * Replaces seven separate `useSyncExternalStore` subscriptions in `XtermAdapter`.
 *
 * Note: each field is selected independently so Zustand's built-in `Object.is`
 * equality suppresses re-renders for unchanged values. The returned object
 * itself is a fresh reference each render — consumers should destructure and
 * pass primitive fields into their own `useMemo` deps.
 *
 * The explicit `useAppThemeStore((s) => s.selectedSchemeId)` subscription is
 * required: `selectWrapperBackground` and `selectEffectiveTheme` read
 * `useAppThemeStore.getState()` internally without subscribing, so app-theme
 * changes would not trigger a re-render here without this line.
 */
export function useTerminalAppearance(): TerminalAppearanceState {
  const fontSize = useTerminalFontStore((s) => s.fontSize);
  const fontFamily = useTerminalFontStore((s) => s.fontFamily);
  const performanceMode = usePerformanceModeStore((s) => s.performanceMode);
  const scrollbackLines = useScrollbackStore((s) => s.scrollbackLines);
  const projectScrollback = useProjectSettingsStore(
    (s) => s.settings?.terminalSettings?.scrollbackLines
  );
  // Subscribe to app theme so wrapperBackground + effectiveTheme re-compute on theme change.
  // Value is intentionally discarded — the subscription is what drives reactivity.
  useAppThemeStore((s) => s.selectedSchemeId);
  useAppThemeStore((s) => s.previewSchemeId);
  const wrapperBackground = useTerminalColorSchemeStore(selectWrapperBackground);
  const effectiveTheme = useTerminalColorSchemeStore(selectEffectiveTheme);
  const screenReaderMode = useScreenReaderStore((s) => s.resolvedScreenReaderEnabled());

  return {
    fontSize,
    fontFamily,
    performanceMode,
    scrollbackLines,
    projectScrollback,
    effectiveTheme,
    wrapperBackground,
    screenReaderMode,
  };
}
