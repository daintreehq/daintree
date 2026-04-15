import { systemClient } from "@/clients/systemClient";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";

// TODO(0.9): Remove this component and its usage in src/App.tsx. The legacy
// Canopy build variant is being dropped in 0.9 — delete the component, its
// tests, and the IS_LEGACY_BUILD branch in App.tsx.
const DOWNLOAD_URL = "https://daintree.org/download";

export function LegacyMigrationBar() {
  const openExternal = (url: string) => {
    void systemClient.openExternal(url).catch(() => {});
  };

  return (
    <div
      role="region"
      aria-label="Canopy has been renamed to Daintree"
      className="fixed bottom-0 left-0 right-0 z-50 flex h-10 w-full items-center justify-between gap-4 border-t border-black/20 px-4"
      style={{ backgroundColor: "#B24522" }}
      data-testid="legacy-migration-bar"
    >
      <div className="flex min-w-0 items-center gap-3">
        <DaintreeIcon size={18} className="shrink-0 text-white" />
        <p className="truncate text-sm">
          <span className="font-semibold text-white">
            Canopy is now Daintree — same app, new name.
          </span>
          <span className="ml-1 text-white/75">
            Reinstall under Daintree to keep receiving updates.
          </span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => openExternal(DOWNLOAD_URL)}
        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-white/25 bg-white/10 px-3 text-[12px] font-semibold text-white transition-[background-color,filter] hover:bg-white/20 active:brightness-95 focus:outline-none focus:ring-2 focus:ring-white/60 focus:ring-offset-1 focus:ring-offset-[#B24522]"
        style={{
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.15)",
        }}
      >
        Download Daintree
      </button>
    </div>
  );
}
