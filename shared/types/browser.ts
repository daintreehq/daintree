export interface BrowserHistory {
  past: string[];
  present: string;
  future: string[];
}

export interface BrowserNavigationHistoryEntry {
  index: number;
  url: string;
  title: string;
}

export interface BrowserNavigationHistorySnapshot {
  entries: BrowserNavigationHistoryEntry[];
  activeIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface UrlHistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: number;
  favicon?: string;
}
