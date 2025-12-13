import { Globe } from "lucide-react";
import type { SidecarLink } from "@shared/types";
import { SidecarIcon } from "./SidecarIcon";

interface SidecarLaunchpadProps {
  links: SidecarLink[];
  onOpenUrl: (url: string, title: string) => void;
}

export function SidecarLaunchpad({ links, onOpenUrl }: SidecarLaunchpadProps) {
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
              onClick={() => onOpenUrl(link.url, link.title)}
              className="flex items-center gap-4 p-4 rounded-xl bg-canopy-border hover:bg-canopy-border/80 border border-canopy-border hover:border-canopy-border transition-all group focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
            >
              <div className="w-8 h-8 flex items-center justify-center text-foreground group-hover:text-white transition-colors">
                <SidecarIcon icon={link.icon} size="launchpad" url={link.url} type={link.type} />
              </div>
              <div className="text-left">
                <div className="font-medium text-foreground group-hover:text-white transition-colors">
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
