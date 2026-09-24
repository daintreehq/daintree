import { Globe, Settings2 } from "lucide-react";
import { useCallback } from "react";
import type { PortalLink } from "@shared/types";
import { PortalIcon } from "./PortalIcon";
import { isMac } from "@/lib/platform";
import { actionService } from "@/services/ActionService";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";

interface PortalLaunchpadProps {
  links: PortalLink[];
  onOpenUrl: (url: string, title: string, background?: boolean) => void;
}

function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

export function PortalLaunchpad({ links, onOpenUrl }: PortalLaunchpadProps) {
  const mac = isMac();

  const openPortalSettings = useCallback(() => {
    void actionService.dispatch("app.settings.openTab", { tab: "portal" }, { source: "user" });
  }, []);

  if (links.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<Globe />}
          title="Add a chat service"
          description="Choose which web chats open here in Portal settings."
          action={
            <Button type="button" variant="outline" size="sm" onClick={openPortalSettings}>
              Open Portal settings
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <section
        aria-labelledby="portal-launchpad-heading"
        className="mx-auto max-w-md px-3 pt-4 pb-6"
      >
        <div className="flex items-center justify-between gap-2 pl-3 pr-1 pb-2">
          <h2 id="portal-launchpad-heading" className="text-sm font-medium text-text-primary">
            New chat
          </h2>
          <button
            type="button"
            onClick={openPortalSettings}
            className="toolbar-icon-button flex items-center gap-1.5 h-7 px-2 rounded-[var(--radius-md)] text-xs text-text-secondary hover:text-text-primary"
          >
            <Settings2 className="w-3.5 h-3.5" aria-hidden="true" />
            Manage
          </button>
        </div>
        <ul className="flex flex-col gap-0.5">
          {links.map((link) => (
            <li key={link.id}>
              <button
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
                className="group flex w-full items-center gap-3 h-10 px-3 rounded-[var(--radius-lg)] text-left transition-colors duration-150 hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]"
              >
                <span className="flex w-6 h-6 shrink-0 items-center justify-center text-text-secondary">
                  <PortalIcon icon={link.icon} size="launchpad" />
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span
                    className="min-w-0 max-w-[70%] shrink-0 truncate text-sm font-medium text-text-primary"
                    title={link.title}
                  >
                    {link.title}
                  </span>
                  <span className="min-w-0 truncate text-xs text-text-secondary group-hover:text-text-primary transition-colors duration-150">
                    {linkHost(link.url)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="px-3 pt-3 text-xs text-text-secondary">
          {mac ? "⌘-click" : "Ctrl+click"} to open in the background
        </p>
      </section>
    </div>
  );
}
