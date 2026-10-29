import { useEffect, useRef, useSyncExternalStore } from "react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  pluginDocumentRuntime,
  type PluginDocumentDiagnostic,
} from "@/services/plugin/pluginDocumentRuntime";
import { actionService } from "@/services/ActionService";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import { useProjectStore } from "@/store/projectStore";
import { notify } from "@/lib/notify";
import { usePluginRuntimeStore, type PluginRuntimeMeta } from "@/store/pluginRuntimeStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useGlobalBannerDismissalStore } from "@/store/globalBannerDismissalStore";

/**
 * The plugins a reload would replace, by the names people know them by — the
 * manifest id only for one the runtime store can't name yet.
 */
function affectedPlugins(
  diagnostics: readonly PluginDocumentDiagnostic[],
  metaById: ReadonlyMap<string, PluginRuntimeMeta>
): string {
  return [
    ...new Set(
      diagnostics.map((item) =>
        item.pluginId
          ? (metaById.get(item.pluginId)?.displayName ??
            pluginManifestIdFromInstanceKey(item.pluginId))
          : "Unknown plugin"
      )
    ),
  ].join(", ");
}

/** {@link affectedPlugins}, kept current as the runtime store learns names. */
function useAffectedPlugins(diagnostics: readonly PluginDocumentDiagnostic[]): string {
  const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
  useEffect(() => initPluginRuntime(), [initPluginRuntime]);
  return usePluginRuntimeStore((s) => affectedPlugins(diagnostics, s.pluginMetaById));
}

function requestReload() {
  void actionService.dispatch("plugin.reloadWindow", undefined, { source: "user" });
}

export function PluginDocumentWarning() {
  const diagnostics = useSyncExternalStore(
    pluginDocumentRuntime.subscribe,
    pluginDocumentRuntime.getSnapshot
  );
  const dismiss = useGlobalBannerDismissalStore((s) => s.dismiss);
  const affected = useAffectedPlugins(diagnostics);
  if (diagnostics.length === 0) return null;
  return (
    <InlineStatusBanner
      severity="warning"
      role="status"
      title="Plugins need a window reload"
      // A reload is the user's to schedule; the inbox entry keeps it findable.
      onClose={() => dismiss("plugin-document")}
      closeAriaLabel="Dismiss plugin reload warning"
      description="Plugin registrations can't be replaced until this project window reloads. Save edits before continuing."
      contextLine={affected}
      action={{ id: "reload-project-window", label: "Reload window", onClick: requestReload }}
    />
  );
}

/** Mounted independently of banner priority so a higher-priority warning cannot strand a request. */
export function PluginDocumentReloadDialog() {
  const pending = useSyncExternalStore(
    pluginDocumentRuntime.subscribe,
    pluginDocumentRuntime.getReloadConfirmation
  );
  useEffect(() => () => pluginDocumentRuntime.resolveReloadConfirmation(false), []);
  if (!pending) return null;
  return (
    <ConfirmDialog
      isOpen
      title="Reload this project window?"
      description="Reloads every view in this project window to replace plugin registrations. Unsaved edits and other in-memory view state may be lost. Save your work before reloading."
      confirmLabel="Reload window"
      variant="destructive"
      onClose={() => pluginDocumentRuntime.resolveReloadConfirmation(false)}
      onConfirm={() => pluginDocumentRuntime.resolveReloadConfirmation(true)}
    />
  );
}

/** Keep recovery discoverable in the inbox while another banner owns the global slot. */
export function usePluginDocumentNotifications() {
  const diagnostics = useSyncExternalStore(
    pluginDocumentRuntime.subscribe,
    pluginDocumentRuntime.getSnapshot
  );
  const projectId = useProjectStore((state) => state.currentProject?.id);
  const summary = useAffectedPlugins(diagnostics);
  // Each diagnostic is a new snapshot, but the inbox entry only changes when
  // the set of affected plugins does; re-notifying archives the previous entry
  // and churns unrelated history off the 200-entry cap.
  const lastSummary = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    const key = `plugin-document:${projectId}`;
    if (diagnostics.length === 0) {
      // A reload replaces the document but not the persisted inbox, so the
      // previous document's entry would keep claiming a reload is needed.
      const { entries, archiveEntry } = useNotificationHistoryStore.getState();
      for (const entry of entries) {
        if (entry.supersedeKey === key && entry.archivedAt === null) archiveEntry(entry.id);
      }
      lastSummary.current = null;
      return;
    }
    if (summary === lastSummary.current) return;
    lastSummary.current = summary;
    notify({
      type: "warning",
      title: "Plugins need a window reload",
      message: `${summary}: save edits, then reload this project window to replace plugin registrations.`,
      priority: "low",
      supersedeKey: key,
      context: { projectId, eventKind: "recovery" },
      // The inbox keeps only actions carrying an actionId; an onClick-only
      // action vanishes from the one surface this low-priority entry has.
      action: { label: "Review reload", actionId: "plugin.reloadWindow", onClick: requestReload },
    });
  }, [diagnostics, projectId, summary]);
}
