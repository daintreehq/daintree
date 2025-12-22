import React from "react";

export interface BrowserHeaderContentProps {
  id: string;
  url?: string;
  isLoading?: boolean;
}

/**
 * Browser-specific header content.
 * Currently empty but provides an extension point for future additions
 * like SSL indicator, favicon, page title from iframe, etc.
 */
function BrowserHeaderContentComponent({
  id: _id,
  url: _url,
  isLoading: _isLoading,
}: BrowserHeaderContentProps) {
  // Future: SSL indicator, favicon, etc.
  return null;
}

export const BrowserHeaderContent = React.memo(BrowserHeaderContentComponent);
