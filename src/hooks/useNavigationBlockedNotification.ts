import { useEffect, useRef } from "react";
import { notify } from "@/lib/notify";

const COALESCE_MS = 3000;

export function useNavigationBlockedNotification(panelId: string): void {
  const lastNotifiedRef = useRef<{ url: string; ts: number } | null>(null);

  useEffect(() => {
    if (!window.electron?.webview?.onNavigationBlocked) return;

    const cleanup = window.electron.webview.onNavigationBlocked((payload) => {
      if (payload.panelId !== panelId) return;

      // Deduplicate rapid-fire notifications for the same URL (e.g. redirect chains)
      const now = Date.now();
      const last = lastNotifiedRef.current;
      if (last && last.url === payload.url && now - last.ts < COALESCE_MS) return;
      lastNotifiedRef.current = { url: payload.url, ts: now };

      const displayUrl = payload.url.length > 60 ? payload.url.slice(0, 57) + "..." : payload.url;

      notify({
        type: "warning",
        title: "Navigation blocked",
        message: `Cross-origin navigation to ${displayUrl} is not allowed in the integrated browser.`,
        inboxMessage: `Blocked navigation to ${payload.url}`,
        action: {
          label: "Open in browser",
          onClick: () => {
            window.electron.system.openExternal(payload.url);
          },
        },
        duration: 8000,
      });
    });

    return cleanup;
  }, [panelId]);
}
