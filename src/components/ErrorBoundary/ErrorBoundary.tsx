import React, { Component, type ReactNode } from "react";
import { ErrorFallback, type ErrorFallbackProps } from "./ErrorFallback";
import { useErrorStore } from "@/store/errorStore";
import { actionService } from "@/services/ActionService";

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
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
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

    this.setState({
      errorInfo,
    });

    try {
      useErrorStore.getState().addError({
        type: "unknown",
        message: error.message || "Component rendering error",
        details: `${error.stack || ""}\n\nComponent Stack:${errorInfo.componentStack || ""}`,
        source: componentName || "ErrorBoundary",
        context,
        isTransient: false,
      });
    } catch (storeError) {
      console.error("Failed to add error to store:", storeError);
    }

    if (onError) {
      try {
        onError(error, errorInfo);
      } catch (handlerError) {
        console.error("Error in onError handler:", handlerError);
      }
    }

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
    });
  };

  handleReport = (): void => {
    const { error, errorInfo } = this.state;
    const { componentName, context } = this.props;

    const issueBody = encodeURIComponent(
      `## Error Report\n\n` +
        `**Component:** ${componentName || "Unknown"}\n` +
        `**Message:** ${error?.message || "Unknown error"}\n\n` +
        `**Context:**\n` +
        `${context ? JSON.stringify(context, null, 2) : "None"}\n\n` +
        `**Stack Trace:**\n\`\`\`\n${error?.stack || "No stack trace"}\n\`\`\`\n\n` +
        `**Component Stack:**\n\`\`\`\n${errorInfo?.componentStack || "No component stack"}\n\`\`\``
    );

    const issueUrl = `https://github.com/gregpriday/canopy-electron/issues/new?title=${encodeURIComponent(`Component Error: ${error?.message || "Unknown"}`)}&body=${issueBody}`;

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
    const { hasError, error, errorInfo } = this.state;
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
          onReport={variant === "fullscreen" ? this.handleReport : undefined}
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
