/** The DOM id a portal tab carries, so the page region can name it back. */
export const portalTabDomId = (tabId: string) => `portal-tab-${tabId}`;

/** The region the portal's tabs switch — `PortalDock`'s page placeholder. */
export const PORTAL_TAB_PANEL_ID = "portal-placeholder";

/** The dock's `<aside>` landmark — what its resize handle controls. */
export const PORTAL_DOCK_ID = "portal-dock";

/** The toolbar's portal toggle, where focus goes when the dock closes with no pane to take it. */
export const PORTAL_TOGGLE_ID = "portal-toggle-button";

/** The toolbar's Copy URL button, where a copy asked for from a key is confirmed. */
export const PORTAL_COPY_URL_ID = "portal-copy-url";
