import { useEffect, useRef } from "react";
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
 *   The gate renders as a neutral card in the panel grid. An inbox entry
 *   keeps the choice discoverable after dismissal, alongside the sidebar.
 * - `plugin:project-plugins-changed` is a full snapshot, pushed on every open,
 *   trust change and staged activation. The manager renders from it rather than
 *   refetching, which is why nothing here polls. A manifest the host refused
 *   arrives in it already described, and gets announced once here — the folder
 *   is the user's own, so a plugin that will not parse is a mistake they can
 *   fix rather than a fact about someone else's software (#12212).
 * - `plugin:project-plugin-staged` announces a manifest id this project has
 *   never had. Non-blocking, once per id: main records the id the moment it
 *   stages it, so an ignored or declined stage never re-announces.
 * - `plugin:project-plugin-visibility-changed` carries the per-project overlay
 *   for INSTALLED plugins. Unlike the three above it has no cold-start emission,
 *   so the initial value is pulled once on mount.
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
  // Snapshots re-push on every open, trust change and activation, so the same
  // broken manifest arrives over and over. Keyed by the reason as well as the
  // folder, so editing the manifest into a *different* error is announced again
  // — that is progress the author wants to see — while re-reading the same one
  // is not.
  const announcedInvalid = useRef(new Set<string>());

  useEffect(() => {
    useProjectPluginStore.getState().setViewProjectId(viewProjectId);
  }, [viewProjectId]);

  useEffect(() => {
    const offPrompt = window.electron.events.on("plugin:project-trust-prompt", (payload) => {
      const store = useProjectPluginStore.getState();
      store.openPrompt(payload);
      // Only when the store actually took it — a prompt for a project this view
      // is not showing is refused there, and an inbox row for it would name a
      // folder the user is not looking at.
      if (useProjectPluginStore.getState().prompt !== payload) return;
      notify({
        type: "info",
        title: "Project plugins available",
        message:
          "They haven't been run. Decide whether to enable this project's plugins in the plugin manager.",
        // The grid card is the timely surface; the inbox keeps a route back
        // to the choice after dismissal without adding a duplicate toast.
        priority: "low",
        action: {
          label: "Open plugin manager",
          onClick: () => usePluginManagerStore.getState().open(),
        },
        supersedeKey: `project-plugin-trust:${payload.projectId}`,
        context: { projectId: payload.projectId, eventKind: "settings" },
      });
    });

    const offChanged = window.electron.events.on("plugin:project-plugins-changed", (payload) => {
      const before = useProjectPluginStore.getState();
      useProjectPluginStore.getState().applySnapshot(payload);
      // The store drops a snapshot for a project this view is not showing;
      // announcing one it refused would name a folder the user is not looking at.
      if (useProjectPluginStore.getState().projectId !== payload.projectId) return;
      if (before.projectId !== null && before.projectId !== payload.projectId) {
        announcedInvalid.current.clear();
      }

      for (const plugin of payload.plugins) {
        if (plugin.state !== "invalid") continue;
        const reason = plugin.error ?? "the manifest could not be read";
        const key = `${payload.projectId}:${plugin.dirName}:${reason}`;
        if (announcedInvalid.current.has(key)) continue;
        announcedInvalid.current.add(key);
        notify({
          type: "error",
          title: `Couldn't read the plugin in ${plugin.dirName}`,
          // The reason already names the field path — it is the formatted first
          // schema issue — and that path IS the fix, so it goes in whole.
          message: reason,
          // The staged announcement is passive because the sidebar carries the
          // same fact persistently. This one is not: the plugin the user just
          // wrote is not going to run, and nothing else will say so until they
          // happen to open the plugin manager.
          priority: "high",
          action: {
            label: "Open plugin manager",
            onClick: () => usePluginManagerStore.getState().open(),
          },
          correlationId: `project-plugin-invalid:${payload.projectId}:${plugin.dirName}`,
          context: { projectId: payload.projectId, eventKind: "settings" },
        });
      }
    });

    const offVisibility = window.electron.events.on(
      "plugin:project-plugin-visibility-changed",
      (payload) => {
        useProjectPluginStore.getState().applyVisibility(payload);
      }
    );

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

    // The visibility overlay has no cold-start push — main only emits it on a
    // change — so unlike the plugin list this pull is the primary read, not a
    // backstop.
    safeFireAndForget(useProjectPluginStore.getState().loadVisibility(), {
      context: "useProjectPluginBridge: initial project plugin visibility",
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
      offVisibility();
      offStaged();
    };
  }, []);
}
