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

/**
 * A link saved with one project and shown only in that project's Portal
 * launchpad (#17091). Kept in the project's local settings, never in the
 * committed settings file, so a cloned repository can't seed it.
 */
export interface ProjectPortalLink {
  id: string;
  title: string;
  url: string;
  /** Set while the link is as the Assistant left it. A change made by hand clears it. */
  addedByAssistant?: true;
}

/** Who is changing a project's links: the Assistant is held to its own links and a narrower URL rule. */
export type ProjectPortalLinkActor = "user" | "assistant";

export type ProjectPortalLinkChange =
  | { op: "add"; title: string; url: string }
  | { op: "update"; id: string; title?: string; url?: string }
  /** `onlyIfAddedByAssistant` is an Undo of the Assistant's add: a link someone has since taken over stays. */
  | { op: "remove"; id: string; onlyIfAddedByAssistant?: boolean };

export interface ProjectPortalLinksChangePayload {
  projectId: string;
  actor: ProjectPortalLinkActor;
  change: ProjectPortalLinkChange;
}

export type ProjectPortalLinkRefusal =
  "invalid-title" | "invalid-url" | "limit" | "not-found" | "not-added-by-assistant";

/** `saved` rather than `ok`: an IPC handler's result can't carry the envelope's own keys. */
export type ProjectPortalLinksChangeResult =
  | {
      saved: true;
      /** The project's links as saved. */
      links: ProjectPortalLink[];
      /** The link added or updated, or the one removed. */
      link: ProjectPortalLink;
    }
  | { saved: false; code: ProjectPortalLinkRefusal; message: string };

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
  grok: {
    title: "Grok",
    url: "https://grok.com/",
    icon: "grok",
  },
  mistral: {
    title: "Le Chat",
    url: "https://chat.mistral.ai/chat",
    icon: "mistral",
  },
  qwen: {
    title: "Qwen",
    url: "https://chat.qwen.ai/",
    icon: "qwen",
  },
  kimi: {
    title: "Kimi",
    url: "https://www.kimi.com/",
    icon: "kimi",
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
  /**
   * Optional Chromium session partition this tab's `WebContentsView` runs on.
   * Set when the tab was promoted from a dev preview so the shared session
   * (cookies, localStorage, IndexedDB) survives LRU eviction and restart — the
   * restore paths re-create the view on the same partition.
   */
  partition?: string;
}

export interface PortalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Session history of a live tab's view. Lost with the view, so never persisted. */
export interface PortalTabHistory {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface PortalNavEvent extends PortalTabHistory {
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
  /**
   * True when this create is the first half of a restore (create → bounds
   * polling → show). Marks the tab as restoring in `PortalManager` so LRU
   * eviction cannot reclaim it during the create→show window — `activeTabId`
   * only protects it after `showTab()` completes. Background opens must omit
   * this flag or they would be shielded from eviction indefinitely.
   */
  isRestore?: boolean;
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

export const DEFAULT_PORTAL_TABS: PortalTab[] = [];

export const PORTAL_MIN_WIDTH = 320;
export const PORTAL_MAX_WIDTH = 1200;
export const PORTAL_DEFAULT_WIDTH = 480;
// Minimum editor canvas width preserved when restoring a persisted portal
// width on launch. If the saved width would shrink the editor below this on
// the current viewport, the portal falls back to a viewport-safe size.
export const PORTAL_MIN_EDITOR_WIDTH = 400;
