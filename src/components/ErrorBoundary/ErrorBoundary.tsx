import React, { Component, type ReactNode } from "react";
import { ErrorFallback, type ErrorFallbackProps } from "./ErrorFallback";
import { useErrorStore } from "@/store/errorStore";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { captureRendererException } from "@/utils/rendererSentry";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { buildReportIssueUrl } from "./buildReportIssueUrl";
import type { PluginDiagnosticsSnapshot } from "../../../shared/types/plugin";
import { notify } from "@/lib/notify";

// Upper bound on how long the report path waits for the plugin diagnostics
// snapshot before proceeding without it. Generous for serializing ≤500
// capped-message lines; guards the Report button from a stalled IPC call.
const PLUGIN_DIAGNOSTICS_TIMEOUT_MS = 2000;

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: React.ComponentType<ErrorFallbackProps>;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  onReset?: () => void;
  resetKeys?: Array<string | number>;
  variant?: "fullscreen" | "section" | "component";
  componentName?: string;
  context?: {
    worktreeId?: string;
    terminalId?: string;
  };
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  incidentId: string | null;
  reportInFlight: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // Synchronous guard against same-tick double-clicks on "Report issue".
  // setState is batched, so two clicks in one event tick can both observe
  // `state.reportInFlight === false`. The class field flips synchronously
  // and prevents the underlying async chain from firing twice; the React
  // state drives the visible `disabled` prop on the button.
  private reportInFlight = false;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      incidentId: null,
      reportInFlight: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const { onError, context, componentName } = this.props;
    const componentStack = errorInfo.componentStack || "";

    const correlationId = crypto.randomUUID();

    const sentryEventId = captureRendererException(error, {
      tags: {
        source: "react-error-boundary",
        component: componentName ?? "ErrorBoundary",
      },
      contexts: { react: { componentStack } },
      extra: { correlationId, ...(context ?? {}) },
    });

    let storeIncidentId: string | null = null;
    try {
      storeIncidentId = useErrorStore.getState().addError({
        type: "unknown",
        message: error.message || "Component rendering error",
        details: `${error.stack || ""}\n\nComponent Stack:${componentStack}`,
        source: componentName || "ErrorBoundary",
        context,
        retryability: "none",
        correlationId,
      });
    } catch (storeError) {
      logError("Failed to add error to store", storeError);
    }

    // Prefer the Sentry event ID for the user-visible "Error ID" — engineers
    // can search Sentry by it directly. Fall back to the error-store ID when
    // Sentry isn't initialized so users always have *something* to quote.
    const incidentId = sentryEventId ?? storeIncidentId;

    this.setState({
      errorInfo,
      incidentId,
    });

    if (onError) {
      try {
        onError(error, errorInfo);
      } catch (handlerError) {
        logError("Error in onError handler", handlerError);
      }
    }

    logError("React error boundary caught render error", error, {
      correlationId,
      componentName: componentName || "ErrorBoundary",
      context,
      componentStack,
      incidentId,
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    const { resetKeys } = this.props;
    const { hasError } = this.state;

    if (hasError && resetKeys) {
      const prevResetKeys = prevProps.resetKeys || [];
      const hasResetKeyChanged =
        resetKeys.length !== prevResetKeys.length ||
        resetKeys.some((key, index) => key !== prevResetKeys[index]);

      if (hasResetKeyChanged) {
        this.resetError();
      }
    }
  }

  resetError = (): void => {
    const { onReset } = this.props;

    if (onReset) {
      try {
        onReset();
      } catch (error) {
        logError("Error in onReset handler", error);
      }
    }

    // Reset the synchronous class-field guard alongside state so a hung
    // report from the previous error session doesn't permanently disable
    // the Report issue button after recovery.
    this.reportInFlight = false;
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      incidentId: null,
      reportInFlight: false,
    });
  };

  handleReport = async (): Promise<void> => {
    if (this.reportInFlight) return;
    this.reportInFlight = true;
    this.setState({ reportInFlight: true });
    try {
      const { error, errorInfo, incidentId } = this.state;
      const { componentName, context } = this.props;

      if (!error) return;

      // Best-effort plugin diagnostics — if the bridge is missing, the call
      // fails, or it stalls (a plugin spamming huge logs could slow snapshot
      // serialization), the report still opens without the plugin section.
      // The race against a 2s timeout guards the `reportInFlight` reset in the
      // outer finally from being blocked by a never-resolving IPC call.
      let pluginDiagnostics: PluginDiagnosticsSnapshot | undefined;
      try {
        const fetchDiagnostics = window.electron?.plugin?.getDiagnostics();
        pluginDiagnostics = fetchDiagnostics
          ? await Promise.race([
              fetchDiagnostics,
              new Promise<undefined>((resolve) =>
                setTimeout(() => resolve(undefined), PLUGIN_DIAGNOSTICS_TIMEOUT_MS)
              ),
            ])
          : undefined;
      } catch {
        pluginDiagnostics = undefined;
      }

      const { url, fullBody, usedClipboardFallback } = buildReportIssueUrl({
        incidentId,
        componentName,
        message: error.message,
        stack: error.stack ?? "",
        componentStack: errorInfo?.componentStack ?? "",
        context,
        pluginDiagnostics,
      });

      if (usedClipboardFallback) {
        const writeText = window.electron?.clipboard?.writeText;
        let clipboardOk = false;
        if (writeText) {
          try {
            await writeText(fullBody);
            clipboardOk = true;
          } catch (clipboardError) {
            logError("Failed to copy crash report to clipboard", clipboardError);
          }
        }
        if (clipboardOk) {
          notify({
            type: "info",
            title: "Error details copied",
            message:
              "The full crash report was copied to your clipboard — paste it into the issue body.",
            transient: true,
          });
        } else {
          notify({
            type: "info",
            title: "Error details too long",
            message:
              "Couldn't copy the full report. Quote the Error ID shown above when filing the issue.",
            inboxMessage: "Couldn't copy crash report to clipboard.",
          });
        }
      }

      if (!window.electron?.system?.openExternal) return;

      try {
        const result = await actionService.dispatch(
          "system.openExternal",
          { url },
          { source: "user" }
        );
        if (!result.ok) {
          safeFireAndForget(window.electron.system.openExternal(url), {
            context: "ErrorBoundary.handleReport openExternal fallback",
          });
        }
      } catch {
        safeFireAndForget(window.electron.system.openExternal(url), {
          context: "ErrorBoundary.handleReport openExternal fallback",
        });
      }
    } finally {
      this.reportInFlight = false;
      this.setState({ reportInFlight: false });
    }
  };

  render(): ReactNode {
    const { hasError, error, errorInfo, incidentId, reportInFlight } = this.state;
    const { children, fallback: FallbackComponent, variant, componentName } = this.props;

    if (hasError && error) {
      const Fallback = FallbackComponent || ErrorFallback;

      return (
        <Fallback
          error={error}
          errorInfo={errorInfo || undefined}
          resetError={this.resetError}
          variant={variant}
          componentName={componentName}
          incidentId={incidentId}
          onReport={variant !== "component" ? this.handleReport : undefined}
          reportInFlight={reportInFlight}
        />
      );
    }

    return children;
  }
}

export interface WithErrorBoundaryOptions {
  variant?: "fullscreen" | "section" | "component";
  componentName?: string;
  context?: {
    worktreeId?: string;
    terminalId?: string;
  };
  onReset?: () => void;
  resetKeys?: Array<string | number>;
}

export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  options: WithErrorBoundaryOptions = {}
): React.ComponentType<P> {
  const WrappedComponent = (props: P) => (
    <ErrorBoundary
      variant={options.variant || "component"}
      componentName={options.componentName || Component.displayName || Component.name}
      context={options.context}
      onReset={options.onReset}
      resetKeys={options.resetKeys}
    >
      <Component {...props} />
    </ErrorBoundary>
  );

  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name || "Component"})`;

  return WrappedComponent;
}
