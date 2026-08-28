import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import { scrubReportText } from "@shared/utils/reportScrubbers";
import { TriangleAlert } from "lucide-react";

export interface ErrorFallbackProps {
  error: Error;
  errorInfo?: React.ErrorInfo;
  resetError: () => void;
  variant?: "fullscreen" | "section" | "component";
  componentName?: string;
  incidentId?: string | null;
  onReport?: () => void | Promise<void>;
  reportInFlight?: boolean;
}

const VARIANT_STYLES = {
  fullscreen: "h-screen w-screen flex items-center justify-center bg-surface-canvas",
  section: "h-full w-full flex items-center justify-center p-8",
  component:
    "p-4 rounded-[var(--radius-lg)] bg-[color-mix(in_oklab,var(--color-status-error)_12%,transparent)] border border-status-error/30",
} as const;

const VARIANT_SIZES = {
  fullscreen: {
    icon: "size-16",
    title: "text-2xl",
    message: "text-base",
    button: "px-6 py-3 text-base",
  },
  section: {
    icon: "size-9",
    title: "text-xl",
    message: "text-sm",
    button: "px-4 py-2 text-sm",
  },
  component: {
    icon: "size-6",
    title: "text-base",
    message: "text-xs",
    button: "px-3 py-1.5 text-xs",
  },
} as const;

export function ErrorFallback({
  error,
  errorInfo,
  resetError,
  variant = "component",
  componentName,
  incidentId,
  onReport,
  reportInFlight = false,
}: ErrorFallbackProps) {
  const sizes = VARIANT_SIZES[variant];
  const { copied: incidentIdCopied, copy: copyIncidentId } = useCopyWithFeedback({
    announcement: "Error ID copied",
  });

  const announcedRef = useRef(false);

  // Fullscreen carries role="alertdialog" + autoFocus on its primary button —
  // AT already gets a focus shift + accessible-name read, so a duplicate
  // announce() would over-narrate. Section/component variants are inline and
  // need an explicit live-region message.
  useEffect(() => {
    if (variant === "fullscreen" || announcedRef.current) return;
    announcedRef.current = true;
    const name = componentName || (variant === "section" ? "Section" : "Component");
    const msg = variant === "section" ? `${name} stopped working` : `${name} error`;
    useAnnouncerStore.getState().announce(msg, variant === "section" ? "assertive" : "polite");
  }, [variant, componentName]);

  const handleOpenLogs = () => {
    void actionService.dispatch("logs.openFile", undefined, { source: "user" });
  };

  const handleCopyIncidentId = () => {
    if (!incidentId) return;
    void copyIncidentId(incidentId);
  };

  const isFullscreen = variant === "fullscreen";

  return (
    <div
      className={cn(VARIANT_STYLES[variant])}
      data-testid="error-fallback"
      data-variant={variant}
      {...(isFullscreen
        ? {
            role: "alertdialog",
            "aria-modal": true,
            "aria-labelledby": "error-fallback-title",
          }
        : {})}
    >
      <div className="flex flex-col items-center gap-4 max-w-2xl">
        <TriangleAlert className={cn("text-status-error", sizes.icon)} />

        <div className="text-center space-y-2">
          <h2
            className={cn("font-semibold text-status-error", sizes.title)}
            data-testid="error-fallback-title"
            {...(isFullscreen ? { id: "error-fallback-title" } : {})}
          >
            {variant === "fullscreen" && "Daintree hit an unrecoverable error"}
            {variant === "section" && `${componentName || "Section"} stopped working`}
            {variant === "component" && `${componentName || "Component"} error`}
          </h2>

          <p className={cn("text-text-primary", sizes.message)}>
            {import.meta.env.DEV
              ? error.message
              : variant === "fullscreen"
                ? "The window can't continue. Reloading usually fixes it."
                : variant === "section"
                  ? "This pane crashed but the rest of Daintree is still running."
                  : `Couldn't render ${componentName || "this component"}. Try again, or reload the pane.`}
          </p>

          {!import.meta.env.DEV && incidentId && variant !== "component" && (
            <p className={cn("text-text-secondary font-mono break-all", sizes.message)}>
              Error ID:{" "}
              <button
                type="button"
                onClick={handleCopyIncidentId}
                aria-label="Copy error ID"
                data-testid="error-fallback-copy-id"
                className="cursor-copy hover:text-text-primary transition-colors text-left break-all"
              >
                {incidentIdCopied ? "Copied" : incidentId}
              </button>
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetError}
            data-testid="error-fallback-restart"
            autoFocus={isFullscreen}
            className={cn(
              "bg-status-error hover:bg-[color-mix(in_oklab,var(--color-status-error)_85%,transparent)] text-surface-canvas rounded transition-colors",
              sizes.button
            )}
          >
            {variant === "fullscreen"
              ? "Try again"
              : variant === "section"
                ? "Reload pane"
                : "Try again"}
          </button>

          {variant !== "component" && onReport && (
            <button
              type="button"
              onClick={onReport}
              disabled={reportInFlight}
              data-testid="error-fallback-report"
              className={cn(
                "bg-border-default hover:bg-daintree-border/80 text-text-primary rounded transition-colors",
                "disabled:opacity-60 disabled:cursor-not-allowed",
                sizes.button
              )}
            >
              Report issue
            </button>
          )}

          {variant !== "component" && (
            <button
              type="button"
              onClick={handleOpenLogs}
              data-testid="error-fallback-logs"
              className={cn(
                "bg-border-default hover:bg-daintree-border/80 text-text-primary rounded transition-colors",
                sizes.button
              )}
            >
              View logs
            </button>
          )}
        </div>

        {(error.stack || errorInfo?.componentStack) && variant !== "component" && (
          <details className="w-full mt-4">
            <summary className="cursor-pointer text-xs text-text-secondary hover:text-text-primary">
              Technical details
            </summary>
            {/* Production stacks are scrubbed before display so crash reporters
                never expose user paths or secrets; dev keeps the raw stack. */}
            <pre className="mt-2 p-3 bg-scrim-soft rounded text-xs text-status-error/80 overflow-auto max-h-48 select-text">
              {import.meta.env.DEV
                ? error.stack || "No stack trace available"
                : scrubReportText(error.stack || "No stack trace available")}
              {errorInfo?.componentStack && (
                <>
                  {"\n\nComponent Stack:\n"}
                  {import.meta.env.DEV
                    ? errorInfo.componentStack
                    : scrubReportText(errorInfo.componentStack)}
                </>
              )}
            </pre>
          </details>
        )}
      </div>
      {/* Co-located live region: fullscreen variant carries `aria-modal`, so
          VoiceOver suppresses external `aria-live` regions when
          `document.ariaNotify` is unavailable (Chromium 354736464). */}
      {isFullscreen && <AccessibilityAnnouncer />}
    </div>
  );
}
