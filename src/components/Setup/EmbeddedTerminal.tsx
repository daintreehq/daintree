import { useCallback, useEffect, useRef, useState } from "react";
import { XtermAdapter } from "@/components/Terminal/XtermAdapter";
import { terminalClient } from "@/clients";

interface EmbeddedTerminalProps {
  className?: string;
}

export function EmbeddedTerminal({ className }: EmbeddedTerminalProps) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const pendingIdRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const id = `setup-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    pendingIdRef.current = id;

    terminalClient
      .spawn({
        id,
        kind: "terminal",
        cols: 80,
        rows: 12,
        isEphemeral: true,
      })
      .then(() => {
        if (mountedRef.current) {
          setTerminalId(id);
        } else {
          terminalClient.kill(id).catch(() => {});
        }
        pendingIdRef.current = null;
      })
      .catch((err) => {
        console.error("[EmbeddedTerminal] Failed to spawn:", err);
        pendingIdRef.current = null;
      });

    return () => {
      mountedRef.current = false;
      if (pendingIdRef.current) {
        terminalClient.kill(pendingIdRef.current).catch(() => {});
        pendingIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const id = terminalId;
    if (!id) return;
    return () => {
      terminalClient.kill(id).catch(() => {});
    };
  }, [terminalId]);

  const handleExit = useCallback(() => {
    setTerminalId(null);
  }, []);

  if (!terminalId) {
    return (
      <div
        className={`flex items-center justify-center bg-canopy-bg rounded-[var(--radius-md)] border border-canopy-border ${className ?? ""}`}
        style={{ height: 280 }}
      >
        <span className="text-sm text-canopy-text/40">Starting terminal...</span>
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-[var(--radius-md)] border border-canopy-border ${className ?? ""}`}
      style={{ height: 280 }}
    >
      <XtermAdapter terminalId={terminalId} terminalType="terminal" onExit={handleExit} />
    </div>
  );
}
