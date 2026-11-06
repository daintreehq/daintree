import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";

/**
 * Voice: an explanation only. Dictation is the phone app's own setting;
 * this says where it's controlled and where the encryption stops.
 */
export function DecisionsVoiceSection() {
  return (
    <SettingsSection title="Voice" id="decisions-voice">
      <SettingsGroup>
        <SettingsRow
          id="decisions-voice-dictation"
          label="Dictating answers"
          description="It's a setting in the phone app, off until you turn it on there, and it isn't end-to-end encrypted: a speech provider hears what you say and a correction provider reads the transcript with the question. The answer you send is still encrypted."
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
