import { useState, useCallback, useEffect } from "react";
import { XtermAdapter } from "../Terminal/XtermAdapter";
import { terminalInstanceService } from "../../services/TerminalInstanceService";

interface ConsoleDrawerProps {
  terminalId: string;
  defaultOpen?: boolean;
}

export function ConsoleDrawer({ terminalId, defaultOpen = false }: ConsoleDrawerProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const toggleDrawer = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    terminalInstanceService.setVisible(terminalId, isOpen);
  }, [terminalId, isOpen]);

  return (
    <div className="flex flex-col border-t border-gray-700">
      <button
        onClick={toggleDrawer}
        className="flex items-center justify-between px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800 transition-colors"
        aria-expanded={isOpen}
        aria-controls={`console-drawer-${terminalId}`}
      >
        <span>{isOpen ? "Hide Logs" : "Show Logs"}</span>
        <svg
          className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div id={`console-drawer-${terminalId}`} className="h-[300px]">
          <div className="h-full bg-black">
            <XtermAdapter terminalId={terminalId} />
          </div>
        </div>
      )}
    </div>
  );
}
