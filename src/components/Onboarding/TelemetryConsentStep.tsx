import { forwardRef } from "react";
import { Shield, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TelemetryConsentStepProps {
  onDismiss: (enabled: boolean) => void;
}

export const TelemetryConsentStep = forwardRef<HTMLHeadingElement, TelemetryConsentStepProps>(
  function TelemetryConsentStep({ onDismiss }, ref) {
    return (
      <div
        className={cn(
          "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-md",
          "bg-surface border border-canopy-border rounded-[var(--radius-lg)] shadow-xl p-4"
        )}
        role="dialog"
        aria-label="Crash reporting consent"
      >
        <div className="flex items-start gap-3">
          <Shield className="w-5 h-5 text-canopy-accent shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3
              ref={ref}
              tabIndex={-1}
              className="text-sm font-semibold text-canopy-text mb-1 focus:outline-hidden"
            >
              Help improve Canopy
            </h3>
            <p className="text-xs text-canopy-text/70 mb-3">
              Send anonymous crash reports when something goes wrong. No file contents, credentials,
              or personal data are ever collected.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void onDismiss(true)} className="flex-1">
                Enable
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onDismiss(false)}
                className="flex-1 text-canopy-text border-canopy-border hover:bg-canopy-border hover:text-canopy-text"
              >
                No thanks
              </Button>
            </div>
          </div>
          <button
            onClick={() => void onDismiss(false)}
            aria-label="Dismiss"
            className="text-canopy-text/40 hover:text-canopy-text transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }
);
