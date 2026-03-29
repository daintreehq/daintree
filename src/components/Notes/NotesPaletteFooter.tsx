import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { KBD_CLASS } from "@/components/ui/AppPaletteDialog";

interface NotesPaletteFooterProps {
  hasSelection: boolean;
}

export function NotesPaletteFooter({ hasSelection }: NotesPaletteFooterProps) {
  const [helpOpen, setHelpOpen] = useState(false);

  const hints = [
    { keys: ["↑", "↓"], label: "to navigate" },
    { keys: ["Enter"], label: "to select" },
    { keys: ["⇧Enter"], label: "grid" },
    { keys: ["⇧⌘Enter"], label: "dock" },
    { keys: ["⌘N"], label: "new" },
    { keys: ["Esc"], label: hasSelection ? "deselect" : "close" },
  ];

  return (
    <div className="px-3 py-2 border-t border-canopy-border bg-canopy-sidebar/50 text-xs text-canopy-text/50 flex items-center gap-4 shrink-0">
      <div className="w-full flex items-center justify-between">
        <span>
          <kbd className={KBD_CLASS}>↵</kbd>
          <span className="ml-1.5">to select</span>
        </span>
        <Popover open={helpOpen} onOpenChange={setHelpOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="p-0.5 rounded transition-colors text-canopy-text/40 hover:text-canopy-text/60 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              aria-label="Keyboard shortcuts"
            >
              <CircleHelp className="w-3.5 h-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="end"
            className="w-auto p-3"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <div className="flex flex-col gap-1.5 text-xs text-canopy-text/60">
              {hints.map(({ keys, label }) => (
                <span key={label}>
                  {keys.map((key, i) => (
                    <kbd key={key} className={cn(KBD_CLASS, i > 0 && "ml-1")}>
                      {key}
                    </kbd>
                  ))}
                  <span className="ml-1.5">{label}</span>
                </span>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
