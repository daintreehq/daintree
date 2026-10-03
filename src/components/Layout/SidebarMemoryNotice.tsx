import { MemoryStick } from "@/components/icons";
import { SidebarFooterGlyph } from "@/components/Layout/SidebarFooterGlyph";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { cn } from "@/lib/utils";
import { useSystemMemoryNoticeStore } from "@/store/systemMemoryNoticeStore";

/**
 * High system memory use, as one ambient line at the top of the sidebar
 * footer (#13101). It used to be a grid bar that stayed until dismissed, and on
 * a machine that runs hot it came back every episode — too loud for a reading
 * Daintree didn't cause and can't fix.
 *
 * Tier-1 chrome: neutral glyph and secondary text, never an accent or a status
 * colour, no dismiss. It states what was measured and nothing else (#12462),
 * clears itself on recovery, and follows the footer's polarity — the reading on
 * the left, its one control on the right, shortened below 280px like "Run".
 */
export function SidebarMemoryNotice() {
  const notice = useSystemMemoryNoticeStore((s) => s.notice);

  if (!notice) return null;

  const { action } = notice;

  return (
    <div data-sidebar-memory-notice="" className="flex min-h-7 w-full shrink-0 items-stretch">
      <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-4 pr-2">
        <SidebarFooterGlyph>
          <MemoryStick className="h-3 w-3 text-text-secondary" aria-hidden="true" />
        </SidebarFooterGlyph>
        <TruncatedTooltip content={notice.detail} side="top" contentClassName="max-w-xs">
          <span
            role="status"
            aria-atomic="true"
            className="min-w-0 truncate text-2xs font-medium text-text-secondary"
          >
            {notice.reading}
          </span>
        </TruncatedTooltip>
      </div>
      {action && (
        <button
          type="button"
          data-sidebar-memory-action=""
          aria-label={action.label}
          onClick={() => void action.onClick()}
          className={cn(
            "flex shrink-0 items-center px-3 text-2xs font-medium text-text-secondary transition-colors",
            "hover:bg-overlay-soft hover:text-text-primary",
            "focus-visible:bg-overlay-medium focus-visible:text-text-primary",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
          )}
        >
          <span>
            Ask agent<span className="@max-[280px]/footer:hidden"> about memory</span>
          </span>
        </button>
      )}
    </div>
  );
}
