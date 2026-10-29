import { isActiveVoiceSession, type RecentDictation } from "@shared/types";
import { isPtyPanel } from "@shared/types/panel";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { useVoiceRecordingStore, type VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { getTerminalInputBlock } from "@/services/terminal/inputGate";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { requestPaneFocus } from "@/components/Terminal/paneFocusRequest";
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
import { useCanopyStore } from "@/store/canopyStore";
import { resolveCanopyReplyDictation } from "@/services/canopyReplyDictation";

/** The pill for sighted users and a polite announcement, as the other draft writes report. */
function report(message: TypingLocatorMessage): void {
  useTypingLocatorStore.getState().showLocator(message);
  useAnnouncerStore.getState().announce(formatTypingLocatorMessage(message), "polite");
}

/** Where a recovered dictation would go right now, or why it can't. */
export type RecentDictationDestination =
  | {
      ok: true;
      target: VoiceRecordingTarget;
      /** The pane, or the assistant or Canopy reply, as the user knows it. */
      label: string;
    }
  | {
      ok: false;
      /**
       * A lower-case clause, the condition before the pane it names so a long
       * title can't hide it: "input is locked in Claude".
       */
      reason: string;
    };

/** The destination as the palette names a dictation's source: "Claude · daintree / develop". */
export function describeDestination(target: VoiceRecordingTarget): string {
  const title = target.panelTitle?.trim() || "Untitled panel";
  const place = [target.projectName, target.worktreeLabel].filter(Boolean).join(" / ");
  return place ? `${title} · ${place}` : title;
}

/**
 * Where a recent dictation would be added if picked now, without adding it
 * (#14637, #15127): the palette and menu name it before the pick, and the
 * add re-checks it at the pick.
 *
 * Refused while that panel is still being dictated into or is sending a
 * dictation: a session's later words are placed by offsets into the draft
 * that text added under them would shift. Refused too where the draft isn't
 * this composer's alone: an armed fleet mirrors it into every armed agent,
 * and another screen driving the project replaces it with its own.
 */
export function resolveRecentDictationDestination(): RecentDictationDestination {
  // Canopy covers the grid while it's open: the dictation goes to the selected
  // row's reply, as the dictation key does, or nowhere.
  const reply = useCanopyStore.getState().isOpen ? resolveCanopyReplyDictation() : null;
  if (reply && !reply.ok) return { ok: false, reason: "select an agent in Canopy to reply to" };
  // Otherwise judged by where the user last worked, not by the palette or
  // menu that holds the keyboard now.
  const target = reply?.ok
    ? reply.target
    : voiceRecordingService.getFocusedComposerTarget(
        isAssistantFocused() || wasAssistantLastFocused()
      );
  if (!target) return { ok: false, reason: "focus an agent's input first" };
  const { panelId } = target;
  const title = target.panelTitle?.trim() || "that panel";

  const voice = useVoiceRecordingStore.getState();
  const dictatingHere =
    voice.pendingTarget?.panelId === panelId ||
    (voice.activeTarget?.panelId === panelId && isActiveVoiceSession(voice.status));
  if (dictatingHere) return { ok: false, reason: `dictation is still running in ${title}` };

  if (useTerminalInputStore.getState().isVoiceSubmitting(panelId)) {
    return { ok: false, reason: `a dictation is still sending in ${title}` };
  }
  // A reply's draft is its own: the pane's lock, fleet and driver don't reach it.
  if (!reply) {
    const panel = usePanelStore.getState().panelsById[panelId];
    if (panel && isPtyPanel(panel) && panel.isInputLocked === true) {
      return { ok: false, reason: `input is locked in ${title}` };
    }
    const armed = useFleetArmingStore.getState().armedIds;
    if (armed.size >= 2 && armed.has(panelId)) {
      return { ok: false, reason: `an armed fleet includes ${title}` };
    }
    if (getTerminalInputBlock()?.kind === "driven-elsewhere") {
      return { ok: false, reason: "another screen is driving this project" };
    }
  }
  return { ok: true, target, label: describeDestination(target) };
}

/**
 * Appends a recent dictation to the draft `resolveRecentDictationDestination`
 * names, never sending it (#14637). Returns the panel it went into, so the
 * caller can hand that composer the keyboard once its menu or palette has
 * closed, or null when it was refused (the pill says why).
 */
export function insertRecentDictation(
  dictation: RecentDictation,
  version: RecentDictationVersion = "cleaned"
): string | null {
  const destination = resolveRecentDictationDestination();
  if (!destination.ok) {
    report({ kind: "draft-refused", lead: `Not added to draft: ${destination.reason}` });
    return null;
  }
  const { panelId, projectId } = destination.target;
  const inputStore = useTerminalInputStore.getState();
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
    lead: version === "original" ? "Added original to draft in" : "Added to draft in",
    target: destination.label,
  });
  return panelId;
}

/**
 * Hands the keyboard to the composer a recovered dictation went into, the way
 * the type-anywhere rescue does: the input bar, not the terminal, even when the
 * terminal was last focused. Call it once the menu or palette has closed.
 */
export function focusRecoveredComposer(panelId: string): void {
  if (useCanopyStore.getState().isOpen) {
    const reply = resolveCanopyReplyDictation();
    if (reply.ok && reply.target.panelId === panelId) reply.focus();
    return;
  }
  const helpState = useHelpPanelStore.getState();
  // The assistant's composer lives in its own panel, which takes focus its way.
  if (selectActiveSlot(helpState).terminalId === panelId) {
    helpState.requestFocus();
    return;
  }
  requestPaneFocus(panelId, "hybridInput");
  focusPanelInput(panelId, "hybridInput");
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
