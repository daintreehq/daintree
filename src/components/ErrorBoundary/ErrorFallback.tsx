import { useEffect, useRef } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { scrubReportText } from "@shared/utils/reportScrubbers";
import { resolveBoundaryDisplayName } from "./boundaryDisplayName";

export interface ErrorFallbackProps {
  error: Error;
  errorInfo?: React.ErrorInfo;
  resetError: () => void;
  variant?: "fullscreen" | "section" | "component";
  componentName?: string;
  /** A name people recognise ("Panel grid", a branch name). Defaults from `componentName`. */
  displayName?: string;
  incidentId?: string | null;
  onReport?: () => void | Promise<void>;
  reportInFlight?: boolean;
  /** How many times this boundary has already been reset. Past zero, offer a window reload. */
  retryCount?: number;
}

const TITLE_ID = "error-fallback-title";
const DESCRIPTION_ID = "error-fallback-description";

/**
 * The text behind "Copy details". Production scrubs every line, message
 * included, because this is exactly what gets pasted into a public issue.
 */
function buildDetailsText(
  error: Error,
  errorInfo: React.ErrorInfo | undefined,
  incidentId: string | null | undefined,
  name: string
): string {
  const scrub = (text: string) => (import.meta.env.DEV ? text : scrubReportText(text));
  const lines = [`${name} stopped working`];
  if (incidentId) lines.push(`Error ID: ${incidentId}`);
  lines.push("", scrub(error.stack || error.message || "No stack trace available"));
  if (errorInfo?.componentStack) {
    lines.push("", "Component stack:", scrub(errorInfo.componentStack.replace(/^\n+/, "")));
  }
  return lines.join("\n");
}

function reloadWindow() {
  safeFireAndForget(
    actionService
      .dispatch("window.reload", undefined, { source: "user" })
      .then((result) => (result.ok ? undefined : window.electron?.window?.reload?.())),
    { context: "ErrorFallback reload window" }
  );
}

function openLogs() {
  void actionService.dispatch("logs.openFile", undefined, { source: "user" });
}

export function ErrorFallback({
  error,
  errorInfo,
  resetError,
  variant = "component",
  componentName,
  displayName,
  incidentId,
  onReport,
  reportInFlight = false,
  retryCount = 0,
}: ErrorFallbackProps) {
  const isFullscreen = variant === "fullscreen";
  const isComponent = variant === "component";
  const name = resolveBoundaryDisplayName(
    displayName,
    componentName,
    variant === "section" ? "This area" : "This panel"
  );
  const { copied: idCopied, copy: copyId } = useCopyWithFeedback({
    announcement: "Error ID copied",
  });
  const { copied: detailsCopied, copy: copyDetails } = useCopyWithFeedback({
    announcement: "Error details copied",
  });

  const announcedRef = useRef(false);

  // Fullscreen carries role="alertdialog" + autoFocus on its primary button —
  // AT already gets a focus shift + accessible-name read, so a duplicate
  // announce() would over-narrate. Section/component variants are inline and
  // need an explicit live-region message.
  useEffect(() => {
    if (isFullscreen || announcedRef.current) return;
    announcedRef.current = true;
    useAnnouncerStore
      .getState()
      .announce(`${name} stopped working`, variant === "section" ? "assertive" : "polite");
  }, [isFullscreen, name, variant]);

  const escalated = isFullscreen || retryCount > 0;
  const showIncidentId = !import.meta.env.DEV && !!incidentId;
  const hasDetails = !!(error.stack || errorInfo?.componentStack);

  const title = isFullscreen ? "Daintree couldn't display this window" : `${name} stopped working`;

  let description: string;
  if (import.meta.env.DEV) {
    description = error.message;
  } else if (isFullscreen) {
    description =
      retryCount > 0
        ? "Your terminals and agents are still running. Trying again didn't help, so reload the window."
        : "Your terminals and agents are still running. Try again to rebuild the window.";
  } else if (retryCount > 0) {
    description = "Still not working? Reload the window. Your terminals and agents keep running.";
  } else if (isComponent) {
    description = "Try again to reload it.";
  } else {
    description = "Your terminals and agents are still running. Try again to reload this area.";
  }

  const handleCopyDetails = () => {
    void copyDetails(buildDetailsText(error, errorInfo, incidentId, name));
  };

  return (
    <div
      className={cn(
        "@container w-full",
        isFullscreen &&
          "flex h-screen w-screen overflow-y-auto bg-surface-canvas px-6 py-10 text-text-primary",
        variant === "section" && "flex h-full overflow-y-auto px-4 py-6 @md:px-8",
        isComponent && "flex h-full min-h-full overflow-y-auto px-4 py-4"
      )}
      data-testid="error-fallback"
      data-variant={variant}
      {...(isFullscreen
        ? {
            role: "alertdialog",
            "aria-modal": true,
            "aria-labelledby": TITLE_ID,
            "aria-describedby": DESCRIPTION_ID,
          }
        : {})}
    >
      <div
        className={cn(
          "m-auto flex w-full min-w-0 flex-col items-center text-center",
          isFullscreen && "max-w-xl gap-5",
          variant === "section" && "max-w-lg gap-4",
          isComponent && "max-w-md gap-3"
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            "flex shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-overlay-subtle",
            isFullscreen ? "size-12" : isComponent ? "size-8" : "size-10"
          )}
        >
          <TriangleAlert
            className={cn(
              "text-status-error",
              isFullscreen ? "size-6" : isComponent ? "size-4" : "size-5"
            )}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <h2
            className={cn(
              "font-semibold text-text-primary text-balance",
              isFullscreen ? "text-xl" : isComponent ? "text-sm" : "text-base"
            )}
            data-testid="error-fallback-title"
            {...(isFullscreen ? { id: TITLE_ID } : {})}
          >
            {title}
          </h2>
          <p
            className={cn(
              "text-text-secondary text-pretty break-words",
              isFullscreen ? "text-sm" : "text-xs @sm:text-sm"
            )}
            {...(isFullscreen ? { id: DESCRIPTION_ID } : {})}
          >
            {description}
          </p>
        </div>

        <div className="flex w-full flex-col items-stretch gap-2 @xs:w-auto @xs:flex-row @xs:flex-wrap @xs:items-center @xs:justify-center">
          <Button
            type="button"
            variant="contrast"
            size={isFullscreen ? "lg" : "sm"}
            onClick={resetError}
            data-testid="error-fallback-restart"
            autoFocus={isFullscreen}
          >
            Try again
          </Button>
          {escalated && (
            <Button
              type="button"
              variant="subtle"
              size={isFullscreen ? "lg" : "sm"}
              onClick={reloadWindow}
              data-testid="error-fallback-reload-window"
            >
              Reload window
            </Button>
          )}
        </div>

        {!isComponent && (
          <div className="flex flex-wrap items-center justify-center gap-1">
            {onReport && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onReport}
                disabled={reportInFlight}
                data-testid="error-fallback-report"
              >
                Report issue
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openLogs}
              data-testid="error-fallback-logs"
            >
              View logs
            </Button>
          </div>
        )}

        {showIncidentId && !isComponent && (
          <div className="flex max-w-full flex-wrap items-center justify-center gap-x-1.5 text-xs text-text-secondary">
            <span>Error ID</span>
            <button
              type="button"
              onClick={() => void copyId(incidentId!)}
              aria-label="Copy error ID"
              data-testid="error-fallback-copy-id"
              className="group inline-flex min-w-0 max-w-full cursor-copy items-center gap-1.5 rounded-[var(--radius-sm)] px-1 py-0.5 text-left font-mono break-words hover:bg-overlay-soft hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              <span className="min-w-0 break-words">{incidentId}</span>
              <span className="inline-flex w-16 shrink-0 items-center gap-1 font-sans">
                {idCopied ? (
                  <>
                    <Check className="size-3.5 shrink-0" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <Copy className="size-3.5 shrink-0" aria-hidden="true" />
                )}
              </span>
            </button>
          </div>
        )}

        {isComponent && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleCopyDetails}
            data-testid="error-fallback-copy-details"
          >
            {detailsCopied ? "Copied" : "Copy details"}
          </Button>
        )}

        {hasDetails && !isComponent && (
          <details className="group w-full min-w-0 text-left">
            <summary className="mx-auto w-fit cursor-pointer rounded-[var(--radius-sm)] px-1 text-xs text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary">
              Technical details
            </summary>
            <div className="mt-3 flex flex-col gap-2 rounded-[var(--radius-md)] border border-divider bg-surface-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-text-secondary">
                  {import.meta.env.DEV ? "Stack trace" : "Stack trace, with personal paths removed"}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handleCopyDetails}
                  data-testid="error-fallback-copy-details"
                >
                  {detailsCopied ? "Copied" : "Copy details"}
                </Button>
              </div>
              {/* Production stacks are scrubbed before display so crash reporters
                  never expose user paths or secrets; dev keeps the raw stack. */}
              <pre className="max-h-64 min-w-0 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-text-secondary select-text">
                {import.meta.env.DEV
                  ? error.stack || "No stack trace available"
                  : scrubReportText(error.stack || "No stack trace available")}
                {errorInfo?.componentStack && (
                  <>
                    {"\n\nComponent stack:"}
                    {import.meta.env.DEV
                      ? errorInfo.componentStack
                      : scrubReportText(errorInfo.componentStack)}
                  </>
                )}
              </pre>
            </div>
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
