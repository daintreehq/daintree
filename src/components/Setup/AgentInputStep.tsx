import { useRef, useState } from "react";
import { useIsPresent } from "framer-motion";
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

type FocusTarget = "hybrid" | "terminal";

type InputAction =
  "terminalConfig.setHybridInputEnabled" | "terminalConfig.setHybridInputAutoFocus";

interface FailedWrite {
  actionId: InputAction;
  enabled: boolean;
}

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
  const savedHybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);
  const savedHybridInputAutoFocus = useTerminalInputStore((state) => state.hybridInputAutoFocus);
  // A step animating out is still clickable, but the lock it holds goes with it.
  const isPresent = useIsPresent();
  // The newest pick of each setting until its write settles. A queued write
  // only reaches the store when it runs, and a choice that didn't show would
  // leave the next click acting on the one before it.
  const [picked, setPicked] = useState<Partial<Record<InputAction, boolean>>>({});
  const hybridInputEnabled =
    picked["terminalConfig.setHybridInputEnabled"] ?? savedHybridInputEnabled;
  const hybridInputAutoFocus =
    picked["terminalConfig.setHybridInputAutoFocus"] ?? savedHybridInputAutoFocus;
  const [failed, setFailed] = useState<FailedWrite | null>(null);
  const inFlightRef = useRef(0);
  const latestAttemptRef = useRef<Partial<Record<InputAction, number>>>({});
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const write = async (actionId: InputAction, enabled: boolean, attempt: number) => {
    try {
      const result = await actionService.dispatch(actionId, { enabled }, { source: "user" });
      if (!result.ok) throw new Error(result.error.message);
      if (latestAttemptRef.current[actionId] === attempt) {
        setFailed((prev) => (prev?.actionId === actionId ? null : prev));
      }
    } catch (error) {
      logError("Failed to persist a hybrid input setting from setup", error);
      if (latestAttemptRef.current[actionId] === attempt) setFailed({ actionId, enabled });
    } finally {
      if (latestAttemptRef.current[actionId] === attempt) {
        setPicked((prev) => ({ ...prev, [actionId]: undefined }));
      }
      inFlightRef.current -= 1;
      if (inFlightRef.current === 0) onBusyChange(false);
    }
  };

  // One write at a time. Each action rolls back to the value it found when it
  // ran, which is only the saved value while no other write is in flight; a
  // pick made meanwhile waits its turn rather than being dropped. Only the
  // newest pick of a setting decides whether a retry is on offer.
  const persist = (actionId: InputAction, enabled: boolean) => {
    if (!isPresent) return;
    const attempt = (latestAttemptRef.current[actionId] ?? 0) + 1;
    latestAttemptRef.current[actionId] = attempt;
    setPicked((prev) => ({ ...prev, [actionId]: enabled }));
    inFlightRef.current += 1;
    onBusyChange(true);
    queueRef.current = queueRef.current.then(() => write(actionId, enabled, attempt));
  };

  // Nothing is left to retry once the setting reads the pick (another window
  // saved it), or once the focus choice is out of reach.
  const retry =
    failed &&
    (failed.actionId === "terminalConfig.setHybridInputEnabled"
      ? hybridInputEnabled !== failed.enabled
      : hybridInputEnabled && hybridInputAutoFocus !== failed.enabled)
      ? failed
      : null;

  return (
    <section className="space-y-3">
      {retry && (
        <SettingsLoadErrorBanner
          title="Couldn't save that change"
          message="The setting is back to its previous value."
          onRetry={() => persist(retry.actionId, retry.enabled)}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          title="Hybrid input"
          subtitle="Show the multi-line input at the bottom of agent terminals. With it off, you type straight into the agent's own prompt, without dictation or Insert file reference."
          isEnabled={hybridInputEnabled}
          onChange={() => persist("terminalConfig.setHybridInputEnabled", !hybridInputEnabled)}
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
              persist("terminalConfig.setHybridInputAutoFocus", enabled);
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
