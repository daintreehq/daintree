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
