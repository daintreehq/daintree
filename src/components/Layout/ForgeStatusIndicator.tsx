import { cn } from "@/lib/utils";

export type ForgeStatusIndicatorStatus = "idle" | "loading" | "error";

interface ForgeStatusIndicatorProps {
  status: ForgeStatusIndicatorStatus;
  error?: string;
}

/**
 * A 2px bar inside the stats capsule, one pixel clear of its bottom border and
 * inset past the corner curves, so it reads as its own mark rather than the
 * border changing colour or a second rule beneath the first.
 */
export function ForgeStatusIndicator({ status, error }: ForgeStatusIndicatorProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-px left-[calc(var(--toolbar-pill-radius,var(--radius-md))-1px)] right-[calc(var(--toolbar-pill-radius,var(--radius-md))-1px)] h-0.5 rounded-full transition-opacity duration-150",
        status === "idle" && "opacity-0",
        status === "loading" && "overflow-hidden forge-status-loading",
        status === "error" && "forge-status-error"
      )}
      role="status"
      aria-live="polite"
      aria-label={
        status === "loading"
          ? "Loading repository data"
          : status === "error"
            ? `Repository error: ${error ?? "Unknown error"}`
            : undefined
      }
    />
  );
}
