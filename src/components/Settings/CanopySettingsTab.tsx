import { useCallback, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { CANOPY_BETA_TERMS } from "@/components/Canopy/canopyTerms";
import { useCanopyStore } from "@/store/canopyStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

export function CanopySettingsTab() {
  const snapshot = useCanopyStore((s) => s.snapshot);
  const applySnapshot = useCanopyStore((s) => s.applySnapshot);

  useEffect(() => {
    safeFireAndForget(window.electron.canopy.getSnapshot().then(applySnapshot), {
      context: "Reading whether Canopy is on",
    });
  }, [applySnapshot]);

  const activated = snapshot?.activated === true;
  const toggle = useCallback(() => {
    safeFireAndForget(window.electron.canopy.activate(!activated).then(applySnapshot), {
      context: "Turning Canopy on or off",
    });
  }, [activated, applySnapshot]);

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Canopy"
        description="One inbox of every agent, read off its screen. To read them, Canopy sends your agents' terminal output to Daintree's servers. It keeps reading while it's closed, so it can tell you when an agent is asking for you. Anything shaped like a password or key is stripped first."
        id="canopy-activation"
      >
        <SettingsGroup>
          <SettingsSwitchCard
            id="canopy-read-terminals"
            title="Read agent terminals"
            subtitle="Off, nothing leaves this computer and every reading is deleted."
            isEnabled={activated}
            onChange={toggle}
          />
          <SettingsRow
            id="canopy-plan"
            label="Plan"
            description={snapshot?.tier === "priority" ? "Paid" : CANOPY_BETA_TERMS}
            control={
              snapshot?.tier === "priority" ? (
                <span className="text-xs text-text-secondary">Paid</span>
              ) : (
                <Badge tone="warning" size="sm">
                  Beta
                </Badge>
              )
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
