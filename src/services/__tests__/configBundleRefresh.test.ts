// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const getThemeConfig = vi.hoisted(() => vi.fn());

vi.mock("@/clients/appThemeClient", () => ({ appThemeClient: { get: getThemeConfig } }));
vi.mock("@/store/notificationSettingsStore", () => ({
  useNotificationSettingsStore: {
    getState: () => ({ rehydrate: () => Promise.resolve() }),
  },
}));

import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { flushPendingTheme, useAppThemeStore } from "@/store/appThemeStore";
import { refreshImportedConfig } from "../configBundleRefresh";

function selectedSchemeType() {
  const selectedId = useAppThemeStore.getState().selectedSchemeId;
  return BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === selectedId)?.type;
}

describe("refreshImportedConfig theme refresh", () => {
  beforeEach(() => {
    Object.assign(window, {
      electron: { app: { reloadConfig: () => Promise.resolve() } },
    });
    useAppThemeStore.setState({
      selectedSchemeId: "bondi",
      customSchemes: [],
      preferredDarkSchemeId: "daintree",
      preferredLightSchemeId: "bondi",
    });
  });

  it("keeps a missing scheme held in the light slot on a light built-in", async () => {
    getThemeConfig.mockResolvedValue({
      colorSchemeId: "custom-deleted",
      preferredLightSchemeId: "custom-deleted",
      customSchemes: [],
    });

    await refreshImportedConfig();
    flushPendingTheme();

    expect(selectedSchemeType()).toBe("light");
  });

  it("keeps a missing scheme held in the dark slot on a dark built-in", async () => {
    getThemeConfig.mockResolvedValue({
      colorSchemeId: "custom-deleted",
      preferredDarkSchemeId: "custom-deleted",
      customSchemes: [],
    });

    await refreshImportedConfig();
    flushPendingTheme();

    expect(selectedSchemeType()).toBe("dark");
  });

  it("repaints the current id when an import changes the theme it names", async () => {
    const light = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "light")!;
    const paper = { ...light, id: "custom-paper", name: "Paper", builtin: false };
    useAppThemeStore.getState().addCustomScheme(paper);
    useAppThemeStore.getState().setSelectedSchemeIdSilent(paper.id);
    flushPendingTheme();

    const imported = { ...paper, tokens: { ...paper.tokens, "surface-canvas": "#fafafa" } };
    getThemeConfig.mockResolvedValue({
      colorSchemeId: paper.id,
      customSchemes: [imported],
      recentSchemeIds: ["bondi"],
    });

    await refreshImportedConfig();
    flushPendingTheme();

    expect(document.documentElement.style.getPropertyValue("--theme-surface-canvas").trim()).toBe(
      "#fafafa"
    );
    expect(useAppThemeStore.getState().recentSchemeIds).toEqual(["bondi"]);
  });
});
