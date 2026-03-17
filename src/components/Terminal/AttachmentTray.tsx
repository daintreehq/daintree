import { memo } from "react";
import { X, ImageIcon, FileText } from "lucide-react";
import type { TrayItem } from "./attachmentTrayUtils";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";

interface AttachmentTrayProps {
  items: TrayItem[];
  onRemove: (item: TrayItem) => void;
}

const KIND_ICON = {
  image: ImageIcon,
  file: FileText,
} as const;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const AttachmentTray = memo(function AttachmentTray({
  items,
  onRemove,
}: AttachmentTrayProps) {
  if (items.length === 0) return null;

  return (
    <ul className="mt-1.5 flex flex-wrap gap-1 text-[11px] leading-tight">
      {items.map((item) => {
        const Icon = KIND_ICON[item.kind];
        return (
          <li key={item.id} className="flex items-center">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-sm bg-tint/[0.04] px-1.5 py-0.5 text-canopy-text/70 hover:bg-tint/[0.08] transition-colors cursor-default"
                  >
                    <Icon className="h-3 w-3 shrink-0 opacity-60" />
                    <span className="max-w-[140px] truncate">{item.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className={item.kind === "image" ? "p-0 overflow-hidden" : undefined}
                >
                  {item.kind === "image" && item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt={item.label}
                      style={{ width: 160, height: "auto" }}
                      className="block rounded-[var(--radius-md)]"
                    />
                  ) : (
                    <span>
                      {item.label}
                      {item.fileSize != null && ` \u00b7 ${formatFileSize(item.fileSize)}`}
                    </span>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <button
              type="button"
              className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-canopy-text/40 hover:bg-tint/[0.08] hover:text-canopy-text/80 transition-colors cursor-pointer"
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
  );
});
