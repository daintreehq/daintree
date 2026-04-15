export function NotesPaneSkeleton() {
  return (
    <div
      className="flex flex-col h-full w-full"
      role="status"
      aria-busy="true"
      aria-label="Loading notes panel"
    >
      <span className="sr-only">Loading notes panel</span>

      {/* Header row — matches PanelHeader h-8 layout (icon + title left, menu + close right) */}
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
        </div>
      </div>

      {/* Content area — empty, no animation */}
      <div className="flex-1 min-h-0 bg-daintree-bg" />
    </div>
  );
}
