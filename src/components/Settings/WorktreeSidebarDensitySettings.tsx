import {
  CARD_DENSITY_OPTIONS,
  DEFAULT_CARD_DENSITY,
} from "@/components/Worktree/cardDensityOptions";
import { SECTION_SETTINGS } from "@/components/Settings/settingsSectionOwners";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import { SettingsSection } from "./SettingsSection";

export const WORKTREE_SIDEBAR_SECTION_ID = "worktree-sidebar-density";

/** The same choice as the sidebar's right-click View menu, read from the same store. */
export function WorktreeSidebarDensitySettings() {
  const density = useWorktreeFilterStore((s) => s.cardDensity);
  const setDensity = useWorktreeFilterStore((s) => s.setCardDensity);

  return (
    <SettingsSection
      id={WORKTREE_SIDEBAR_SECTION_ID}
      title="Sidebar"
      settings={SECTION_SETTINGS.worktreeSidebar}
    >
      <SettingsGroup>
        <SettingsPresetGroup
          label="Density"
          description="Comfortable gives each fact about a worktree its own line. Compact fits more worktrees on screen. Also under View when you right-click the sidebar."
          options={CARD_DENSITY_OPTIONS}
          value={density}
          onChange={setDensity}
          isModified={density !== DEFAULT_CARD_DENSITY}
          onReset={() => setDensity(DEFAULT_CARD_DENSITY)}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
