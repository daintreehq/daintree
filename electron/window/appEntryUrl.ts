import type { WebContents } from "electron";
import { getDevServerUrl } from "../../shared/config/devServer.js";

// recovery.html replaces a crashed view's document in place, so reloading that
// view needs the URL it was first given. Only the window's startup view puts
// its project in the URL (`?projectId=`); ProjectViewFactory views load the
// static entry and keep their project in additionalArguments, which survive
// navigation. Navigation history can't stand in: caching a view clears it.
const entryUrls = new WeakMap<WebContents, string>();

export function getDefaultAppEntryUrl(): string {
  if (process.env.NODE_ENV === "development") {
    return getDevServerUrl();
  }
  return "app://daintree/index.html";
}

export function recordAppEntryUrl(webContents: WebContents, url: string): void {
  entryUrls.set(webContents, url);
}

export function getAppEntryUrl(webContents: WebContents): string {
  return entryUrls.get(webContents) ?? getDefaultAppEntryUrl();
}
