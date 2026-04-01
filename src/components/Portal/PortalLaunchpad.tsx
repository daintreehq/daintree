import { Globe } from "lucide-react";
import { useMemo } from "react";
import type { PortalLink } from "@shared/types";
import { PortalIcon } from "./PortalIcon";

interface PortalLaunchpadProps {
  links: PortalLink[];
  onOpenUrl: (url: string, title: string, background?: boolean) => void;
}

export function PortalLaunchpad({ links, onOpenUrl }: PortalLaunchpadProps) {
  const isMac = useMemo(() => navigator.platform.toUpperCase().includes("MAC"), []);
  if (links.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-start pt-8 text-muted-foreground px-6">
        <Globe className="w-12 h-12 mb-4 opacity-50" />
        <p className="text-sm">No AI agents configured</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-start pt-8 px-8">
      <div className="w-full max-w-sm">
        <h2 className="text-lg font-medium mb-6 text-foreground text-center">New Chat</h2>
        <div className="grid grid-cols-1 gap-4">
          {links.map((link) => (
            <button
              key={link.id}
              type="button"
              onClick={(e) => {
                const modifierBackground = isMac ? e.metaKey : e.ctrlKey;
                onOpenUrl(link.url, link.title, modifierBackground);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenUrl(link.url, link.title, true);
                }
              }}
              className="flex items-center gap-4 p-4 rounded-[var(--radius-xl)] bg-canopy-border hover:bg-canopy-border/80 border border-canopy-border hover:border-canopy-border transition-colors group focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
            >
              <div className="w-8 h-8 flex items-center justify-center text-foreground group-hover:text-canopy-text transition-colors">
                <PortalIcon icon={link.icon} size="launchpad" url={link.url} type={link.type} />
              </div>
              <div className="text-left">
                <div className="font-medium text-foreground group-hover:text-canopy-text transition-colors">
                  {link.title}
                </div>
                <div className="text-xs text-canopy-text/70">Open web client</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
