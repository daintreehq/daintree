import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { SkeletonHint } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";

interface DevPreviewLoadingStateProps {
  variant: "full" | "overlay";
  isLoading: boolean;
  phaseLabel: string;
  onCancel?: () => void;
  className?: string;
}

function FullSkeleton({
  phaseLabel,
  isLoading,
  onCancel,
}: {
  phaseLabel: string;
  isLoading: boolean;
  onCancel?: () => void;
}) {
  const showSpinner = useDohertyGate(isLoading);

  return (
    <div className="relative flex flex-col items-center justify-center h-full bg-surface-canvas px-6">
      <div
        className="flex max-w-[28ch] flex-col items-center gap-3 text-center"
        role="status"
        aria-live="off"
        aria-label={phaseLabel}
      >
        <span className="sr-only">{phaseLabel}</span>

        {/* Spinner + visible caption gated by the Doherty threshold. The
            caption is aria-hidden. The phase is spoken by the hint below, so
            this status region is named but not live (`aria-live="off"`): two
            live regions carrying the same phase would announce it twice. */}
        {showSpinner && (
          <>
            <Spinner size="xl" className="text-daintree-text/45" />
            <p aria-hidden="true" className="text-sm text-text-secondary break-words">
              {phaseLabel}
            </p>
          </>
        )}
      </div>

      <SkeletonHint
        className="absolute bottom-8 inset-x-4 flex justify-center pointer-events-auto"
        message={phaseLabel}
        onCancel={onCancel}
      />
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
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-canvas">
      <div
        className="flex max-w-[28ch] flex-col items-center gap-3 text-center"
        role="status"
        aria-live="off"
        aria-label={phaseLabel}
      >
        <span className="sr-only">{phaseLabel}</span>

        {/* Visible caption only (aria-hidden). The wrapper is named but not
            live — the hint below speaks the phase, once. */}
        <Spinner size="xl" className="text-daintree-text/45" />
        <p aria-hidden="true" className="text-sm text-text-secondary break-words">
          {phaseLabel}
        </p>
      </div>

      <SkeletonHint
        className="absolute bottom-8 inset-x-4 flex justify-center pointer-events-auto"
        message={phaseLabel}
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
    <div className={cn("h-full", className)}>
      <FullSkeleton phaseLabel={phaseLabel} isLoading={isLoading} onCancel={onCancel} />
    </div>
  );
}
