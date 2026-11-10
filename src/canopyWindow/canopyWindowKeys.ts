import { CLOSE_OWNER_ATTR, requestOwnedClose } from "@/lib/closeRequest";
import { keybindingService } from "@/services/KeybindingService";
import { buildKeybindingWhenContext } from "@/services/keybindingWhenContext";
import { isTerminalReservedKey } from "@/services/terminalReservedKeys";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { logError } from "@/utils/logger";

const WINDOW_KEYS = ["canopy.toggle", "voiceInput.toggle", "voiceInput.stopAndSend"] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];

/** Close Window's own key, as the menu has it, whatever `terminal.close` is bound to. */
const CLOSE_WINDOW_COMBO = "Cmd+W";

function isWindowKey(actionId: string | undefined): actionId is WindowKey {
  return WINDOW_KEYS.some((key) => key === actionId);
}

/** One keystroke only, as in the dialog's reply: a chord's first key would type into the agent. */
function matchesTriggerCombo(
  event: KeyboardEvent,
  actionId: WindowKey | "terminal.close"
): boolean {
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
 * Canopy's key is left to what is typed into, as in a project window: bound
 * without Cmd or Ctrl, it is typing in the reply, the search or the terminal,
 * and one a focused terminal owns (Ctrl+E off the Mac) is the shell's. The
 * dictation keys reach the reply from anywhere, the terminal included.
 */
function leftToTarget(event: KeyboardEvent, actionId: WindowKey): boolean {
  if (actionId !== "canopy.toggle") return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const inTerminal = target.closest(".xterm") !== null;
  const typedInto =
    inTerminal ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable;
  if (typedInto && !event.metaKey && !event.ctrlKey) return true;
  return inTerminal && isTerminalReservedKey(event);
}

/**
 * Cmd+W closes what the keyboard is in (#16618). In an agent's pane (its
 * terminal, its reply or its title bar) that is the agent's terminal, to the
 * trash, as on its grid pane, with the undo line and Z to take it back; the
 * pane takes `terminal.close` as the user has it bound. With no pane in hand,
 * Close Window's own key closes the window. Inside a pane it never does, even
 * when the pane can't take the close: a window left open all day, often on
 * another display, is the costly thing to lose. A key the terminal owns (Ctrl+W
 * off the Mac) is the shell's, and another binding that wins the key keeps it.
 */
function routeClose(
  event: KeyboardEvent,
  actionId: string | undefined,
  closesPane: boolean,
  closesWindow: boolean
): boolean {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (target?.closest(".xterm") && isTerminalReservedKey(event)) return false;
  if (target?.closest(`[${CLOSE_OWNER_ATTR}]`)) {
    if (!closesPane || actionId !== "terminal.close") return false;
    // Bound without Cmd or Ctrl, it is typing in the reply or the terminal.
    const typedInto =
      target.closest(".xterm") !== null ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (typedInto && !event.metaKey && !event.ctrlKey) return false;
    return requestOwnedClose(target);
  }
  if (!closesWindow || (actionId !== undefined && actionId !== "terminal.close")) return false;
  window.electron.window.close().catch((error: unknown) => {
    logError("[CanopyWindowKeys] Closing the Canopy window failed", error);
  });
  return true;
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
 * own listeners hear a held key's release and the words main sends back. Cmd+W
 * is main's to hand over, as in a project window, and closes the pane's
 * terminal or the window (see `routeClose`).
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
    const closesPane = matchesTriggerCombo(event, "terminal.close");
    const closesWindow = keybindingService.matchesEvent(event, CLOSE_WINDOW_COMBO);
    const answers =
      closesPane || closesWindow || WINDOW_KEYS.some((key) => matchesTriggerCombo(event, key));
    if (!answers) return;
    // The same keys may hold another binding that wins them, or one whose
    // condition fails: the key then goes on to the reply or the terminal.
    const result = keybindingService.resolveKeybinding(event);
    const actionId = result.match?.actionId;
    // A key that begins a chord and finishes nothing is the chord's: it goes on.
    if (result.chordPrefix && actionId === undefined) {
      keybindingService.clearPendingChord();
      return;
    }
    const handled = isWindowKey(actionId)
      ? !leftToTarget(event, actionId)
      : routeClose(event, actionId, closesPane, closesWindow);
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    if (isWindowKey(actionId)) void runWindowKey(actionId);
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    keybindingService.setWhenContextProvider(null);
  };
}
