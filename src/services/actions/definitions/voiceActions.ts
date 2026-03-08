import type { ActionRegistry } from "../actionTypes";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

export function registerVoiceActions(actions: ActionRegistry): void {
  actions.set("voiceInput.toggle", () => ({
    id: "voiceInput.toggle",
    title: "Toggle Voice Dictation",
    description: "Start or stop dictation for the focused terminal input",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      await voiceRecordingService.toggleFocusedPanel();
    },
  }));
}
