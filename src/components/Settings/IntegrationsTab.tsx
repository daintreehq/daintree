import { EditorIntegrationTab } from "./EditorIntegrationTab";
import { ImageViewerTab } from "./ImageViewerTab";
import { VoiceInputSettingsTab } from "./VoiceInputSettingsTab";

export function IntegrationsTab() {
  return (
    <div className="space-y-8">
      <EditorIntegrationTab />
      <ImageViewerTab />
      <VoiceInputSettingsTab />
    </div>
  );
}
