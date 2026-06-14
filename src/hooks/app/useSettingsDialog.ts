import { useCallback, useEffect, useState } from "react";
import type { SettingsTab, SettingsNavTarget } from "@/components/Settings";
import { isSettingsTab } from "@/components/Settings/settingsTabIds";
import { BUILTIN_GITHUB_PROVIDER_ID, normalizeProviderId } from "@shared/utils/forgeProviderIds";

export function useSettingsDialog() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [settingsSubtab, setSettingsSubtab] = useState<string | undefined>();
  const [settingsSectionId, setSettingsSectionId] = useState<string | undefined>();

  const handleSettings = useCallback(() => {
    setSettingsTab(undefined);
    setSettingsSubtab(undefined);
    setSettingsSectionId(undefined);
    setIsSettingsOpen(true);
  }, []);

  const handleOpenSettingsTab = useCallback((target: SettingsNavTarget) => {
    // TODO(#8329): remove stale-ID normalization after 1 release
    // Legacy callers can still emit ids outside the SettingsTab union at
    // runtime; compare through `string` until the normalization window closes.
    const rawTab: string = target.tab;
    let normalized = target;
    if (rawTab === "github") {
      if (import.meta.env.DEV) {
        console.warn(
          "[useSettingsDialog] stale tab ID 'github' normalized to 'code-forge' — update the call site"
        );
      }
      normalized = {
        tab: "code-forge",
        subtab: target.subtab ?? BUILTIN_GITHUB_PROVIDER_ID,
        sectionId: target.sectionId,
      };
    } else if (rawTab === "forge") {
      if (import.meta.env.DEV) {
        console.warn(
          "[useSettingsDialog] stale tab ID 'forge' normalized to 'code-forge' — update the call site"
        );
      }
      normalized = {
        tab: "code-forge",
        subtab: target.subtab ?? "general",
        sectionId: target.sectionId,
      };
    }
    const tab = isSettingsTab(normalized.tab) ? normalized.tab : "general";
    setSettingsTab(tab);
    // Forge subtabs route on canonical `{pluginId}.{contributionId}` ids;
    // normalize legacy bare forms ("github", "builtin.github") from in-flight
    // callers at this read boundary. Other subtabs pass through unchanged.
    const subtab =
      tab === "code-forge" && normalized.subtab !== undefined && normalized.subtab !== "general"
        ? (normalizeProviderId(normalized.subtab) ?? normalized.subtab)
        : normalized.subtab;
    setSettingsSubtab(subtab);
    setSettingsSectionId(normalized.sectionId);
    setIsSettingsOpen(true);
  }, []);

  useEffect(() => {
    const handleOpenSettingsTabEvent = (event: Event) => {
      const customEvent = event as CustomEvent<unknown>;
      const detail = customEvent.detail;
      const target: SettingsNavTarget =
        typeof detail === "string"
          ? { tab: detail as SettingsTab }
          : detail && typeof detail === "object" && "tab" in detail
            ? (detail as SettingsNavTarget)
            : { tab: "general" };
      handleOpenSettingsTab(target);
    };

    window.addEventListener("daintree:open-settings-tab", handleOpenSettingsTabEvent);
    return () =>
      window.removeEventListener("daintree:open-settings-tab", handleOpenSettingsTabEvent);
  }, [handleOpenSettingsTab]);

  return {
    isSettingsOpen,
    settingsTab,
    settingsSubtab,
    settingsSectionId,
    handleSettings,
    handleOpenSettingsTab,
    setIsSettingsOpen,
  };
}
