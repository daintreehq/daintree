import { useCallback } from "react";
import { isMac } from "@/lib/platform";
import { KbdChord } from "@/components/ui/Kbd";
import { SettingsShortcutCapture } from "./SettingsShortcutCapture";
import type { BuiltInAgentId } from "@shared/config/agentIds";

export interface AgentShortcutCaptureProps {
  agentId: BuiltInAgentId;
  onCapture: (combo: string) => void;
  onCancel: () => void;
  /** Compact rendering for inline contexts like the agent tray dropdown. */
  compact?: boolean;
  /** The agent's binding in force now; `""` when it has none. */
  currentCombo?: string;
}

/**
 * The internal combo format uses "Cmd+" on every platform — SettingsShortcutCapture
 * maps ctrlKey to "Cmd" off macOS — so one pattern covers Cmd+Alt+letter on Mac
 * and Ctrl+Alt+letter elsewhere, and matches the stored bindings in
 * defaultKeybindings.ts.
 */
const AGENT_COMBO_PATTERN = /^Cmd\+Alt\+[A-Za-z]$/;

/**
 * SettingsShortcutCapture held to the agent-shortcut convention: one stroke of
 * Cmd+Alt+letter (Ctrl+Alt+letter off macOS), stated before the first attempt,
 * and never left sharing a combo with another action.
 */
export function AgentShortcutCapture({
  agentId,
  onCapture,
  onCancel,
  compact = false,
  currentCombo,
}: AgentShortcutCaptureProps) {
  const mac = isMac();

  const validateCombo = useCallback(
    (combo: string): string | null =>
      AGENT_COMBO_PATTERN.test(combo)
        ? null
        : `Agent shortcuts are ${mac ? "⌘⌥" : "Ctrl+Alt"} and a letter`,
    [mac]
  );

  return (
    <SettingsShortcutCapture
      onCapture={onCapture}
      onCancel={onCancel}
      excludeActionId={`agent.${agentId}`}
      validateCombo={validateCombo}
      compact={compact}
      autoStart
      currentCombo={currentCombo}
      singleStroke
      blockConflicts
      recordingHint={
        <span className="inline-flex items-center gap-1.5">
          Hold
          <KbdChord shortcut="Cmd+Alt" foreground="primary" />
          and press a letter
        </span>
      }
    />
  );
}
