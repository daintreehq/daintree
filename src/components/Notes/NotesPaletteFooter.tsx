import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";

interface NotesPaletteFooterProps {
  hasSelection: boolean;
}

export function NotesPaletteFooter({ hasSelection }: NotesPaletteFooterProps) {
  return (
    <div className="px-3 py-2 border-t border-canopy-border bg-canopy-sidebar/50 text-xs text-canopy-text/50 flex items-center gap-4 shrink-0">
      <PaletteFooterHints
        primaryHint={{ keys: ["↵"], label: "to select" }}
        hints={[
          { keys: ["↑", "↓"], label: "to navigate" },
          { keys: ["Enter"], label: "to select" },
          { keys: ["⇧Enter"], label: "grid" },
          { keys: ["⇧⌘Enter"], label: "dock" },
          { keys: ["⌘N"], label: "new" },
          { keys: ["Esc"], label: hasSelection ? "deselect" : "close" },
        ]}
      />
    </div>
  );
}
