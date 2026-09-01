import { useEffect } from "react";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useProjectStore } from "@/store/projectStore";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";

/**
 * Wires this project view to its own `.daintree/plugins/` folder.
 *
 * Three project-scoped pushes arrive here and nowhere else:
 *
 * - `plugin:project-trust-prompt` raises the consent gate. It is the **only**
 *   thing in the renderer that may, and main emits it only when the folder holds
 *   a valid manifest and no decision is on record — so a project the user has
 *   already answered for never asks again, whatever its contents do afterwards.
 * - `plugin:project-plugins-changed` is a full snapshot, pushed on every open,
 *   trust change and staged activation. The manager renders from it rather than
 *   refetching, which is why nothing here polls.
 * - `plugin:project-plugin-staged` announces a manifest id this project has
 *   never had. Non-blocking, once per id: main records the id the moment it
 *   stages it, so an ignored or declined stage never re-announces.
 *
 * The one fetch is a cold-start backstop for the snapshot. It cannot raise the
 * gate — `plugin:project-list` carries inventory, not consent — so a missed
 * prompt degrades to "the folder is listed and blocked", never to a dialog this
 * renderer decided to show on its own.
 *
 * Mounted once near the app root, alongside the other plugin bridges.
 */
export function useProjectPluginBridge(): void {
  const viewProjectId = useProjectStore((s) => s.currentProject?.id ?? null);

  useEffect(() => {
    useProjectPluginStore.getState().setViewProjectId(viewProjectId);
  }, [viewProjectId]);

  useEffect(() => {
    const offPrompt = window.electron.events.on("plugin:project-trust-prompt", (payload) => {
      useProjectPluginStore.getState().openPrompt(payload);
    });

    const offChanged = window.electron.events.on("plugin:project-plugins-changed", (payload) => {
      useProjectPluginStore.getState().applySnapshot(payload);
    });

    const offStaged = window.electron.events.on("plugin:project-plugin-staged", (payload) => {
      notify({
        type: "info",
        title: "Project plugin staged",
        message: `'${payload.displayName}' was added to this project's plugins folder and hasn't been run.`,
        action: {
          label: "Review",
          onClick: () => usePluginManagerStore.getState().open(),
        },
        correlationId: `project-plugin-staged:${payload.projectId}`,
        // "settings" routes this passively — the inbox, not a toast. The
        // sidebar indicator already carries the same signal persistently and
        // never expires, so interrupting for it as well would be the same fact
        // twice at a louder tier than it earns.
        context: { projectId: payload.projectId, eventKind: "settings" },
      });
    });

    let cancelled = false;
    safeFireAndForget(
      window.electron.plugin.getProjectPlugins().then((plugins) => {
        if (cancelled) return;
        const state = useProjectPluginStore.getState();
        // Only fills a genuine gap. Once a snapshot push has landed it owns the
        // rows, and this reply — which carries no trust state — must not
        // overwrite them with a half-populated view.
        if (state.trust !== null || plugins.length === 0) return;
        state.applySnapshot({
          projectId: state.viewProjectId ?? plugins[0]?.projectId ?? "",
          plugins,
          trust: state.trust ?? {
            projectId: state.viewProjectId ?? plugins[0]?.projectId ?? "",
            decision: null,
            enabled: false,
            persisted: false,
          },
        });
      }),
      { context: "useProjectPluginBridge: initial project plugin list" }
    );

    // Deliberately no `reset()` here. The preload replays a buffered prompt to
    // its FIRST subscriber and drops it, and main never re-emits one once a
    // decision is stored — so clearing the store on unmount would throw away the
    // only prompt this project will ever get. A StrictMode double-mount and a
    // plain remount both hit that path. The store is per project view and dies
    // with the V8 context anyway, so there is nothing here worth reclaiming.
    return () => {
      cancelled = true;
      offPrompt();
      offChanged();
      offStaged();
    };
  }, []);
}
