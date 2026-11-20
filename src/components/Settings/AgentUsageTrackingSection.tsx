import { useRef, useState } from "react";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { SECTION_SETTINGS } from "./settingsSectionOwners";
import { useAgentUsageTrackingStore } from "@/store/agentUsageTrackingStore";
import { logError } from "@/utils/logger";

/**
 * One switch for every agent's usage tracking (#17981): the sidebar's Usage
 * section, and the background reads behind it on this machine and the hosts
 * it links to. What a person opens themselves (an agent's account quota, an
 * account picker's headroom) still reads while open.
 */
export function AgentUsageTrackingSection() {
  const enabled = useAgentUsageTrackingStore((state) => state.enabled);
  const setEnabled = useAgentUsageTrackingStore((state) => state.setEnabled);
  const [unsaved, setUnsaved] = useState<boolean | null>(null);
  const latestSave = useRef(0);
  // Drawn from the default until main answers.
  const isOn = enabled !== false;

  const save = (next: boolean) => {
    const attempt = ++latestSave.current;
    setUnsaved(null);
    setEnabled(next).catch((error: unknown) => {
      logError("Failed to save agent usage tracking", error);
      // A later save has the last word on what's shown.
      if (attempt === latestSave.current) setUnsaved(next);
    });
  };

  return (
    <SettingsSection id="agents-usage" title="Usage" settings={SECTION_SETTINGS.agentUsage}>
      {unsaved !== null && (
        <SettingsLoadErrorBanner
          title="Couldn't save that change"
          message="The switch shows what's saved now."
          onRetry={() => save(unsaved)}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          id="agents-usage-tracking"
          title="Track agent usage"
          subtitle="Shows each agent's usage in the sidebar, read in the background here and on linked hosts. An agent's account quota still reads when you open it."
          isEnabled={isOn}
          onChange={() => save(!isOn)}
          isModified={!isOn}
          onReset={() => save(true)}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
