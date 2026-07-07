import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type ForgeStatusIndicatorStatus = "idle" | "loading" | "success" | "error";

interface ForgeStatusIndicatorProps {
  status: ForgeStatusIndicatorStatus;
  error?: string;
  onTransitionEnd?: () => void;
}

export function ForgeStatusIndicator({
  status,
  error,
  onTransitionEnd,
}: ForgeStatusIndicatorProps) {
  const [internalStatus, setInternalStatus] = useState<ForgeStatusIndicatorStatus>(status);

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

  return (
    <div
      className={cn(
        "absolute bottom-0 left-0 right-0 h-[1px] rounded-b-[var(--radius-md)] transition-opacity duration-150",
        internalStatus === "idle" && "opacity-0 pointer-events-none",
        internalStatus === "loading" && "overflow-hidden forge-status-loading",
        internalStatus === "success" && "forge-status-success",
        internalStatus === "error" && "forge-status-error"
      )}
      role="status"
      aria-live="polite"
      aria-label={
        internalStatus === "loading"
          ? "Loading repository data"
          : internalStatus === "success"
            ? "Repository data updated"
            : internalStatus === "error"
              ? `Repository error: ${error ?? "Unknown error"}`
              : undefined
      }
    />
  );
}
