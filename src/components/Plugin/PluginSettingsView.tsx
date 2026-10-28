import { useEffect, useRef } from "react";
import { ChevronLeft } from "lucide-react";
import type { LoadedPluginInfo, PluginSettingsViewContext } from "@shared/types/plugin";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import { pluginDeclaresSettingsView, settingsViewOf } from "@/services/plugin/pluginSettingsHome";
import { selectPluginHostedView, usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";

/**
 * A plugin's custom settings section (`contributes.views` with `location:
 * "settings"`), mounted in its settings home below the declared fields.
 *
 * The host owns the chrome: the section heading is the home's own, and the
 * view renders its rows inside this one `SettingsGroup` surface, so a custom
 * section reads as more rows of the same settings rather than a panel pasted
 * into a page. The view itself mounts through the shared hosted-view path
 * (`PluginHostedView`) with `hostContext: "settings"` — the same activation,
 * error boundary and "Try again" a panel gets, contained so it can't paint over
 * the page around it. There is no dialog-level Save: the view applies its own
 * changes as they are made, like every other settings row.
 *
 * Its module URL comes from the hosted-view snapshot main pushes to this
 * project, so a plugin reload swaps the open section onto the new module, and a
 * plugin that stops or is hidden in this project withdraws it.
 *
 * A plugin that declares a section but can't show it here still gets the
 * section, as one row saying what it needs, rather than leaving the user to
 * guess where it went.
 *
 * A view that declares `pages` gets them listed under its root as rows with
 * an Open button. An open page keeps the same mount — the view just hears the
 * page id in `settingsContext.page` — under a host-drawn heading with a Back
 * button that returns focus to the page's Open button.
 */
export function PluginSettingsView({
  plugin,
  context,
  running = true,
  page = null,
  onPageChange,
  pageHeadingId,
  focus = null,
  onFocusAnswered,
}: {
  plugin: LoadedPluginInfo;
  context: PluginSettingsViewContext;
  /** False while the home knows the plugin is stopped, even if its list is stale. */
  running?: boolean;
  /** The declared page that is open, or `null` for the section's root. */
  page?: string | null;
  onPageChange?: (page: string | null) => void;
  /** The DOM id the open page's heading takes, where a page deep link lands. */
  pageHeadingId?: string;
  /** A deep link to a key the view edits, handed on until it is answered. */
  focus?: { key: string; nonce: number } | null;
  onFocusAnswered?: (nonce: number, landed: boolean) => void;
}) {
  const initHostedViews = usePluginHostedViewsStore((s) => s.init);
  useEffect(() => {
    initHostedViews();
  }, [initHostedViews]);
  const snapshotLoaded = usePluginHostedViewsStore((s) => s.views !== null);
  const loadFailed = usePluginHostedViewsStore((s) => s.loadFailed);
  const view = usePluginHostedViewsStore((s) =>
    selectPluginHostedView(s.views, plugin.instanceId, "settings")
  );

  const pages = settingsViewOf(plugin)?.pages ?? [];
  const openPage = page === null ? undefined : pages.find((p) => p.id === page);
  // Back hands focus to the Open button it came from; opening a page moves it
  // to the page's heading, so a keyboard user is never left on a control that
  // has just been unmounted.
  const pagesRef = useRef<HTMLDivElement>(null);
  const returnToPage = useRef<string | null>(null);
  const openPageId = openPage?.id ?? null;
  useEffect(() => {
    if (openPageId !== null) {
      // Remembered even before the view has rendered, so Back after a deep
      // link into a page still knows where to return.
      returnToPage.current = openPageId;
      if (pageHeadingId !== undefined) document.getElementById(pageHeadingId)?.focus();
      return;
    }
    const back = returnToPage.current;
    returnToPage.current = null;
    const root = pagesRef.current;
    if (back === null || root === null) return;
    // Only when focus went down with the page (Back, or the page's controls);
    // never pulled away from wherever the user has moved on to.
    const active = document.activeElement;
    if (active !== null && active !== document.body && !root.contains(active)) return;
    // The page's own Open button, or — when a reload dropped that page — the
    // first page left, or the section itself, rather than the document.
    const trigger =
      root.querySelector<HTMLElement>(`[data-settings-page-trigger="${CSS.escape(back)}"]`) ??
      root.querySelector<HTMLElement>("[data-settings-page-trigger]");
    if (trigger) {
      trigger.focus({ preventScroll: false });
      return;
    }
    if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
    root.focus({ preventScroll: true });
  }, [openPageId, pageHeadingId]);

  const viewFocus =
    focus !== null && onFocusAnswered !== undefined
      ? {
          key: focus.key,
          nonce: focus.nonce,
          acknowledge: (landed: boolean) => onFocusAnswered(focus.nonce, landed),
        }
      : undefined;
  const viewContext: PluginSettingsViewContext = {
    ...context,
    ...(pages.length > 0 ? { page: openPage?.id ?? null } : {}),
    ...(viewFocus !== undefined ? { focus: viewFocus } : {}),
  };

  if (!pluginDeclaresSettingsView(plugin)) return null;
  if (running && view !== undefined) {
    return (
      <div ref={pagesRef} className="grid gap-3">
        {openPage !== undefined && (
          <div className="flex items-start gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPageChange?.(null)}
              aria-label="Back to all settings"
            >
              <ChevronLeft aria-hidden="true" />
              Back
            </Button>
            <div className="min-w-0 pt-1">
              <h4
                id={pageHeadingId}
                tabIndex={-1}
                className="text-sm font-medium text-text-primary"
              >
                {openPage.title}
              </h4>
              {openPage.description !== undefined && (
                <p className="text-xs text-text-secondary">{openPage.description}</p>
              )}
            </div>
          </div>
        )}
        <SettingsGroup>
          <PluginHostedView
            source={{ from: "hosted", view }}
            host="settings"
            // Keyed by home: the manager and the project page each hold their own
            // mount, and a view's per-mount state belongs to one of them.
            mountId={`settings:${plugin.instanceId}:${context.scope}`}
            settingsContext={viewContext}
            testId="plugin-settings-view"
          />
        </SettingsGroup>
        {openPage === undefined && pages.length > 0 && (
          <SettingsGroup>
            {pages.map((p) => (
              <SettingsRow
                key={p.id}
                label={p.title}
                {...(p.description !== undefined ? { description: p.description } : {})}
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    data-settings-page-trigger={p.id}
                    aria-label={`Open ${p.title}`}
                    onClick={() => onPageChange?.(p.id)}
                  >
                    Open
                  </Button>
                }
              />
            ))}
          </SettingsGroup>
        )}
      </div>
    );
  }
  if (running && !plugin.disabled && !snapshotLoaded) {
    // The first snapshot is one round trip away; a running plugin's section
    // waits for it rather than flashing a row that says it isn't available.
    if (!loadFailed) return null;
    return (
      <SettingsGroup>
        <SettingsRow
          label="More settings"
          description="Couldn't load this section"
          control={
            <Button size="sm" variant="outline" onClick={initHostedViews}>
              Retry
            </Button>
          }
        />
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup>
      <SettingsRow label="More settings" description={unavailableReason(plugin, running)} />
    </SettingsGroup>
  );
}

function unavailableReason(plugin: LoadedPluginInfo, running: boolean): string {
  if (plugin.disabled) return "Available when the plugin is enabled";
  if (!running || plugin.blocklisted || plugin.origin === "project") {
    return "Available while the plugin is running";
  }
  // Main serves this project no section for a running installed plugin. Said
  // as observed: usually the project hides the plugin, but a reload in flight
  // reads the same way for a moment.
  return "Not available in this project";
}
