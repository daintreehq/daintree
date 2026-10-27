import { useRef, useState } from "react";
import { SettingsDependents, SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import {
  SettingsPresetGroup,
  type SettingsPresetOption,
} from "@/components/Settings/SettingsPresetGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { useTerminalInputStore } from "@/store";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import type { ActionId } from "@shared/types/actions";

type FocusTarget = "hybrid" | "terminal";

const FOCUS_OPTIONS: readonly SettingsPresetOption<FocusTarget>[] = [
  { value: "hybrid", label: "Hybrid input" },
  { value: "terminal", label: "Terminal" },
];

/**
 * The two Settings → Agents → Input choices, put in front of a new user. Read
 * from and written through the same store and actions as that page, so a pick
 * here is the setting itself rather than a copy committed on Continue, and
 * clicking straight through writes nothing.
 */
export function AgentInputStep({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((state) => state.hybridInputAutoFocus);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  // A second pick can land before the busy state renders; the ref turns it away.
  const writingRef = useRef(false);

  // The actions roll their own value back on failure, so the banner only offers the same write again.
  const persist = async (actionId: ActionId, enabled: boolean): Promise<void> => {
    if (writingRef.current) return;
    writingRef.current = true;
    onBusyChange(true);
    try {
      const result = await actionService.dispatch(actionId, { enabled }, { source: "user" });
      if (!result.ok) throw new Error(result.error.message);
      setRetry(null);
    } catch (error) {
      logError("Failed to persist a hybrid input setting from setup", error);
      setRetry(() => () => void persist(actionId, enabled));
    } finally {
      writingRef.current = false;
      onBusyChange(false);
    }
  };

  return (
    <section className="space-y-3">
      {retry && (
        <SettingsLoadErrorBanner
          title="Couldn't save that change"
          message="The setting is back to its previous value."
          onRetry={retry}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          title="Hybrid input"
          subtitle="Show the multi-line input at the bottom of agent terminals. With it off, you type straight into the agent's own prompt, and dictation and file references stop working there."
          isEnabled={hybridInputEnabled}
          onChange={() => void persist("terminalConfig.setHybridInputEnabled", !hybridInputEnabled)}
        />
        <SettingsDependents
          disabled={!hybridInputEnabled}
          reason="Turn on the hybrid input to choose where agent panes put the keyboard"
        >
          <SettingsPresetGroup
            label="Focus first"
            description="Where the keyboard goes when you switch to an agent terminal or click into an unfocused one"
            options={FOCUS_OPTIONS}
            value={hybridInputAutoFocus ? "hybrid" : "terminal"}
            onChange={(value) => {
              const enabled = value === "hybrid";
              if (enabled === hybridInputAutoFocus) return;
              void persist("terminalConfig.setHybridInputAutoFocus", enabled);
            }}
          />
        </SettingsDependents>
      </SettingsGroup>
      <p className="text-xs text-text-secondary">
        You can change these anytime in Settings → Agents → Input
      </p>
    </section>
  );
}
