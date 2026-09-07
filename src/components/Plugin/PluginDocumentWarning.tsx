import { useEffect, useSyncExternalStore } from "react";
import { TriangleAlert } from "lucide-react";
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

function affectedPlugins(diagnostics: readonly PluginDocumentDiagnostic[]): string {
  return [
    ...new Set(
      diagnostics.map((item) =>
        item.pluginId ? pluginManifestIdFromInstanceKey(item.pluginId) : "Unknown plugin"
      )
    ),
  ].join(", ");
}

function requestReload() {
  void actionService.dispatch("plugin.reloadWindow", undefined, { source: "user" });
}

export function PluginDocumentWarning() {
  const diagnostics = useSyncExternalStore(
    pluginDocumentRuntime.subscribe,
    pluginDocumentRuntime.getSnapshot
  );
  if (diagnostics.length === 0) return null;
  return (
    <InlineStatusBanner
      icon={TriangleAlert}
      severity="warning"
      title="Plugins need a window reload"
      description="Plugin registrations can't be replaced until this project window reloads. Save edits before continuing."
      contextLine={affectedPlugins(diagnostics)}
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
  useEffect(() => {
    if (!projectId || diagnostics.length === 0) return;
    notify({
      type: "warning",
      title: "Plugins need a window reload",
      message: `${affectedPlugins(diagnostics)}: save edits, then reload this project window to replace plugin registrations.`,
      priority: "low",
      supersedeKey: `plugin-document:${projectId}`,
      context: { projectId, eventKind: "recovery" },
      action: { label: "Review reload", onClick: requestReload },
    });
  }, [diagnostics, projectId]);
}
