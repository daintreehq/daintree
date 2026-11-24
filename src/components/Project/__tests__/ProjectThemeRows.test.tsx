// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { useAppThemeStore } from "@/store/appThemeStore";
import { resetProjectThemeStoreForTests, useProjectThemeStore } from "@/store/projectThemeStore";
import { ProjectThemeRows } from "../ProjectThemeSettings";

const PROJECT = "a".repeat(64);
const GLOBAL = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "dark")!;
const CHOSEN = BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === "light")!;

const setTheme = vi.fn<(schemeId: string | null) => Promise<unknown>>();

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  resetProjectThemeStoreForTests();
  useAppThemeStore.setState({
    selectedSchemeId: GLOBAL.id,
    customSchemes: [],
    pluginSchemes: [],
    pluginSnapshotScheme: null,
    projectSchemeId: null,
    projectSnapshotScheme: null,
    previewSchemeId: null,
  });
  setTheme.mockReset().mockResolvedValue({
    projectId: PROJECT,
    choice: { colorSchemeId: CHOSEN.id },
    suggestedSchemeId: null,
  });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      projectTheme: {
        get: vi.fn(() => new Promise(() => {})),
        onChanged: vi.fn(() => () => {}),
        setTheme,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
  resetProjectThemeStoreForTests();
});

function renderRows() {
  return render(
    <TooltipProvider>
      <SettingsGroup>
        <ProjectThemeRows />
      </SettingsGroup>
    </TooltipProvider>
  );
}

describe("ProjectThemeRows Retry", () => {
  it("offers Retry beside a failed Theme save and saves the same choice again", async () => {
    renderRows();
    act(() => {
      useProjectThemeStore.setState({
        loaded: true,
        projectId: PROJECT,
        failedSave: { save: { kind: "theme", schemeId: CHOSEN.id }, message: "Disk is full" },
      });
    });

    expect(screen.getByText("Disk is full")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    expect(setTheme).toHaveBeenCalledWith(CHOSEN.id);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers no Retry while nothing has failed", () => {
    renderRows();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
