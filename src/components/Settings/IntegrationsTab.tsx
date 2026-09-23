import { EditorIntegrationTab } from "./EditorIntegrationTab";
import { ImageViewerTab } from "./ImageViewerTab";

export function IntegrationsTab() {
  return (
    <div className="space-y-8">
      <EditorIntegrationTab />
      <ImageViewerTab />
    </div>
  );
}
