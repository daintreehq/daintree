import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import type { ProjectPluginInfo } from "@shared/types/plugin";

const MICRO_LABEL = "text-3xs font-medium uppercase tracking-wider text-text-secondary";

function stateLabel(state: ProjectPluginInfo["state"]): string {
  switch (state) {
    case "active":
      return "Running";
    case "staged":
      return "Staged";
    case "blocked":
      return "Off";
    case "invalid":
      return "Unreadable";
  }
}

/**
 * The quiet, persistent way back into a project's own plugins.
 *
 * `Keep disabled` is remembered and must never re-prompt, so something has to
 * carry the offer afterwards or the decision is one-way. This is that something:
 * a Tier-1 ambient chrome item in the sidebar footer, sharing the surface and
 * the neutral dot of `ProjectResourceBadge` rather than inventing a new element.
 * No accent, no colour-coded state — a folder full of plugins the user turned
 * off is not a fault, and the popover is where the detail belongs.
 *
 * It renders only when there is something to act on: plugins that are blocked,
 * or staged and awaiting a click. A project whose plugins are all running shows
 * nothing at all, which is the point of the tier.
 */
export function ProjectPluginIndicator() {
  const [open, setOpen] = useState(false);
  const plugins = useProjectPluginStore((s) => s.plugins);
  const trust = useProjectPluginStore((s) => s.trust);
  const deciding = useProjectPluginStore((s) => s.deciding);
  const activating = useProjectPluginStore((s) => s.activating);
  const error = useProjectPluginStore((s) => s.error);
  const decide = useProjectPluginStore((s) => s.decide);
  const activateStaged = useProjectPluginStore((s) => s.activateStaged);

  const blocked = plugins.filter((p) => p.state === "blocked");
  const staged = plugins.filter((p) => p.state === "staged");
  const enabled = trust?.enabled === true;

  if (blocked.length === 0 && staged.length === 0) return null;

  const summary =
    blocked.length > 0
      ? `${blocked.length} project plugin${blocked.length === 1 ? "" : "s"} off`
      : `${staged.length} project plugin${staged.length === 1 ? "" : "s"} staged`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Project plugins — ${summary}`}
          className="px-4 py-2 border-t border-divider surface-chrome flex items-center shrink-0 w-full hover:bg-text-primary/[0.02] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex h-2 w-2 rounded-full bg-text-primary/25 shrink-0" />
            <span className="text-3xs text-text-secondary font-medium truncate">{summary}</span>
          </div>
        </button>
      </PopoverTrigger>

      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-3">
        <div className="space-y-3">
          <div>
            <p className={MICRO_LABEL}>Project plugins</p>
            <p className="mt-1 text-2xs text-text-secondary leading-relaxed">
              Shipped in this project&apos;s <code className="font-mono">.daintree/plugins</code>{" "}
              folder. Plugin code runs with your account and isn&apos;t sandboxed.
            </p>
          </div>

          <ul className="space-y-1">
            {plugins.map((plugin) => (
              <li key={plugin.id} className="flex items-center gap-2 min-w-0">
                <span className="text-2xs text-text-primary truncate flex-1 min-w-0">
                  {plugin.displayName}
                </span>
                {plugin.state === "staged" ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void activateStaged(plugin.id)}
                    loading={activating.has(plugin.id)}
                  >
                    Activate
                  </Button>
                ) : (
                  <span className="text-3xs text-text-secondary shrink-0">
                    {stateLabel(plugin.state)}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div className="pt-2 border-t border-divider space-y-2">
            {enabled ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => void decide("disabled")}
                  loading={deciding === "disabled"}
                >
                  Turn off project plugins
                </Button>
                <p className="text-3xs text-text-secondary leading-tight">
                  Every plugin this project ships unloads straight away.
                </p>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => void decide("enabled")}
                  loading={deciding === "enabled"}
                >
                  Enable for this project
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => void decide("session")}
                  loading={deciding === "session"}
                >
                  Enable for this session
                </Button>
              </>
            )}

            {error && <p className="text-3xs text-status-danger leading-tight">{error}</p>}

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                usePluginManagerStore.getState().open();
              }}
              className="text-2xs text-text-secondary hover:text-text-primary underline underline-offset-2 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              Open plugin manager
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
