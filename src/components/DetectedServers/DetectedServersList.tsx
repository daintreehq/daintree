import { ExternalLink, Signal } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DetectedDevServer } from "@shared/types/ipc/globalDevServers";

interface DetectedServersListProps {
  servers: DetectedDevServer[];
  onOpen: (url: string) => void;
  onClose?: () => void;
}

export function DetectedServersList({ servers, onOpen, onClose }: DetectedServersListProps) {
  if (servers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-text-muted">
        <Signal className="h-8 w-8 mb-2 opacity-40" />
        <p className="text-sm font-medium">No dev servers detected</p>
        <p className="text-xs mt-1 text-center">
          Start a dev server in any terminal and it will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
        <span className="text-xs font-medium text-text-secondary">
          {servers.length} detected {servers.length === 1 ? "server" : "servers"}
        </span>
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {servers.map((server) => (
          <div
            key={`${server.port}-${server.terminalId}`}
            className="flex items-center gap-3 px-3 py-2 hover:bg-overlay-medium transition-colors border-b border-divider last:border-b-0"
          >
            <div className="flex items-center justify-center w-10 h-6 rounded bg-overlay-soft text-xs font-mono font-medium text-text-secondary shrink-0">
              {server.port}
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm truncate text-text-primary">{server.url}</span>
              <span className="text-xs text-text-muted truncate">
                {server.terminalTitle ?? server.worktreeId ?? "Terminal"}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 h-7 w-7 text-text-secondary hover:text-canopy-accent"
              onClick={() => {
                onOpen(server.url);
                onClose?.();
              }}
              aria-label={`Open ${server.url}`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
