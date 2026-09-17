import { useEffect, useState } from "react";
import { SquareDashedMousePointer } from "lucide-react";
import type { DevPreviewToolButtonProps } from "@/registry/devPreviewToolRegistry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Literals, not `shared/protocol.ts`: this button is in the eager bundle and the
// protocol module pulls in zod. `__tests__/entryIds.test.ts` checks them.
export const BUTTON_PLUGIN_ID = "daintree.sveltekit-builder";
export const DETECT_APPS_CHANNEL = "detect-apps";

/**
 * One lookup per worktree, reused briefly: every preview in a worktree asks the
 * same question as it mounts. The answer can change — someone scaffolds the app
 * after opening the preview — so it is re-asked whenever the preview's page
 * changes or becomes ready, and a "no" is never reused.
 */
const DETECTION_TTL_MS = 15_000;
const detected = new Map<string, { at: number; pending: Promise<boolean> }>();

function hasSvelteKitApp(worktreePath: string): Promise<boolean> {
  const cached = detected.get(worktreePath);
  if (cached && Date.now() - cached.at < DETECTION_TTL_MS) return cached.pending;
  const pending = window.electron.plugin
    .invoke(BUTTON_PLUGIN_ID, DETECT_APPS_CHANNEL, { worktreePath })
    .then((result) => {
      const count = (result as { appCount?: unknown }).appCount;
      const found = typeof count === "number" && count > 0;
      // Only a positive answer is reused: an app scaffolded a moment ago must
      // show up on the next page load, not after the cache runs out.
      if (!found && detected.get(worktreePath)?.pending === pending) detected.delete(worktreePath);
      return found;
    })
    .catch(() => {
      // A failed lookup is retried next time rather than hiding the button for good.
      detected.delete(worktreePath);
      return false;
    });
  detected.set(worktreePath, { at: Date.now(), pending });
  return pending;
}

/** The dev preview toolbar toggle, shown only on a worktree with a SvelteKit app. */
export function SiteBuilderButton({
  worktreePath,
  url,
  isWebviewReady,
  active,
  onToggle,
}: DevPreviewToolButtonProps) {
  const [available, setAvailable] = useState<{ path: string; ok: boolean } | null>(null);

  // Re-asked when the page changes or finishes loading: a dev server that just
  // came up may be the first sign the app exists.
  useEffect(() => {
    if (!worktreePath) return;
    let cancelled = false;
    void hasSvelteKitApp(worktreePath).then((ok) => {
      if (!cancelled) setAvailable({ path: worktreePath, ok });
    });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, url, isWebviewReady]);

  // Keep an active builder reachable even if detection hasn't answered.
  if (!active && !(available?.ok && available.path === worktreePath)) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Site Builder"
          aria-pressed={active}
          className={cn(
            "toolbar-icon-button rounded-[var(--radius-md)] p-1.5",
            active && "bg-overlay-soft text-text-primary"
          )}
        >
          <SquareDashedMousePointer className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {active ? "Close Site Builder" : "Trace an element to its source, or ask an agent about it"}
      </TooltipContent>
    </Tooltip>
  );
}
