import { useState } from "react";
import { BatteryMedium } from "lucide-react";
import { Coffee } from "@/components/icons";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { keepAwakeClient } from "@/clients/keepAwakeClient";
import { loadKeepAwakeState } from "@/hooks/useKeepAwakeSync";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import type { KeepAwakeConfig } from "@shared/types";

/**
 * Whether Daintree holds off idle sleep while agents work, and whether that
 * extends to battery power (#12516). The description reports what main is
 * doing right now rather than what the switches ask for, so it only changes
 * once main has acted.
 */
export function KeepAwakeSection() {
  const state = useKeepAwakeStore((s) => s.state);
  const loadError = useKeepAwakeStore((s) => s.loadError);
  const [pending, setPending] = useState<KeepAwakeConfig | null>(null);

  if (!state && !loadError) return null;

  // The patch holds absolute values, so "Try again" resends exactly what failed
  // rather than flipping whatever the switch shows by then.
  const save = async (patch: Partial<KeepAwakeConfig>) => {
    const current = useKeepAwakeStore.getState().state;
    if (!current || pending) return;
    setPending({ ...current.config, ...patch });
    try {
      const next = await keepAwakeClient.updateConfig(patch);
      useKeepAwakeStore.getState().applyState(next);
    } catch (error) {
      logError("Failed to update keep-awake config", error);
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Keep-awake couldn't be updated.",
        actions: [{ label: "Try again", variant: "primary", onClick: () => void save(patch) }],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      setPending(null);
    }
  };

  const config = pending ?? state?.config;

  return (
    <SettingsSection
      icon={Coffee}
      title="Keep awake"
      description={
        state?.isBlocking
          ? "Daintree is keeping this machine awake right now."
          : "Daintree isn't keeping this machine awake right now."
      }
      id="general-keep-awake"
    >
      {!config ? (
        <SettingsLoadErrorBanner
          title="Couldn't load keep-awake settings"
          message={loadError ?? ""}
          onRetry={() => void loadKeepAwakeState()}
        />
      ) : (
        <>
          <SettingsSwitchCard
            icon={Coffee}
            title="Keep awake while agents work"
            subtitle="Holds off idle sleep while an agent is working — the display can still turn off"
            isEnabled={config.enabled}
            onChange={() => void save({ enabled: !config.enabled })}
            ariaLabel="Keep Awake While Agents Work Toggle"
            disabled={pending !== null}
          />
          <SettingsSwitchCard
            icon={BatteryMedium}
            title="Keep awake on battery"
            subtitle="Also holds off idle sleep when this machine is unplugged, which drains its battery"
            isEnabled={config.onBattery}
            onChange={() => void save({ onBattery: !config.onBattery })}
            ariaLabel="Keep Awake On Battery Toggle"
            disabled={pending !== null || !config.enabled}
          />
        </>
      )}
    </SettingsSection>
  );
}
