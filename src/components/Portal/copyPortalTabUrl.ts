import { usePortalStore } from "@/store/portalStore";
import { copyWithToast } from "@/lib/copyWithToast";
import type { CopyFlashTicket } from "@/lib/copyFlash";
import { writeMainClipboard } from "@/lib/mainClipboard";

/**
 * A portal tab menu's Copy URL. The row closes on select, so it confirms like
 * any menu row: a flash at `flash` (taken by the tab, clear of the page view),
 * and a Retry toast that writes that same URL even if the tab has moved on.
 * Written through main, since the page may hold focus.
 */
export function copyPortalTabUrl(tabId: string, flash: CopyFlashTicket): void {
  const url = usePortalStore.getState().tabs.find((t) => t.id === tabId)?.url;
  if (!url) return;
  copyWithToast("URL", url, {
    flash,
    write: async (text) => {
      await writeMainClipboard(text);
      return true;
    },
  });
}
