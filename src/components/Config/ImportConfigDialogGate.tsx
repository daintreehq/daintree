import { useEffect, useState } from "react";
import { lazyWhenLoaded } from "@/lib/lazyWithPreload";
import { refreshImportedConfig } from "@/services/configBundleRefresh";
import { IMPORT_CONFIG_EVENT } from "./importConfigEvent";

const LazyImportConfigDialog = lazyWhenLoaded(
  () => import("./ImportConfigDialog"),
  (m) => m.ImportConfigDialog
);

/**
 * Owns what the import flow must do with no dialog loaded, and loads the dialog
 * on the first request for it.
 *
 * Every `IMPORT_CONFIG_EVENT` (the `app.importConfig` action, a report's Try
 * again) bumps the request the dialog acts on, so the first one is never lost
 * to a chunk still loading. Kept mounted once loaded, so later requests reach
 * the same dialog.
 */
export function ImportConfigDialogGate() {
  const [request, setRequest] = useState(0);

  useEffect(() => {
    const handler = () => setRequest((n) => n + 1);
    window.addEventListener(IMPORT_CONFIG_EVENT, handler);
    return () => window.removeEventListener(IMPORT_CONFIG_EVENT, handler);
  }, []);

  // An import applied in any window has to reach this one too — each project
  // view holds its own theme and notification stores, and `app.reloadConfig`
  // reconciles neither.
  useEffect(() => {
    return window.electron.configBundle.onImported(() => {
      void refreshImportedConfig();
    });
  }, []);

  return request > 0 ? <LazyImportConfigDialog request={request} /> : null;
}
