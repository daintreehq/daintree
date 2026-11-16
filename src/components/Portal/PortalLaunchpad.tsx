import { Globe, Settings2 } from "lucide-react";
import { useCallback } from "react";
import type { PortalLink, ProjectPortalLink } from "@shared/types";
import { portalLinkHost } from "@shared/utils/projectPortalLinks";
import { PortalIcon } from "./PortalIcon";
import { isMac } from "@/lib/platform";
import { actionService } from "@/services/ActionService";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

interface PortalLaunchpadProps {
  links: PortalLink[];
  /** This project's own links, shown above the chat services. */
  projectLinks?: ProjectPortalLink[];
  onOpenUrl: (url: string, title: string, background?: boolean) => void;
}

const NO_PROJECT_LINKS: ProjectPortalLink[] = [];

interface LaunchpadRowProps {
  id: string;
  title: string;
  url: string;
  icon: string;
  addedByAssistant?: boolean;
  mac: boolean;
  onOpenUrl: PortalLaunchpadProps["onOpenUrl"];
}

function LaunchpadRow({
  id,
  title,
  url,
  icon,
  addedByAssistant,
  mac,
  onOpenUrl,
}: LaunchpadRowProps) {
  return (
    <li>
      <ChoiceCard
        tone="row"
        padding="sm"
        aria-labelledby={`portal-link-${id}-title`}
        aria-describedby={`portal-link-${id}-host`}
        onClick={(e) => {
          const modifierBackground = mac ? e.metaKey : e.ctrlKey;
          onOpenUrl(url, title, modifierBackground);
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            onOpenUrl(url, title, true);
          }
        }}
        className="group w-full items-center gap-3"
      >
        <span className="flex w-6 h-6 shrink-0 items-center justify-center text-text-secondary">
          <PortalIcon icon={icon} size="launchpad" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <TruncatedTooltip content={title} focusable={false}>
            <span
              id={`portal-link-${id}-title`}
              className="min-w-0 max-w-[70%] shrink-0 truncate text-sm font-medium text-text-primary"
            >
              {title}
            </span>
          </TruncatedTooltip>
          <span
            id={`portal-link-${id}-host`}
            className="min-w-0 truncate text-xs text-text-secondary group-hover:text-text-primary transition-colors duration-150"
          >
            {portalLinkHost(url)}
            {addedByAssistant && <span className="sr-only">, added by the Assistant</span>}
          </span>
        </span>
        {addedByAssistant && (
          <Badge size="xs" tone="neutral" aria-hidden="true">
            Assistant
          </Badge>
        )}
      </ChoiceCard>
    </li>
  );
}

export function PortalLaunchpad({
  links,
  projectLinks = NO_PROJECT_LINKS,
  onOpenUrl,
}: PortalLaunchpadProps) {
  const mac = isMac();

  const openPortalSettings = useCallback(() => {
    void actionService.dispatch("app.settings.openTab", { tab: "portal" }, { source: "user" });
  }, []);

  const openProjectLinkSettings = useCallback(() => {
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "project:general", sectionId: "project-portal-links" },
      { source: "user" }
    );
  }, []);

  if (links.length === 0 && projectLinks.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          icon={<Globe />}
          title="Add a chat service"
          description="Choose which web chats open here in Portal settings."
          action={
            <Button type="button" variant="contrast" size="sm" onClick={openPortalSettings}>
              Open Portal settings
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-md px-3 pt-4 pb-6">
        {projectLinks.length > 0 && (
          <section aria-labelledby="portal-launchpad-project-heading" className="pb-4">
            <div className="flex items-center justify-between gap-2 pl-3 pr-1 pb-2">
              <h2
                id="portal-launchpad-project-heading"
                className="text-sm font-medium text-text-primary"
              >
                This project
              </h2>
              <button
                type="button"
                onClick={openProjectLinkSettings}
                aria-label="Manage this project's links"
                className="toolbar-icon-button flex items-center gap-1.5 h-7 px-2 rounded-[var(--radius-md)] text-xs text-text-secondary hover:text-text-primary"
              >
                <Settings2 className="w-3.5 h-3.5" aria-hidden="true" />
                Manage
              </button>
            </div>
            <ul className="flex flex-col gap-0.5">
              {projectLinks.map((link) => (
                <LaunchpadRow
                  key={link.id}
                  id={`project-${link.id}`}
                  title={link.title}
                  url={link.url}
                  icon="globe"
                  addedByAssistant={link.addedByAssistant === true}
                  mac={mac}
                  onOpenUrl={onOpenUrl}
                />
              ))}
            </ul>
          </section>
        )}
        {links.length > 0 && (
          <section aria-labelledby="portal-launchpad-heading">
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
                <LaunchpadRow
                  key={link.id}
                  id={link.id}
                  title={link.title}
                  url={link.url}
                  icon={link.icon}
                  mac={mac}
                  onOpenUrl={onOpenUrl}
                />
              ))}
            </ul>
          </section>
        )}
        <p className="px-3 pt-3 text-xs text-text-secondary">
          {mac ? "⌘-click" : "Ctrl+click"} to open in the background
        </p>
      </div>
    </div>
  );
}
