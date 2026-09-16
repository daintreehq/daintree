import type { ReactNode } from "react";
import { AlertTriangle, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type NoticeTone = "info" | "warning" | "error";

const TONE_CLASS: Record<NoticeTone, string> = {
  info: "border-border-subtle bg-surface-inset",
  warning: "border-status-warning/40 bg-status-warning/10",
  error: "border-status-error/40 bg-status-error/10",
};

const ICON_CLASS: Record<NoticeTone, string> = {
  info: "text-text-secondary",
  warning: "text-status-warning",
  error: "text-status-error",
};

/**
 * A pane-local signal (T2/T3). The glyph is the tone's non-colour channel, and
 * the words carry the meaning on their own — tone never stands in for copy.
 */
export function InspectorNotice({
  tone,
  title,
  children,
  action,
  role,
  className,
}: {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
  className?: string;
}) {
  const Icon = tone === "error" ? XCircle : tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      role={role}
      data-tone={tone}
      className={cn("flex gap-2 rounded-md border px-3 py-2 text-xs", TONE_CLASS[tone], className)}
    >
      <Icon className={cn("mt-px h-3.5 w-3.5 shrink-0", ICON_CLASS[tone])} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium text-text-primary">{title}</p>
        {children ? <div className="text-text-secondary">{children}</div> : null}
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}
