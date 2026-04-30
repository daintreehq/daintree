export interface BrowserHistory {
  past: string[];
  present: string;
  future: string[];
}

export interface UrlHistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: number;
  favicon?: string;
}
