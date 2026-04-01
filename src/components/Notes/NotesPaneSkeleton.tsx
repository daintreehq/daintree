export function NotesPaneSkeleton() {
  return (
    <div
      className="flex flex-col h-full w-full"
      role="status"
      aria-busy="true"
      aria-label="Loading notes panel"
    >
      <span className="sr-only">Loading notes panel</span>

      {/* Header row — matches PanelHeader h-8 with headerActions area */}
      <div
        className="flex items-center justify-between px-3 shrink-0 h-8 border-b border-divider bg-surface"
        aria-hidden="true"
      >
        {/* Title placeholder */}
        <div className="animate-pulse-delayed h-3 w-20 bg-muted rounded" />

        {/* Header actions placeholder — mode toggle group + copy path */}
        <div className="flex items-center gap-1">
          {/* Mode toggle group (3 buttons) */}
          <div className="flex items-center rounded-[var(--radius-sm)] overflow-hidden mr-1 gap-px">
            <div className="animate-pulse-delayed h-5 w-6 bg-muted" />
            <div className="animate-pulse-delayed h-5 w-6 bg-muted" />
            <div className="animate-pulse-delayed h-5 w-6 bg-muted" />
          </div>
          {/* Copy path button */}
          <div className="animate-pulse-delayed h-5 w-16 bg-muted rounded-[var(--radius-sm)]" />
        </div>
      </div>

      {/* Content area — empty, no animation */}
      <div className="flex-1 min-h-0 bg-canopy-bg" />
    </div>
  );
}
