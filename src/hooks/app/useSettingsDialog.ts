import { useCallback, useEffect, useState } from "react";
import type { SettingsTab, SettingsNavTarget } from "@/components/Settings";
import { isSettingsTab } from "@/components/Settings/settingsTabRegistry";

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
    let normalized = target;
    if (target.tab === "github") {
      if (import.meta.env.DEV) {
        console.warn(
          "[useSettingsDialog] stale tab ID 'github' normalized to 'code-forge' — update the call site"
        );
      }
      normalized = {
        tab: "code-forge",
        subtab: target.subtab ?? "github",
        sectionId: target.sectionId,
      };
    } else if (target.tab === "forge") {
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
    setSettingsSubtab(normalized.subtab);
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
