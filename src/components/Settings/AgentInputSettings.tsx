import { useEffect, useState } from "react";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsDependents } from "./SettingsGroup";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import type { SettingsPresetOption } from "./SettingsPresetGroup";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { SECTION_SETTINGS } from "./settingsSectionOwners";
import { useTerminalInputStore } from "@/store";
import { actionService } from "@/services/ActionService";
import { logError, logWarn } from "@/utils/logger";
import type { ActionId } from "@shared/types/actions";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import {
  refreshUploadPreferences,
  setInterceptCtrlVImages,
  shouldInterceptCtrlVImages,
} from "@/components/Terminal/uploads/ctrlVImagePaste";

type FocusTarget = "hybrid" | "terminal";

const FOCUS_OPTIONS: readonly SettingsPresetOption<FocusTarget>[] = [
  { value: "hybrid", label: "Hybrid input" },
  { value: "terminal", label: "Terminal" },
];

async function dispatchSetting(actionId: ActionId, args: unknown): Promise<void> {
  const result = await actionService.dispatch(actionId, args, { source: "user" });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

/**
 * Ctrl+V in an agent terminal of a window attached to a remote host sends this
 * machine's clipboard image. Shown only once remote hosts are in use.
 */
function RemoteClipboardImagesRow() {
  const [inUse, setInUse] = useState(false);
  const [enabled, setEnabled] = useState(shouldInterceptCtrlVImages);
  useEffect(() => {
    if (!isRemoteShellSupported()) return;
    let cancelled = false;
    const check = async () => {
      if (!(await window.electron.remoteHosts.isInUse()) || cancelled) return;
      await refreshUploadPreferences();
      if (cancelled) return;
      setEnabled(shouldInterceptCtrlVImages());
      setInUse(true);
    };
    check().catch((error: unknown) =>
      logWarn("[AgentInputSettings] Remote hosts check failed", { error })
    );
    return () => {
      cancelled = true;
    };
  }, []);
  if (!inUse) return null;
  const update = (next: boolean) => {
    setEnabled(next);
    setInterceptCtrlVImages(next).catch((error: unknown) => {
      setEnabled(!next);
      logError("[AgentInputSettings] Failed to save the Ctrl+V image setting", error);
    });
  };
  return (
    <SettingsSwitchCard
      id="agents-remote-clipboard-images"
      title="Send my clipboard images to remote agents on Ctrl+V"
      subtitle="In a window attached to another machine, an agent's Ctrl+V gets the image on this computer's clipboard instead of the host's. With no image on the clipboard, Ctrl+V goes to the agent unchanged."
      isEnabled={enabled}
      onChange={() => update(!enabled)}
      isModified={!enabled}
      onReset={() => update(true)}
    />
  );
}

/**
 * Where typing goes in agent terminals. Global to every agent, so it sits beside
 * "All agents" rather than inside it: that section promises each agent's page can
 * override its settings, and these can't be overridden.
 */
export function AgentInputSettings() {
  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((state) => state.hybridInputAutoFocus);
  const [retry, setRetry] = useState<(() => void) | null>(null);

  // The actions roll their own value back on failure, so the banner only offers the same write again.
  const persist = async (actionId: ActionId, args: unknown, logMessage: string): Promise<void> => {
    try {
      await dispatchSetting(actionId, args);
      setRetry(null);
    } catch (error) {
      logError(logMessage, error);
      setRetry(() => () => void persist(actionId, args, logMessage));
    }
  };

  const setHybridInputEnabled = (enabled: boolean) =>
    persist(
      "terminalConfig.setHybridInputEnabled",
      { enabled },
      "Failed to persist hybrid input setting"
    );

  const setHybridInputAutoFocus = (enabled: boolean) =>
    persist(
      "terminalConfig.setHybridInputAutoFocus",
      { enabled },
      "Failed to persist hybrid input focus setting"
    );

  return (
    <SettingsSection
      id="agents-input"
      title="Input"
      description="Applies to every agent"
      settings={SECTION_SETTINGS.agentInput}
    >
      {retry && (
        <SettingsLoadErrorBanner
          title="Couldn't save that change"
          message="The setting is back to its previous value."
          onRetry={retry}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          id="agents-hybrid-input"
          title="Hybrid input"
          subtitle="Show the multi-line input at the bottom of agent terminals"
          isEnabled={hybridInputEnabled}
          onChange={() => void setHybridInputEnabled(!hybridInputEnabled)}
          isModified={!hybridInputEnabled}
          onReset={() => void setHybridInputEnabled(true)}
        />
        <SettingsDependents
          disabled={!hybridInputEnabled}
          reason="Turn on the hybrid input to choose where agent panes put the keyboard"
        >
          <SettingsPresetGroup
            id="agents-hybrid-focus"
            label="Focus first"
            description="Where switching to an agent pane puts the keyboard, with the terminal taking it when the hybrid input can't. Files dropped on the terminal of a pane you aren't typing in go there too. Clicking either one only changes that pane."
            options={FOCUS_OPTIONS}
            value={hybridInputAutoFocus ? "hybrid" : "terminal"}
            onChange={(value) => void setHybridInputAutoFocus(value === "hybrid")}
            isModified={!hybridInputAutoFocus}
            onReset={() => void setHybridInputAutoFocus(true)}
          />
        </SettingsDependents>
        <RemoteClipboardImagesRow />
      </SettingsGroup>
    </SettingsSection>
  );
}
