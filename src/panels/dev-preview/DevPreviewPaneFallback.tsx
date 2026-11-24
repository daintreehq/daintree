import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { Skeleton, SkeletonHint } from "@/components/ui/Skeleton";

const LOADING_LABEL = "Loading dev preview panel";

export function DevPreviewPaneFallback(props: BasePanelProps) {
  return (
    <ContentPanel {...props} kind="dev-preview">
      <div className="relative flex flex-col h-full">
        {/* Reserves BrowserToolbar's 40px row (py-1.5 + h-7 bar) and its border so the viewport doesn't shift when DevPreviewPane mounts. Quiet like the canvas: no bones. */}
        <div className="shrink-0 bg-surface border-b border-overlay">
          <div data-testid="dev-preview-fallback-toolbar" className="h-10" />
        </div>
        <Skeleton label={LOADING_LABEL} className="flex-1 min-h-0 bg-surface-canvas" />
        <SkeletonHint className="absolute bottom-8 inset-x-4 flex justify-center pointer-events-auto" />
      </div>
    </ContentPanel>
  );
}
