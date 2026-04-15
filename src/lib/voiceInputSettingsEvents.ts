import type { VoiceInputSettings } from "@shared/types";

export const VOICE_INPUT_SETTINGS_CHANGED_EVENT = "daintree:voice-input-settings-changed";

export function dispatchVoiceInputSettingsChanged(settings: VoiceInputSettings): void {
  window.dispatchEvent(
    new CustomEvent<VoiceInputSettings>(VOICE_INPUT_SETTINGS_CHANGED_EVENT, {
      detail: settings,
    })
  );
}
