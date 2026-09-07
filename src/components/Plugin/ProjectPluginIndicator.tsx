import { useState } from "react";
import { RefreshCw } from "lucide-react";
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
 * A plugin that loaded and then hit an error is still `active`, so the state
 * alone would call it "Running" (#12232). The last outcome outranks the state
 * here — "Running" for something that threw on startup is the one label that
 * would actively mislead.
 */
function rowLabel(plugin: ProjectPluginInfo): string {
  return plugin.loadError ? "Error" : stateLabel(plugin.state);
}

/**
 * The quiet, persistent way back into a project's own plugins.
 *
 * `Keep disabled` is remembered and must never re-prompt, so something has to
 * carry the offer afterwards or the decision is one-way. This is that something:
 * a Tier-1 ambient chrome item in the sidebar footer, sharing the surface and
 * the neutral dot of `ProjectResourceBadge` rather than inventing a new element.
 * Never an accent, and never a status colour — a folder full of plugins the
 * user turned off is not a fault, and the popover is where the detail belongs.
 * The dot stays neutral even for a genuine fault: `ProjectResourceBadge`, its
 * neighbour in this same footer stack, flattens `critical` to the same neutral,
 * and #12212 ruled an unreadable manifest into that chrome too. An activation
 * failure (#12232) is the same kind of fault as an unreadable one, so it reads
 * the same way here — the summary line names it, and the row below names the
 * cause.
 *
 * It renders only when there is something to act on: plugins that are blocked,
 * staged and awaiting a click, unreadable, or broken. A project whose plugins
 * all loaded and ran shows nothing at all, which is the point of the tier.
 *
 * Unreadable earns a place here because a manifest the host refused is a fault
 * the author has to fix, and before #12212 the only record of it anywhere was
 * red text inside the plugin manager that nothing pointed at. It stays inside
 * the same neutral chrome as the other states — the summary line names it, and
 * the reason sits in the popover next to the reload that retries it.
 */
export function ProjectPluginIndicator() {
  const [open, setOpen] = useState(false);
  const plugins = useProjectPluginStore((s) => s.plugins);
  const trust = useProjectPluginStore((s) => s.trust);
  const deciding = useProjectPluginStore((s) => s.deciding);
  const activating = useProjectPluginStore((s) => s.activating);
  const reloading = useProjectPluginStore((s) => s.reloading);
  const error = useProjectPluginStore((s) => s.error);
  const decide = useProjectPluginStore((s) => s.decide);
  const activateStaged = useProjectPluginStore((s) => s.activateStaged);
  const reload = useProjectPluginStore((s) => s.reload);

  const blocked = plugins.filter((p) => p.state === "blocked");
  const staged = plugins.filter((p) => p.state === "staged");
  const invalid = plugins.filter((p) => p.state === "invalid");
  const failed = plugins.filter((p) => p.loadError !== undefined);
  const enabled = trust?.enabled === true;
  // The decision applied but never reached disk, so the next launch will ask
  // again. Nothing else can carry this: a failed "always enable" still STARTS
  // the plugins, so every row goes active and the rejected call's error has no
  // surface left to appear on (#12212).
  const unsaved = trust?.decision === "enabled" && trust.persisted === false;

  if (
    blocked.length === 0 &&
    staged.length === 0 &&
    invalid.length === 0 &&
    failed.length === 0 &&
    !unsaved
  )
    return null;

  // Ordered by how much it is a fault rather than a state the user chose, and
  // by how little else carries it. A decision that silently will not survive a
  // restart first — nothing else can show it, since a failed "always enable"
  // still starts the plugins. Then a plugin that loaded and hit an error, whose
  // row state says "Running" and so reads as healthy until this says otherwise.
  // Then a manifest that will not parse, which its own row already labels
  // "Unreadable". Then the two ordinary resting states.
  const summary = unsaved
    ? "Project plugins on, but not saved"
    : failed.length > 0
      ? failed.length === 1
        ? "1 project plugin has an error"
        : `${failed.length} project plugins have errors`
      : invalid.length > 0
        ? `${invalid.length} project plugin${invalid.length === 1 ? "" : "s"} unreadable`
        : blocked.length > 0
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
              <li key={plugin.id} className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
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
                      {rowLabel(plugin)}
                    </span>
                  )}
                </div>
                {/* The reason, where the state is. Naming the field that was
                    rejected is the whole fix a typo'd manifest needs, and the
                    plugin manager was the only place it existed. */}
                {plugin.state === "invalid" && plugin.error && (
                  <p className="mt-0.5 text-3xs text-text-secondary leading-tight break-words">
                    {plugin.error}
                  </p>
                )}
                {/* Same slot for the same job. A rejected manifest and a plugin
                    that threw are both "the folder is not working", and the two
                    can never appear together — a manifest that failed discovery
                    never loads, so it never reaches an activation. */}
                {plugin.loadError && (
                  <p className="mt-0.5 text-3xs text-text-secondary leading-tight break-words">
                    {plugin.loadError.message}
                  </p>
                )}
              </li>
            ))}
          </ul>

          <div className="pt-2 border-t border-divider space-y-2">
            {/* Re-reads the folder in place. Before #12212 the only way to pick
                up a fixed manifest was to switch projects and back. */}
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => void reload()}
              loading={reloading}
            >
              <RefreshCw />
              Reload from folder
            </Button>

            {unsaved && (
              <>
                <p className="text-3xs text-text-secondary leading-tight">
                  These plugins are running, but Daintree couldn&apos;t write the choice to its
                  settings file — this project will ask again next launch.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => void decide("enabled")}
                  loading={deciding === "enabled"}
                >
                  Retry
                </Button>
              </>
            )}

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
