import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { SkeletonHint, useLiveRegionReady } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";

interface PaneLoadingStateProps {
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
  const ready = useLiveRegionReady();

  return (
    <div className="relative flex flex-col items-center justify-center h-full bg-surface-canvas px-6">
      <div
        className="flex max-w-[28ch] flex-col items-center gap-3 text-center"
        role="status"
        aria-live="polite"
        aria-label={phaseLabel}
      >
        {/* Filled once the wait clears the Doherty gate, a commit after the
            region mounted, so it is announced once. The hint below speaks
            only when the wait escalates. */}
        <span className="sr-only">{ready && showSpinner ? phaseLabel : ""}</span>

        {/* Spinner + visible caption gated by the Doherty threshold. The
            caption is aria-hidden; the span above carries the phase. */}
        {showSpinner && (
          <>
            <Spinner size="xl" className="text-text-secondary" />
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
  return <OverlayBody phaseLabel={phaseLabel} onCancel={onCancel} />;
}

function OverlayBody({ phaseLabel, onCancel }: { phaseLabel: string; onCancel?: () => void }) {
  const ready = useLiveRegionReady();

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-canvas">
      <div
        className="flex max-w-[28ch] flex-col items-center gap-3 text-center"
        role="status"
        aria-live="polite"
        aria-label={phaseLabel}
      >
        {/* Announced once as the overlay appears; the hint below speaks only
            when the wait escalates. */}
        <span className="sr-only">{ready ? phaseLabel : ""}</span>

        {/* Visible caption only (aria-hidden). */}
        <Spinner size="xl" className="text-text-secondary" />
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

export function PaneLoadingState({
  variant,
  isLoading,
  phaseLabel,
  onCancel,
  className,
}: PaneLoadingStateProps) {
  if (variant === "overlay") {
    return <OverlaySkeleton phaseLabel={phaseLabel} isLoading={isLoading} onCancel={onCancel} />;
  }

  return (
    <div className={cn("h-full", className)}>
      <FullSkeleton phaseLabel={phaseLabel} isLoading={isLoading} onCancel={onCancel} />
    </div>
  );
}
