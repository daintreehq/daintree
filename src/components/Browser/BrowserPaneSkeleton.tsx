interface BrowserPaneSkeletonProps {
  label?: string;
}

export function BrowserPaneSkeleton({ label = "Loading browser panel" }: BrowserPaneSkeletonProps) {
  return (
    <div className="flex flex-col h-full w-full" role="status" aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}</span>

      {/* Header row — matches PanelHeader h-8 in grid location */}
      <div
        className="flex items-center justify-between px-3 shrink-0 h-8 border-b border-divider bg-surface"
        aria-hidden="true"
      >
        <div className="flex items-center gap-2">
          <div className="animate-pulse-delayed h-3.5 w-3.5 bg-muted rounded" />
          <div className="animate-pulse-delayed h-3 w-24 bg-muted rounded" />
        </div>
        <div className="flex items-center gap-1">
          <div className="animate-pulse-delayed h-4 w-4 bg-muted rounded" />
          <div className="animate-pulse-delayed h-4 w-4 bg-muted rounded" />
        </div>
      </div>

      {/* Toolbar row — matches BrowserToolbar layout */}
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 bg-surface border-b border-overlay shrink-0"
        aria-hidden="true"
      >
        {/* Nav button placeholders */}
        <div className="animate-pulse-delayed h-7 w-7 bg-muted rounded" />
        <div className="animate-pulse-delayed h-7 w-7 bg-muted rounded" />
        <div className="animate-pulse-delayed h-7 w-7 bg-muted rounded" />

        {/* URL bar placeholder */}
        <div className="animate-pulse-delayed flex-1 h-7 bg-muted rounded" />

        {/* Action button placeholders */}
        <div className="animate-pulse-delayed h-7 w-7 bg-muted rounded" />
        <div className="animate-pulse-delayed h-7 w-7 bg-muted rounded" />
      </div>

      {/* Content area — empty, no animation */}
      <div className="flex-1 min-h-0 bg-canopy-bg" />
    </div>
  );
}
