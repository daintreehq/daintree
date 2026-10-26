import { isActiveVoiceSession, type RecentDictation } from "@shared/types";
import { isPtyPanel } from "@shared/types/panel";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { getTerminalInputBlock } from "@/services/terminal/inputGate";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { selectActiveSlot, useHelpPanelStore } from "@/store/helpPanelStore";
import { wasAssistantLastFocused } from "@/lib/composerSurface";
import {
  formatTypingLocatorMessage,
  useTypingLocatorStore,
  type TypingLocatorMessage,
} from "@/store/typingLocatorStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { recentDictationText, type RecentDictationVersion } from "@/store/recentDictationsStore";
import { copyWithToast } from "@/lib/copyWithToast";

/** The pill for sighted users and a polite announcement, as the other draft writes report. */
function report(message: TypingLocatorMessage): void {
  useTypingLocatorStore.getState().showLocator(message);
  useAnnouncerStore.getState().announce(formatTypingLocatorMessage(message), "polite");
}

function refuse(why: string): null {
  report({ kind: "draft-refused", lead: `Not added to draft: ${why}` });
  return null;
}

/**
 * Appends a recent dictation to the focused composer's draft, never sending
 * it (#14637). Returns the panel it went into, so the caller can hand that
 * composer the keyboard once its menu or palette has closed, or null when it
 * was refused (the pill says why).
 *
 * Refused while that panel is still being dictated into or is sending a
 * dictation: a session's later words are placed by offsets into the draft
 * that text added under them would shift. Refused too where the draft isn't
 * this composer's alone: an armed fleet mirrors it into every armed agent,
 * and another screen driving the project replaces it with its own.
 */
export function insertRecentDictation(
  dictation: RecentDictation,
  version: RecentDictationVersion = "cleaned"
): string | null {
  // Judged by where the user last worked, not by the palette or menu that
  // holds the keyboard now.
  const target = voiceRecordingService.getFocusedComposerTarget(
    isAssistantFocused() || wasAssistantLastFocused()
  );
  if (!target) return refuse("focus an agent's input first");
  const { panelId, projectId } = target;

  const voice = useVoiceRecordingStore.getState();
  const dictatingHere =
    voice.pendingTarget?.panelId === panelId ||
    (voice.activeTarget?.panelId === panelId && isActiveVoiceSession(voice.status));
  if (dictatingHere) return refuse("dictation is still running there");

  const inputStore = useTerminalInputStore.getState();
  if (inputStore.isVoiceSubmitting(panelId)) return refuse("that agent is sending dictation");
  const panel = usePanelStore.getState().panelsById[panelId];
  if (panel && isPtyPanel(panel) && panel.isInputLocked === true) {
    return refuse("that agent's input is locked");
  }
  const armed = useFleetArmingStore.getState().armedIds;
  if (armed.size >= 2 && armed.has(panelId)) return refuse("that agent is in an armed fleet");
  if (getTerminalInputBlock()?.kind === "driven-elsewhere") {
    return refuse("another screen is driving this project");
  }

  const draft = inputStore.getDraftInput(panelId, projectId);
  const separator = draft && !/\s$/.test(draft) ? " " : "";
  inputStore.setDraftInput(
    panelId,
    draft + separator + recentDictationText(dictation, version),
    projectId
  );
  inputStore.bumpExternalDraftRevision();

  report({
    kind: "draft-added",
    lead: "Added to draft in",
    ...(target.panelTitle ? { target: target.panelTitle } : {}),
  });
  return panelId;
}

/**
 * Hands the keyboard to the composer a recovered dictation went into, the way
 * the type-anywhere rescue does: the input bar, not the terminal, even when the
 * terminal was last focused. Call it once the menu or palette has closed.
 */
export function focusRecoveredComposer(panelId: string): void {
  const helpState = useHelpPanelStore.getState();
  // The assistant's composer lives in its own panel, which takes focus its way.
  if (selectActiveSlot(helpState).terminalId === panelId) {
    helpState.requestFocus();
    return;
  }
  usePanelStore.getState().setPreferredTerminalFocusTarget("hybridInput");
  focusPanelInput(panelId);
}

/**
 * Puts a recent dictation on the clipboard through the menu-row copy gesture:
 * the pick closes its menu or palette, so a "Copied" flash and announcement
 * confirm it, and a refusal is a toast with Retry.
 */
export function copyRecentDictation(
  dictation: RecentDictation,
  version: RecentDictationVersion = "cleaned"
): void {
  copyWithToast("Dictation", recentDictationText(dictation, version));
}
