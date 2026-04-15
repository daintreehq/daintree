import { useCallback, useEffect, useState } from "react";
import type { SettingsTab, SettingsNavTarget } from "@/components/Settings";

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
    const allowedTabs: SettingsTab[] = [
      "general",
      "keyboard",
      "terminal",
      "terminalAppearance",
      "worktree",
      "agents",
      "github",
      "portal",
      "toolbar",
      "notifications",
      "integrations",

      "mcp",
      "environment",
      "privacy",
      "troubleshooting",
      "project:general",
      "project:context",
      "project:automation",
      "project:recipes",
      "project:commands",
      "project:notifications",
      "project:github",
    ];
    const tab = allowedTabs.includes(target.tab as SettingsTab)
      ? (target.tab as SettingsTab)
      : "general";
    setSettingsTab(tab);
    setSettingsSubtab(target.subtab);
    setSettingsSectionId(target.sectionId);
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
