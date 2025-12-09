import { useState } from "react";
import { AlertCircle, LayoutGrid, PanelBottom } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { useTerminalStore } from "@/store/terminalStore";
import { useWaitingTerminalIds } from "@/hooks/useTerminalSelectors";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { ClaudeIcon, GeminiIcon, CodexIcon } from "@/components/icons";
import type { TerminalType, TerminalLocation } from "@shared/types";

function getTerminalIcon(type: TerminalType) {
  const iconProps = { className: "h-3.5 w-3.5 shrink-0" };

  switch (type) {
    case "claude":
      return <ClaudeIcon {...iconProps} brandColor={getBrandColorHex("claude")} />;
    case "gemini":
      return <GeminiIcon {...iconProps} brandColor={getBrandColorHex("gemini")} />;
    case "codex":
      return <CodexIcon {...iconProps} brandColor={getBrandColorHex("codex")} />;
    default:
      return <AlertCircle {...iconProps} />;
  }
}

function getLocationIcon(location: TerminalLocation | undefined) {
  if (location === "dock") return <PanelBottom className="w-3.5 h-3.5" />;
  return <LayoutGrid className="w-3.5 h-3.5" />;
}

export function WaitingContainer() {
  const [isOpen, setIsOpen] = useState(false);
  const waitingIds = useWaitingTerminalIds();
  const { activateTerminal, pingTerminal, focusedId } = useTerminalStore(
    useShallow((state) => ({
      activateTerminal: state.activateTerminal,
      pingTerminal: state.pingTerminal,
      focusedId: state.focusedId,
    }))
  );
  const shortcut = useKeybindingDisplay("agent.focusNextWaiting");

  const waitingTerminals = useTerminalStore(
    useShallow((state) =>
      waitingIds.map((id) => state.terminals.find((t) => t.id === id)).filter(Boolean)
    )
  );

  if (waitingTerminals.length === 0) return null;

  const count = waitingTerminals.length;
  const contentId = "waiting-container-popover";

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="pill"
          size="sm"
          className={cn(
            "px-3",
            isOpen && "bg-canopy-border border-canopy-border ring-1 ring-canopy-accent/20"
          )}
          title={`View agents waiting for input${shortcut ? ` (${shortcut})` : ""}`}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={contentId}
          aria-label={`Waiting: ${count} agent${count === 1 ? "" : "s"}`}
        >
          <AlertCircle className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          <span className="font-medium">Waiting ({count})</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        id={contentId}
        role="dialog"
        aria-label="Waiting terminals"
        className="w-80 p-0 border-canopy-border bg-canopy-sidebar shadow-2xl"
        side="top"
        align="end"
        sideOffset={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 border-b border-canopy-border bg-canopy-bg/50 flex justify-between items-center">
            <span className="text-xs font-medium text-canopy-text/70">Waiting For Input</span>
          </div>

          <div className="p-1 flex flex-col gap-1 max-h-[300px] overflow-y-auto">
            {waitingTerminals.map((terminal) => {
              if (!terminal) return null;
              const isFocused = terminal.id === focusedId;

              return (
                <button
                  key={terminal.id}
                  onClick={() => {
                    activateTerminal(terminal.id);
                    pingTerminal(terminal.id);
                    setIsOpen(false);
                  }}
                  className={cn(
                    "flex items-center justify-between gap-3 w-full px-2 py-2 rounded-sm transition-colors group text-left outline-none",
                    "hover:bg-white/5 focus:bg-white/5",
                    isFocused && "bg-white/5"
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
                      {getTerminalIcon(terminal.type)}
                    </div>
                    <span
                      className={cn(
                        "text-sm truncate text-canopy-text/90 group-hover:text-canopy-text",
                        isFocused ? "font-bold text-canopy-text" : "font-medium"
                      )}
                    >
                      {terminal.title}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <AlertCircle
                      className="w-3.5 h-3.5 text-amber-400"
                      aria-label="Waiting for input"
                    />

                    <div
                      className="text-muted-foreground/40 group-hover:text-muted-foreground/60"
                      title={terminal.location === "dock" ? "Docked" : "On Grid"}
                    >
                      {getLocationIcon(terminal.location)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
