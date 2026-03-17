const kbdClass = "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60";

const HINTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["↑", "↓"], label: "to navigate" },
  { keys: ["Enter"], label: "to select" },
  { keys: ["⇧Enter"], label: "grid" },
  { keys: ["⇧⌘Enter"], label: "dock" },
  { keys: ["⌘N"], label: "new" },
];

interface NotesPaletteFooterProps {
  hasSelection: boolean;
}

export function NotesPaletteFooter({ hasSelection }: NotesPaletteFooterProps) {
  return (
    <div className="px-3 py-2 border-t border-canopy-border bg-canopy-sidebar/50 text-xs text-canopy-text/50 flex items-center gap-4 shrink-0">
      {HINTS.map(({ keys, label }) => (
        <span key={label}>
          {keys.map((key, i) => (
            <kbd key={key} className={`${kbdClass}${i > 0 ? " ml-1" : ""}`}>
              {key}
            </kbd>
          ))}
          <span className="ml-1.5">{label}</span>
        </span>
      ))}
      <span>
        <kbd className={kbdClass}>Esc</kbd>
        <span className="ml-1.5">{hasSelection ? "deselect" : "close"}</span>
      </span>
    </div>
  );
}
