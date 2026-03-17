import { createPortal } from "react-dom";

interface OnboardingProgressIndicatorProps {
  currentIndex: number;
  total: number;
}

export function OnboardingProgressIndicator({
  currentIndex,
  total,
}: OnboardingProgressIndicatorProps) {
  return createPortal(
    <div
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[var(--z-toast)] pointer-events-none"
      role="group"
      aria-label="Onboarding progress"
      data-testid="onboarding-progress"
    >
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            data-testid={`progress-dot-${i}`}
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              i === currentIndex
                ? "bg-canopy-accent"
                : i < currentIndex
                  ? "bg-canopy-text/30"
                  : "bg-canopy-text/15"
            }`}
            aria-current={i === currentIndex ? "step" : undefined}
          />
        ))}
      </div>
      <span className="sr-only">
        Step {currentIndex + 1} of {total}
      </span>
    </div>,
    document.body
  );
}
