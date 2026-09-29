import { House } from "lucide-react";
import type { PortalLink } from "@shared/types";
import {
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { actionService } from "@/services/ActionService";

interface PortalDefaultNewTabSubmenuProps {
  links: PortalLink[];
  defaultNewTabUrl: string | null;
}

/** "Default new tab" picker shared by the portal's context menus. */
export function PortalDefaultNewTabSubmenu({
  links,
  defaultNewTabUrl,
}: PortalDefaultNewTabSubmenuProps) {
  const source = useMenuActionSource();
  const setDefault = (url: string | null) =>
    void actionService.dispatch("portal.setDefaultNewTab", { url }, { source });

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <House data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
        Default new tab
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuCheckboxItem
          checked={defaultNewTabUrl === null}
          onSelect={() => setDefault(null)}
        >
          Launchpad
        </ContextMenuCheckboxItem>
        {links.length > 0 && <ContextMenuSeparator />}
        {links.map((link) => (
          <ContextMenuCheckboxItem
            key={link.url}
            checked={defaultNewTabUrl === link.url}
            onSelect={() => setDefault(link.url)}
          >
            {link.title}
          </ContextMenuCheckboxItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
