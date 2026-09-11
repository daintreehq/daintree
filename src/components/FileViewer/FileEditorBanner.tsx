import { useEffect, useMemo, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { resolveFileEditor } from "@/registry/fileEditorRegistry";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { FileEditorHintBar } from "@/components/FileViewer/FileEditorHintBar";

interface FileEditorBannerProps {
  filePath: string;
  content: string;
  onEdit: () => void | Promise<void>;
}

/** Both readers use the same discovery route, even while the plugin's view is disabled. */
export function FileEditorBanner({ filePath, content, onEdit }: FileEditorBannerProps) {
  const registration = resolveFileEditor(filePath);
  const contentBytes = useMemo(() => new TextEncoder().encode(content).byteLength, [content]);
  const meta = usePluginRuntimeStore((state) =>
    registration ? state.pluginMetaById.get(registration.pluginId) : undefined
  );
  const disabled = usePluginRuntimeStore((state) =>
    registration ? state.disabledPluginIds.has(registration.pluginId) : false
  );
  const init = usePluginRuntimeStore((state) => state.init);
  useEffect(() => init(), [init]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!registration || !meta || dismissed || contentBytes > registration.maxBytes) {
    return null;
  }
  // Enablement is persisted before activation finishes. Keep the current
  // attempt visible until it succeeds or the user can act on its error.
  if (!disabled && !pending && !error) return null;

  const edit = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (disabled || error) {
        await window.electron.plugin.setEnabled(registration.pluginId, true);
        const plugins = await window.electron.plugin.list();
        const plugin = plugins.find((entry) => entry.instanceId === registration.pluginId);
        usePluginRuntimeStore.getState().refresh();
        if (!plugin || plugin.disabled || plugin.pendingRestart || plugin.loadError) {
          throw new Error("The plugin couldn't start. Check its status in Preferences → Plugins.");
        }
      }
      // A file selection can change while enabling. Don't open the previous
      // selection after the reader has moved on (callers key by file path).
      if (mounted.current) await onEdit();
    } catch (err) {
      if (mounted.current) setError(formatErrorMessage(err, "Couldn't open the editor"));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return (
    <FileEditorHintBar
      pluginName={meta.displayName}
      state="disabled"
      pending={pending}
      error={error}
      onAction={() => void edit()}
      onDismiss={() => setDismissed(true)}
    />
  );
}
