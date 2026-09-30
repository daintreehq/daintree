import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";

export interface UnderlineTabItem<T extends string = string> {
  id: T;
  label: string;
  renderIcon?: (isActive: boolean) => ReactNode;
  trailing?: ReactNode;
}

interface UnderlineTabsProps<T extends string> {
  tabs: UnderlineTabItem<T>[];
  activeId: T;
  onChange: (id: T) => void;
  "aria-label": string;
  /** The tab's own id. Its panel points back at it with `aria-labelledby`. */
  tabId: (id: T) => string;
  /** The id of the panel each tab controls. */
  panelId: (id: T) => string;
  /**
   * `page` sits above a page of content (settings subtabs) and sizes itself from
   * its padding. `strip` fills the height of a fixed chrome strip — a drawer or
   * dock header — so the underline lands on the strip's own bottom edge.
   */
  density?: "page" | "strip";
  className?: string;
}

/**
 * The app's one horizontal tab strip: settings subtabs, the diagnostics dock and
 * the dev preview's output drawer. They are the same control, so they share one
 * look ("Settings Nav Active" in docs/themes/interaction-state-recipes.md), one
 * keyboard model and one focus ring.
 *
 * WAI-ARIA Tabs with automatic activation: arrow keys and Home/End move focus and
 * select in one step, wrapping at the ends, and only the selected tab is a tab stop.
 */
export function UnderlineTabs<T extends string>({
  tabs,
  activeId,
  onChange,
  "aria-label": ariaLabel,
  tabId,
  panelId,
  density = "page",
  className,
}: UnderlineTabsProps<T>) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const focusedIndex = buttons.findIndex((button) => button === document.activeElement);
    if (focusedIndex === -1) return;

    let nextIndex: number;
    switch (e.key) {
      case "ArrowRight":
        nextIndex = (focusedIndex + 1) % buttons.length;
        break;
      case "ArrowLeft":
        nextIndex = (focusedIndex - 1 + buttons.length) % buttons.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = buttons.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    buttons[nextIndex]!.focus();
    onChange(next.id);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn("flex gap-x-1 -mb-px", density === "strip" && "self-stretch", className)}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-selected={isActive}
            aria-controls={panelId(tab.id)}
            tabIndex={isActive ? 0 : -1}
            data-tab={tab.id}
            onClick={() => onChange(tab.id)}
            className={cn(
              "inline-flex items-center gap-2 px-3 text-sm font-medium whitespace-nowrap",
              density === "strip" ? "pt-0.5" : "pb-2.5 pt-0.5",
              "transition-[color,border-color] duration-150 ease-out flex-shrink-0",
              // -outline-offset keeps the ring inside the button's own box. With a
              // positive offset the top edge was clipped by the scrollport whenever the
              // bar sat against the dialog header, leaving an open-topped "U".
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2 focus-visible:rounded-[var(--radius-sm)]",
              isActive
                ? // forced-colors replaces every author colour with a system one, so an
                  // accent underline against a transparent sibling underline becomes two
                  // identical lines and the active tab is unidentifiable. A Highlight
                  // outline is the one selection cue that survives there.
                  "border-b-2 border-accent-primary text-text-primary forced-colors:outline forced-colors:outline-2 forced-colors:[outline-color:Highlight] forced-colors:rounded-[var(--radius-sm)]"
                : "border-b-2 border-transparent text-text-secondary hover:border-border-default hover:text-text-primary"
            )}
          >
            {tab.renderIcon?.(isActive)}
            <span>{tab.label}</span>
            {tab.trailing && (
              <span className="flex items-center gap-1 shrink-0">{tab.trailing}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const ERROR_COUNT_CAP = 99;

/**
 * The error tally a tab carries (Problems, Console). Error-toned because it is
 * the one count in either strip that means something is wrong; capped so a burst
 * of errors cannot push the strip's other tabs about. The numeral is visual only
 * and the full count is what a screen reader says, since "Problems, 99+, tab"
 * names neither the unit nor the number.
 */
export function TabErrorCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge size="xs" tone="error" shape="pill" className="leading-none tabular-nums">
      <span aria-hidden="true">{count > ERROR_COUNT_CAP ? `${ERROR_COUNT_CAP}+` : count}</span>
      <span className="sr-only">{pluralize(count, "error")}</span>
    </Badge>
  );
}
