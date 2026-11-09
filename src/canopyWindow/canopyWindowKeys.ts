import { keybindingService } from "@/services/KeybindingService";
import { buildKeybindingWhenContext } from "@/services/keybindingWhenContext";
import { isTerminalReservedKey } from "@/services/terminalReservedKeys";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { logError } from "@/utils/logger";

const WINDOW_KEYS = ["canopy.toggle", "voiceInput.toggle", "voiceInput.stopAndSend"] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];

function isWindowKey(actionId: string | undefined): actionId is WindowKey {
  return WINDOW_KEYS.some((key) => key === actionId);
}

/** One keystroke only, as in the dialog's reply: a chord's first key would type into the agent. */
function matchesTriggerCombo(event: KeyboardEvent, actionId: WindowKey): boolean {
  return keybindingService
    .getTriggerCombos(actionId)
    .some((combo) => !combo.includes(" ") && keybindingService.matchesEvent(event, combo));
}

/**
 * Canopy's key from inside its own window (#16578): back to the project window
 * the user was last in, with the Canopy window left where it stands. With no
 * project window open, nothing moves.
 */
export function returnToLastProjectWindow(): void {
  window.electron.canopyWindow.focusLastProjectWindow().catch((error: unknown) => {
    logError("[CanopyWindowKeys] Going back to a project window failed", error);
  });
}

/**
 * Canopy's key on one a focused terminal owns (Ctrl+E off the Mac) is the
 * shell's, as in a project window. The dictation keys reach the reply from
 * anywhere, the terminal included.
 */
function leftToTerminal(event: KeyboardEvent, actionId: WindowKey): boolean {
  if (actionId !== "canopy.toggle" || !isTerminalReservedKey(event)) return false;
  const target = event.target;
  return target instanceof Element && target.closest(".xterm") !== null;
}

async function runWindowKey(actionId: WindowKey): Promise<void> {
  try {
    if (actionId === "canopy.toggle") {
      returnToLastProjectWindow();
    } else if (actionId === "voiceInput.toggle") {
      await voiceRecordingService.toggleFocusedPanel({ returnToTarget: true });
    } else {
      await voiceRecordingService.stopAndSend();
    }
  } catch (error) {
    logError(`[CanopyWindowKeys] "${actionId}" failed`, error);
  }
}

/**
 * The Canopy window has no project shell, so none of its keybinding resolver
 * or action registry: these are the keys it answers, wherever the keyboard is.
 * Canopy's own key goes back to a project window, as a project window's comes
 * here. The dictation keys go to the selected agent's reply through the voice
 * service's routing, as in the Canopy dialog's agent pane, and the service's
 * own listeners hear a held key's release and the words main sends back.
 *
 * One listener and one resolver context for all of them: the context is a
 * single slot, which a second module's teardown would clear under this one.
 */
export function startCanopyWindowKeys(): () => void {
  // Started once per renderer and torn down with its module, as in a project
  // window. Its keydown listener goes first, so a press is on record before the
  // start below claims it for a hold.
  voiceRecordingService.initialize();
  // Stop-and-send takes its key only while there is a dictation or a send to
  // stop, and Canopy's key none while Canopy is hidden.
  keybindingService.setWhenContextProvider(buildKeybindingWhenContext);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || keybindingService.isCapturingShortcut()) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (!WINDOW_KEYS.some((key) => matchesTriggerCombo(event, key))) return;
    // The same keys may hold another binding that wins them, or one whose
    // condition fails: the key then goes on to the reply or the terminal.
    const result = keybindingService.resolveKeybinding(event);
    const actionId = result.match?.actionId;
    if (!isWindowKey(actionId) || leftToTerminal(event, actionId)) {
      if (result.chordPrefix) keybindingService.clearPendingChord();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void runWindowKey(actionId);
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    keybindingService.setWhenContextProvider(null);
  };
}
