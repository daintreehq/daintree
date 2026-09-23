import { useId } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsSectionProps {
  title: string;
  /**
   * What the section is for, when the title alone does not say it. Never a restatement
   * of the title or of the one row beneath it.
   */
  description?: ReactNode;
  children: ReactNode;
  id?: string;
  badge?: string;
  /** Section-level control pinned to the right of the heading (a wizard, an "Add" button). */
  action?: ReactNode;
  className?: string;
}

/**
 * A titled block on a settings page: heading outside, its groups and rows below.
 *
 * No icon. The sidebar and the page title already carry one, and a glyph on every
 * section heading made each page a column of icons the eye had to read past to reach
 * the words. No sticky header either: it pinned the heading and its paragraph over
 * the content being read, with the scrolled rows ghosting through behind it.
 */
export function SettingsSection({
  title,
  description,
  children,
  id,
  badge,
  action,
  className,
}: SettingsSectionProps) {
  const headingId = useId();

  return (
    // A group, not a <section>: a named section is a region landmark, and thirty of
    // them per page would bury the dialog's real landmarks for screen-reader users.
    <div
      className={cn("settings-section grid grid-cols-[minmax(0,1fr)] gap-3 scroll-mt-6", className)}
      id={id}
      role="group"
      aria-labelledby={headingId}
    >
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h4
            id={headingId}
            className="text-sm font-semibold text-text-primary flex items-center gap-2 flex-wrap"
          >
            {title}
            {badge && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-3xs font-medium bg-overlay-subtle border border-border-default text-text-secondary">
                {badge}
              </span>
            )}
          </h4>
          {description && (
            <p className="mt-1 text-xs text-text-secondary select-text">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
      </div>
      {children}
    </div>
  );
}
