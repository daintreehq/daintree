// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
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
