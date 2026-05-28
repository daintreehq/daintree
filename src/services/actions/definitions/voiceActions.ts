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
    keywords: ["dictate", "mic", "speech"],
    run: async () => {
      await voiceRecordingService.toggleFocusedPanel();
    },
  }));

  actions.set("voiceInput.toggleAssistant", () => ({
    id: "voiceInput.toggleAssistant",
    title: "Toggle Voice Dictation in Assistant",
    description: "Start or stop dictation in the Daintree Assistant from anywhere",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "speech", "assistant"],
    run: async () => {
      await voiceRecordingService.toggleAssistant();
    },
  }));

  actions.set("voiceInput.togglePause", () => ({
    id: "voiceInput.togglePause",
    title: "Pause or Resume Voice Dictation",
    description: "Suspend dictation without ending the session, or resume after pausing",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["pause", "resume", "dictate", "mic", "speech"],
    run: async () => {
      voiceRecordingService.togglePause();
    },
  }));
}
