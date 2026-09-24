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
const AGENT_MODIFIERS = ["Cmd", "Alt"];

/**
 * Keeps teaching the rule while modifiers are down, so following the live text
 * never leads into a rejection: release what is extra, add what is missing, and
 * only then ask for the letter.
 */
function agentHeldHint(held: string[]) {
  const extra = held.filter((mod) => !AGENT_MODIFIERS.includes(mod));
  if (extra.length > 0) {
    return (
      <span className="inline-flex items-center gap-1.5">
        Release
        <KbdChord shortcut={extra.join("+")} />
      </span>
    );
  }
  const missing = AGENT_MODIFIERS.filter((mod) => !held.includes(mod));
  if (missing.length > 0) {
    return (
      <span className="inline-flex items-center gap-1.5">
        Add
        <KbdChord shortcut={missing.join("+")} />
      </span>
    );
  }
  return "Now press a letter";
}

function validateAgentCombo(combo: string) {
  if (AGENT_COMBO_PATTERN.test(combo)) return null;
  // Key caps rather than raw glyphs, so the reason is spoken as key names.
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      Agent shortcuts are
      <KbdChord shortcut="Cmd+Alt" />
      and a letter
    </span>
  );
}

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
  return (
    <SettingsShortcutCapture
      onCapture={onCapture}
      onCancel={onCancel}
      excludeActionId={`agent.${agentId}`}
      validateCombo={validateAgentCombo}
      compact={compact}
      autoStart
      currentCombo={currentCombo}
      singleStroke
      blockConflicts
      heldHint={agentHeldHint}
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
