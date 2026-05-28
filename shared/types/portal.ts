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
  /**
   * Optional Chromium session partition override. When a valid
   * `persist:dev-preview-*` partition is supplied (promoting a dev preview into
   * a Portal tab), the new `WebContentsView` shares that session — cookies,
   * localStorage, and IndexedDB carry over. Invalid values are ignored and the
   * default `persist:portal` partition is used.
   */
  partition?: string;
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

export const PORTAL_MIN_WIDTH = 320;
export const PORTAL_MAX_WIDTH = 1200;
export const PORTAL_DEFAULT_WIDTH = 480;
// Minimum editor canvas width preserved when restoring a persisted portal
// width on launch. If the saved width would shrink the editor below this on
// the current viewport, the portal falls back to a viewport-safe size.
export const PORTAL_MIN_EDITOR_WIDTH = 400;
