import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry } from "../actionTypes";
import {
  getLoadedVoiceRecordingService,
  loadVoiceRecordingService,
  takePendingVoiceShortcutPress,
} from "@/services/voiceRecordingRuntime";
import { resolveDictationTarget } from "@/services/voiceDictationTarget";
import { usePanelStore } from "@/store/panelStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { usePaletteStore } from "@/store/paletteStore";
import { notify } from "@/lib/notify";

// The service loads on first use; a voice key pressed while it couldn't yet
// listen is handed to it, so a hold still ends on release.
async function voiceForKey(ctx: ActionContext | undefined) {
  const service = await loadVoiceRecordingService();
  if (ctx?.dispatchSource === "keybinding") {
    service.adoptShortcutPress(takePendingVoiceShortcutPress());
  }
  return service;
}

const lockTargetArgsSchema = z.object({ panelId: z.string().optional() });
const recallRecentTargetArgsSchema = z.object({ panelId: z.string() });

export function registerVoiceActions(actions: ActionRegistry): void {
  actions.set("voiceInput.toggle", () => ({
    id: "voiceInput.toggle",
    title: "Toggle voice dictation",
    description:
      "Stop dictation wherever it is recording, whatever has focus; when idle, start it in the focused terminal input (or the locked panel)",
    paletteDescription:
      "Stop dictation wherever it's recording, or start it in the focused or locked input",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "speech"],
    run: async (_args: unknown, ctx) => {
      const service = await voiceForKey(ctx);
      // Only the key itself takes the person back to a dictation it stops (#14791).
      await service.toggleFocusedPanel({
        returnToTarget: ctx?.dispatchSource === "keybinding",
      });
    },
  }));

  actions.set("voiceInput.toggleAssistant", () => ({
    id: "voiceInput.toggleAssistant",
    title: "Toggle voice dictation in assistant",
    description: "Start or stop dictation in the Daintree Assistant from anywhere",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "speech", "assistant"],
    run: async (_args: unknown, ctx) => {
      await (await voiceForKey(ctx)).toggleAssistant();
    },
  }));

  actions.set("voiceInput.rewriteSelection", () => ({
    id: "voiceInput.rewriteSelection",
    title: "Rewrite selection by voice",
    description:
      'Record a spoken instruction ("make this shorter", "turn this into a list") and apply it to the text selected in the focused prompt; stops dictation if it is recording',
    paletteDescription:
      "Rewrite the selected prompt text by spoken instruction, or stop active dictation",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "speech", "rewrite", "rephrase", "edit", "command"],
    run: async (_args: unknown, ctx) => {
      await (await voiceForKey(ctx)).rewriteSelection();
    },
  }));

  actions.set("voiceInput.togglePause", () => ({
    id: "voiceInput.togglePause",
    title: "Pause or resume voice dictation",
    description: "Suspend dictation without ending the session, or resume after pausing",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["pause", "resume", "dictate", "mic", "speech"],
    run: async () => {
      (await loadVoiceRecordingService()).togglePause();
    },
  }));

  actions.set("voiceInput.stopAndSend", () => ({
    id: "voiceInput.stopAndSend",
    title: "Stop voice dictation and send",
    description:
      "Stop dictation and send the prompt it was dictating into, the way Enter would, without going to its terminal",
    paletteDescription: "Stop dictating and send the prompt, as Enter would",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "speech", "submit", "send", "stop"],
    run: async () => {
      await (await loadVoiceRecordingService()).stopAndSend();
    },
  }));

  actions.set("voiceInput.lockTarget", () => ({
    id: "voiceInput.lockTarget",
    title: "Lock voice dictation to panel",
    description: "Pin voice dictation to a specific panel so focus changes don't redirect it",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "lock", "pin", "fix"],
    argsSchema: lockTargetArgsSchema,
    run: async (args: unknown) => {
      const parsed = lockTargetArgsSchema.safeParse(args ?? {});
      const requestedId =
        (parsed.success ? parsed.data.panelId : undefined) ??
        usePanelStore.getState().focusedId ??
        undefined;
      if (!requestedId) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "transient",
          code: "lock_target_no_focus",
          message: "Focus a panel before locking dictation to it.",
        });
        useVoiceRecordingStore.getState().announce("Focus a panel before locking dictation to it.");
        return;
      }
      // Only a pane whose composer can show the words (#14955).
      const target = resolveDictationTarget(requestedId);
      if (!target) {
        const message = "Only an agent terminal's input can take dictation.";
        useVoiceRecordingStore.getState().setLastError({
          severity: "transient",
          code: "lock_target_unavailable",
          message,
        });
        useVoiceRecordingStore.getState().announce(`Dictation not locked. ${message}`);
        notify({
          type: "info",
          title: "Dictation not locked",
          message,
          transient: true,
          priority: "high",
          replaceKey: "voice-lock-target",
          context: { eventKind: "uiFeedback" },
        });
        return;
      }
      useVoiceRecordingStore.getState().lockTarget(target);
      useVoiceRecordingStore
        .getState()
        .announce(`Dictation locked to ${target.panelTitle ?? "this panel"}.`);
    },
  }));

  actions.set("voiceInput.unlockTarget", () => ({
    id: "voiceInput.unlockTarget",
    title: "Unlock voice dictation",
    description: "Release the pinned dictation target so voice follows focus again",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "unlock", "release"],
    run: async () => {
      const wasLocked = useVoiceRecordingStore.getState().lockedTarget;
      useVoiceRecordingStore.getState().unlockTarget();
      if (wasLocked) {
        useVoiceRecordingStore.getState().announce("Dictation unlocked.");
      }
    },
  }));

  actions.set("voiceInput.recallRecentTarget", () => ({
    id: "voiceInput.recallRecentTarget",
    title: "Toggle voice dictation on recent target",
    description: "Start or stop dictation on a recently used panel by id",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "recent", "history"],
    argsSchema: recallRecentTargetArgsSchema,
    run: async (args: unknown) => {
      const parsed = recallRecentTargetArgsSchema.safeParse(args);
      if (!parsed.success) return;
      const { panelId } = parsed.data;
      const refuse = () =>
        useVoiceRecordingStore.getState().setLastError({
          severity: "transient",
          code: "recall_target_unavailable",
          message: "That panel is no longer available for dictation.",
        });
      const target = resolveDictationTarget(panelId);
      if (!target) {
        // Only a start needs the composer: one already running there still stops.
        const stopping = getLoadedVoiceRecordingService()?.stopPanelDictation(panelId);
        if (stopping) {
          await stopping;
          return;
        }
        refuse();
        return;
      }
      const loaded = getLoadedVoiceRecordingService();
      const service = loaded ?? (await loadVoiceRecordingService());
      // The pane can go while the service loads.
      const current = loaded ? target : resolveDictationTarget(panelId);
      if (!current) {
        refuse();
        return;
      }
      await service.toggle(current);
    },
  }));

  // Opens the picker only: the text never rides on the action, so dispatch
  // logging and automation can't carry it.
  actions.set("voiceInput.openRecentDictations", () => ({
    id: "voiceInput.openRecentDictations",
    title: "Recover a recent dictation",
    description:
      "Pick one of this session's dictations to add to the focused input's draft or copy",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "dictation", "voice", "history", "recover", "copy", "transcript"],
    run: async () => {
      usePaletteStore.getState().openPalette("recent-dictations");
    },
  }));
}
