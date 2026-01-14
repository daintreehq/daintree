import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type GitHubStatusIndicatorStatus = "idle" | "loading" | "success" | "error";

interface GitHubStatusIndicatorProps {
  status: GitHubStatusIndicatorStatus;
  error?: string;
  onTransitionEnd?: () => void;
}

export function GitHubStatusIndicator({
  status,
  error,
  onTransitionEnd,
}: GitHubStatusIndicatorProps) {
  const [internalStatus, setInternalStatus] = useState<GitHubStatusIndicatorStatus>(status);

  useEffect(() => {
    if (status === "success") {
      setInternalStatus("success");
      const timer = setTimeout(() => {
        setInternalStatus("idle");
        onTransitionEnd?.();
      }, 500);
      return () => clearTimeout(timer);
    }
    setInternalStatus(status);
    return undefined;
  }, [status, onTransitionEnd]);

  if (internalStatus === "idle") return null;

  return (
    <div
      className={cn(
        "absolute bottom-0 left-0 right-0 h-[1px] rounded-b-[var(--radius-md)]",
        internalStatus === "loading" && "overflow-hidden github-status-loading",
        internalStatus === "success" && "github-status-success",
        internalStatus === "error" && "github-status-error"
      )}
      role="status"
      aria-live="polite"
      aria-label={
        internalStatus === "loading"
          ? "Loading GitHub data"
          : internalStatus === "success"
            ? "GitHub data updated"
            : internalStatus === "error"
              ? `GitHub error: ${error ?? "Unknown error"}`
              : undefined
      }
    />
  );
}
