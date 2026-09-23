import { useEffect, useRef } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { AccessibilityAnnouncer } from "@/components/Accessibility/AccessibilityAnnouncer";
import { scrubReportText } from "@shared/utils/reportScrubbers";
import { resolveBoundaryDisplayName } from "./boundaryDisplayName";
import { StackLines } from "./StackLines";
import { reloadWindow } from "./reloadWindow";

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

  // Once Try again has failed, the reload leads: offering the button that just
  // failed as the primary action is how a crash screen turns into a loop.
  const retried = retryCount > 0;
  const showReload = isFullscreen || retried;
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
    description =
      "Your terminals and agents are still running. Trying again didn't help, so reload the window.";
  } else if (isComponent) {
    description = "The rest of Daintree is still running.";
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
          isComponent && "max-w-md gap-2 @xs:gap-3"
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            "flex shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-overlay-subtle",
            isFullscreen ? "size-12" : isComponent ? "hidden size-8 @xs:flex" : "size-10"
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
              "text-text-secondary text-balance break-words",
              isFullscreen ? "text-sm" : isComponent ? "text-xs" : "text-xs @sm:text-sm"
            )}
            {...(isFullscreen ? { id: DESCRIPTION_ID } : {})}
          >
            {description}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          {retried && (
            <Button
              type="button"
              variant="contrast"
              size={isFullscreen ? "lg" : "sm"}
              onClick={reloadWindow}
              data-testid="error-fallback-reload-window"
              autoFocus={isFullscreen}
            >
              Reload window
            </Button>
          )}
          <Button
            type="button"
            variant={retried ? "subtle" : "contrast"}
            size={isFullscreen ? "lg" : "sm"}
            onClick={resetError}
            data-testid="error-fallback-restart"
            autoFocus={isFullscreen && !retried}
          >
            Try again
          </Button>
          {showReload && !retried && (
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
          {isComponent && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCopyDetails}
              data-testid="error-fallback-copy-details"
            >
              {detailsCopied ? "Copied" : "Copy details"}
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
                // loading, not disabled: a disabled button drops the focus the
                // user just put on it while enrichment is gathered.
                loading={reportInFlight}
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
          // Inline text rather than flex items, so a long ID wraps as one
          // centred run at its hyphens. The "Copied" confirmation hangs outside
          // the flow: reserving room for it would push the ID off-centre.
          <p className="max-w-full text-center text-xs text-text-secondary">
            Error ID{" "}
            <button
              type="button"
              onClick={() => void copyId(incidentId!)}
              aria-label="Copy error ID"
              data-testid="error-fallback-copy-id"
              className="relative inline cursor-copy rounded-[var(--radius-sm)] px-1 py-0.5 font-mono break-words hover:bg-overlay-soft hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              {incidentId}
              {idCopied ? (
                <Check className="ml-1.5 inline size-3.5 align-[-2px]" aria-hidden="true" />
              ) : (
                <Copy className="ml-1.5 inline size-3.5 align-[-2px]" aria-hidden="true" />
              )}
              {idCopied && (
                <span className="absolute top-1/2 left-full ml-1 -translate-y-1/2 font-sans whitespace-nowrap text-text-primary">
                  Copied
                </span>
              )}
            </button>
          </p>
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
                  size="sm"
                  onClick={handleCopyDetails}
                  data-testid="error-fallback-copy-details"
                >
                  {detailsCopied ? "Copied" : "Copy details"}
                </Button>
              </div>
              {/* Production stacks are scrubbed before display so crash reporters
                  never expose user paths or secrets; dev keeps the raw stack. */}
              <pre className="max-h-64 min-w-0 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-text-secondary select-text">
                <StackLines
                  text={
                    import.meta.env.DEV
                      ? error.stack || "No stack trace available"
                      : scrubReportText(error.stack || "No stack trace available")
                  }
                />
                {errorInfo?.componentStack && (
                  <StackLines
                    text={`\nComponent stack:${
                      import.meta.env.DEV
                        ? errorInfo.componentStack
                        : scrubReportText(errorInfo.componentStack)
                    }`}
                  />
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
