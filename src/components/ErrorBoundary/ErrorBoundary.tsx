import React, { Component, type ReactNode } from "react";
import { ErrorFallback, type ErrorFallbackProps } from "./ErrorFallback";
import { useErrorStore } from "@/store/errorStore";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: React.ComponentType<ErrorFallbackProps>;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
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
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      incidentId: null,
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

    this.setState({
      errorInfo,
    });

    const correlationId = crypto.randomUUID();

    let incidentId: string | null = null;
    try {
      incidentId = useErrorStore.getState().addError({
        type: "unknown",
        message: error.message || "Component rendering error",
        details: `${error.stack || ""}\n\nComponent Stack:${componentStack}`,
        source: componentName || "ErrorBoundary",
        context,
        isTransient: false,
        correlationId,
      });
    } catch (storeError) {
      console.error("Failed to add error to store:", storeError);
    }

    this.setState({
      errorInfo,
      incidentId,
    });

    if (onError) {
      try {
        onError(error, errorInfo);
      } catch (handlerError) {
        console.error("Error in onError handler:", handlerError);
      }
    }

    logError("React error boundary caught render error", error, {
      correlationId,
      componentName: componentName || "ErrorBoundary",
      context,
      componentStack,
      incidentId,
    });

    console.error("ErrorBoundary caught error:", error, errorInfo);
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
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      incidentId: null,
    });
  };

  handleReport = (): void => {
    const { error, errorInfo, incidentId } = this.state;
    const { componentName, context } = this.props;

    const issueBody = encodeURIComponent(
      `## Error Report\n\n` +
        `**Component:** ${componentName || "Unknown"}\n` +
        `**Incident ID:** ${incidentId ?? "unknown"}\n` +
        `**Message:** ${error?.message || "Unknown error"}\n\n` +
        `**Context:**\n` +
        `${context ? JSON.stringify(context, null, 2) : "None"}\n\n` +
        `**Stack Trace:**\n\`\`\`\n${error?.stack || "No stack trace"}\n\`\`\`\n\n` +
        `**Component Stack:**\n\`\`\`\n${errorInfo?.componentStack || "No component stack"}\n\`\`\``
    );

    const issueUrl = `https://github.com/canopyide/canopy/issues/new?title=${encodeURIComponent(`Component Error: ${error?.message || "Unknown"}`)}&body=${issueBody}`;

    if (window.electron?.system?.openExternal) {
      actionService
        .dispatch("system.openExternal", { url: issueUrl }, { source: "user" })
        .then((result) => {
          if (!result.ok) {
            window.electron.system.openExternal(issueUrl);
          }
        })
        .catch(() => {
          window.electron.system.openExternal(issueUrl);
        });
    }
  };

  render(): ReactNode {
    const { hasError, error, errorInfo, incidentId } = this.state;
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
      resetKeys={options.resetKeys}
    >
      <Component {...props} />
    </ErrorBoundary>
  );

  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name || "Component"})`;

  return WrappedComponent;
}
