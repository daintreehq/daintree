import { memo } from "react";
import { X, ImageIcon, FileText, Link } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TrayItem } from "./attachmentTrayUtils";
import { buildSummaryLine, isWarningUsage } from "./attachmentTrayUtils";

interface AttachmentTrayProps {
  items: TrayItem[];
  totalTokens: number;
  contextWindow: number;
  onRemove: (item: TrayItem) => void;
}

const KIND_ICON = {
  image: ImageIcon,
  file: FileText,
  url: Link,
} as const;

export const AttachmentTray = memo(function AttachmentTray({
  items,
  totalTokens,
  contextWindow,
  onRemove,
}: AttachmentTrayProps) {
  if (items.length === 0) return null;

  const warning = isWarningUsage(totalTokens, contextWindow);
  const summary = buildSummaryLine(items);

  return (
    <div
      className={cn(
        "mt-1.5 rounded-sm border px-2.5 py-1.5 text-[11px] leading-tight",
        warning
          ? "border-activity-waiting/40 bg-activity-waiting/[0.06]"
          : "border-white/[0.06] bg-white/[0.02]"
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 font-medium",
          warning ? "text-activity-waiting" : "text-canopy-text/60"
        )}
      >
        <span>{summary}</span>
        {warning && (
          <span className="shrink-0 text-[10px] text-activity-waiting/80">
            Context limit approaching
          </span>
        )}
      </div>

      <ul className="mt-1 flex flex-wrap gap-1">
        {items.map((item) => {
          const Icon = KIND_ICON[item.kind];
          return (
            <li
              key={item.id}
              className="flex items-center gap-1 rounded-sm bg-white/[0.04] px-1.5 py-0.5 text-canopy-text/70"
            >
              <Icon className="h-3 w-3 shrink-0 opacity-60" />
              <span className="max-w-[140px] truncate">{item.label}</span>
              <span className="shrink-0 text-[10px] opacity-50">
                ~{item.tokenEstimate.toLocaleString()}tk
              </span>
              <button
                type="button"
                className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-canopy-text/40 hover:bg-white/[0.08] hover:text-canopy-text/80 transition-colors cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item);
                }}
                aria-label={`Remove ${item.label}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
});
