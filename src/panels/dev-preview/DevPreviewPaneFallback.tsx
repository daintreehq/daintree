import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { Skeleton, SkeletonHint } from "@/components/ui/Skeleton";

const LOADING_LABEL = "Loading dev preview panel";

export function DevPreviewPaneFallback(props: BasePanelProps) {
  return (
    <ContentPanel {...props} kind="dev-preview">
      <div className="relative h-full">
        <Skeleton label={LOADING_LABEL} className="h-full bg-surface-canvas" />
        <SkeletonHint className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto" />
      </div>
    </ContentPanel>
  );
}
