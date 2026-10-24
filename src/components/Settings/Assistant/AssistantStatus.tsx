import type { ReactNode } from "react";
import { XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsInlineError } from "../SettingsGroup";

/** A status sentence with its mark: the colour sits on the dot, never on the words. */
export function StatusLine({
  tone,
  children,
  live = false,
}: {
  tone: "ok" | "idle" | "error";
  children: ReactNode;
  live?: boolean;
}) {
  return (
    <span role={live ? "status" : undefined} className="flex items-start gap-2">
      {tone === "error" ? (
        <XCircle className="w-3.5 h-3.5 mt-px shrink-0 text-status-error" aria-hidden="true" />
      ) : (
        <span
          className={cn(
            "status-mark mt-1 w-2 h-2 rounded-full shrink-0",
            tone === "ok" ? "bg-activity-working" : "bg-text-secondary"
          )}
          aria-hidden="true"
        />
      )}
      <span>{children}</span>
    </span>
  );
}

/** A failed load or save in this tab, said once when it happens, with its retry beside it. */
export function TabError({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <SettingsInlineError
      role="alert"
      action={
        onRetry && (
          <Button variant="ghost" size="xs" onClick={onRetry} className="-my-1 shrink-0">
            Retry
          </Button>
        )
      }
    >
      {children}
    </SettingsInlineError>
  );
}
