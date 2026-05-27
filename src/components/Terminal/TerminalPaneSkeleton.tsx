import { SkeletonHint } from "@/components/ui/Skeleton";

interface TerminalPaneSkeletonProps {
  label?: string;
}

export function TerminalPaneSkeleton({ label = "Starting terminal" }: TerminalPaneSkeletonProps) {
  return (
    <div className="relative flex flex-col h-full w-full">
      <div
        className="flex flex-col h-full w-full"
        role="status"
        aria-busy="true"
        aria-label={label}
      >
        <span className="sr-only">{label}</span>

        {/* Header row — matches PanelHeader h-8 */}
        <div
          className="flex items-center justify-between px-3 shrink-0 h-8 border-b border-divider bg-surface"
          aria-hidden="true"
        >
          <div className="flex items-center gap-2">
            <div className="animate-pulse-delayed h-3.5 w-3.5 bg-muted rounded" />
            <div className="animate-pulse-delayed h-3 w-20 bg-muted rounded" />
          </div>
          <div className="flex items-center gap-1">
            <div className="animate-pulse-delayed h-4 w-4 bg-muted rounded" />
            <div className="animate-pulse-delayed h-4 w-4 bg-muted rounded" />
            <div className="animate-pulse-delayed h-4 w-4 bg-muted rounded" />
          </div>
        </div>

        {/* Body area — dark rectangle, no fake terminal lines */}
        <div className="flex-1 min-h-0 bg-daintree-bg" />
      </div>

      <SkeletonHint className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto" />
    </div>
  );
}
