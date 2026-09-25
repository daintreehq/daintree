import { useRef, useState } from "react";

import { SettingsSection } from "@/components/Settings/SettingsSection";
import { useSettingsOwnerMarker } from "@/hooks/useSettingsOwner";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsDependents, SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { keepAwakeClient } from "@/clients/keepAwakeClient";
import { loadKeepAwakeState } from "@/hooks/useKeepAwakeSync";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type { KeepAwakeConfig } from "@shared/types";

/** Shown, locked, until main's state arrives — the stored defaults, and what reset returns to. */
const DEFAULT_CONFIG: KeepAwakeConfig = { enabled: true, onBattery: false };

interface SaveFailure {
  patch: Partial<KeepAwakeConfig>;
  message: string;
}

/**
 * Whether Daintree holds off idle sleep while agents work, and whether that
 * extends to battery power (#12516). The description reports what main is
 * doing right now rather than what the switches ask for, so it only changes
 * once main has acted.
 */
export function KeepAwakeSection() {
  // Each machine holds its own power assertion, so a remote window edits this one's.
  const ownerMarker = useSettingsOwnerMarker();
  const state = useKeepAwakeStore((s) => s.state);
  const loadError = useKeepAwakeStore((s) => s.loadError);
  const [pendingPatch, setPendingPatch] = useState<Partial<KeepAwakeConfig> | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const savingRef = useRef(false);

  // The patch holds absolute values, so a retry resends exactly what failed
  // rather than flipping whatever the switch shows by then. Promise chaining
  // rather than try/finally, which the React Compiler can't lower.
  const save = (patch: Partial<KeepAwakeConfig>): Promise<void> => {
    if (savingRef.current || !useKeepAwakeStore.getState().state) return Promise.resolve();
    savingRef.current = true;
    setPendingPatch(patch);
    setSaveFailure(null);
    return Promise.resolve()
      .then(() => keepAwakeClient.updateConfig(patch))
      .then(
        (next) => {
          useKeepAwakeStore.getState().applyState(next);
        },
        (error: unknown) => {
          logError("Failed to update keep-awake config", error);
          setSaveFailure({
            patch,
            message: formatErrorMessage(error, "The setting couldn't be written."),
          });
        }
      )
      .finally(() => {
        savingRef.current = false;
        setPendingPatch(null);
      });
  };

  // Only the field being saved is overridden, so a change another window makes
  // to the other one still shows while this save is in flight.
  const config = { ...(state?.config ?? DEFAULT_CONFIG), ...pendingPatch };
  const locked = state === null || pendingPatch !== null;

  return (
    <SettingsSection
      title="Keep awake"
      badge={ownerMarker("device")}
      description={
        <span role="status">
          {state === null
            ? "Whether Daintree keeps this machine awake while agents work"
            : state.isBlocking
              ? "Daintree is keeping this machine awake right now"
              : "Daintree isn't keeping this machine awake right now"}
        </span>
      }
      id="general-keep-awake"
    >
      {/* A failed load keeps the rows on screen, locked at their defaults, so the
          setting still reads as one this app has rather than vanishing. */}
      {state === null && loadError !== null && (
        <SettingsLoadErrorBanner
          title="Couldn't load keep-awake settings"
          message={loadError}
          onRetry={() => void loadKeepAwakeState()}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          title="Keep awake while agents work"
          subtitle="Holds off idle sleep while an agent is working — the display can still turn off"
          isEnabled={config.enabled}
          onChange={() => void save({ enabled: !config.enabled })}
          disabled={locked}
          isModified={state !== null && config.enabled !== DEFAULT_CONFIG.enabled}
          onReset={() => void save({ enabled: DEFAULT_CONFIG.enabled })}
        />
        <SettingsDependents
          disabled={state !== null && !config.enabled}
          reason="Turn on keep awake while agents work to extend it to battery power"
        >
          <SettingsSwitchCard
            title="Keep awake on battery"
            subtitle="Also holds off idle sleep when this machine is unplugged, which drains its battery"
            isEnabled={config.onBattery}
            onChange={() => void save({ onBattery: !config.onBattery })}
            disabled={locked}
            isModified={state !== null && config.onBattery !== DEFAULT_CONFIG.onBattery}
            onReset={() => void save({ onBattery: DEFAULT_CONFIG.onBattery })}
          />
        </SettingsDependents>
      </SettingsGroup>
      {saveFailure && (
        <SettingsLoadErrorBanner
          title="Couldn't save keep-awake setting"
          message={saveFailure.message}
          onRetry={() => void save(saveFailure.patch)}
        />
      )}
    </SettingsSection>
  );
}
