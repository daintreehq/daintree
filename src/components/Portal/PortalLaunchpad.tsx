import { Globe, Plus } from "lucide-react";
import { useCallback } from "react";
import type { PortalLink } from "@shared/types";
import { PortalIcon } from "./PortalIcon";
import { isMac } from "@/lib/platform";
import { actionService } from "@/services/ActionService";
import { Button } from "@/components/ui/button";

interface PortalLaunchpadProps {
  links: PortalLink[];
  onOpenUrl: (url: string, title: string, background?: boolean) => void;
}

export function PortalLaunchpad({ links, onOpenUrl }: PortalLaunchpadProps) {
  const mac = isMac();

  const handleAddPortalLink = useCallback(() => {
    void actionService.dispatch("app.settings.openTab", { tab: "portal" }, { source: "user" });
  }, []);

  if (links.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
        <Globe className="w-12 h-12 mb-2 opacity-50" />
        <p className="text-sm text-daintree-text/50">No AI agents configured</p>
        <p className="text-xs text-daintree-text/40">
          Add a portal link to use as your AI agent web client.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddPortalLink}
          className="gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add agent link</span>
        </Button>
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
                const modifierBackground = mac ? e.metaKey : e.ctrlKey;
                onOpenUrl(link.url, link.title, modifierBackground);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenUrl(link.url, link.title, true);
                }
              }}
              className="flex items-center gap-4 p-4 rounded-[var(--radius-xl)] bg-daintree-border hover:bg-daintree-border/80 border border-daintree-border hover:border-daintree-border transition-colors group focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
            >
              <div className="w-8 h-8 flex items-center justify-center text-foreground group-hover:text-daintree-text transition-colors">
                <PortalIcon icon={link.icon} size="launchpad" url={link.url} type={link.type} />
              </div>
              <div className="text-left min-w-0">
                <div className="font-medium text-foreground group-hover:text-daintree-text transition-colors">
                  {link.title}
                </div>
                <div className="text-xs text-daintree-text/70 truncate">
                  {(() => {
                    try {
                      const host = new URL(link.url).hostname;
                      return host || "Open web client";
                    } catch {
                      return "Open web client";
                    }
                  })()}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
