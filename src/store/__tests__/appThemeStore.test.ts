// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { useAppThemeStore } from "../appThemeStore";

describe("appThemeStore.recentSchemeIds LRU", () => {
  beforeEach(() => {
    useAppThemeStore.setState({
      selectedSchemeId: DEFAULT_APP_SCHEME_ID,
      customSchemes: [],
      colorVisionMode: "default",
      followSystem: false,
      preferredDarkSchemeId: "daintree",
      preferredLightSchemeId: "bondi",
      recentSchemeIds: [],
      accentColorOverride: null,
    });
  });

  it("starts empty", () => {
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual([]);
  });

  it("setSelectedSchemeId prepends the id to recentSchemeIds", () => {
    useAppThemeStore.getState().setSelectedSchemeId("svalbard");
    expect(useAppThemeStore.getState().recentSchemeIds[0]).toBe("svalbard");

    useAppThemeStore.getState().setSelectedSchemeId("bondi");
    const recent = useAppThemeStore.getState().recentSchemeIds;
    expect(recent[0]).toBe("bondi");
    expect(recent[1]).toBe("svalbard");
  });

  it("deduplicates when re-selecting an existing id (moves to front)", () => {
    const store = useAppThemeStore.getState();
    store.setSelectedSchemeId("daintree");
    store.setSelectedSchemeId("bondi");
    store.setSelectedSchemeId("serengeti");
    store.setSelectedSchemeId("daintree");

    const recent = useAppThemeStore.getState().recentSchemeIds;
    expect(recent[0]).toBe("daintree");
    expect(recent.filter((id) => id === "daintree")).toHaveLength(1);
    expect(recent).toHaveLength(3);
  });

  it("caps the list at 5 entries, evicting the oldest", () => {
    const store = useAppThemeStore.getState();
    const ids = ["daintree", "bondi", "serengeti", "hokkaido", "namib", "arashiyama", "atacama"];
    for (const id of ids) store.setSelectedSchemeId(id);

    const recent = useAppThemeStore.getState().recentSchemeIds;
    expect(recent).toHaveLength(5);
    // Newest first, oldest two evicted
    expect(recent[0]).toBe("atacama");
    expect(recent).not.toContain("daintree");
    expect(recent).not.toContain("bondi");
  });

  it("setSelectedSchemeIdSilent does NOT mutate recentSchemeIds", () => {
    useAppThemeStore.getState().setSelectedSchemeId("svalbard");
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["svalbard"]);

    useAppThemeStore.getState().setSelectedSchemeIdSilent("bondi");
    expect(useAppThemeStore.getState().selectedSchemeId).toBe("bondi");
    // recentSchemeIds unchanged — silent path does not record usage
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["svalbard"]);
  });

  it("injectTheme does NOT mutate recentSchemeIds (hover preview)", () => {
    useAppThemeStore.getState().setSelectedSchemeId("daintree");
    const before = useAppThemeStore.getState().recentSchemeIds;

    const someScheme = { id: "hover-target", tokens: {} } as unknown as Parameters<
      ReturnType<typeof useAppThemeStore.getState>["injectTheme"]
    >[0];
    try {
      useAppThemeStore.getState().injectTheme(someScheme);
    } catch {
      // jsdom may throw on unknown tokens — irrelevant to this assertion
    }

    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(before);
  });

  it("setRecentSchemeIds replaces the list and caps at 5", () => {
    useAppThemeStore.getState().setRecentSchemeIds(["a", "b", "c", "d", "e", "f", "g"]);
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("setRecentSchemeIds deduplicates incoming entries", () => {
    useAppThemeStore.getState().setRecentSchemeIds(["a", "b", "a", "c", "b", "d"]);
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["a", "b", "c", "d"]);
  });

  it("setAccentColorOverride patches the CSS variables on :root", () => {
    // Start from a known dark built-in so base accent is a predictable hex.
    useAppThemeStore.getState().setSelectedSchemeIdSilent("daintree");
    const baseAccent = document.documentElement.style.getPropertyValue("--theme-accent-primary");
    expect(baseAccent).toBeTruthy();

    useAppThemeStore.getState().setAccentColorOverride("#ff00aa");
    expect(useAppThemeStore.getState().accentColorOverride).toBe("#ff00aa");
    const overridden = document.documentElement.style.getPropertyValue("--theme-accent-primary");
    expect(overridden).toBe("#ff00aa");
    expect(document.documentElement.style.getPropertyValue("--theme-accent-rgb")).toBe(
      "255, 0, 170"
    );
    // Non-accent tokens should be unchanged from the base theme.
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
    expect(document.documentElement.style.getPropertyValue("--theme-surface-canvas")).toBe(
      daintree.tokens["surface-canvas"]
    );
  });

  it("setAccentColorOverride(null) clears the override and restores theme accent", () => {
    useAppThemeStore.getState().setSelectedSchemeIdSilent("daintree");
    const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;

    useAppThemeStore.getState().setAccentColorOverride("#112233");
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      "#112233"
    );

    useAppThemeStore.getState().setAccentColorOverride(null);
    expect(useAppThemeStore.getState().accentColorOverride).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      daintree.tokens["accent-primary"]
    );
  });

  it("override survives a subsequent setSelectedSchemeId (theme switch)", () => {
    useAppThemeStore.getState().setAccentColorOverride("#abcdef");
    // Switch to a different theme — the override must still be applied.
    useAppThemeStore.getState().setSelectedSchemeId("bondi");
    expect(useAppThemeStore.getState().accentColorOverride).toBe("#abcdef");
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      "#abcdef"
    );
    // And setSelectedSchemeIdSilent (follow-system, hydration) path too.
    useAppThemeStore.getState().setSelectedSchemeIdSilent("daintree");
    expect(document.documentElement.style.getPropertyValue("--theme-accent-primary")).toBe(
      "#abcdef"
    );
  });

  it("removeCustomScheme strips the removed id from recentSchemeIds", () => {
    const customScheme = {
      id: "custom-app-theme",
      name: "Custom",
      type: "dark" as const,
      builtin: false,
      tokens: {} as never,
    };
    useAppThemeStore.getState().addCustomScheme(customScheme);
    useAppThemeStore.getState().setSelectedSchemeId("custom-app-theme");
    useAppThemeStore.getState().setSelectedSchemeId("svalbard");
    expect(useAppThemeStore.getState().recentSchemeIds).toContain("custom-app-theme");

    useAppThemeStore.getState().removeCustomScheme("custom-app-theme");
    expect(useAppThemeStore.getState().recentSchemeIds).not.toContain("custom-app-theme");
  });
});
