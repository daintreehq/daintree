import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { SkeletonHint } from "@/components/ui/Skeleton";

interface DevPreviewLoadingStateProps {
  variant: "full" | "overlay";
  isLoading: boolean;
  phaseLabel: string;
  onCancel?: () => void;
  className?: string;
}

function SkeletonBone({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`bg-muted rounded animate-pulse-delayed ${className ?? ""}`}
    />
  );
}

function FullSkeleton({ phaseLabel, isLoading }: { phaseLabel: string; isLoading: boolean }) {
  const showPhaseLabel = useDohertyGate(isLoading);

  return (
    <div className="relative flex flex-col items-center justify-center h-full bg-daintree-bg px-6">
      <div
        className="flex flex-col items-center w-full max-w-md"
        role="status"
        aria-busy="true"
        aria-label={phaseLabel}
      >
        <span className="sr-only">{phaseLabel}</span>

        <div className="w-full flex flex-col gap-4" aria-hidden="true">
          <SkeletonBone className="h-3.5 w-3/4" />
          <div className="space-y-2">
            <SkeletonBone className="h-3 w-full" />
            <SkeletonBone className="h-3 w-5/6" />
            <SkeletonBone className="h-3 w-2/3" />
          </div>
          <div className="space-y-2 mt-3">
            <SkeletonBone className="h-2.5 w-full" />
            <SkeletonBone className="h-2.5 w-4/5" />
            <SkeletonBone className="h-2.5 w-3/5" />
          </div>
        </div>

        {showPhaseLabel && (
          <p aria-live="polite" className="mt-6 text-xs text-daintree-text/60">
            {phaseLabel}
          </p>
        )}
      </div>

      <SkeletonHint className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto" />
    </div>
  );
}

function OverlaySkeleton({
  phaseLabel,
  isLoading,
  onCancel,
}: {
  phaseLabel: string;
  isLoading: boolean;
  onCancel?: () => void;
}) {
  const showOverlay = useDohertyGate(isLoading);

  if (!showOverlay) return null;

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-daintree-bg">
      <div
        className="flex flex-col items-center gap-3"
        role="status"
        aria-busy="true"
        aria-label={phaseLabel}
      >
        <span className="sr-only">{phaseLabel}</span>

        <p aria-live="polite" className="text-xs text-daintree-text/60">
          {phaseLabel}
        </p>
      </div>

      <SkeletonHint
        className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto"
        onCancel={onCancel}
      />
    </div>
  );
}

export function DevPreviewLoadingState({
  variant,
  isLoading,
  phaseLabel,
  onCancel,
  className,
}: DevPreviewLoadingStateProps) {
  if (variant === "overlay") {
    return <OverlaySkeleton phaseLabel={phaseLabel} isLoading={isLoading} onCancel={onCancel} />;
  }

  return (
    <div className={className}>
      <FullSkeleton phaseLabel={phaseLabel} isLoading={isLoading} />
    </div>
  );
}
