// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemes";
import {
  flushPendingTheme,
  injectSchemeToDOM,
  resolveCommittedScheme,
  useAppThemeStore,
} from "../appThemeStore";
import {
  applyAccentOverrideToScheme,
  compilePluginTheme,
  makePluginThemeId,
  toPluginThemeSnapshot,
  type AppColorScheme,
  type AppThemeConfig,
  type PluginThemeSource,
} from "@shared/theme";

const dark = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "dark")!;
const light = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "light")!;
const otherDark = BUILT_IN_APP_SCHEMES.find(
  (scheme) => scheme.type === "dark" && scheme.id !== dark.id
)!;

const root = document.documentElement;

function painted(token: string): string {
  flushPendingTheme();
  return root.style.getPropertyValue(`--theme-${token}`).trim();
}

function canvasOf(scheme: AppColorScheme): string {
  return scheme.tokens["surface-canvas"].trim();
}

function reconcile(config: AppThemeConfig, opts?: { crossfade?: boolean }) {
  useAppThemeStore.getState().reconcileAppThemeConfig(config, opts);
}

/** Paints `scheme` behind the store's back, so a repaint the store skipped stays visible. */
function desyncDom(): void {
  root.style.setProperty("--theme-surface-canvas", "sentinel");
}

describe("appThemeStore: settings another view or the OS changed (#16271)", () => {
  beforeEach(() => {
    useAppThemeStore.setState({
      selectedSchemeId: dark.id,
      customSchemes: [],
      pluginSchemes: [],
      pluginSnapshotScheme: null,
      projectSchemeId: null,
      projectSnapshotScheme: null,
      colorVisionMode: "default",
      followSystem: false,
      preferredDarkSchemeId: "daintree",
      preferredLightSchemeId: "bondi",
      accentColorOverride: null,
      previewSchemeId: null,
      recentSchemeIds: [],
    });
    injectSchemeToDOM(dark, { immediate: true });
    delete root.dataset.colorblind;
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "startViewTransition");
    flushPendingTheme();
    vi.restoreAllMocks();
  });

  it("paints a scheme another view picked, without adding it to this view's recents", () => {
    reconcile({ colorSchemeId: light.id, recentSchemeIds: [otherDark.id] });

    expect(painted("surface-canvas")).toBe(canvasOf(light));
    const state = useAppThemeStore.getState();
    expect(state.selectedSchemeId).toBe(light.id);
    // The list as persisted: the pushed selection is not recorded as this view's pick.
    expect(state.recentSchemeIds).toEqual([otherDark.id]);
  });

  it("applies an accent override, and its removal", () => {
    reconcile({ colorSchemeId: dark.id, accentColorOverride: "#FF8800" });
    expect(useAppThemeStore.getState().accentColorOverride).toBe("#ff8800");
    expect(painted("accent-primary")).toBe(
      applyAccentOverrideToScheme(dark, "#ff8800").tokens["accent-primary"].trim()
    );

    reconcile({ colorSchemeId: dark.id, accentColorOverride: null });
    expect(useAppThemeStore.getState().accentColorOverride).toBeNull();
    expect(painted("accent-primary")).toBe(dark.tokens["accent-primary"].trim());
  });

  it("applies a colour vision mode, and clears it on a return to the default", () => {
    reconcile({ colorSchemeId: dark.id, colorVisionMode: "red-green" });
    expect(root.dataset.colorblind).toBe("red-green");

    reconcile({ colorSchemeId: dark.id });
    expect(useAppThemeStore.getState().colorVisionMode).toBe("default");
    expect(root.dataset.colorblind).toBeUndefined();
    expect(painted("status-success")).toBe(dark.tokens["status-success"].trim());
  });

  it("doesn't repaint for a change that leaves this view looking the same", () => {
    desyncDom();

    reconcile({
      colorSchemeId: dark.id,
      followSystem: true,
      preferredLightSchemeId: "svalbard",
      recentSchemeIds: [dark.id],
    });

    expect(painted("surface-canvas")).toBe("sentinel");
    const state = useAppThemeStore.getState();
    expect(state.followSystem).toBe(true);
    expect(state.preferredLightSchemeId).toBe("svalbard");
    expect(state.recentSchemeIds).toEqual([dark.id]);
  });

  describe("crossfading", () => {
    let deferred: Array<() => void>;
    let startViewTransition: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Without matchMedia the reduced-motion guard skips every transition.
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: vi.fn(() => ({ matches: false })),
      });
      deferred = [];
      startViewTransition = vi.fn((callback: () => void) => {
        deferred.push(callback);
        return { ready: Promise.resolve(), finished: Promise.resolve() };
      });
      Object.assign(document, { startViewTransition });
    });

    it("fades to a visible change, painting it inside the transition", () => {
      reconcile({ colorSchemeId: light.id }, { crossfade: true });

      expect(startViewTransition).toHaveBeenCalledTimes(1);
      expect(root.style.getPropertyValue("--theme-surface-canvas").trim()).toBe(canvasOf(dark));
      deferred[0]!();
      expect(root.style.getPropertyValue("--theme-surface-canvas").trim()).toBe(canvasOf(light));
    });

    it("starts no transition when nothing visible changed", () => {
      reconcile({ colorSchemeId: dark.id, recentSchemeIds: [dark.id] }, { crossfade: true });

      expect(startViewTransition).not.toHaveBeenCalled();
    });

    it("drops a fade that a newer paint overtook before it ran", () => {
      reconcile({ colorSchemeId: light.id }, { crossfade: true });
      // A hover preview starts in this view before the transition's callback runs.
      useAppThemeStore.getState().injectTheme(otherDark);
      flushPendingTheme();

      deferred[0]!();

      expect(painted("surface-canvas")).toBe(canvasOf(otherDark));
    });
  });

  it("replaces the imported themes, so one deleted elsewhere falls back by polarity", () => {
    const paper: AppColorScheme = {
      ...light,
      id: "custom-paper",
      name: "Paper",
      builtin: false,
      tokens: { ...light.tokens, "surface-canvas": "#fdf6e3" },
    };
    useAppThemeStore.getState().addCustomScheme(paper);
    useAppThemeStore.getState().setSelectedSchemeIdSilent(paper.id);
    expect(painted("surface-canvas")).toBe(canvasOf(paper));

    reconcile({ colorSchemeId: paper.id, customSchemes: [], preferredLightSchemeId: paper.id });

    const state = useAppThemeStore.getState();
    expect(state.customSchemes).toEqual([]);
    const fallback = resolveCommittedScheme(state);
    expect(fallback).toMatchObject({ builtin: true, type: "light" });
    expect(painted("surface-canvas")).toBe(canvasOf(fallback));
  });

  it("repaints an imported theme whose palette changed under the same id", () => {
    const paper: AppColorScheme = { ...light, id: "custom-paper", name: "Paper", builtin: false };
    useAppThemeStore.getState().addCustomScheme(paper);
    useAppThemeStore.getState().setSelectedSchemeIdSilent(paper.id);

    const edited = { ...paper, tokens: { ...paper.tokens, "surface-canvas": "#fafafa" } };
    reconcile({ colorSchemeId: paper.id, customSchemes: [edited] });

    expect(painted("surface-canvas")).toBe("#fafafa");
  });

  it("doesn't repaint for a rename of the imported theme on screen", () => {
    const paper: AppColorScheme = { ...light, id: "custom-paper", name: "Paper", builtin: false };
    useAppThemeStore.getState().addCustomScheme(paper);
    useAppThemeStore.getState().setSelectedSchemeIdSilent(paper.id);
    flushPendingTheme();
    desyncDom();

    reconcile({ colorSchemeId: paper.id, customSchemes: [{ ...paper, name: "Parchment" }] });

    expect(painted("surface-canvas")).toBe("sentinel");
    expect(useAppThemeStore.getState().customSchemes[0]!.name).toBe("Parchment");
  });

  it("paints a plugin theme from the pushed snapshot before this view has the catalog", () => {
    const source: PluginThemeSource = {
      id: makePluginThemeId("acme.themes", "paper"),
      name: "Paper",
      type: "light",
      pluginId: "acme.themes",
      pluginName: "Acme Themes",
      palette: BUILT_IN_THEME_SOURCES.find((candidate) => candidate.type === "light")!.palette,
    };

    reconcile({ colorSchemeId: source.id, pluginThemeSnapshot: toPluginThemeSnapshot(source) });

    expect(useAppThemeStore.getState().selectedSchemeId).toBe(source.id);
    expect(painted("surface-canvas")).toBe(canvasOf(compilePluginTheme(source)));
    expect(root.dataset.theme).toBe(source.id);
  });

  it("keeps this view's project theme on screen while the global selection moves under it", () => {
    useAppThemeStore.getState().setProjectTheme({ colorSchemeId: light.id });
    expect(painted("surface-canvas")).toBe(canvasOf(light));

    reconcile({ colorSchemeId: otherDark.id, accentColorOverride: "#ff00aa" });

    expect(useAppThemeStore.getState().selectedSchemeId).toBe(otherDark.id);
    expect(painted("surface-canvas")).toBe(canvasOf(light));
    // The accent is global, so it lands on the project's theme.
    expect(painted("accent-primary")).toBe("#ff00aa");
  });

  it("leaves an open preview on screen, and ending it shows the pushed theme", () => {
    useAppThemeStore.setState({ previewSchemeId: otherDark.id });
    useAppThemeStore.getState().injectTheme(otherDark);

    reconcile({ colorSchemeId: light.id });

    expect(painted("surface-canvas")).toBe(canvasOf(otherDark));
    expect(useAppThemeStore.getState().previewSchemeId).toBe(otherDark.id);

    // Ending it the way the theme browser does.
    useAppThemeStore.setState({ previewSchemeId: null });
    injectSchemeToDOM(resolveCommittedScheme(useAppThemeStore.getState()), { immediate: true });
    expect(painted("surface-canvas")).toBe(canvasOf(light));
  });

  it("clears a colour vision mode reset under an open preview once the preview ends", () => {
    reconcile({ colorSchemeId: dark.id, colorVisionMode: "red-green" });
    useAppThemeStore.setState({ previewSchemeId: otherDark.id });
    useAppThemeStore.getState().injectTheme(otherDark);
    flushPendingTheme();

    reconcile({ colorSchemeId: dark.id });
    expect(useAppThemeStore.getState().colorVisionMode).toBe("default");

    useAppThemeStore.setState({ previewSchemeId: null });
    injectSchemeToDOM(resolveCommittedScheme(useAppThemeStore.getState()), { immediate: true });
    expect(root.dataset.colorblind).toBeUndefined();
  });

  it("ends a preview of an imported theme deleted elsewhere, and paints the committed one", () => {
    const paper: AppColorScheme = { ...light, id: "custom-paper", name: "Paper", builtin: false };
    useAppThemeStore.getState().addCustomScheme(paper);
    useAppThemeStore.setState({ previewSchemeId: paper.id });
    useAppThemeStore.getState().injectTheme(paper);

    reconcile({ colorSchemeId: dark.id, customSchemes: [] });

    expect(useAppThemeStore.getState().previewSchemeId).toBeNull();
    expect(painted("surface-canvas")).toBe(canvasOf(dark));
  });
});
