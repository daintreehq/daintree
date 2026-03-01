export type SidecarLayoutMode = "push" | "overlay";

export type SidecarLayoutModePreference = "auto" | "push" | "overlay";

export type SidecarLinkType = "system" | "user";

export interface SidecarLink {
  id: string;
  title: string;
  url: string;
  icon: string;
  type: SidecarLinkType;
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

export const DEFAULT_SYSTEM_LINKS: SidecarLink[] = Object.entries(LINK_TEMPLATES).map(
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

export interface SidecarTab {
  id: string;
  url: string | null;
  title: string;
  favicon?: string;
  icon?: string;
}

export interface SidecarBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SidecarNavEvent {
  tabId: string;
  title: string;
  url: string;
}

export interface SidecarCreatePayload {
  tabId: string;
  url: string;
}

export interface SidecarShowPayload {
  tabId: string;
  bounds: SidecarBounds;
}

export interface SidecarCloseTabPayload {
  tabId: string;
}

export interface SidecarNavigatePayload {
  tabId: string;
  url: string;
}

export interface SidecarNewTabMenuLink {
  title: string;
  url: string;
}

export interface SidecarShowNewTabMenuPayload {
  x: number;
  y: number;
  links: SidecarNewTabMenuLink[];
  defaultNewTabUrl: string | null;
}

export type SidecarNewTabMenuAction =
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

export const DEFAULT_SIDECAR_TABS: SidecarTab[] = [];

export const SIDECAR_MIN_WIDTH = 480;
export const SIDECAR_MAX_WIDTH = 1200;
export const SIDECAR_DEFAULT_WIDTH = 640;
export const MIN_GRID_WIDTH = 400;
