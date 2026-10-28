// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemes";
import {
  flushPendingTheme,
  injectSchemeToDOM,
  resolveCommittedScheme,
  useAppThemeStore,
} from "../appThemeStore";
import {
  compilePluginTheme,
  makePluginThemeId,
  toPluginThemeSnapshot,
  type AppColorScheme,
  type PluginThemeSource,
} from "@shared/theme";

const dark = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "dark")!;
const light = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "light")!;
const otherDark = BUILT_IN_APP_SCHEMES.find(
  (scheme) => scheme.type === "dark" && scheme.id !== dark.id
)!;

function paintedCanvas(): string {
  flushPendingTheme();
  return document.documentElement.style.getPropertyValue("--theme-surface-canvas").trim();
}

function canvasOf(scheme: AppColorScheme): string {
  return scheme.tokens["surface-canvas"].trim();
}

describe("appThemeStore: a project's own theme (#13833)", () => {
  beforeEach(() => {
    useAppThemeStore.setState({
      selectedSchemeId: dark.id,
      customSchemes: [],
      pluginSchemes: [],
      pluginSnapshotScheme: null,
      projectSchemeId: null,
      projectSnapshotScheme: null,
      colorVisionMode: "default",
      accentColorOverride: null,
      previewSchemeId: null,
      recentSchemeIds: [],
    });
    useAppThemeStore.getState().setSelectedSchemeIdSilent(dark.id);
    flushPendingTheme();
  });

  it("paints the project's theme while the global selection stays the user's default", () => {
    useAppThemeStore.getState().setProjectTheme({ colorSchemeId: light.id });
    expect(paintedCanvas()).toBe(canvasOf(light));
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(dark.id);
    expect(resolveCommittedScheme(useAppThemeStore.getState()).id).toBe(light.id);
  });

  it("keeps the project's theme on screen when the global theme changes", () => {
    const store = useAppThemeStore.getState();
    store.setProjectTheme({ colorSchemeId: light.id });
    store.setSelectedSchemeId(otherDark.id);
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(otherDark.id);
    expect(paintedCanvas()).toBe(canvasOf(light));

    // An OS appearance flip moves the global theme too, and still not this project.
    useAppThemeStore.getState().setSelectedSchemeIdSilent(dark.id, { crossfade: true });
    expect(paintedCanvas()).toBe(canvasOf(light));
  });

  it("follows the global theme again once the project's theme is cleared", () => {
    const store = useAppThemeStore.getState();
    store.setProjectTheme({ colorSchemeId: light.id });
    store.setProjectTheme(null);
    expect(paintedCanvas()).toBe(canvasOf(dark));
  });

  it("shows the global theme while the project's theme can't resolve, and keeps the choice", () => {
    useAppThemeStore.getState().setProjectTheme({ colorSchemeId: "custom-deleted" });
    expect(paintedCanvas()).toBe(canvasOf(dark));
    expect(useAppThemeStore.getState().projectSchemeId).toBe("custom-deleted");
  });

  it("applies the global accent override on top of the project's theme", () => {
    const store = useAppThemeStore.getState();
    store.setProjectTheme({ colorSchemeId: light.id });
    store.setAccentColorOverride("#ff00aa");
    flushPendingTheme();
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary").trim()).toBe(
      "#ff00aa"
    );
    expect(paintedCanvas()).toBe(canvasOf(light));
  });

  it("falls back to the global theme when the project's imported theme is removed", () => {
    const paper: AppColorScheme = { ...light, id: "custom-paper", name: "Paper", builtin: false };
    const store = useAppThemeStore.getState();
    store.addCustomScheme(paper);
    store.setProjectTheme({ colorSchemeId: paper.id });
    expect(resolveCommittedScheme(useAppThemeStore.getState()).id).toBe(paper.id);

    useAppThemeStore.getState().removeCustomScheme(paper.id);
    expect(paintedCanvas()).toBe(canvasOf(dark));
  });

  it("paints a plugin theme from its snapshot before the plugin catalog arrives", () => {
    const source: PluginThemeSource = {
      id: makePluginThemeId("acme.themes", "paper"),
      name: "Paper",
      type: "light",
      pluginId: "acme.themes",
      pluginName: "Acme Themes",
      palette: BUILT_IN_THEME_SOURCES.find((candidate) => candidate.type === "light")!.palette,
    };
    const compiled = compilePluginTheme(source);
    useAppThemeStore.getState().setProjectTheme({
      colorSchemeId: source.id,
      pluginThemeSnapshot: toPluginThemeSnapshot(source),
    });
    expect(resolveCommittedScheme(useAppThemeStore.getState()).id).toBe(source.id);
    expect(paintedCanvas()).toBe(canvasOf(compiled));
  });

  it("leaves an open preview on screen, and restoring the committed theme shows the project's", () => {
    const store = useAppThemeStore.getState();
    useAppThemeStore.setState({ previewSchemeId: otherDark.id });
    store.injectTheme(otherDark);
    expect(paintedCanvas()).toBe(canvasOf(otherDark));

    store.setProjectTheme({ colorSchemeId: light.id });
    // The preview still owns the DOM.
    expect(paintedCanvas()).toBe(canvasOf(otherDark));

    // Ending it the way the theme browser does paints the project's theme.
    useAppThemeStore.setState({ previewSchemeId: null });
    injectSchemeToDOM(resolveCommittedScheme(useAppThemeStore.getState()), { immediate: true });
    expect(paintedCanvas()).toBe(canvasOf(light));
  });
});
