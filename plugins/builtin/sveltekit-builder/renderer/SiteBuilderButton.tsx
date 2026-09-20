import { SquareDashedMousePointer } from "lucide-react";
import type {
  DevPreviewToolButtonProps,
  DevPreviewToolContext,
} from "@/registry/devPreviewToolRegistry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Literals, not `shared/protocol.ts`: this button is in the eager bundle and the
// protocol module pulls in zod. `__tests__/entryIds.test.ts` checks them.
export const BUTTON_PLUGIN_ID = "daintree.sveltekit-builder";
export const DETECT_APPS_CHANNEL = "detect-apps";

/**
 * One lookup per worktree, reused briefly: every preview in a worktree asks the
 * same question as it mounts. The answer can change — someone scaffolds the app
 * after opening the preview — so the host re-asks whenever the preview's page
 * changes or becomes ready, and a "no" is never reused.
 */
const DETECTION_TTL_MS = 15_000;
const detected = new Map<string, { at: number; pending: Promise<boolean> }>();

/**
 * Main refuses a scan outright once its queue is full, so an overloaded host
 * answers "ask again", not "there is no app here". Nothing re-asks on its own:
 * the host re-runs availability when the preview's page changes, which may be
 * minutes away or never, and until then the toggle is hidden and any command
 * is refused with {@link SITE_BUILDER_UNAVAILABLE_REASON} — a statement about
 * the worktree we never actually established.
 *
 * One delayed retry is what closes that gap. The refusal is immediate and the
 * queue drains in scan time, so a second ask usually lands on capacity; if it
 * does not, the answer is still only "no" until the next lookup, never cached.
 */
const SCAN_BUSY_RETRY_MS = 750;

function isScanOverloaded(error: unknown): boolean {
  return error instanceof Error && error.message.includes("SCAN_BUSY");
}

function askMain(projectId: string, worktreeId: string, worktreePath: string): Promise<unknown> {
  // The ids, not just the path: main scans through a filesystem handle bound
  // to this workspace, so a preview on a worktree the focused window does not
  // own still gets a real answer rather than a denied read.
  return window.electron.plugin.invoke(BUTTON_PLUGIN_ID, DETECT_APPS_CHANNEL, {
    projectId,
    worktreeId,
    worktreePath,
  });
}

function hasSvelteKitApp(
  projectId: string,
  worktreeId: string,
  worktreePath: string
): Promise<boolean> {
  // Keyed by the workspace, not the path alone: the answer was authorised for
  // one project and worktree, and must not be lent to a call about another.
  const key = `${projectId}\n${worktreeId}\n${worktreePath}`;
  const cached = detected.get(key);
  if (cached && Date.now() - cached.at < DETECTION_TTL_MS) return cached.pending;
  const pending = askMain(projectId, worktreeId, worktreePath)
    .catch((error: unknown) => {
      if (!isScanOverloaded(error)) throw error;
      return new Promise((resolve) => setTimeout(resolve, SCAN_BUSY_RETRY_MS)).then(() =>
        askMain(projectId, worktreeId, worktreePath)
      );
    })
    .then((result) => {
      const count = (result as { appCount?: unknown }).appCount;
      const found = typeof count === "number" && count > 0;
      // Only a positive answer is reused: an app scaffolded a moment ago must
      // show up on the next page load, not after the cache runs out.
      if (!found && detected.get(key)?.pending === pending) detected.delete(key);
      return found;
    })
    .catch(() => {
      // A failed lookup is retried next time rather than hiding the button for good.
      detected.delete(key);
      return false;
    });
  detected.set(key, { at: Date.now(), pending });
  return pending;
}

/**
 * Whether this preview has anything to build: the tool's one availability
 * answer, which the host uses for both the toolbar toggle and any command
 * aimed at the builder.
 */
export function siteBuilderApplies(context: DevPreviewToolContext): Promise<boolean> {
  // No workspace to name means nothing to scope the scan to, and an unscoped
  // scan is exactly what this avoids — so the answer is no, not a guess.
  if (!context.projectId || !context.worktreeId || !context.worktreePath) {
    return Promise.resolve(false);
  }
  return hasSvelteKitApp(context.projectId, context.worktreeId, context.worktreePath);
}

/** Why a command is refused where the builder does not apply. */
export const SITE_BUILDER_UNAVAILABLE_REASON =
  "The Site Builder needs a SvelteKit app in this worktree";

/**
 * The dev preview toolbar toggle. Where it is shown is the host's call — it
 * asks `siteBuilderApplies` for this preview.
 */
export function SiteBuilderButton({ active, onToggle }: DevPreviewToolButtonProps) {
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
