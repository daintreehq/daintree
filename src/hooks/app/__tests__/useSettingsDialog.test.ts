// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

vi.mock("@/components/Settings/settingsTabIds", () => ({
  isSettingsTab: (tab: string) => ["general", "code-forge", "appearance"].includes(tab),
}));

import type { SettingsTab } from "@/components/Settings/settingsTabIds";
import { useSettingsDialog } from "../useSettingsDialog";

// Stale/fake ids exercised below sit outside the SettingsTab union by design —
// the hook normalizes or validates them at runtime.
const asTab = (tab: string) => tab as SettingsTab;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSettingsDialog — forge subtab normalization", () => {
  it("normalizes the legacy 'github' tab to code-forge with the canonical GitHub subtab", () => {
    const { result } = renderHook(() => useSettingsDialog());

    act(() => {
      result.current.handleOpenSettingsTab({ tab: asTab("github") });
    });

    expect(result.current.settingsTab).toBe("code-forge");
    expect(result.current.settingsSubtab).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(result.current.isSettingsOpen).toBe(true);
  });

  it("normalizes a legacy bare 'github' subtab on the code-forge tab to the canonical id", () => {
    const { result } = renderHook(() => useSettingsDialog());

    act(() => {
      result.current.handleOpenSettingsTab({ tab: "code-forge", subtab: "github" });
    });

    expect(result.current.settingsTab).toBe("code-forge");
    expect(result.current.settingsSubtab).toBe(BUILTIN_GITHUB_PROVIDER_ID);
  });

  it("passes an already-canonical forge subtab through unchanged", () => {
    const { result } = renderHook(() => useSettingsDialog());

    act(() => {
      result.current.handleOpenSettingsTab({ tab: "code-forge", subtab: "acme.gitea" });
    });

    expect(result.current.settingsSubtab).toBe("acme.gitea");
  });

  it("leaves the 'general' forge subtab unchanged", () => {
    const { result } = renderHook(() => useSettingsDialog());

    act(() => {
      result.current.handleOpenSettingsTab({ tab: "code-forge", subtab: "general" });
    });

    expect(result.current.settingsSubtab).toBe("general");
  });

  it("normalizes the legacy 'forge' tab to code-forge with the general subtab", () => {
    const { result } = renderHook(() => useSettingsDialog());

    act(() => {
      result.current.handleOpenSettingsTab({ tab: asTab("forge") });
    });

    expect(result.current.settingsTab).toBe("code-forge");
    expect(result.current.settingsSubtab).toBe("general");
  });

  it("normalizes a legacy bare 'github' subtab arriving via the open-settings-tab event", () => {
    const { result } = renderHook(() => useSettingsDialog());

    act(() => {
      window.dispatchEvent(
        new CustomEvent("daintree:open-settings-tab", {
          detail: { tab: "code-forge", subtab: "github" },
        })
      );
    });

    expect(result.current.settingsTab).toBe("code-forge");
    expect(result.current.settingsSubtab).toBe(BUILTIN_GITHUB_PROVIDER_ID);
    expect(result.current.isSettingsOpen).toBe(true);
  });

  it("does not normalize subtabs on non-forge tabs", () => {
    const { result } = renderHook(() => useSettingsDialog());

    act(() => {
      result.current.handleOpenSettingsTab({ tab: asTab("appearance"), subtab: "github" });
    });

    expect(result.current.settingsTab).toBe("appearance");
    expect(result.current.settingsSubtab).toBe("github");
  });
});
