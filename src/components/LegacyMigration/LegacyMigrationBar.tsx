import { ArrowRight, AlertCircle } from "lucide-react";
import { systemClient } from "@/clients/systemClient";

const DOWNLOAD_URL = "https://daintree.org";
const LEARN_MORE_URL = "https://daintree.org/canopy-migration";

export function LegacyMigrationBar() {
  const openExternal = (url: string) => {
    void systemClient.openExternal(url).catch(() => {});
  };

  return (
    <div
      role="region"
      aria-label="Migrate to Daintree"
      className="fixed bottom-0 left-0 right-0 z-50 w-full flex items-center gap-3 px-4 py-2 bg-[var(--color-status-warning)]/95 text-[var(--color-bg)] border-t border-[var(--color-status-warning)] text-sm shadow-[0_-2px_8px_rgba(0,0,0,0.15)]"
      data-testid="legacy-migration-bar"
    >
      <AlertCircle className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-0 truncate">
        Canopy has moved to <strong>Daintree</strong>. This legacy build keeps receiving critical
        fixes through the 0.8.x series and will stop updating at 0.9.
      </span>
      <button
        type="button"
        onClick={() => openExternal(LEARN_MORE_URL)}
        className="underline underline-offset-2 opacity-80 hover:opacity-100 shrink-0"
      >
        Why?
      </button>
      <button
        type="button"
        onClick={() => openExternal(DOWNLOAD_URL)}
        className="inline-flex items-center gap-1 px-3 py-1 rounded-md bg-[var(--color-bg)] text-[var(--color-fg)] font-medium hover:opacity-90 shrink-0"
      >
        Download Daintree
        <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
