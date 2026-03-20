export type PortalLinkType = "system" | "user";

export interface PortalLink {
  id: string;
  title: string;
  url: string;
  icon: string;
  type: PortalLinkType;
  enabled: boolean;
  order: number;
  alwaysEnabled?: boolean;
}

export interface LinkTemplate {
  title: string;
  url: string;
  icon: string;
}

export const LINK_TEMPLATES: Record<string, LinkTemplate> = {
  claude: {
    title: "Claude",
    url: "https://claude.ai/new",
    icon: "claude",
  },
  codex: {
    title: "ChatGPT",
    url: "https://chatgpt.com/",
    icon: "codex",
  },
  gemini: {
    title: "Gemini",
    url: "https://gemini.google.com/app",
    icon: "gemini",
  },
};

export const DEFAULT_SYSTEM_LINKS: PortalLink[] = Object.entries(LINK_TEMPLATES).map(
  ([key, template], index) => ({
    id: `system-${key}`,
    title: template.title,
    url: template.url,
    icon: template.icon,
    type: "system" as const,
    enabled: true,
    order: index,
  })
);

export interface PortalTab {
  id: string;
  url: string | null;
  title: string;
  favicon?: string;
  icon?: string;
}

export interface PortalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PortalNavEvent {
  tabId: string;
  title: string;
  url: string;
}

export interface PortalCreatePayload {
  tabId: string;
  url: string;
}

export interface PortalShowPayload {
  tabId: string;
  bounds: PortalBounds;
}

export interface PortalCloseTabPayload {
  tabId: string;
}

export interface PortalNavigatePayload {
  tabId: string;
  url: string;
}

export interface PortalNewTabMenuLink {
  title: string;
  url: string;
}

export interface PortalShowNewTabMenuPayload {
  x: number;
  y: number;
  links: PortalNewTabMenuLink[];
  defaultNewTabUrl: string | null;
}

export type PortalNewTabMenuAction =
  | {
      type: "open-url";
      url: string;
      title: string;
    }
  | {
      type: "open-launchpad";
    }
  | {
      type: "set-default-new-tab-url";
      url: string | null;
    };

export const DEFAULT_PORTAL_TABS: PortalTab[] = [];

export const PORTAL_MIN_WIDTH = 480;
export const PORTAL_MAX_WIDTH = 1200;
export const PORTAL_DEFAULT_WIDTH = 480;
