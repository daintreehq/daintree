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
        aria-busy="true"
        aria-label={phaseLabel}
      >
        <span className="sr-only">{phaseLabel}</span>

        {/* Spinner + visible caption gated by the Doherty threshold. The
            caption is aria-hidden — the role=status wrapper above owns the AT
            announcement, and an aria-live here would be silenced by its
            aria-busy="true" anyway. The phase also flows through the hint. */}
        {showSpinner && (
          <>
            <Spinner size="xl" className="text-daintree-text/45" />
            <p aria-hidden="true" className="text-sm text-daintree-text/60 break-words">
              {phaseLabel}
            </p>
          </>
        )}
      </div>

      <SkeletonHint
        className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto"
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
        aria-busy="true"
        aria-label={phaseLabel}
      >
        <span className="sr-only">{phaseLabel}</span>

        {/* Visible caption only (aria-hidden) — the wrapper owns the AT
            announcement; the phase also flows through the hint. */}
        <Spinner size="xl" className="text-daintree-text/45" />
        <p aria-hidden="true" className="text-sm text-daintree-text/60 break-words">
          {phaseLabel}
        </p>
      </div>

      <SkeletonHint
        className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto"
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
