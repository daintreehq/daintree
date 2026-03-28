import { useState } from "react";
import type { CdpStackTrace } from "@shared/types/ipc/webviewConsole";

interface StackTraceProps {
  stackTrace: CdpStackTrace;
}

export function StackTrace({ stackTrace }: StackTraceProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (stackTrace.callFrames.length === 0) return null;

  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="text-[10px] text-canopy-text/40 hover:text-canopy-text/60 transition-colors select-none"
      >
        <span className="mr-0.5">{isExpanded ? "▼" : "▶"}</span>
        stack trace
      </button>
      {isExpanded && (
        <div className="pl-3 border-l border-tint/10 mt-0.5 select-text">
          {stackTrace.callFrames.map((frame, i) => (
            <div key={i} className="text-canopy-text/40 text-[10px] leading-relaxed">
              <span className="text-canopy-text/50">{frame.functionName || "(anonymous)"}</span>
              {frame.url && (
                <span>
                  {" "}
                  ({frame.url}:{frame.lineNumber}:{frame.columnNumber})
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
