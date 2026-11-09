import { keybindingService } from "@/services/KeybindingService";
import { buildKeybindingWhenContext } from "@/services/keybindingWhenContext";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { logError } from "@/utils/logger";

const DICTATION_KEYS = ["voiceInput.toggle", "voiceInput.stopAndSend"] as const;
type DictationKey = (typeof DICTATION_KEYS)[number];

function isDictationKey(actionId: string | undefined): actionId is DictationKey {
  return DICTATION_KEYS.some((key) => key === actionId);
}

/** One keystroke only, as in the dialog's reply: a chord's first key would type into the agent. */
function matchesTriggerCombo(event: KeyboardEvent, actionId: DictationKey): boolean {
  return keybindingService
    .getTriggerCombos(actionId)
    .some((combo) => !combo.includes(" ") && keybindingService.matchesEvent(event, combo));
}

async function runDictationKey(actionId: DictationKey): Promise<void> {
  try {
    if (actionId === "voiceInput.toggle") {
      await voiceRecordingService.toggleFocusedPanel({ returnToTarget: true });
    } else {
      await voiceRecordingService.stopAndSend();
    }
  } catch (error) {
    logError(`[CanopyWindowDictation] "${actionId}" failed`, error);
  }
}

/**
 * The Canopy window has no project shell, so none of its keybinding resolver
 * or action registry: the dictation keys are the ones it answers, wherever the
 * keyboard is, as the Canopy dialog's agent pane does. The voice service's
 * routing sends them to the selected agent's reply, and its own listeners hear
 * a held key's release and the words main sends back.
 */
export function startCanopyWindowDictation(): () => void {
  // Started once per renderer and torn down with its module, as in a project window.
  voiceRecordingService.initialize();
  // Stop-and-send takes its key only while there is a dictation or a send to stop.
  keybindingService.setWhenContextProvider(buildKeybindingWhenContext);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || keybindingService.isCapturingShortcut()) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (!DICTATION_KEYS.some((key) => matchesTriggerCombo(event, key))) return;
    // The same keys may hold another binding that wins them, or one whose
    // condition fails: the key then goes on to the reply or the terminal.
    const result = keybindingService.resolveKeybinding(event);
    const actionId = result.match?.actionId;
    if (!isDictationKey(actionId)) {
      if (result.chordPrefix) keybindingService.clearPendingChord();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void runDictationKey(actionId);
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    keybindingService.setWhenContextProvider(null);
  };
}
